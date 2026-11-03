package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func workspaceCall(t *testing.T, s *Server, method, path string, body any, profileID string) *httptest.ResponseRecorder {
	t.Helper()
	b, e := json.Marshal(body)
	if e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest(method, path, strings.NewReader(string(b)))
	r.Host = "127.0.0.1:18787"
	r.Header.Set("X-Profile-ID", profileID)
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	return w
}
func createLocalProfile(t *testing.T, s *Server, name, text string) string {
	t.Helper()
	w := workspaceCall(t, s, "POST", "/api/profiles", map[string]string{"name": name, "text": text, "expected": profileRevision(s.state)}, s.state.ProfileID)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	return s.state.Profiles[len(s.state.Profiles)-1].ID
}
func TestLocalProfileSwitchPreservesDraftsAndRejectsStalePreview(t *testing.T) {
	s := newTestServer(t)
	id := createLocalProfile(t, s, "备用.yaml", strings.Replace(example, "mode: rule", "mode: global", 1))
	oldID := s.state.ProfileID
	unsaved := example + "# retained draft\n"
	expected := profileRevision(s.state)
	req := map[string]any{"expected": expected, "revision": revision(s.state.Draft), "saveCurrent": unsaved}
	w := workspaceCall(t, s, "POST", "/api/profiles/"+id+"/switch", req, oldID)
	if w.Code != 200 || s.runtime.Mode != "global" || s.state.ProfileID != id {
		t.Fatal(w.Code, w.Body.String())
	}
	if s.state.Profiles[0].Draft != unsaved || s.state.Profiles[0].ID != oldID {
		t.Fatal("old workspace was not preserved")
	}
	w = workspaceCall(t, s, "POST", "/api/profiles/"+oldID+"/switch", req, id)
	if w.Code != 409 || s.state.ProfileID != id {
		t.Fatal("stale preview switched profile")
	}
	reloaded, e := newServer(s.path, example)
	if e != nil || reloaded.state.ProfileID != id || reloaded.state.Profiles[0].Draft != unsaved {
		t.Fatal("profile library did not survive reload", e)
	}
	w = workspaceCall(t, s, "POST", "/api/profiles/"+oldID+"/switch", map[string]string{"expected": profileRevision(s.state), "revision": revision(s.state.Draft)}, id)
	if w.Code != 200 || s.state.Draft != unsaved || len(s.state.History) < 2 {
		t.Fatal("return to original document lost draft/history", w.Code)
	}
}
func TestLocalFailedSwitchDoesNotSaveCurrentOrChangeRuntime(t *testing.T) {
	s := newTestServer(t)
	id := createLocalProfile(t, s, "错误.yaml", "mode: unsupported\n")
	before, _ := os.ReadFile(s.path)
	w := workspaceCall(t, s, "POST", "/api/profiles/"+id+"/switch", map[string]any{"expected": profileRevision(s.state), "revision": revision(s.state.Draft), "saveCurrent": "# should not save\n" + example}, s.state.ProfileID)
	after, _ := os.ReadFile(s.path)
	if w.Code != 422 || string(before) != string(after) || s.runtime.Mode != "rule" || s.state.ProfileID != "default" {
		t.Fatal("invalid switch changed state", w.Code)
	}
}
func TestLocalProfileIdentityGuardsEqualYamlAndConcurrentSourceEdits(t *testing.T) {
	s := newTestServer(t)
	id := createLocalProfile(t, s, "same.yaml", example)
	w := workspaceCall(t, s, "POST", "/api/profiles/"+id+"/switch", map[string]string{"expected": profileRevision(s.state), "revision": revision(example)}, "default")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w = call(s, "PUT", "/api/draft", textBody(t, example+"# stale\n"), revision(example)); w.Code != 409 {
		t.Fatal("old tab wrote to a different profile")
	}
	if w = workspaceCall(t, s, "PATCH", "/api/runtime", map[string]string{"mode": "global"}, "default"); w.Code != 409 {
		t.Fatal("old dashboard controlled a different profile")
	}
	w = workspaceCall(t, s, "POST", "/api/profiles/default/switch", map[string]string{"expected": profileRevision(s.state), "revision": "stale"}, id)
	if w.Code != 409 {
		t.Fatal("stale source revision accepted")
	}
}
func TestLocalRuntimeStartRestartAndAutostart(t *testing.T) {
	s := newTestServer(t)
	for _, body := range []any{map[string]string{"mode": "global"}, map[string]bool{"restart": true}} {
		w := workspaceCall(t, s, "PATCH", "/api/runtime", body, "default")
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if s.runtime.Mode != "rule" || s.state.Draft != example {
		t.Fatal("restart did not use applied YAML")
	}
	w := workspaceCall(t, s, "PATCH", "/api/runtime", map[string]bool{"running": false}, "default")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = workspaceCall(t, s, "PATCH", "/api/runtime", map[string]string{"mode": "direct"}, "default")
	if w.Code != 409 {
		t.Fatal("stopped runtime accepted mode change")
	}
	w = workspaceCall(t, s, "PATCH", "/api/runtime", map[string]bool{"autoStart": false}, "default")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	reloaded, e := newServer(s.path, example)
	if e != nil || reloaded.runtime.Running {
		t.Fatal("simulated startup preference lost", e)
	}
	w = workspaceCall(t, s, "PATCH", "/api/runtime", map[string]bool{"running": true}, "default")
	if w.Code != 200 || !s.runtime.Running || s.runtime.StartedAt == "" {
		t.Fatal("start failed", w.Code)
	}
}
func TestLocalProfilesDisabledForRouterAndProtectCurrent(t *testing.T) {
	s := newTestServer(t)
	w := workspaceCall(t, s, "DELETE", "/api/profiles/default", map[string]string{"expected": profileRevision(s.state)}, "default")
	if w.Code != 409 {
		t.Fatal("active document deleted")
	}
	s.routerOnly = true
	w = workspaceCall(t, s, "POST", "/api/profiles", map[string]string{"name": "x", "text": example, "expected": profileRevision(s.state)}, "default")
	if w.Code != 409 || len(s.state.Profiles) != 0 {
		t.Fatal("router accepted simulator profile mutation")
	}
}
func TestLocalLegacyWorkspaceAndFailedDiskCommit(t *testing.T) {
	s := newTestServer(t)
	legacy := `{"draft":"mode: global\n","applied":"mode: rule\n","history":[]}`
	if e := os.WriteFile(s.path, []byte(legacy), 0600); e != nil {
		t.Fatal(e)
	}
	s, e := newServer(s.path, example)
	if e != nil || s.state.Draft != "mode: global\n" || s.state.ProfileID != "default" || s.runtime.Mode != "rule" {
		t.Fatal("legacy state migration changed YAML", e)
	}
	id := createLocalProfile(t, s, "valid.yaml", example)
	s.path = filepath.Join(t.TempDir(), "occupied")
	if e := os.Mkdir(s.path, 0700); e != nil {
		t.Fatal(e)
	}
	w := workspaceCall(t, s, "POST", "/api/profiles/"+id+"/switch", map[string]string{"expected": profileRevision(s.state), "revision": revision(s.state.Draft)}, "default")
	if w.Code != 500 || s.state.ProfileID != "default" || s.runtime.Mode != "rule" {
		t.Fatal("disk failure mutated in-memory state", w.Code)
	}
}
