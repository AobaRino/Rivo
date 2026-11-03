// Controlled HTTP origin and resource source for the isolated Docker tests.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

func main() {
	if extraCommand() {
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "boot" {
		if b, err := os.ReadFile("/fixtures/file.mrs"); err == nil {
			if err := os.WriteFile("/data/file.mrs", b, 0600); err != nil {
				panic(err)
			}
		}
		if err := syscall.Exec("/mihomo", append([]string{"/mihomo", "-d", "/data"}, os.Args[2:]...), os.Environ()); err != nil {
			panic(err)
		}
	}
	if len(os.Args) > 1 && os.Args[1] == "request" {
		var q struct {
			URL, Method, Body, Proxy string
			Headers                  map[string]string
		}
		if err := json.Unmarshal([]byte(os.Args[2]), &q); err != nil {
			panic(err)
		}
		tr := &http.Transport{DisableKeepAlives: true}
		if q.Proxy != "" {
			u, e := url.Parse(q.Proxy)
			if e != nil {
				panic(e)
			}
			tr.Proxy = http.ProxyURL(u)
		}
		c := &http.Client{Transport: tr, Timeout: 8 * time.Second}
		req, e := http.NewRequest(q.Method, q.URL, bytes.NewBufferString(q.Body))
		if e != nil {
			panic(e)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer sandbox-only-token")
		for key, value := range q.Headers {
			if key == "Host" {
				req.Host = value
			} else {
				req.Header.Set(key, value)
			}
		}
		r, e := c.Do(req)
		result := map[string]any{}
		if e != nil {
			result["error"] = e.Error()
		} else {
			defer r.Body.Close()
			b, e := io.ReadAll(io.LimitReader(r.Body, 2<<20))
			result["status"] = r.StatusCode
			result["body"] = string(b)
			if e != nil {
				result["error"] = e.Error()
			}
		}
		json.NewEncoder(os.Stdout).Encode(result)
		return
	}
	go udpOrigin()
	var mu sync.Mutex
	modes := map[string]string{"sub": "v1", "rules": "v1", "geo": "v1"}
	counts := map[string]int{}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		counts[r.URL.Path]++
		if r.URL.Path == "/control" {
			for k := range modes {
				if v := r.URL.Query().Get(k); v != "" {
					modes[k] = v
				}
			}
			json.NewEncoder(w).Encode(modes)
			return
		}
		if r.URL.Path == "/stats" {
			json.NewEncoder(w).Encode(map[string]any{"counts": counts, "modes": modes})
			return
		}
		if r.URL.Path == "/ok" {
			json.NewEncoder(w).Encode(map[string]string{"marker": "isolated-origin", "remote": r.RemoteAddr, "host": r.Host})
			return
		}
		if r.URL.Path == "/health" {
			w.WriteHeader(204)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		kind := ""
		if name == "sub.yaml" {
			kind = "sub"
			name = "sub-" + modes[kind] + ".yaml"
		}
		if name == "rules.yaml" {
			kind = "rules"
			name = "rules-" + modes[kind] + ".yaml"
		}
		if strings.HasSuffix(name, ".dat") {
			kind = "geo"
		}
		if kind != "" && modes[kind] == "offline" {
			http.Error(w, "controlled source outage", 503)
			return
		}
		if kind != "" && modes[kind] == "invalid" {
			fmt.Fprint(w, "[invalid resource:")
			return
		}
		if filepath.Base(name) != name {
			http.NotFound(w, r)
			return
		}
		b, e := os.ReadFile(filepath.Join("/fixtures", name))
		if e != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(b)
	})
	if err := http.ListenAndServe(":8080", nil); err != nil {
		panic(err)
	}
}
