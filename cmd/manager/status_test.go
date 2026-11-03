package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPollingStatusDoesNotCarryWorkspaceSecretsOrHistory(t *testing.T) {
	s := newTestServer(t)
	s.state.Draft = "secret: private-workspace-secret\n"
	w := call(s, "GET", "/api/status", "", "")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["revision"] != revision(s.state.Draft) || strings.Contains(w.Body.String(), "private-workspace") {
		t.Fatal(out)
	}
	for _, key := range []string{"draft", "applied", "history"} {
		if _, ok := out[key]; ok {
			t.Fatal("large/sensitive field in poll", key)
		}
	}
}
