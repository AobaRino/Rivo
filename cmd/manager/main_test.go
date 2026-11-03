package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

const example = "mode: rule\nmixed-port: 7890\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n"

func TestNativeDisabledPortAndNormalDNS(t *testing.T) {
	text := "mixed-port: 0\ndns:\n  enhanced-mode: normal\nproxies:\n  - name: local-direct\n    type: direct\nrules:\n  - MATCH,local-direct\n"
	if issues := validate(text); len(issues) != 0 {
		t.Fatal(issues)
	}
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	s, e := newServer(filepath.Join(t.TempDir(), "state.json"), example)
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func call(s *Server, method, path, body, rev string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = "127.0.0.1:18787"
	if rev != "" {
		r.Header.Set("If-Match", rev)
	}
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	return w
}
func textBody(t *testing.T, text string) string {
	b, e := json.Marshal(map[string]string{"text": text})
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}
func TestDraftIsNotRuntimeAndRevisionConflicts(t *testing.T) {
	s := newTestServer(t)
	old := revision(example)
	updated := strings.Replace(example, "mode: rule", "mode: global", 1)
	w := call(s, http.MethodPut, "/api/draft", textBody(t, updated), old)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if s.runtime.Mode != "rule" || s.state.Applied != example {
		t.Fatal("saving changed runtime")
	}
	if w = call(s, http.MethodPut, "/api/draft", textBody(t, example), old); w.Code != 409 {
		t.Fatal("stale save accepted")
	}
	w = call(s, http.MethodPost, "/api/apply", `{"revision":"`+revision(updated)+`"}`, "")
	if w.Code != 200 || s.runtime.Mode != "global" {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestInvalidDraftSurvivesButCannotApply(t *testing.T) {
	s := newTestServer(t)
	bad := "mode: [unfinished"
	if w := call(s, http.MethodPut, "/api/draft", textBody(t, bad), revision(example)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w := call(s, http.MethodPost, "/api/apply", `{"revision":"`+revision(bad)+`"}`, "")
	if w.Code != 422 {
		t.Fatal(w.Code)
	}
	if s.state.Applied != example || s.runtime.Mode != "rule" {
		t.Fatal("failed apply modified active state")
	}
	reload, e := newServer(s.path, example)
	if e != nil || reload.state.Draft != bad {
		t.Fatal("invalid source was lost", e)
	}
}
func TestTemporaryRuntimeDoesNotWriteConfig(t *testing.T) {
	s := newTestServer(t)
	w := call(s, http.MethodPatch, "/api/runtime", `{"mode":"global"}`, "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if s.state.Draft != example || s.runtime.Mode != "global" {
		t.Fatal("runtime mutated document")
	}
	reloaded, e := newServer(s.path, example)
	if e != nil || reloaded.runtime.Mode != "rule" {
		t.Fatal("runtime mode persisted", e)
	}
}
func TestRejectsCrossOriginMutation(t *testing.T) {
	s := newTestServer(t)
	r := httptest.NewRequest(http.MethodPatch, "/api/runtime", strings.NewReader(`{"mode":"global"}`))
	r.Host = "127.0.0.1:18787"
	r.Header.Set("Origin", "https://untrusted.example")
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
func TestValidationReferencesAndDuplicates(t *testing.T) {
	for _, bad := range []string{"mode: rule\nmode: global\n", "mode: wrong\n", "mixed-port: 99999\n", "rules:\n  - MATCH,Missing\n", "mode: rule\n---\nmode: direct\n"} {
		if len(validate(bad)) == 0 {
			t.Fatal("accepted invalid YAML", bad)
		}
	}
}
