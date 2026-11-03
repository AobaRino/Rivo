package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWebIndependentLoginSetupLogoutAndExpiry(t *testing.T) {
	dir := t.TempDir()
	a, e := newWebAuth(dir, true)
	if e != nil {
		t.Fatal(e)
	}
	h := a.handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	call := func(method, path, body string, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://router.test:18888"+path, strings.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Mihomo-Request", "1")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := call("GET", "/api/state", "", nil, ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := call("POST", "/api/auth/setup", `{"password":"test-password-12345","token":"wrong"}`, nil, ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	b, _ := json.Marshal(map[string]string{"password": "test-password-12345", "token": a.bootstrap})
	w := call("POST", "/api/auth/setup", string(b), nil, "https://router.test:18888")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing session")
	}
	c := cookies[0]
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
		t.Fatal("insecure cookie")
	}
	if _, e = os.Stat(filepath.Join(dir, "setup-token")); !os.IsNotExist(e) {
		t.Fatal("setup token retained")
	}
	stored, _ := os.ReadFile(filepath.Join(dir, "credentials.json"))
	if strings.Contains(string(stored), "test-password") {
		t.Fatal("plaintext password")
	}
	if w = call("POST", "/api/auth/setup", string(b), nil, ""); w.Code != 403 {
		t.Fatal("setup replay")
	}
	if w = call("GET", "/api/state", "", c, ""); w.Code != 204 {
		t.Fatal("session rejected", w.Code)
	}
	if w = call("PUT", "/api/draft", "{}", c, "https://attacker.test"); w.Code != 403 {
		t.Fatal("cross origin accepted")
	}
	if w = call("POST", "/api/auth/logout", "{}", c, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w = call("GET", "/api/state", "", c, ""); w.Code != 401 {
		t.Fatal("logout not revoked")
	}
	w = call("POST", "/api/auth/login", `{"password":"test-password-12345"}`, nil, "")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	c = w.Result().Cookies()[0]
	a.now = func() time.Time { return time.Now().Add(13 * time.Hour) }
	if w = call("GET", "/api/state", "", c, ""); w.Code != 401 {
		t.Fatal("expired session accepted")
	}
	restored, e := newWebAuth(dir, true)
	if e != nil || restored.bootstrap != "" || restored.credentials.Hash == "" {
		t.Fatal("credentials not restored", e)
	}
}

func TestWebLoginRateLimitAndPublicSurface(t *testing.T) {
	a, e := newWebAuth(t.TempDir(), false)
	if e != nil {
		t.Fatal(e)
	}
	h := a.handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for i := 0; i < 6; i++ {
		r := httptest.NewRequest("POST", "http://localhost/api/auth/login", strings.NewReader(`{"password":"bad"}`))
		r.Header.Set("X-Mihomo-Request", "1")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 401
		if i == 5 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://localhost/api/auth/session", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || strings.Contains(w.Body.String(), a.bootstrap) {
		t.Fatal("setup secret leaked")
	}
	for _, route := range []string{"/api/state", "/api/dashboard/live/version", "/api/dashboard-manager"} {
		r = httptest.NewRequest("GET", "http://localhost"+route, nil)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal(route, w.Code)
		}
	}
}

