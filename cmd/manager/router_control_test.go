package main

import (
	"errors"
	"testing"
)

func TestRouterAutostartOnlyChangesBootPolicy(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		calls := 0
		err := routerSetAutostart(enabled, func(name, action string) error {
			calls++
			want := "disable"
			if enabled {
				want = "enable"
			}
			if name != "mihomo-manager-system" || action != want {
				t.Fatalf("unexpected service mutation: %s %s", name, action)
			}
			return nil
		})
		if err != nil || calls != 1 {
			t.Fatal(err, calls)
		}
	}
	want := errors.New("read-only filesystem")
	if err := routerSetAutostart(true, func(string, string) error { return want }); !errors.Is(err, want) {
		t.Fatal("boot-policy failure was hidden", err)
	}
}
