package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProviderStatusReportsEmptyAndDoesNotExposeSecrets(t *testing.T) {
	config := []byte("proxy-providers:\n  ready: {type: http, url: 'https://example.com/?token=private'}\n  empty: {type: file}\n  absent: {type: inline}\n")
	data := []byte(`{"providers":{"ready":{"proxies":[{"name":"node","type":"Vless","password":"private","server":"private"}],"updatedAt":"2026-10-27T01:00:00Z"},"empty":{"proxies":[],"updatedAt":"0001-01-01T00:00:00Z"},"default":{"proxies":[{}]}}}`)
	rows, err := summarizeProviders(config, data)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[0].State != "missing" || rows[1].State != "empty" || rows[1].UpdatedAt != "" || rows[2].Nodes != 1 || rows[2].State != "loaded" {
		t.Fatal(rows)
	}
	if len(rows[2].Members) != 1 || rows[2].Members[0].Name != "node" || rows[2].Members[0].Type != "Vless" {
		t.Fatal("display members missing", rows[2].Members)
	}
	b, _ := json.Marshal(rows)
	if strings.Contains(string(b), "private") || strings.Contains(string(b), "example.com") {
		t.Fatal("credentials exposed")
	}
	if _, err = summarizeProviders(config, []byte(`{"unexpected":true}`)); err == nil {
		t.Fatal("invalid response accepted")
	}
}
