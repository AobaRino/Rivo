package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestRouterCoreControlRequestBoundary(t *testing.T) {
	for _, body := range []string{
		`{}`, `{"action":"reboot","expectedApplied":"x"}`,
		`{"action":"start","expectedApplied":"x","command":"anything"}`,
		`{"action":"stop","expectedApplied":"x"}{}`, `{"action":"stop"}`,
	} {
		if _, err := decodeRouterCoreRequest(strings.NewReader(body)); err == nil {
			t.Fatal("accepted", body)
		}
	}
	for _, action := range []string{"start", "stop", "restart"} {
		if _, err := decodeRouterCoreRequest(strings.NewReader(`{"action":"` + action + `","expectedApplied":"revision"}`)); err != nil {
			t.Fatal(err)
		}
	}
	if routerAPIPermission("POST", "/api/core/control") != "write" || routerAPIPermission("GET", "/api/core/control") != "" {
		t.Fatal("incorrect privileged endpoint permission")
	}
	// An authenticated editor is not a substitute for authenticating the public
	// endpoint. Verify new operations use the existing login/CSRF gate.
	a, err := newWebAuth(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	reached := false
	h := a.handler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
	r := httptest.NewRequest("POST", "https://router.test:18888/api/core/control", strings.NewReader(`{"action":"stop","expectedApplied":"x"}`))
	r.Header.Set("Origin", "https://router.test:18888")
	r.Header.Set("X-Mihomo-Request", "1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if reached || w.Code != 401 {
		t.Fatal("unauthenticated control reached broker", w.Code)
	}
}

func TestRouterCoreControlTransitions(t *testing.T) {
	for _, tc := range []struct {
		name, action, fail string
		network            bool
		want               []string
	}{
		{"stop", "stop", "", true, []string{"suspend", "stop"}},
		{"start with takeover", "start", "", true, []string{"validate", "start", "health", "resume"}},
		{"start without takeover", "start", "", false, []string{"validate", "start", "health"}},
		{"restart", "restart", "", true, []string{"validate", "suspend", "stop", "start", "health", "resume"}},
		{"bad config leaves live core", "restart", "validate", true, []string{"validate"}},
		{"cannot detach leaves core", "stop", "suspend", true, []string{"suspend"}},
		{"start failure", "start", "start", true, []string{"validate", "start", "suspend", "stop"}},
		{"health failure", "start", "health", true, []string{"validate", "start", "health", "suspend", "stop"}},
		{"network failure", "restart", "resume", true, []string{"validate", "suspend", "stop", "start", "health", "resume", "suspend", "stop"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			step := func(name string) func() error {
				return func() error {
					calls = append(calls, name)
					if tc.fail == name {
						return errors.New("test failure")
					}
					return nil
				}
			}
			o := routerCoreOps{step("validate"), step("suspend"), step("stop"), step("start"), func(pid int) error {
				if tc.action == "restart" && pid != 42 {
					t.Fatal("restart accepted old PID")
				}
				if tc.action == "start" && pid != 0 {
					t.Fatal("start was not idempotent")
				}
				return step("health")()
			}, step("resume"), func(string) {}}
			err := o.run(tc.action, tc.network, 42)
			if (err != nil) != (tc.fail != "") || !slices.Equal(calls, tc.want) {
				t.Fatal(calls, err)
			}
		})
	}
}
