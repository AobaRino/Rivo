package main

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Authentication belongs to the application, not to a LuCI/rpcd session.
// The one-time setup token is available only to the machine administrator.
type webCredentials struct {
	Salt string `json:"salt"`
	Hash string `json:"hash"`
}
type loginAttempt struct {
	Count int
	Until time.Time
}
type webSession struct {
	expires    time.Time
	remembered bool
	ctx        context.Context
	cancel     context.CancelFunc
}
type webAuth struct {
	mu          sync.Mutex
	dir         string
	credentials webCredentials
	bootstrap   string
	sessions    map[[32]byte]webSession
	storeDirty  bool
	attempts    map[string]loginAttempt
	secure      bool
	now         func() time.Time
}

func randomToken() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func passwordHash(password, salt string) string {
	b, _ := pbkdf2.Key(sha256.New, password, []byte(salt), 600000, 32)
	return hex.EncodeToString(b)
}
func newWebAuth(dir string, secure bool) (*webAuth, error) {
	a := &webAuth{dir: dir, secure: secure, sessions: map[[32]byte]webSession{}, attempts: map[string]loginAttempt{}, now: time.Now}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(dir, "credentials.json"))
	if err == nil {
		if json.Unmarshal(b, &a.credentials) != nil || len(a.credentials.Salt) != 64 || len(a.credentials.Hash) != 64 {
			return nil, errors.New("Web 登录配置无效，未覆盖原文件")
		}
		// A crash after storing credentials must not leave a reusable setup token.
		_ = os.Remove(filepath.Join(dir, "setup-token"))
	} else if os.IsNotExist(err) {
		b, err = os.ReadFile(filepath.Join(dir, "setup-token"))
		if err == nil {
			a.bootstrap = strings.TrimSpace(string(b))
		} else if os.IsNotExist(err) {
			a.bootstrap = randomToken()
			err = atomicWriteFile(filepath.Join(dir, "setup-token"), []byte(a.bootstrap), 0600)
		}
		if err != nil {
			return nil, err
		}
		if len(a.bootstrap) != 64 {
			return nil, errors.New("初始化令牌无效")
		}
	} else {
		return nil, err
	}
	if err := a.loadSessions(); err != nil {
		// A damaged cache must not authorize anyone or prevent password login.
		// The next verified login must replace it successfully before a cookie is issued.
		a.storeDirty = true
		log.Printf("Rivo: 保持登录记录无法载入，已拒绝已保存会话；请重新登录以重建记录: %v", err)
	}
	return a, nil
}
func (a *webAuth) cookieName() string {
	if a.secure {
		return "__Host-mm-session"
	}
	return "mm-session"
}
func (a *webAuth) authenticated(r *http.Request) bool {
	c, err := r.Cookie(a.cookieName())
	if err != nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	key := sha256.Sum256([]byte(c.Value))
	session, ok := a.sessions[key]
	if !ok || !a.now().Before(session.expires) {
		if ok {
			session.cancel()
			a.storeDirty = a.storeDirty || session.remembered
		}
		delete(a.sessions, key)
		return false
	}
	return true
}
func webSameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		return err == nil && u.Scheme == scheme && u.Host == r.Host && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
	}
	return r.Method == "GET" || r.Method == "HEAD" || r.Header.Get("X-Mihomo-Request") == "1"
}

