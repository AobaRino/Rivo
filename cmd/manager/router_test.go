package main

import "testing"

func TestRouterModeNeverAppliesOrStartsCore(t *testing.T) {
	s := newTestServer(t)
	s.routerOnly = true
	for _, endpoint := range []struct{ method, path string }{{"POST", "/api/apply"}, {"PATCH", "/api/runtime"}, {"POST", "/api/core/prepare"}, {"POST", "/api/core/activate"}, {"POST", "/api/core/rollback"}} {
		w := call(s, endpoint.method, endpoint.path, "{}", "")
		if w.Code != 409 {
			t.Fatalf("%s returned %d", endpoint.path, w.Code)
		}
	}
	if s.state.Draft != example || s.state.Applied != example || s.core != nil {
		t.Fatal("configuration mode mutated runtime")
	}
}
