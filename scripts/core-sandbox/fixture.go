//go:build linux

// A controlled TLS mirror serving unchanged, independently verified official
// release packages. Only the isolated containers trust this test CA.
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		panic("mode required")
	}
	switch os.Args[1] {
	case "certs":
		certs(os.Args[2])
	case "serve":
		serve()
	case "relay":
		u, _ := url.Parse("http://127.0.0.1:18787")
		proxy := httputil.NewSingleHostReverseProxy(u)
		original := proxy.Director
		proxy.Director = func(r *http.Request) {
			original(r)
			r.Host = "127.0.0.1:18787"
			// Dedicated temporary browser-test port, not a production proxy.
			if r.Header.Get("Origin") == "http://127.0.0.1:18789" {
				r.Header.Set("Origin", "http://127.0.0.1:18787")
			}
		}
		mux := http.NewServeMux()
		mux.Handle("/api/", proxy)
		mux.Handle("/", http.FileServer(http.Dir("/fixtures/web")))
		must(http.ListenAndServe(":18788", mux))
	case "boot":
		must(os.MkdirAll("/data/work/configs", 0700))
		must(os.MkdirAll("/data/core", 0700))
		if _, e := os.Stat("/data/coreconfig.yaml"); os.IsNotExist(e) {
			b, e := os.ReadFile("/fixtures/coreconfig.yaml")
			must(e)
			must(os.WriteFile("/data/coreconfig.yaml", b, 0600))
		}
		b, e := os.ReadFile("/fixtures/workspace.yaml")
		must(e)
		must(os.WriteFile("/data/work/configs/example.yaml", b, 0600))
		must(os.Chdir("/data/work"))
		must(syscall.Exec("/manager", []string{"/manager"}, os.Environ()))
	case "request":
		request()
	case "hold-port":
		ln, e := net.Listen("tcp", "127.0.0.1:17899")
		must(e)
		defer ln.Close()
		for {
			conn, e := ln.Accept()
			must(e)
			conn.Close()
		}
	case "kill-candidate":
		id := os.Args[2]
		if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(id) {
			panic("invalid ID")
		}
		paths, e := filepath.Glob("/proc/[0-9]*/exe")
		must(e)
		for _, p := range paths {
			target, e := os.Readlink(p)
			if e == nil && target == "/data/core/releases/"+id+"/mihomo" {
				var pid int
				fmt.Sscanf(p, "/proc/%d/exe", &pid)
				must(syscall.Kill(pid, syscall.SIGKILL))
				fmt.Println("killed owned candidate")
				return
			}
		}
		panic("candidate not found")
	case "config":
		must(os.WriteFile("/data/coreconfig.yaml", []byte(os.Args[2]), 0600))
	case "corrupt-candidate":
		id := os.Args[2]
		if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(id) {
			panic("invalid ID")
		}
		f, e := os.OpenFile("/data/core/releases/"+id+"/mihomo", os.O_APPEND|os.O_WRONLY, 0)
		must(e)
		_, e = f.WriteString("corrupt")
		must(e)
		must(f.Close())
	case "read":
		b, e := os.ReadFile(os.Args[2])
		must(e)
		os.Stdout.Write(b)
	default:
		panic("unknown mode")
	}
}
func must(e error) {
	if e != nil {
		panic(e)
	}
}
func certs(dir string) {
	must(os.MkdirAll(dir, 0700))
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	must(e)
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	ca := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Rivo isolated test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(7 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, e := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	must(e)
	must(os.WriteFile(filepath.Join(dir, "ca.crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600))
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "sandbox release source"}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, DNSNames: []string{"api.github.com", "github.com", "registry.npmjs.org"}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	cert, e := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, key)
	must(e)
	must(os.WriteFile(filepath.Join(dir, "server.crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0600))
	must(os.WriteFile(filepath.Join(dir, "server.key"), pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0600))
}
func serve() {
	b, e := os.ReadFile("/fixtures/index.json")
	must(e)
	var index map[string]struct {
		File   string `json:"file"`
		Status int    `json:"status"`
	}
	must(json.Unmarshal(b, &index))
	var mu sync.Mutex
	fault := ""
	control := http.NewServeMux()
	control.HandleFunc("/fault", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == "POST" {
			b, _ := io.ReadAll(io.LimitReader(r.Body, 512))
			fault = string(b)
		}
		fmt.Fprint(w, fault)
	})
	control.HandleFunc("/origin", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "sandbox-core-origin") })
	control.HandleFunc("/subscription.yaml", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "proxies:\n  - name: SubscriptionDirect\n    type: direct\n")
	})
	go func() { must(http.ListenAndServe(":8080", control)) }()
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := "https://" + r.Host + r.URL.RequestURI()
		item, ok := index[key]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if item.Status != 200 {
			w.WriteHeader(item.Status)
			fmt.Fprint(w, "unavailable")
			return
		}
		data, e := os.ReadFile(filepath.Join("/fixtures", item.File))
		if e != nil {
			w.WriteHeader(500)
			return
		}
		mu.Lock()
		f := fault
		mu.Unlock()
		if f != "" && strings.Contains(key, f) {
			data = append([]byte("corrupt"), data...)
		}
		w.Write(data)
	})
	must(http.ListenAndServeTLS(":443", "/fixtures/server.crt", "/fixtures/server.key", h))
}
func request() {
	var q struct {
		URL, Method, Body, Proxy string
		Headers                  map[string]string
	}
	must(json.Unmarshal([]byte(os.Args[2]), &q))
	tr := &http.Transport{Proxy: nil}
	if q.Proxy != "" {
		u, e := url.Parse(q.Proxy)
		must(e)
		tr.Proxy = http.ProxyURL(u)
	}
	c := &http.Client{Transport: tr, Timeout: 15 * time.Second}
	r, e := http.NewRequest(q.Method, q.URL, bytes.NewBufferString(q.Body))
	must(e)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range q.Headers {
		r.Header.Set(k, v)
	}
	res, e := c.Do(r)
	must(e)
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	must(e)
	out := map[string]any{"status": res.StatusCode, "body": string(b)}
	_ = json.NewEncoder(os.Stdout).Encode(out)
}