func TestWebCrossSitePageNavigationDoesNotAuthorizeAPI(t *testing.T) {
	a, err := newWebAuth(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	if err := a.setSession(login, httptest.NewRequest("POST", "https://router.test/api/auth/login", nil), false); err != nil {
		t.Fatal(err)
	}
	cookie := login.Result().Cookies()[0]
	h := a.handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for _, tc := range []struct {
		name, method, path, mode, dest string
		status                         int
	}{
		{"LuCI link", "GET", "/", "navigate", "document", 204},
		{"deep link", "GET", "/groups", "navigate", "document", 204},
		{"HEAD page", "HEAD", "/", "navigate", "document", 204},
		{"dashboard page", "GET", "/dashboard-ui/v3.29.1/", "navigate", "document", 204},
		{"iframe", "GET", "/", "navigate", "iframe", 403},
		{"fetch", "GET", "/", "cors", "empty", 403},
		{"image", "GET", "/", "no-cors", "image", 403},
		{"missing metadata", "GET", "/", "", "", 403},
		{"form POST", "POST", "/", "navigate", "document", 403},
		{"API directory", "GET", "/api", "navigate", "document", 403},
		{"API navigation", "GET", "/api/state", "navigate", "document", 403},
		{"encoded API navigation", "GET", "/api%2Fstate", "navigate", "document", 403},
		{"API fetch", "GET", "/api/state", "cors", "empty", 403},
		{"login", "POST", "/api/auth/login", "navigate", "document", 403},
		{"session", "GET", "/api/auth/session", "navigate", "document", 403},
		{"dashboard API", "GET", "/api/dashboard/live/proxies", "navigate", "document", 403},
		{"save", "PUT", "/api/draft", "navigate", "document", 403},
		{"control", "POST", "/api/core/control", "navigate", "document", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "https://router.test:18888"+tc.path, nil)
			r.Header.Set("Sec-Fetch-Site", "cross-site")
			r.Header.Set("Sec-Fetch-Mode", tc.mode)
			r.Header.Set("Sec-Fetch-Dest", tc.dest)
			r.Header.Set("Origin", "http://192.0.2.1")
			r.Header.Set("X-Mihomo-Request", "1")
			r.AddCookie(cookie) // An existing login must not weaken the API checks.
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d: %s; want %d", w.Code, w.Body.String(), tc.status)
			}
			if w.Header().Get("X-Frame-Options") != "DENY" || len(w.Result().Cookies()) != 0 ||
				!strings.Contains(w.Header().Get("Vary"), "Sec-Fetch-Mode") {
				t.Fatal("navigation changed session or resource isolation")
			}
		})
	}
	// Opening a public document creates no session: API access still needs login.
	r := httptest.NewRequest("GET", "https://router.test:18888/api/state", nil)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatal("unauthenticated API accepted", w.Code)
	}
}

func TestLogoutCancelsActiveAPIRequest(t *testing.T) {
	a, e := newWebAuth(t.TempDir(), false)
	if e != nil {
		t.Fatal(e)
	}
	w := httptest.NewRecorder()
	if err := a.setSession(w, httptest.NewRequest("POST", "http://localhost/api/auth/login", nil), false); err != nil {
		t.Fatal(err)
	}
	cookie := w.Result().Cookies()[0]
	started, finished := make(chan struct{}), make(chan struct{})
	h := a.handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(finished) }))
	r := httptest.NewRequest("GET", "http://localhost/api/dashboard/live/traffic", nil)
	r.AddCookie(cookie)
	go h.ServeHTTP(httptest.NewRecorder(), r)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}
	r = httptest.NewRequest("POST", "http://localhost/api/auth/logout", strings.NewReader("{}"))
	r.Header.Set("X-Mihomo-Request", "1")
	r.AddCookie(cookie)
	h.ServeHTTP(httptest.NewRecorder(), r)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("logged out stream kept running")
	}
}

func TestStandaloneSPARoutesAndDashboardBoundary(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "index.html"), []byte("workspace-shell"), 0600)
	for _, tc := range []struct {
		path   string
		status int
	}{{"/", 200}, {"/rules", 200}, {"/nodes", 200}, {"/api/missing", 404}, {"/assets/missing.js", 404}} {
		w := httptest.NewRecorder()
		spaHandler(dir).ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.status {
			t.Fatal(tc.path, w.Code)
		}
	}
	for _, tc := range []struct {
		method, path string
		allowed      bool
	}{{"GET", "traffic", true}, {"GET", "proxies", true}, {"PUT", "proxies/group", true}, {"DELETE", "connections", true}, {"PATCH", "configs", true}, {"PUT", "configs", false}, {"POST", "upgrade", false}, {"GET", "../configs", false}} {
		if dashboardEndpointAllowed(tc.method, tc.path) != tc.allowed {
			t.Fatal(tc)
		}
	}
}

func TestRuntimePatchCannotBypassNetworkValidation(t *testing.T) {
	for _, body := range []string{`{"tun":{"enable":true}}`, `{"mode":"global","mixed-port":7890}`, `{"dns":{"enable":false}}`, `{"mode":"unknown"}`, `{}`} {
		r := httptest.NewRequest("PATCH", "http://localhost/configs", strings.NewReader(body))
		w := httptest.NewRecorder()
		if sanitizeRuntimePatch(w, r) || w.Code != 400 {
			t.Fatal("unsafe runtime change", body, w.Code)
		}
	}
	r := httptest.NewRequest("PATCH", "http://localhost/configs", strings.NewReader(`{"mode":"rule"}`))
	w := httptest.NewRecorder()
	if !sanitizeRuntimePatch(w, r) {
		t.Fatal("valid mode rejected")
	}
}
