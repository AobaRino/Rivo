package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const rememberedTestPassword = "remembered-password-12345"

func authForSessionTest(t *testing.T, dir string) *webAuth {
	t.Helper()
	a, err := newWebAuth(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, session := range a.sessions {
			session.cancel()
		}
	})
	return a
}

func sessionRequest(t *testing.T, a *webAuth, method, path string, payload any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, "https://router.test:18888"+path, strings.NewReader(string(body)))
	r.Header.Set("Origin", "https://router.test:18888")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	a.handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })).ServeHTTP(w, r)
	return w
}

func sessionLogin(t *testing.T, a *webAuth, remember bool, current *http.Cookie) *http.Cookie {
	t.Helper()
	path := "/api/auth/login"
	payload := map[string]any{"password": rememberedTestPassword, "remember": remember}
	if a.bootstrap != "" {
		path = "/api/auth/setup"
		payload["token"] = a.bootstrap
	}
	w := sessionRequest(t, a, "POST", path, payload, current)
	if w.Code != http.StatusOK || len(w.Result().Cookies()) != 1 {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	return w.Result().Cookies()[0]
}

func expectSession(t *testing.T, a *webAuth, cookie *http.Cookie, allowed bool) {
	t.Helper()
	w := sessionRequest(t, a, "GET", "/api/state", nil, cookie)
	want := http.StatusUnauthorized
	if allowed {
		want = http.StatusNoContent
	}
	if w.Code != want {
		t.Fatalf("session status %d, want %d", w.Code, want)
	}
}

func readSessionStore(t *testing.T, dir string) storedWebSessions {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "sessions.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored storedWebSessions
	if err := json.Unmarshal(b, &stored); err != nil {
		t.Fatal(err)
	}
	return stored
}

func TestRememberedLoginRestartsWithoutRetainingOrdinarySession(t *testing.T) {
	dir := t.TempDir()
	a := authForSessionTest(t, dir)
	remembered := sessionLogin(t, a, true, nil) // Setup accepts the same opt-in.
	ordinary := sessionLogin(t, a, false, nil)  // A separate browser remains independent.
	if remembered.MaxAge != int(rememberedLifetime.Seconds()) || ordinary.MaxAge != int(webSessionLifetime.Seconds()) {
		t.Fatal("unexpected cookie lifetimes")
	}
	for _, cookie := range []*http.Cookie{remembered, ordinary} {
		if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.Domain != "" || cookie.Name != "__Host-mm-session" {
			t.Fatal("session cookie protections changed")
		}
		if delta := time.Until(cookie.Expires) - time.Duration(cookie.MaxAge)*time.Second; delta > time.Second || delta < -5*time.Second {
			t.Fatal("cookie expiry does not match fixed lifetime", delta)
		}
	}
	storePath := filepath.Join(dir, "sessions.json")
	b, err := os.ReadFile(storePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), remembered.Value) || strings.Contains(string(b), ordinary.Value) || strings.Contains(string(b), rememberedTestPassword) {
		t.Fatal("plaintext credential or bearer token persisted")
	}
	stored := readSessionStore(t, dir)
	key := sha256.Sum256([]byte(remembered.Value))
	if stored.Version != 1 || stored.Credentials != a.credentialsFingerprint() || len(stored.Sessions) != 1 || stored.Sessions[hex.EncodeToString(key[:])].IsZero() {
		t.Fatal("unexpected persistent session representation")
	}
	info, err := os.Stat(storePath)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("session store is not owner-only", err)
	}
	restored := authForSessionTest(t, dir)
	expectSession(t, restored, remembered, true)
	expectSession(t, restored, ordinary, false)
	// Polling does not renew lifetime or rewrite storage.
	mtime := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(storePath, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		expectSession(t, restored, remembered, true)
	}
	info, err = os.Stat(storePath)
	if err != nil || !info.ModTime().Equal(mtime) {
		t.Fatal("polling rewrote the session store", err)
	}
}

