package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

const maxTextBytes = 2 << 20

type History struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	At   string `json:"at"`
	Text string `json:"text"`
}
type Runtime struct {
	Mode      string            `json:"mode"`
	LogLevel  string            `json:"logLevel"`
	Running   bool              `json:"running"`
	Selected  map[string]string `json:"selected"`
	StartedAt string            `json:"startedAt,omitempty"`
}
type State struct {
	Draft       string    `json:"draft"`
	Applied     string    `json:"applied"`
	SavedAt     string    `json:"savedAt"`
	AppliedAt   string    `json:"appliedAt"`
	History     []History `json:"history"`
	ProfileID   string    `json:"profileID,omitempty"`
	ProfileName string    `json:"profileName,omitempty"`
	// The open document lives in Draft/History. Only closed documents live here.
	Profiles  []LocalProfile `json:"profiles,omitempty"`
	AutoStart *bool          `json:"autoStart,omitempty"`
}
type Server struct {
	routerOnly bool
	core       *CoreManager
	dashboard  *DashboardManager
	mu         sync.Mutex
	state      State
	runtime    Runtime
	path       string
	events     []LocalEvent
}
type Diagnostic struct {
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

func revision(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func timestamp() string        { return time.Now().UTC().Format(time.RFC3339Nano) }
func newServer(path, seed string) (*Server, error) {
	s := &Server{path: path}
	b, err := os.ReadFile(path)
	if err == nil {
		if err = json.Unmarshal(b, &s.state); err != nil {
			return nil, fmt.Errorf("读取本地状态失败，未覆盖原文件: %w", err)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		now := timestamp()
		s.state = State{Draft: seed, Applied: seed, SavedAt: now, AppliedAt: now, History: []History{{ID: "initial", Kind: "initial", At: now, Text: seed}}}
		if err = s.persist(s.state); err != nil {
			return nil, err
		}
	} else {
		return nil, err
	}
	s.initializeLocalWorkspace()
	s.runtime = runtimeFrom(s.state.Applied)
	if s.state.AutoStart != nil && !*s.state.AutoStart {
		s.runtime.Running = false
		s.runtime.StartedAt = ""
	}
	return s, nil
}
func runtimeFrom(text string) Runtime {
	var c dashboardConfig
	_ = yaml.Unmarshal([]byte(text), &c)
	if c.Mode == "" {
		c.Mode = "rule"
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	r := Runtime{Mode: c.Mode, LogLevel: c.LogLevel, Running: true, Selected: map[string]string{}, StartedAt: timestamp()}
	for _, g := range c.Groups {
		if members := dashboardGroupMembers(c, g); len(members) > 0 {
			r.Selected[g.Name] = members[0]
		}
	}
	r.Selected["GLOBAL"] = "DIRECT"
	return r
}
func (s *Server) persist(st State) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".state-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, s.path)
}
func (s *Server) snapshot() map[string]any {
	out := map[string]any{"draft": s.state.Draft, "applied": s.state.Applied, "revision": revision(s.state.Draft), "savedAt": s.state.SavedAt, "appliedAt": s.state.AppliedAt, "runtime": s.runtime, "history": s.state.History, "simulation": true}
	if s.core != nil {
		s.core.workspaceSnapshot(out)
	} else if !s.routerOnly {
		s.localSnapshot(out)
	}
	return out
}
func jsonResponse(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
func failure(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]string{"error": message})
}
func readJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxTextBytes+65536)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		failure(w, 400, "请求格式错误或内容过大")
		return false
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		failure(w, 400, "请求必须只有一个 JSON 对象")
		return false
	}
	return true
}
func validText(w http.ResponseWriter, text string) bool {
	if len(text) > maxTextBytes || !utf8.ValidString(text) {
		failure(w, 400, "仅接受不超过 2 MB 的 UTF-8 配置")
		return false
	}
	return true
}
func validate(text string) []Diagnostic {
	result := []Diagnostic{}
	add := func(m string) { result = append(result, Diagnostic{"error", m}) }
	if strings.TrimSpace(text) == "" {
		add("配置不能为空")
		return result
	}
	var doc yaml.Node
	decoder := yaml.NewDecoder(strings.NewReader(text))
	if err := decoder.Decode(&doc); err != nil {
		add(err.Error())
		return result
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		add("配置只能包含一个 YAML 文档")
		return result
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		add("配置根节点必须是映射")
		return result
	}
	var data map[string]any
	if err := doc.Decode(&data); err != nil {
		add(err.Error())
		return result
	}
	if mode, ok := data["mode"]; ok && mode != "rule" && mode != "global" && mode != "direct" {
		add("mode 必须是 rule、global 或 direct")
	}
	if port, ok := data["mixed-port"]; ok {
		n, good := port.(int)
		if !good || n < 0 || n > 65535 {
			add("mixed-port 必须是 0–65535 的整数，0 表示关闭")
		}
	}
	for _, key := range []string{"allow-lan", "ipv6"} {
		if value, ok := data[key]; ok {
			if _, good := value.(bool); !good {
				add(key + " 在本地编辑原型中请使用 true 或 false")
			}
		}
	}
	names := map[string]bool{"DIRECT": true, "REJECT": true, "REJECT-DROP": true, "PASS": true, "COMPATIBLE": true, "GLOBAL": true}
	nodeNames := map[string]bool{}
	for _, section := range []string{"proxies", "proxy-groups"} {
		raw, exists := data[section]
		if !exists {
			continue
		}
		list, ok := raw.([]any)
		if !ok {
			add(section + " 必须是列表")
			continue
		}
		for _, item := range list {
			m, ok := item.(map[string]any)
			if !ok {
				add(section + " 中的项目必须是映射")
				continue
			}
			name, ok := m["name"].(string)
			if !ok || strings.TrimSpace(name) == "" {
				add(section + " 中存在空名称")
				continue
			}
			if names[name] {
				add("名称重复或占用保留名称：" + name)
			}
			names[name] = true
			nodeNames[name] = true
		}
	}
	if groups, ok := data["proxy-groups"].([]any); ok {
		for _, item := range groups {
			g, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if refs, ok := g["proxies"].([]any); ok {
				for _, ref := range refs {
					name, ok := ref.(string)
					if !ok || !names[name] {
						add(fmt.Sprintf("代理组 %v 引用了不存在的节点或组：%v", g["name"], ref))
					}
				}
			}
		}
	}
	result = append(result, validateReferences(data, names)...)
	if dns, ok := data["dns"].(map[string]any); ok {
		if value, exists := dns["enhanced-mode"]; exists && value != "normal" && value != "fake-ip" && value != "redir-host" {
			add("dns.enhanced-mode 必须是 normal、fake-ip 或 redir-host")
		}
	}
	result = append(result, validateProviders(data)...)
	return result
}
func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	s.dashboardRoutes(mux)
	s.dashboardManagerRoutes(mux)
	s.coreRoutes(mux)
	s.groupOrderRoutes(mux)
	s.localRoutes(mux)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]any{"ok": true, "simulation": s.core == nil})
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		jsonResponse(w, 200, s.snapshot())
	})
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		out := map[string]any{"revision": revision(s.state.Draft), "simulation": s.core == nil}
		if s.core == nil && !s.routerOnly {
			s.localSnapshot(out)
			out["runtime"] = s.runtime
			out["appliedRevision"] = revision(s.state.Applied)
		}
		if s.core != nil {
			status := s.core.status()
			id := ""
			if v, ok := status["current"].(*CoreBundle); ok && v != nil {
				id = v.ID
			}
			out["core"] = map[string]any{"currentID": id, "busy": status["busy"], "running": status["running"], "operation": status["operation"]}
			if v, ok := status["configuration"].(*CoreConfiguration); ok && v != nil {
				out["appliedRevision"] = v.Hash
			}
		}
		jsonResponse(w, 200, out)
	})
	mux.HandleFunc("POST /api/validate", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Text string `json:"text"`
		}
		if !readJSON(w, r, &req) || !validText(w, req.Text) {
			return
		}
		issues := validate(req.Text)
		jsonResponse(w, 200, map[string]any{"diagnostics": issues, "valid": len(issues) == 0, "engine": "local-static", "coreValidated": false})
	})
	mux.HandleFunc("PUT /api/draft", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Text string `json:"text"`
		}
		if !readJSON(w, r, &req) || !validText(w, req.Text) {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.matchWorkspace(w, r) {
			return
		}
		if r.Header.Get("If-Match") != revision(s.state.Draft) {
			failure(w, 409, "草稿已在其他页面保存。请先导出当前修改，再重新载入最新草稿。")
			return
		}
		if req.Text == s.state.Draft {
			jsonResponse(w, 200, s.snapshot())
			return
		}
		next := s.state
		next.Draft = req.Text
		next.SavedAt = timestamp()
		next.History = append([]History{{ID: revision(req.Text)[:12] + "-" + next.SavedAt, Kind: "save", At: next.SavedAt, Text: req.Text}}, s.state.History...)
		if len(next.History) > 30 {
			next.History = next.History[:30]
		}
		if err := s.persist(next); err != nil {
			failure(w, 500, "保存失败，原草稿未被覆盖")
			return
		}
		s.state = next
		s.addLocalEvent("保存配置草稿", "草稿已保存，运行配置未改变。")
		jsonResponse(w, 200, s.snapshot())
	})
	mux.HandleFunc("POST /api/apply", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Revision        string `json:"revision"`
			ExpectedCurrent string `json:"expectedCurrent"`
			ExpectedApplied string `json:"expectedApplied"`
		}
		if !readJSON(w, r, &req) {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.matchWorkspace(w, r) {
			return
		}
		if req.Revision != revision(s.state.Draft) {
			failure(w, 409, "草稿版本已变化，请重新载入后再应用")
			return
		}
		if s.core != nil {
			if len(req.ExpectedApplied) != 64 {
				failure(w, 409, "请重新预览已应用配置后确认")
				return
			}
			input := []byte(s.state.Draft)
			e := s.core.begin("应用配置", req.ExpectedCurrent, func() error { return s.core.applyConfiguration(input, req.ExpectedApplied) })
			if e != nil {
				failure(w, 409, e.Error())
				return
			}
			jsonResponse(w, 202, s.snapshot())
			return
		}
		if issues := validate(s.state.Draft); len(issues) > 0 {
			jsonResponse(w, 422, map[string]any{"error": "配置存在错误，模拟运行状态保持不变", "diagnostics": issues})
			return
		}
		next := s.state
		next.Applied = next.Draft
		next.AppliedAt = timestamp()
		next.History = append([]History{{ID: revision(next.Draft)[:12] + "-" + next.AppliedAt, Kind: "apply", At: next.AppliedAt, Text: next.Draft}}, s.state.History...)
		if len(next.History) > 30 {
			next.History = next.History[:30]
		}
		if err := s.persist(next); err != nil {
			failure(w, 500, "模拟应用保存失败")
			return
		}
		previous := s.runtime
		s.state = next
		s.runtime = runtimeFrom(next.Applied)
		s.addLocalEvent("模拟应用配置", "配置已模拟应用，运行模式按 YAML 初始化。")
		var c dashboardConfig
		_ = yaml.Unmarshal([]byte(next.Applied), &c)
		if c.Profile.StoreSelected == nil || *c.Profile.StoreSelected {
			for _, g := range c.Groups {
				for _, p := range dashboardGroupMembers(c, g) {
					if previous.Selected[g.Name] == p {
						s.runtime.Selected[g.Name] = p
					}
				}
			}
		}
		jsonResponse(w, 200, s.snapshot())
	})
	mux.HandleFunc("PATCH /api/runtime", func(w http.ResponseWriter, r *http.Request) {
		if s.core != nil {
			failure(w, 409, "真实内核的临时运行控制尚未接入，请通过配置应用修改")
			return
		}
		var req struct {
			Mode      *string `json:"mode"`
			LogLevel  *string `json:"logLevel"`
			Running   *bool   `json:"running"`
			Group     *string `json:"group"`
			Selection *string `json:"selection"`
			Restart   bool    `json:"restart"`
			AutoStart *bool   `json:"autoStart"`
		}
		if !readJSON(w, r, &req) {
			return
		}
		if req.Mode != nil && *req.Mode != "rule" && *req.Mode != "global" && *req.Mode != "direct" {
			failure(w, 400, "不支持的模式")
			return
		}
		if req.LogLevel != nil && !strings.Contains("|debug|info|warning|error|silent|", "|"+*req.LogLevel+"|") {
			failure(w, 400, "不支持的日志级别")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.matchWorkspace(w, r) {
			return
		}
		if !s.runtime.Running && (req.Mode != nil || req.Group != nil || req.LogLevel != nil) {
			failure(w, 409, "模拟器已停止，请先启动")
			return
		}
		if req.Restart && (!s.runtime.Running || req.Running != nil || req.Mode != nil || req.Group != nil) {
			failure(w, 409, "当前不能重启模拟器")
			return
		}
		if req.AutoStart != nil {
			if req.Mode != nil || req.Group != nil || req.Running != nil || req.LogLevel != nil || req.Restart {
				failure(w, 400, "开机启动设置请单独提交")
				return
			}
			next := s.state
			next.AutoStart = req.AutoStart
			if err := s.persist(next); err != nil {
				failure(w, 500, "设置保存失败")
				return
			}
			s.state = next
			s.addLocalEvent("更新模拟启动设置", "仅用于本地模拟器，不创建系统启动项。")
		}
		if req.Group != nil || req.Selection != nil {
			if req.Group == nil || req.Selection == nil {
				failure(w, 400, "缺少代理组或选择")
				return
			}
			var cfg dashboardConfig
			_ = yaml.Unmarshal([]byte(s.state.Applied), &cfg)
			found := false
			for _, g := range cfg.Groups {
				if g.Name == *req.Group && g.Type == "select" {
					for _, p := range dashboardGroupMembers(cfg, g) {
						if p == *req.Selection {
							found = true
						}
					}
				}
			}
			if *req.Group == "GLOBAL" {
				found = *req.Selection == "DIRECT" || *req.Selection == "REJECT"
				for _, g := range cfg.Groups {
					if g.Name == *req.Selection {
						found = true
					}
				}
				for _, p := range cfg.Proxies {
					if p.Name == *req.Selection {
						found = true
					}
				}
			}
			if !found {
				failure(w, 400, "节点不属于已应用的代理组")
				return
			}
			s.runtime.Selected[*req.Group] = *req.Selection
			s.addLocalEvent("切换模拟节点", *req.Group+" → "+*req.Selection)
		}
		if req.Running != nil {
			if *req.Running && !s.runtime.Running {
				s.runtime = runtimeFrom(s.state.Applied)
			}
			s.runtime.Running = *req.Running
			if !*req.Running {
				s.runtime.StartedAt = ""
			}
			s.addLocalEvent("模拟服务启停", map[bool]string{true: "模拟器已启动，未接管系统网络。", false: "模拟器已停止，系统网络未改变。"}[*req.Running])
		}
		if req.Restart {
			s.runtime = runtimeFrom(s.state.Applied)
			s.addLocalEvent("模拟重启", "按已应用 YAML 重新初始化，草稿保持不变。")
		}
		if req.Mode != nil {
			s.runtime.Mode = *req.Mode
			s.addLocalEvent("切换运行模式", "模拟模式："+*req.Mode+"，YAML 未修改。")
		}
		if req.LogLevel != nil {
			s.runtime.LogLevel = *req.LogLevel
		}
		jsonResponse(w, 200, s.snapshot())
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.routerOnly && (r.URL.Path == "/api/apply" || r.URL.Path == "/api/runtime" || (r.Method != "GET" && strings.HasPrefix(r.URL.Path, "/api/core"))) {
			failure(w, 409, "路由器首版仅管理配置，尚未开放内核启动与应用")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		host := r.Host
		if name, _, err := net.SplitHostPort(host); err == nil {
			host = name
		}
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			failure(w, 403, "仅接受本机地址请求")
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://127.0.0.1:5173" && origin != "http://localhost:5173" && origin != "http://127.0.0.1:18787" && origin != "http://localhost:18787" {
			failure(w, 403, "不允许的请求来源")
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func main() {
	if len(os.Args) > 1 {
		var err error
		switch os.Args[1] {
		case "router":
			err = serveRouter()
		case "router-broker":
			err = serveRouterBroker()
		case "router-control":
			err = routerControl()
		case "router-apply":
			err = routerApply()
		case "router-watch-apply":
			routerWatchApply()
		default:
			err = errors.New("未知命令")
		}
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	seed, err := os.ReadFile("configs/example.yaml")
	if err != nil {
		log.Fatal(err)
	}
	server, err := newServer(filepath.Join(".local", "state.json"), string(seed))
	if err != nil {
		log.Fatal(err)
	}
	if os.Getenv("MIHOMO_CORE_ENABLED") == "1" {
		server.core, err = newCoreManager(os.Getenv("MIHOMO_CORE_DIR"), os.Getenv("MIHOMO_CORE_CONFIG"), newCoreCatalog())
		if err != nil {
			log.Fatal(err)
		}
		defer server.core.Close()
	}
	if server.core == nil {
		server.dashboard, err = newDashboardManager(filepath.Join(".local", "zashboard"), newCoreCatalog().get)
		if err != nil {
			log.Fatal(err)
		}
		defer server.dashboard.Close()
		server.dashboard.schedule()
	}
	log.Print("Rivo API http://127.0.0.1:18787 · configuration workspace simulator; managed core enabled: ", server.core != nil)
	var handler http.Handler = server.handler()
	localMux := http.NewServeMux()
	localMux.HandleFunc("GET /api/auth/session", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]any{"authenticated": true, "development": true})
	})
	localMux.Handle("/", handler)
	handler = localMux
	if os.Getenv("MIHOMO_WEB_AUTH") == "1" {
		auth, e := newWebAuth(filepath.Join(".local", "auth"), false)
		if e != nil {
			log.Fatal(e)
		}
		handler = auth.handler(server.handler())
	}
	h := &http.Server{Addr: "127.0.0.1:18787", Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.Shutdown(shutdown)
	}()
	if err = h.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Print(err)
	}
}
