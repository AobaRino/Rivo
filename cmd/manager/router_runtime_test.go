package main

import (
	"os"
	"strings"
	"testing"
)

func TestRouterRuntimeFixedNetworkBoundary(t *testing.T) {
	b, e := os.ReadFile("../../configs/router-lan.yaml")
	if e != nil {
		t.Fatal(e)
	}
	source := string(b)
	if e = validateRouterRuntime(source); e != nil {
		t.Fatal(e)
	}
	cases := map[string]string{
		"controller":         source + "external-controller: 0.0.0.0:9090\n",
		"tun":                strings.Replace(source, "enable: false", "enable: true", 1),
		"dns port":           strings.Replace(source, "127.0.0.1:1053", "0.0.0.0:53", 1),
		"public mixed":       strings.Replace(source, "allow-lan: false", "allow-lan: true", 1),
		"listener override":  strings.Replace(source, "port: 17891", "port: 17891\n    proxy: DIRECT", 1),
		"provider escape":    strings.Replace(source, "./rules/cn-domain.mrs", "/etc/shadow", 1),
		"provider collision": strings.Replace(source, "./rules/cn-ip.mrs", "./rules/cn-domain.mrs", 1),
		"fake-ip":            strings.Replace(source, "enhanced-mode: redir-host", "enhanced-mode: fake-ip", 1),
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			if validateRouterRuntime(text) == nil {
				t.Fatal("accepted incompatible router configuration")
			}
		})
	}
}
