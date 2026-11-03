package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/AobaRino/Rivo/internal/dashboardbundle"
)

func dashboardFixture(t *testing.T, version string) (dashboardbundle.Release, []byte) {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	f, _ := w.Create("dist/index.html")
	_, _ = f.Write([]byte("<!doctype html><html><body>" + version + "</body></html>"))
	f, _ = w.Create("dist/assets/test.js")
	_, _ = f.Write([]byte("/* " + version + " */"))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(b.Bytes())
	r := dashboardbundle.Release{Version: version, URL: "https://github.com/Zephyruso/zashboard/releases/download/" + version + "/dist-no-fonts.zip", SHA256: hex.EncodeToString(h[:]), Size: int64(b.Len())}
	return r, b.Bytes()
}
func dashboardMetadata(r dashboardbundle.Release) []byte {
	b, _ := json.Marshal(githubRelease{Tag: r.Version, Published: "2026-10-28T00:00:00Z", Assets: []releaseAsset{{Name: "dist-no-fonts.zip", URL: r.URL, Digest: "sha256:" + r.SHA256, Size: r.Size}}})
	return b
}
func dashboardTestManager(t *testing.T) (*DashboardManager, dashboardbundle.Release, []byte) {
	t.Helper()
	root := t.TempDir()
	old, data := dashboardFixture(t, dashboardVersion)
	if err := dashboardbundle.Install(root, old, data); err != nil {
		t.Fatal(err)
	}
	next, archive := dashboardFixture(t, "v3.30.0")
	d, err := newDashboardManager(root, func(_ context.Context, u string, _ int64) ([]byte, error) {
		switch u {
		case dashboardReleaseAPI + "latest", dashboardReleaseAPI + "tags/" + next.Version:
			return dashboardMetadata(next), nil
		case next.URL:
			return archive, nil
		}
		return nil, errors.New("unexpected URL: " + u)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	return d, next, archive
}
func waitDashboard(t *testing.T, d *DashboardManager) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		s := d.status()
		if !s["busy"].(bool) {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("dashboard operation did not finish")
	return nil
}
func dashboardSucceeded(t *testing.T, d *DashboardManager) {
	t.Helper()
	s := waitDashboard(t, d)
	if s["operation"].(CoreOperation).Status != "success" {
		t.Fatal(s)
	}
}

func TestDashboardUpdateRollbackPersistenceAndVersionedServing(t *testing.T) {
	d, next, _ := dashboardTestManager(t)
	s := newTestServer(t)
	s.dashboard = d
	original, _ := os.ReadFile(s.path)
	runtime := s.runtime
	call := func(method, path string, body any) int {
		t.Helper()
		w := workspaceCall(t, s, method, "/api/dashboard-manager"+path, body, "")
		if w.Code >= 400 {
			t.Fatal(w.Code, w.Body.String())
		}
		return w.Code
	}
	if call("POST", "/check", map[string]any{}) != 202 {
		t.Fatal("check not asynchronous")
	}
	dashboardSucceeded(t, d)
	call("POST", "/update", map[string]string{"expected": dashboardVersion, "target": next.Version, "digest": next.SHA256})
	dashboardSucceeded(t, d)
	if d.current() != next.Version || d.status()["previous"] != dashboardVersion {
		t.Fatal(d.status())
	}
	w := workspaceCall(t, s, "GET", "/api/dashboard/open", nil, "")
	if !strings.HasPrefix(w.Header().Get("Location"), "/dashboard-ui/"+next.Version+"/#/setup?") {
		t.Fatal(w.Header())
	}
	for _, v := range []string{next.Version, dashboardVersion} {
		w = workspaceCall(t, s, "GET", "/dashboard-ui/"+v+"/assets/test.js", nil, "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), v) || w.Header().Get("Service-Worker-Allowed") != "/dashboard-ui/"+v+"/" {
			t.Fatal(w.Code, w.Body.String(), w.Header())
		}
	}
	call("POST", "/rollback", map[string]string{"expected": next.Version, "target": dashboardVersion})
	dashboardSucceeded(t, d)
	call("PUT", "/settings", map[string]bool{"autoCheck": false})
	copy, err := newDashboardManager(d.dir, d.get)
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	if copy.current() != dashboardVersion || copy.state.Previous != next.Version || copy.state.AutoCheck {
		t.Fatal(copy.status())
	}
	after, _ := os.ReadFile(s.path)
	if !bytes.Equal(original, after) || !reflect.DeepEqual(runtime, s.runtime) {
		t.Fatal("dashboard update changed YAML or core runtime")
	}
	if err = d.update(dashboardVersion, next.Version, "wrong"); err == nil {
		t.Fatal("stale checksum accepted")
	}
	if err = d.rollback(next.Version, dashboardVersion); err == nil {
		t.Fatal("stale version accepted")
	}
}

func TestDashboardFailedDownloadAndChangedReleaseKeepCurrent(t *testing.T) {
	for _, failure := range []string{"download", "checksum", "changed-metadata", "persist"} {
		t.Run(failure, func(t *testing.T) {
			d, next, data := dashboardTestManager(t)
			if err := d.check(false); err != nil {
				t.Fatal(err)
			}
			dashboardSucceeded(t, d)
			get := d.get
			d.get = func(ctx context.Context, u string, max int64) ([]byte, error) {
				if strings.Contains(u, "tags/") && failure == "changed-metadata" {
					other := next
					other.SHA256 = strings.Repeat("a", 64)
					return dashboardMetadata(other), nil
				}
				if u == next.URL {
					if failure == "download" {
						return nil, errors.New("offline")
					}
					if failure == "checksum" {
						return append(data, 0), nil
					}
				}
				return get(ctx, u, max)
			}
			if failure == "persist" {
				if err := os.Remove(filepath.Join(d.dir, "state.json")); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(d.dir, "state.json"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := d.update(dashboardVersion, next.Version, next.SHA256); err != nil {
				t.Fatal(err)
			}
			s := waitDashboard(t, d)
			if s["operation"].(CoreOperation).Status != "failed" || d.current() != dashboardVersion || s["previous"] != "" {
				t.Fatal(s)
			}
		})
	}
}

func TestDashboardAutoCheckCadenceAndConcurrency(t *testing.T) {
	d, next, _ := dashboardTestManager(t)
	get := d.get
	started, unblock := make(chan struct{}), make(chan struct{})
	d.get = func(ctx context.Context, u string, max int64) ([]byte, error) {
		close(started)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-unblock:
		}
		return get(ctx, u, max)
	}
	if err := d.check(true); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := d.check(false); err == nil {
		t.Fatal("concurrent check accepted")
	}
	if err := d.settings(false); err == nil {
		t.Fatal("settings changed during operation")
	}
	close(unblock)
	dashboardSucceeded(t, d)
	d.get = func(context.Context, string, int64) ([]byte, error) {
		t.Error("automatic check ran before due")
		return nil, errors.New("unexpected")
	}
	if err := d.check(true); err != nil {
		t.Fatal(err)
	}
	if d.status()["busy"].(bool) {
		t.Fatal("scheduled too soon")
	}
	if err := d.settings(false); err != nil {
		t.Fatal(err)
	}
	d.state.LastAttempt = ""
	if err := d.check(true); err != nil {
		t.Fatal(err)
	}
	if d.status()["busy"].(bool) {
		t.Fatal("auto check ignored disabled setting")
	}
	d.get = func(context.Context, string, int64) ([]byte, error) { return nil, errors.New("HTTP 503") }
	if err := d.check(false); err != nil {
		t.Fatal(err)
	}
	s := waitDashboard(t, d)
	if s["checkError"] == "" || d.state.Latest.Version != next.Version || d.current() != dashboardVersion {
		t.Fatal(s)
	}
	if until := time.Until(d.nextCheckLocked()); until < 59*time.Minute || until > time.Hour {
		t.Fatal(until)
	}
}

func TestDashboardUpdateRoutesRejectOtherEnvironmentsAndUntrustedOrigins(t *testing.T) {
	d, _, _ := dashboardTestManager(t)
	s := newTestServer(t)
	s.dashboard = d
	s.routerOnly = true
	w := workspaceCall(t, s, "GET", "/api/dashboard-manager", nil, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"enabled":true`) {
		t.Fatal("standalone router dashboard unavailable", w.Code)
	}
	s.core = &CoreManager{}
	w = workspaceCall(t, s, "POST", "/api/dashboard-manager/check", map[string]any{}, "")
	if w.Code != 409 {
		t.Fatal("managed core guard", w.Code)
	}
	s.routerOnly = false
	s.core = nil
	r := httptest.NewRequest("POST", "/api/dashboard-manager/check", strings.NewReader("{}"))
	r.Host = "127.0.0.1:18787"
	r.Header.Set("Origin", "https://untrusted.invalid")
	denied := httptest.NewRecorder()
	s.handler().ServeHTTP(denied, r)
	if denied.Code != 403 {
		t.Fatal("untrusted origin accepted", denied.Code)
	}
	w = workspaceCall(t, s, "PUT", "/api/dashboard-manager/settings", map[string]any{}, "")
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	// Host/Origin protection is shared with all manager API mutations.
	w = workspaceCall(t, s, "GET", "/dashboard-ui/invalid/../../state.json", nil, "")
	if w.Code == 200 {
		t.Fatal("invalid version served")
	}
}

// Opt-in real archive test. Uses only a temporary directory and never a core,
// router, existing local cache, workspace state or system network settings.
func TestDashboardOfficialRoundTrip(t *testing.T) {
	if os.Getenv("MIHOMO_TEST_OFFICIAL_DASHBOARD") != "1" {
		t.Skip("official network test is opt-in")
	}
	get := newCoreCatalog().get
	fetch := &DashboardManager{get: get}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	old, err := fetch.release(ctx, "tags/v3.29.0")
	if err != nil {
		t.Fatal(err)
	}
	data, err := get(ctx, old.URL, dashboardbundle.MaxArchive)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err = dashboardbundle.Install(root, old, data); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(dashboardUpdateState{Current: old.Version, AutoCheck: false})
	if err = os.WriteFile(filepath.Join(root, "state.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	d, err := newDashboardManager(root, get)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err = d.check(false); err != nil {
		t.Fatal(err)
	}
	dashboardSucceeded(t, d)
	latest := d.state.Latest
	if err = d.update(old.Version, latest.Version, latest.SHA256); err != nil {
		t.Fatal(err)
	}
	dashboardSucceeded(t, d)
	if _, err = os.Stat(filepath.Join(root, latest.Version, "dist", "sw.js")); err != nil {
		t.Fatal(err)
	}
	if err = d.rollback(latest.Version, old.Version); err != nil {
		t.Fatal(err)
	}
	dashboardSucceeded(t, d)
	if d.current() != old.Version {
		t.Fatal(d.status())
	}
	t.Logf("Verified official %s -> %s -> %s, SHA-256 and rollback; temporary artifacts cleaned by test", old.Version, latest.Version, old.Version)
}
