package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestRuleProvidersPersistWithoutDownloads(t *testing.T) {
	var requests atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected resource download", 500)
	}))
	defer remote.Close()
	config := "mode: rule\nrule-providers:\n  Sites:\n    type: http\n    behavior: domain\n    format: yaml\n    url: " + remote.URL + "/rules.yaml\n    interval: 86400\n  Local: {type: file, behavior: ipcidr, format: mrs, path: ./rules/local.mrs}\n  Inline: {type: inline, behavior: domain, payload: ['+.example.com']}\nrules: ['RULE-SET,Sites,DIRECT', 'MATCH,DIRECT']\n"
	s := newTestServer(t)
	if w := call(s, "PUT", "/api/draft", textBody(t, config), revision(example)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if s.state.Applied != example {
		t.Fatal("saving a draft changed the applied configuration")
	}
	if w := call(s, "POST", "/api/validate", textBody(t, config), ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	reloaded, err := newServer(s.path, example)
	if err != nil || reloaded.state.Draft != config {
		t.Fatal("rule-provider YAML did not round-trip", err)
	}
	if requests.Load() != 0 {
		t.Fatal("manager downloaded a rule provider")
	}
}
