package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const routerBrokerSocket = "/var/run/mihomo-manager-broker/api.sock"

func unixTransport(socket string) *http.Transport {
	return &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socket)
	}, ResponseHeaderTimeout: 25 * time.Second}
}
func unixProxy(socket string) *httputil.ReverseProxy {
	u, _ := url.Parse("http://localhost")
	p := httputil.NewSingleHostReverseProxy(u)
	p.Transport = unixTransport(socket)
	p.Director = func(r *http.Request) {
		r.URL.Scheme = "http"
		r.URL.Host = "localhost"
		r.Host = "localhost"
		r.Header.Del("Origin")
		r.Header.Del("Cookie")
		r.Header.Del("Authorization")
		r.Header.Del("Forwarded")
		r.Header.Del("X-Forwarded-For")
	}
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) { failure(w, 503, "管理服务暂时不可用") }
	return p
}

// Only this local, socket-bound process has permission to apply a validated
// configuration. It has no TCP listener and accepts no shell command or URL.
func serveRouterBroker() error {
	if os.Getuid() != 0 {
		return errors.New("运行适配服务需要系统权限")
	}
	lock, e := acquireCoreLock(filepath.Dir(routerBrokerSocket))
	if e != nil {
		return e
	}
	defer lock.Close()
	if info, e := os.Lstat(routerBrokerSocket); e == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("适配接口路径被占用")
		}
		if e = os.Remove(routerBrokerSocket); e != nil {
			return e
		}
	}
	l, e := net.Listen("unix", routerBrokerSocket)
	if e != nil {
		return e
	}
	defer l.Close()
	info, e := os.Stat(filepath.Dir(routerBrokerSocket))
	if e != nil {
		return e
	}
	if e = inheritSocketGroup(routerBrokerSocket, info); e != nil {
		return e
	}
	if e = os.Chmod(routerBrokerSocket, 0660); e != nil {
		return e
	}
	t := routerRuntimeTransport{editor: unixTransport(routerSocket)}
	go recoverRouterCoreControl()
	core := unixProxy("/var/run/mihomo-manager-core/control.sock")
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/dashboard/live/") {
			endpoint := strings.TrimPrefix(r.URL.Path, "/api/dashboard/live/")
			if !dashboardEndpointAllowed(r.Method, endpoint) {
				failure(w, 403, "此操作请使用管理器执行")
				return
			}
			if r.Method == "PATCH" && !sanitizeRuntimePatch(w, r) {
				return
			}
			r.URL.Path = "/" + endpoint
			r.URL.RawPath = ""
			core.ServeHTTP(w, r)
			return
		}
		if routerAPIPermission(r.Method, r.URL.Path) == "" || r.URL.RawQuery != "" || r.URL.RawPath != "" {
			failure(w, 404, "接口不存在")
			return
		}
		r.Host = "localhost"
		r.URL.Scheme = "http"
		r.URL.Host = "localhost"
		r.Body = http.MaxBytesReader(w, r.Body, maxTextBytes+65536)
		r.Header.Del("Origin")
		r.Header.Del("Cookie")
		r.Header.Del("Authorization")
		response, err := t.RoundTrip(r)
		if err != nil {
			failure(w, 503, "配置服务暂时不可用")
			return
		}
		defer response.Body.Close()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, io.LimitReader(response.Body, 80<<20))
	})
	return (&http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second}).Serve(l)
}

func spaHandler(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
		if !filepath.IsLocal(strings.TrimPrefix(r.URL.Path, "/")) && r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				// Vite's assets directory contains content-fingerprinted files.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				files.ServeHTTP(w, r)
				return
			}
		} else {
			if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/assets/") || filepath.Ext(path) != "" {
				http.NotFound(w, r)
				return
			}
			path = filepath.Join(dir, "index.html")
		}
		b, e := os.ReadFile(path)
		if e != nil {
			http.Error(w, "页面尚未构建", 503)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		// Reproducible APK builds reuse a fixed mtime even when content changes.
		// Do not use that timestamp to validate HTML or other stable resource URLs.
		http.ServeContent(w, r, filepath.Base(path), time.Time{}, bytes.NewReader(b))
	})
}

