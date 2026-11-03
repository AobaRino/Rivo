package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func healthyRouterProbe() routerHealthCheck {
	return routerHealthCheck{
		pid: func(context.Context) (int, error) { return 20, nil },
		get: func(path string, v any) error {
			if path == "/version" {
				return json.Unmarshal([]byte(`{"version":"test"}`), v)
			}
			return json.Unmarshal([]byte(`{"Status":0,"Answer":[{"type":1,"data":"192.0.2.1"}]}`), v)
		},
		proxy: func(context.Context) error { return nil },
	}
}

func TestRouterHealthWaitsForNewProcess(t *testing.T) {
	h := healthyRouterProbe()
	called := false
	h.proxy = func(context.Context) error { called = true; return nil }
	if err := h.probe(context.Background(), 20); err == nil || called {
		t.Fatal("accepted the old process during asynchronous restart")
	}
	if err := h.probe(context.Background(), 10); err != nil || !called {
		t.Fatal(err)
	}
}

func TestRouterHealthRetriesTransientStartupFailure(t *testing.T) {
	h := healthyRouterProbe()
	calls := 0
	h.proxy = func(context.Context) error {
		calls++
		if calls < 3 {
			return errors.New("connection reset during startup")
		}
		return nil
	}
	ctx, done := context.WithTimeout(context.Background(), time.Second)
	defer done()
	if err := h.wait(ctx, 10, time.Millisecond); err != nil || calls != 3 {
		t.Fatalf("rolled back a transient startup failure: calls=%d err=%v", calls, err)
	}
}

func TestRouterHealthRejectsUnresolvedDNSAndUnstableProcess(t *testing.T) {
	h := healthyRouterProbe()
	h.get = func(path string, v any) error { return json.Unmarshal([]byte(`{"Status":2,"Answer":[]}`), v) }
	ctx, done := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer done()
	if err := h.wait(ctx, 10, time.Millisecond); err == nil || !strings.Contains(err.Error(), "DNS") {
		t.Fatalf("invalid DNS result was accepted: %v", err)
	}
	h = healthyRouterProbe()
	calls := 0
	h.pid = func(context.Context) (int, error) { calls++; return 20 + calls, nil }
	if err := h.probe(context.Background(), 10); err == nil {
		t.Fatal("accepted a process that restarted during the probe")
	}
}
