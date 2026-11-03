package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNativeProviderAndManualNodeCoexist(t *testing.T) {
	var requests atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "manager must not download subscriptions", 500)
	}))
	defer remote.Close()
	config := "mode: rule\nproxies:\n  - {name: VPS, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: example}\nproxy-providers:\n  Airport:\n    type: http\n    url: " + remote.URL + "\n    interval: 3600\n    filter: HK\nproxy-groups:\n  - {name: G, type: select, proxies: [VPS, DIRECT], use: [Airport]}\nrules: ['MATCH,G']\n"
	s := newTestServer(t)
	if w := call(s, "PUT", "/api/draft", textBody(t, config), revision(example)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := call(s, "POST", "/api/apply", `{"revision":"`+revision(config)+`"}`, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	reloaded, err := newServer(s.path, example)
	if err != nil || reloaded.state.Draft != config || reloaded.state.Applied != config {
		t.Fatal("native provider or manual node was modified", err)
	}
	if requests.Load() != 0 {
		t.Fatal("manager downloaded subscription instead of deferring to Mihomo")
	}
}

func TestProviderReferences(t *testing.T) {
	good := "proxy-providers: {A: {type: http, url: 'https://example.com/sub', interval: 3600}}\nproxy-groups: [{name: G, type: select, proxies: [DIRECT], use: [A]}]\nrules: ['MATCH,G']\n"
	if issues := validate(good); len(issues) != 0 {
		t.Fatal(issues)
	}
	for _, bad := range []string{
		strings.Replace(good, "use: [A]", "use: [Missing]", 1),
		strings.Replace(good, "interval: 3600", "interval: -1", 1),
		strings.Replace(good, "https://example.com/sub", "file:///etc/passwd", 1),
		"proxy-groups: [{name: A, type: select, proxies: [B]}, {name: B, type: select, proxies: [A]}]",
	} {
		if len(validate(bad)) == 0 {
			t.Fatal("invalid provider or group references accepted")
		}
	}
}