func TestRememberedSessionExpiresAndRejectsExpiredRestore(t *testing.T) {
	dir := t.TempDir()
	a := authForSessionTest(t, dir)
	cookie := sessionLogin(t, a, true, nil)
	key := sha256.Sum256([]byte(cookie.Value))
	expires := a.sessions[key].expires
	a.now = func() time.Time { return expires }
	expectSession(t, a, cookie, false)
	stored := readSessionStore(t, dir)
	stored.Sessions[hex.EncodeToString(key[:])] = time.Now().Add(-time.Second)
	b, _ := json.Marshal(stored)
	if err := os.WriteFile(filepath.Join(dir, "sessions.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	restored := authForSessionTest(t, dir)
	expectSession(t, restored, cookie, false)
	if !restored.storeDirty {
		t.Fatal("expired entries were not scheduled for cleanup")
	}
	_ = sessionLogin(t, restored, false, nil)
	if len(readSessionStore(t, dir).Sessions) != 0 {
		t.Fatal("explicit login did not clean expired entries")
	}
}

func TestRememberedSessionRestoreSurvivesClockRollback(t *testing.T) {
	dir := t.TempDir()
	a := authForSessionTest(t, dir)
	cookie := sessionLogin(t, a, true, nil)
	restored := &webAuth{dir: dir, credentials: a.credentials, sessions: map[[32]byte]webSession{}, secure: true, now: func() time.Time { return time.Now().Add(-24 * time.Hour) }}
	if err := restored.loadSessions(); err != nil {
		t.Fatal("clock rollback rejected an otherwise valid session", err)
	}
	defer func() {
		for _, session := range restored.sessions {
			session.cancel()
		}
	}()
	expectSession(t, restored, cookie, true)
}

func TestRememberedLogoutPersistsAndCancelsStream(t *testing.T) {
	dir := t.TempDir()
	a := authForSessionTest(t, dir)
	cookie := sessionLogin(t, a, true, nil)
	a = authForSessionTest(t, dir)
	started, finished := make(chan struct{}), make(chan struct{})
	h := a.handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(finished) }))
	r := httptest.NewRequest("GET", "https://router.test:18888/api/dashboard/live/traffic", nil)
	r.AddCookie(cookie)
	go h.ServeHTTP(httptest.NewRecorder(), r)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("stream did not start")
	}
	w := sessionRequest(t, a, "POST", "/api/auth/logout", map[string]any{}, cookie)
	if w.Code != http.StatusOK || len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].MaxAge >= 0 {
		t.Fatal("logout did not clear cookie", w.Code)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("remembered logout did not cancel active stream")
	}
	expectSession(t, a, cookie, false)
	expectSession(t, authForSessionTest(t, dir), cookie, false)
}

func TestRememberedLoginReplacesCurrentCookie(t *testing.T) {
	for _, remember := range []bool{false, true} {
		t.Run(fmt.Sprint(remember), func(t *testing.T) {
			dir := t.TempDir()
			a := authForSessionTest(t, dir)
			old := sessionLogin(t, a, true, nil)
			oldContext := a.sessions[sha256.Sum256([]byte(old.Value))].ctx
			current := sessionLogin(t, a, remember, old)
			select {
			case <-oldContext.Done():
			default:
				t.Fatal("replaced session streams were not cancelled")
			}
			expectSession(t, a, old, false)
			expectSession(t, a, current, true)
			restored := authForSessionTest(t, dir)
			expectSession(t, restored, old, false)
			expectSession(t, restored, current, remember)
		})
	}
}

