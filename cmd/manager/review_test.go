package main

import (
	"net/http/httptest"
	"testing"
)

func TestReviewRuleGrammar(t *testing.T) {
	good := "proxies: [{name: src-node, type: direct}]\nrules: ['IP-CIDR,10.0.0.0/8,src-node,src,no-resolve', 'DOMAIN-REGEX,^a{1,3},src-node', 'MATCH,src-node', 'SUB-RULE,(NETWORK,TCP),branch']\nsub-rules: {branch: ['MATCH,src-node']}\n"
	if issues := validate(good); len(issues) != 0 {
		t.Fatal(issues)
	}
	for _, bad := range []string{
		"proxies: [{name: a, type: direct, dialer-proxy: missing}]",
		"proxies: [{name: a, type: direct, dialer-proxy: g}]\nproxy-groups: [{name: g, type: select, proxies: [a]}]",
		"rule-providers: {a: {type: inline, behavior: classical, format: mrs, payload: []}}",
		"rules: ['AND,((RULE-SET,missing),(NETWORK,TCP)),DIRECT']",
		"sub-rules: {a: ['SUB-RULE,(NETWORK,TCP),a']}",
		"sub-rules: {a: ['MATCH,missing']}",
	} {
		if len(validate(bad)) == 0 {
			t.Fatal("invalid configuration accepted", bad)
		}
	}
}

func TestRejectsRebindingReads(t *testing.T) {
	s := newTestServer(t)
	for _, host := range []string{"attacker.example:18787", "127.0.0.1.attacker.example:18787"} {
		r := httptest.NewRequest("GET", "/api/state", nil)
		r.Host = host
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("state exposed for untrusted Host", w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/api/state", nil)
	r.Host = "127.0.0.1:18787"
	r.Header.Set("Origin", "https://attacker.example")
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestReviewRejectedApplyPreservesState(t *testing.T) {
	s := newTestServer(t)
	bad := "rules: ['RULE-SET,missing,DIRECT']\n"
	if w := call(s, "PUT", "/api/draft", textBody(t, bad), revision(example)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := call(s, "POST", "/api/apply", `{"revision":"`+revision(bad)+`"}`, ""); w.Code != 422 {
		t.Fatal(w.Body.String())
	}
	if s.state.Applied != example || s.runtime.Mode != "rule" {
		t.Fatal("rejected apply changed state")
	}
}