// LuCI may link from an IP address or HTTP origin to the HTTPS management host.
// Allow top-level navigation to public UI documents, never to the API. Opening
// the shell does not authenticate the visitor or permit cross-site API requests.
func webPageNavigation(r *http.Request) bool {
	return (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
		r.URL.Path != "/api" && !strings.HasPrefix(r.URL.Path, "/api/") &&
		r.Header.Get("Sec-Fetch-Mode") == "navigate" &&
		r.Header.Get("Sec-Fetch-Dest") == "document"
}

func (a *webAuth) handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		w.Header().Add("Vary", "Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if !webPageNavigation(r) && !webSameOrigin(r) {
			failure(w, 403, "不允许跨站请求")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/auth/") {
			a.route(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && !a.authenticated(r) {
			if r.URL.Path == "/api/dashboard/open" {
				http.Redirect(w, r, "/", http.StatusSeeOther)
				return
			}
			failure(w, 401, "登录已失效，请重新登录")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			cookie, _ := r.Cookie(a.cookieName())
			a.mu.Lock()
			session, ok := a.sessions[sha256.Sum256([]byte(cookie.Value))]
			a.mu.Unlock()
			if !ok {
				failure(w, 401, "登录已失效")
				return
			}
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			stop := context.AfterFunc(session.ctx, cancel)
			defer stop()
			r = r.WithContext(ctx)
		}
		next.ServeHTTP(w, r)
	})
}
func (a *webAuth) route(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == "GET" && r.URL.Path == "/api/auth/session" {
		a.mu.Lock()
		setup := a.credentials.Hash == ""
		a.mu.Unlock()
		jsonResponse(w, 200, map[string]any{"authenticated": a.authenticated(r), "setupRequired": setup})
		return
	}
	if r.Method != "POST" {
		failure(w, 405, "不支持的操作")
		return
	}
	if r.URL.Path == "/api/auth/logout" {
		a.mu.Lock()
		err := a.revokeSession(r)
		a.mu.Unlock()
		if err != nil {
			failure(w, 500, "退出登录未完成：无法保存会话撤销记录，请重试")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: a.cookieName(), Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode})
		jsonResponse(w, 200, map[string]bool{"authenticated": false})
		return
	}
	if r.URL.Path != "/api/auth/login" && r.URL.Path != "/api/auth/setup" {
		http.NotFound(w, r)
		return
	}
	var req struct {
		Password string `json:"password"`
		Token    string `json:"token,omitempty"`
		Remember bool   `json:"remember"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Password) > 1024 {
		failure(w, 400, "密码过长")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	now := a.now()
	for k, v := range a.attempts {
		if !now.Before(v.Until) {
			delete(a.attempts, k)
		}
	}
	attempt := a.attempts[ip]
	if attempt.Count >= 5 || len(a.attempts) > 4096 {
		w.Header().Set("Retry-After", "60")
		failure(w, 429, "尝试次数过多，请一分钟后重试")
		return
	}
	if attempt.Count == 0 {
		attempt.Until = now.Add(time.Minute)
	}
	attempt.Count++
	a.attempts[ip] = attempt
	if r.URL.Path == "/api/auth/setup" {
		if a.credentials.Hash != "" || a.bootstrap == "" || subtle.ConstantTimeCompare([]byte(req.Token), []byte(a.bootstrap)) != 1 {
			failure(w, 403, "初始化链接无效或已使用")
			return
		}
		if len(req.Password) < 12 {
			failure(w, 400, "请设置至少 12 个字符的密码")
			return
		}
		credentials := webCredentials{Salt: randomToken()}
		credentials.Hash = passwordHash(req.Password, credentials.Salt)
		b, _ := json.Marshal(credentials)
		if err := atomicWriteFile(filepath.Join(a.dir, "credentials.json"), b, 0600); err != nil {
			failure(w, 500, "登录设置保存失败")
			return
		}
		a.credentials = credentials
		a.bootstrap = ""
		_ = os.Remove(filepath.Join(a.dir, "setup-token"))
	} else {
		if a.credentials.Hash == "" || subtle.ConstantTimeCompare([]byte(passwordHash(req.Password, a.credentials.Salt)), []byte(a.credentials.Hash)) != 1 {
			failure(w, 401, "密码不正确")
			return
		}
	}
	delete(a.attempts, ip)
	if err := a.setSession(w, r, req.Remember); err != nil {
		failure(w, 500, "登录会话无法保存，请检查存储后重试")
		return
	}
	jsonResponse(w, 200, map[string]bool{"authenticated": true})
}