func TestRememberedSessionsBoundToCredentials(t *testing.T) {
	dir := t.TempDir()
	a := authForSessionTest(t, dir)
	old := sessionLogin(t, a, true, nil)
	// A password reset rotates the verifier even when the chosen password is unchanged.
	credentials := webCredentials{Salt: randomToken()}
	credentials.Hash = passwordHash(rememberedTestPassword, credentials.Salt)
	b, _ := json.Marshal(credentials)
	if err := atomicWriteFile(filepath.Join(dir, "credentials.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	restored := authForSessionTest(t, dir)
	expectSession(t, restored, old, false)
	current := sessionLogin(t, restored, true, nil)
	restored = authForSessionTest(t, dir)
	expectSession(t, restored, old, false)
	expectSession(t, restored, current, true)
}

func TestRememberedSessionStorageFailuresAreTransactional(t *testing.T) {
	dir := t.TempDir()
	a := authForSessionTest(t, dir)
	ordinary := sessionLogin(t, a, false, nil)
	if _, err := os.Stat(filepath.Join(dir, "sessions.json")); !os.IsNotExist(err) {
		t.Fatal("ordinary login created a persistent session file")
	}
	a.dir = filepath.Join(dir, "missing", "auth")
	w := sessionRequest(t, a, "POST", "/api/auth/login", map[string]any{"password": rememberedTestPassword, "remember": true}, ordinary)
	if w.Code != http.StatusInternalServerError || len(w.Result().Cookies()) != 0 || len(a.sessions) != 1 {
		t.Fatal("failed storage issued a session or replaced the current session", w.Code)
	}
	expectSession(t, a, ordinary, true)
	a.dir = dir
	remembered := sessionLogin(t, a, true, ordinary)
	a.dir = filepath.Join(dir, "missing", "auth")
	w = sessionRequest(t, a, "POST", "/api/auth/logout", map[string]any{}, remembered)
	if w.Code != http.StatusInternalServerError || len(w.Result().Cookies()) != 0 {
		t.Fatal("failed persistent revocation claimed successful logout", w.Code)
	}
	expectSession(t, a, remembered, true)
	expectSession(t, authForSessionTest(t, dir), remembered, true)
	a.dir = dir
	w = sessionRequest(t, a, "POST", "/api/auth/logout", map[string]any{}, remembered)
	if w.Code != http.StatusOK {
		t.Fatal("revocation retry failed", w.Code)
	}
	expectSession(t, authForSessionTest(t, dir), remembered, false)
}

func TestRememberedStoreCorruptionFailsClosedAndLoginRepairs(t *testing.T) {
	seedDir := t.TempDir()
	seed := authForSessionTest(t, seedDir)
	old := sessionLogin(t, seed, true, nil)
	credentials, err := os.ReadFile(filepath.Join(seedDir, "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	valid := readSessionStore(t, seedDir)
	for _, corruption := range []string{"invalid-json", "oversized", "unknown-version", "invalid-hash", "invalid-expiry", "too-many"} {
		t.Run(corruption, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "credentials.json"), credentials, 0600); err != nil {
				t.Fatal(err)
			}
			stored := storedWebSessions{Version: valid.Version, Credentials: valid.Credentials, Sessions: map[string]time.Time{}}
			for key, expires := range valid.Sessions {
				stored.Sessions[key] = expires
			}
			switch corruption {
			case "unknown-version":
				stored.Version++
			case "invalid-hash":
				stored.Sessions["not-a-token-hash"] = time.Now().Add(time.Hour)
			case "invalid-expiry":
				stored.Sessions[strings.Repeat("0", 64)] = time.Time{}
			case "too-many":
				for i := 0; i < webSessionLimit; i++ {
					stored.Sessions[fmt.Sprintf("%064x", i)] = time.Now().Add(time.Hour)
				}
			}
			b, _ := json.Marshal(stored)
			if corruption == "invalid-json" {
				b = []byte(`{"version":`)
			}
			if corruption == "oversized" {
				b = append(b, []byte(strings.Repeat(" ", webSessionsFileLimit))...)
			}
			if err := os.WriteFile(filepath.Join(dir, "sessions.json"), b, 0600); err != nil {
				t.Fatal(err)
			}
			a := authForSessionTest(t, dir)
			expectSession(t, a, old, false)
			if !a.storeDirty {
				t.Fatal("invalid store was not marked for replacement")
			}
			current := sessionLogin(t, a, true, nil)
			restored := authForSessionTest(t, dir)
			expectSession(t, restored, old, false)
			expectSession(t, restored, current, true)
		})
	}
}

func TestRememberedSessionLimitEvictsPersistently(t *testing.T) {
	dir := t.TempDir()
	a := authForSessionTest(t, dir)
	_ = sessionLogin(t, a, false, nil)
	var first *http.Cookie
	base := time.Now()
	for i := 0; i < webSessionLimit+1; i++ {
		a.now = func() time.Time { return base.Add(time.Duration(i) * time.Second) }
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "https://router.test:18888/api/auth/login", nil)
		a.mu.Lock()
		err := a.setSession(w, r, true)
		a.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = w.Result().Cookies()[0]
		}
	}
	if len(a.sessions) != webSessionLimit || len(readSessionStore(t, dir).Sessions) != webSessionLimit {
		t.Fatal("session limit exceeded")
	}
	expectSession(t, a, first, false)
	expectSession(t, authForSessionTest(t, dir), first, false)
}