func ensureWebCertificate(dir, host string) error {
	cert, key := filepath.Join(dir, "web.crt"), filepath.Join(dir, "web.key")
	if _, e := tls.LoadX509KeyPair(cert, key); e == nil {
		return nil
	}
	if _, e := os.Stat(cert); e == nil {
		return errors.New("Web TLS 证书无效，未覆盖")
	}
	private, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		return e
	}
	serial, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if e != nil {
		return e
	}
	c := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Rivo"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(2, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{"localhost"}}
	if ip := net.ParseIP(host); ip != nil {
		c.IPAddresses = []net.IP{ip}
	} else {
		c.DNSNames = append(c.DNSNames, host)
	}
	der, e := x509.CreateCertificate(rand.Reader, c, c, &private.PublicKey, private)
	if e != nil {
		return e
	}
	if e = atomicWriteFile(key, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(private)}), 0600); e != nil {
		return e
	}
	return atomicWriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600)
}

func (s *Server) routerWebHandler(auth *webAuth, webDir string) http.Handler {
	broker := unixProxy(routerBrokerSocket)
	editor := s.handler()
	core := unixProxy(routerBrokerSocket)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/dashboard/live/{endpoint...}", func(w http.ResponseWriter, r *http.Request) {
		endpoint := r.PathValue("endpoint")
		if !dashboardEndpointAllowed(r.Method, endpoint) {
			failure(w, 403, "此操作请使用管理器执行")
			return
		}
		core.ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /api/dashboard/open", func(w http.ResponseWriter, r *http.Request) {
		host, port, e := net.SplitHostPort(r.Host)
		if e != nil {
			failure(w, 400, "无效地址")
			return
		}
		q := url.Values{"hostname": {host}, "port": {port}, "protocol": {"https"}, "secondaryPath": {"/api/dashboard/live"}, "label": {"Rivo"}, "disableUpgradeCore": {"1"}, "disableTunMode": {"1"}}
		http.Redirect(w, r, "/dashboard-ui/"+s.dashboardVersion()+"/#/setup?"+q.Encode(), 302)
	})
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.Clone(r.Context())
		r.Host = "localhost"
		r.Header.Del("Origin")
		editor.ServeHTTP(w, r)
	})
	mux.Handle("/api/dashboard-manager", local)
	mux.Handle("/api/dashboard-manager/", local)
	mux.Handle("/dashboard-ui/", local)
	mux.Handle("/zashboard/", local)
	mux.Handle("/api/", broker)
	mux.Handle("/", spaHandler(webDir))
	return auth.handler(mux)
}
func dashboardEndpointAllowed(method, path string) bool {
	if strings.Contains(path, "..") || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	root := strings.Split(path, "/")[0]
	if method == "GET" {
		switch root {
		case "version", "configs", "proxies", "providers", "rules", "connections", "traffic", "memory", "logs":
			return true
		}
	}
	if method == "PUT" && (strings.HasPrefix(path, "proxies/") || strings.HasPrefix(path, "providers/proxies/") || strings.HasPrefix(path, "providers/rules/")) {
		return true
	}
	if method == "DELETE" && (path == "connections" || strings.HasPrefix(path, "connections/")) {
		return true
	}
	if method == "PATCH" && path == "configs" {
		return true
	} // Validated again by the privileged broker.
	return false
}

func routerWebServer(s *Server) (*http.Server, error) {
	host := os.Getenv("MIHOMO_WEB_HOST")
	if net.ParseIP(host) == nil || net.ParseIP(host).IsUnspecified() {
		return nil, errors.New("Web 服务必须绑定明确的管理地址")
	}
	port, e := strconv.Atoi(os.Getenv("MIHOMO_WEB_PORT"))
	if e != nil || port < 1024 || port > 65535 {
		return nil, errors.New("Web 端口必须在 1024 到 65535 之间")
	}
	dir := "/etc/mihomo-manager"
	certDir := "/var/run/mihomo-manager-broker"
	certificate, certErr := tls.LoadX509KeyPair(filepath.Join(certDir, "web.crt"), filepath.Join(certDir, "web.key"))
	if certErr != nil {
		if e = ensureWebCertificate(dir, host); e != nil {
			return nil, e
		}
		certificate, e = tls.LoadX509KeyPair(filepath.Join(dir, "web.crt"), filepath.Join(dir, "web.key"))
		if e != nil {
			return nil, e
		}
	}
	auth, e := newWebAuth(filepath.Join(dir, "auth"), true)
	if e != nil {
		return nil, e
	}
	return &http.Server{Addr: net.JoinHostPort(host, strconv.Itoa(port)), Handler: s.routerWebHandler(auth, "/usr/share/mihomo-manager/web"), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}}, nil
}
