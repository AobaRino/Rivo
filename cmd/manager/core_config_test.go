package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagedConfigurationBoundaries(t *testing.T) {
	c := &CoreManager{controller: "127.0.0.1:19090", secret: "test-only-control-secret"}
	for _, raw := range []string{
		"mixed-port: 7890\n# keep comment\nx-future: true\n",
		"proxies: [{name: native, type: future-protocol}]\n",
		"proxy-providers: {demo: {type: http, path: providers/demo.yaml}}\n",
	} {
		if _, _, _, e := c.validateManagedConfiguration([]byte(raw)); e != nil {
			t.Fatal(raw, e)
		}
	}
	for _, raw := range []string{
		"tun: {enable: true}", "allow-lan: true", "tproxy-port: 7893", "listeners: [{type: mixed}]",
		"external-controller: 0.0.0.0:9090", "secret: changed", "external-controller-unix: /tmp/control",
		"dns: {enable: true, listen: '0.0.0.0:53'}", "mixed-port: 7890\nport: 7890",
		"proxy-providers: {demo: {path: /data/other.yaml}}", "rule-providers: {demo: {path: ../other.yaml}}",
		"proxy-providers: {demo: {path: './.manager-runtime.yaml'}}",
		"rule-providers: {demo: {path: 'providers/../cache.db'}}",
		"proxy-providers: {demo: {path: same.yaml}}\nrule-providers: {rules: {path: ./same.yaml}}",
	} {
		if _, _, _, e := c.validateManagedConfiguration([]byte(raw)); e == nil {
			t.Fatal("unsafe config accepted", raw)
		}
	}
}
func TestCommittedConfigurationIntegrity(t *testing.T) {
	c := &CoreManager{dir: t.TempDir()}
	v := &CoreConfiguration{ID: strings.Repeat("a", 32), Hash: revision("mode: direct\n")}
	if e := os.MkdirAll(c.configDir(v), 0700); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(c.configDir(v), "config.yaml")
	if e := os.WriteFile(path, []byte("mode: direct\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := c.configurationText(v); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(path, []byte("mode: rule\n"), 0600)
	if _, e := c.configurationText(v); e == nil {
		t.Fatal("modified committed config accepted")
	}
}
func TestCoreEnvironmentDoesNotInheritHooks(t *testing.T) {
	t.Setenv("CLASH_POST_UP", "must-not-run")
	t.Setenv("CLASH_CONFIG_STRING", "must-not-override")
	c := &CoreManager{controller: "127.0.0.1:19090", secret: "test-only-control-secret"}
	env := strings.Join(c.coreEnvironment(), "\n")
	if strings.Contains(env, "CLASH_POST_UP=") || strings.Contains(env, "CLASH_CONFIG_STRING=") {
		t.Fatal("inherited override")
	}
	if !strings.Contains(env, "CLASH_OVERRIDE_EXTERNAL_CONTROLLER=127.0.0.1:19090") {
		t.Fatal("missing managed controller")
	}
}

func TestStoppedCacheReplacesStaleSnapshot(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "cache.db"), []byte("final-state"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, "cache.db"), []byte("stale-copy"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := refreshStoppedCache(src, dst); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dst, "cache.db"))
	if err != nil || string(b) != "final-state" {
		t.Fatal("stale cache retained", err)
	}
	if err = os.Remove(filepath.Join(src, "cache.db")); err != nil {
		t.Fatal(err)
	}
	if err = refreshStoppedCache(src, dst); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(dst, "cache.db")); !os.IsNotExist(err) {
		t.Fatal("deleted cache was resurrected")
	}
}
