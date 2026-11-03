package main

import (
	"fmt"
	"github.com/AobaRino/Rivo/internal/dashboardbundle"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"go.yaml.in/yaml/v3"
)

// The official Zashboard frontend uses a small, explicitly local Clash API
// adapter. It shares the existing simulator; it never starts a core, downloads
// providers, opens a proxy listener or writes YAML from Dashboard operations.
const dashboardVersion = "v3.29.1"

type dashboardProxy struct {
	Name          string   `yaml:"name"`
	Type          string   `yaml:"type"`
	Proxies       []string `yaml:"proxies"`
	Use           []string `yaml:"use"`
	Filter        string   `yaml:"filter"`
	ExcludeFilter string   `yaml:"exclude-filter"`
	ExcludeType   string   `yaml:"exclude-type"`
}
type dashboardProvider struct {
	Type     string           `yaml:"type"`
	Behavior string           `yaml:"behavior"`
	Format   string           `yaml:"format"`
	Payload  []dashboardProxy `yaml:"payload"`
}
type dashboardConfig struct {
	Mode     string `yaml:"mode"`
	LogLevel string `yaml:"log-level"`
	Profile  struct {
		StoreSelected *bool `yaml:"store-selected"`
	} `yaml:"profile"`
	Proxies       []dashboardProxy             `yaml:"proxies"`
	Groups        []dashboardProxy             `yaml:"proxy-groups"`
	Providers     map[string]dashboardProvider `yaml:"proxy-providers"`
	RuleProviders map[string]dashboardProvider `yaml:"rule-providers"`
	Rules         []string                     `yaml:"rules"`
}

// Local-only inline providers make ordering observable without fetching any
// subscription or running a proxy. HTTP/file providers stay unloaded here.
func dashboardGroupMembers(c dashboardConfig, g dashboardProxy) []string {
	types := map[string]string{"DIRECT": "Direct", "REJECT": "Reject"}
	for _, p := range append(append([]dashboardProxy{}, c.Proxies...), c.Groups...) {
		types[p.Name] = dashboardProxyType(p.Type)
	}
	input := GroupOrderPreview{Filter: g.Filter, ExcludeFilter: g.ExcludeFilter, ExcludeType: g.ExcludeType}
	if len(g.Proxies) > 0 {
		source := MemberSource{Manual: true}
		for _, name := range g.Proxies {
			source.Nodes = append(source.Nodes, GroupMember{Name: name, Type: types[name]})
		}
		input.Sources = append(input.Sources, source)
	}
	for _, name := range g.Use {
		source := MemberSource{Name: name}
		p := c.Providers[name]
		if p.Type == "inline" {
			for _, node := range p.Payload {
				source.Nodes = append(source.Nodes, GroupMember{Name: node.Name, Type: dashboardProxyType(node.Type), Source: name})
			}
		}
		input.Sources = append(input.Sources, source)
	}
	nodes, err := previewGroupOrder(input)
	if err != nil {
		return []string{}
	}
	names := []string{}
	for _, node := range nodes {
		names = append(names, node.Name)
	}
	return names
}

func dashboardDir() string {
	return filepath.Join(".local", "zashboard", dashboardVersion, "dist")
}
func (s *Server) dashboardVersion() string {
	if s.dashboard != nil {
		return s.dashboard.current()
	}
	return dashboardVersion
}
func (s *Server) dashboardBundleDir(version string) string {
	root := filepath.Join(".local", "zashboard")
	if s.dashboard != nil {
		root = s.dashboard.dir
	}
	return filepath.Join(root, version, "dist")
}
func (s *Server) dashboardKey() string {
	return s.state.ProfileID + "." + revision(s.state.Applied)
}
func dashboardError(w http.ResponseWriter, code int, message string) {
	// Clash clients expect message (the manager API uses error).
	jsonResponse(w, code, map[string]string{"message": message})
}
func (s *Server) dashboardReady(w http.ResponseWriter, r *http.Request) bool {
	if s.routerOnly || s.core != nil {
		dashboardError(w, 404, "Zashboard 本地接口未在路由器或托管内核开放")
		return false
	}
	if key := r.PathValue("workspace"); key != "" && key != s.dashboardKey() {
		dashboardError(w, 409, "已应用配置发生变化，请从管理器首页重新打开 Zashboard")
		return false
	}
	if !s.runtime.Running {
		dashboardError(w, 503, "本地模拟器已停止，请从首页启动；未连接真实内核")
		return false
	}
	return true
}

func dashboardProxyType(t string) string {
	if v := map[string]string{"select": "Selector", "url-test": "URLTest", "fallback": "Fallback", "load-balance": "LoadBalance", "smart": "Smart", "ss": "Shadowsocks", "ssr": "ShadowsocksR", "vmess": "Vmess", "vless": "Vless", "trojan": "Trojan", "hysteria2": "Hysteria2", "hysteria": "Hysteria", "tuic": "Tuic", "wireguard": "WireGuard", "http": "Http", "socks5": "Socks5", "direct": "Direct", "reject": "Reject", "dns": "Dns", "anytls": "AnyTLS"}[t]; v != "" {
		return v
	}
	return t
}
func (s *Server) dashboardProxies(c dashboardConfig) map[string]map[string]any {
	proxies := map[string]map[string]any{}
	add := func(name, typ string) map[string]any {
		p := map[string]any{"name": name, "type": typ, "history": []any{}, "extra": map[string]any{}, "now": "", "icon": ""}
		proxies[name] = p
		return p
	}
	add("DIRECT", "Direct")
	add("REJECT", "Reject")
	all := []string{"DIRECT", "REJECT"}
	for _, p := range c.Proxies {
		add(p.Name, dashboardProxyType(p.Type))
	}
	for _, provider := range c.Providers {
		if provider.Type == "inline" {
			for _, p := range provider.Payload {
				add(p.Name, dashboardProxyType(p.Type))
			}
		}
	}
	for _, g := range c.Groups {
		p := add(g.Name, dashboardProxyType(g.Type))
		p["all"] = dashboardGroupMembers(c, g)
		p["now"] = s.runtime.Selected[g.Name]
		p["selectable"] = g.Type == "select"
		all = append(all, g.Name)
	}
	for _, p := range c.Proxies {
		all = append(all, p.Name)
	}
	global := add("GLOBAL", "Selector")
	global["all"], global["now"], global["selectable"] = all, s.runtime.Selected["GLOBAL"], true
	// Locally accepted YAML has not been validated by a real core. Avoid
	// handing a cyclic selection chain to the upstream UI's leaf traversal.
	for name, p := range proxies {
		seen := map[string]bool{name: true}
		for next := s.runtime.Selected[name]; next != ""; next = s.runtime.Selected[next] {
			if seen[next] {
				p["now"] = ""
				break
			}
			seen[next] = true
		}
	}
	return proxies
}

func (s *Server) dashboardRoutes(mux *http.ServeMux) {
	// Versioned URLs isolate service-worker caches. This new prefix is outside
	// the legacy /zashboard/ worker scope, including the first migration.
	mux.HandleFunc("GET /dashboard-ui/{version}/{file...}", func(w http.ResponseWriter, r *http.Request) {
		version := r.PathValue("version")
		if s.core != nil || !dashboardbundle.ValidVersion(version) {
			http.NotFound(w, r)
			return
		}
		dir := s.dashboardBundleDir(version)
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
			http.NotFound(w, r)
			return
		}
		prefix := "/dashboard-ui/" + version + "/"
		w.Header().Set("Service-Worker-Allowed", prefix)
		http.StripPrefix(prefix, http.FileServer(http.Dir(dir))).ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /zashboard/", func(w http.ResponseWriter, r *http.Request) {
		if s.core != nil {
			http.NotFound(w, r)
			return
		}
		dir := s.dashboardBundleDir(s.dashboardVersion())
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
			http.Error(w, "Zashboard 尚未准备好，请运行 npm run setup:zashboard 后重试。", 503)
			return
		}
		// Restrict service-worker scope to this vendor UI, never the manager.
		w.Header().Set("Service-Worker-Allowed", "/zashboard/")
		http.StripPrefix("/zashboard/", http.FileServer(http.Dir(dir))).ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /api/dashboard/open", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.dashboardReady(w, r) {
			return
		}
		host, port, err := net.SplitHostPort(r.Host)
		if err != nil {
			dashboardError(w, 400, "无效的本地地址")
			return
		}
		query := url.Values{"hostname": {host}, "port": {port}, "protocol": {"http"}, "secondaryPath": {"/api/dashboard/" + s.dashboardKey()}, "label": {"本地模拟 · " + s.state.ProfileName}, "disableUpgradeCore": {"1"}, "disableTunMode": {"1"}}
		// Official URL-based setup avoids writing Zashboard's private storage format.
		http.Redirect(w, r, "/dashboard-ui/"+s.dashboardVersion()+"/#/setup?"+query.Encode(), http.StatusFound)
	})
	mux.HandleFunc("/api/dashboard/{workspace}/{endpoint...}", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		if !s.dashboardReady(w, r) {
			s.mu.Unlock()
			return
		}
		endpoint := r.PathValue("endpoint")
		if r.Method == http.MethodGet && websocket.IsWebSocketUpgrade(r) && slices.Contains([]string{"connections", "traffic", "memory", "logs"}, endpoint) {
			s.mu.Unlock()
			s.dashboardStream(w, r, endpoint)
			return
		}
		defer s.mu.Unlock()
		unsupported := func() {
			dashboardError(w, 501, "本地模拟未连接 Mihomo；测速、下载、DNS、配置导入和内核操作尚不可用，请在管理器中编辑并预览配置。")
		}
		var cfg dashboardConfig
		if err := yaml.Unmarshal([]byte(s.state.Applied), &cfg); err != nil {
			dashboardError(w, 422, "已应用 YAML 无法读取")
			return
		}
		switch {
		case r.Method == "GET" && endpoint == "version":
			jsonResponse(w, 200, map[string]any{"version": "local-simulator (无真实内核)", "meta": true, "simulation": true})
		case r.Method == "GET" && endpoint == "configs":
			jsonResponse(w, 200, map[string]any{"mode": s.runtime.Mode, "log-level": s.runtime.LogLevel, "mode-list": []string{"rule", "global", "direct"}, "modes": []string{"rule", "global", "direct"}, "port": 0, "socks-port": 0, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0, "allow-lan": false, "bind-address": "127.0.0.1", "ipv6": false, "tun": map[string]any{"enable": false, "stack": ""}, "simulation": true})
		case r.Method == "PATCH" && endpoint == "configs":
			var patch map[string]any
			if !readJSON(w, r, &patch) {
				return
			}
			// Validate the entire patch before changing anything. No silent success
			// for TUN, listener ports or other unsupported settings.
			for key, value := range patch {
				v, ok := value.(string)
				if key != "mode" && key != "log-level" {
					unsupported()
					return
				}
				valid := key == "mode" && slices.Contains([]string{"rule", "global", "direct"}, v) || key == "log-level" && slices.Contains([]string{"debug", "info", "warning", "error", "silent"}, v)
				if !ok || !valid {
					dashboardError(w, 400, "不支持的模式或日志级别")
					return
				}
			}
			if mode, ok := patch["mode"].(string); ok {
				s.runtime.Mode = mode
				s.addLocalEvent("Zashboard 切换模式", "模拟模式："+mode+"，YAML 未修改。")
			}
			if level, ok := patch["log-level"].(string); ok {
				s.runtime.LogLevel = level
				s.addLocalEvent("Zashboard 调整日志级别", "模拟日志级别："+level)
			}
			w.WriteHeader(204)
		case r.Method == "GET" && endpoint == "proxies":
			jsonResponse(w, 200, map[string]any{"proxies": s.dashboardProxies(cfg)})
		case r.Method == "PUT" && strings.HasPrefix(endpoint, "proxies/"):
			var patch struct {
				Name string `json:"name"`
			}
			if !readJSON(w, r, &patch) {
				return
			}
			name := strings.TrimPrefix(endpoint, "proxies/")
			group := s.dashboardProxies(cfg)[name]
			if group == nil || group["selectable"] != true {
				dashboardError(w, 400, "当前代理组不支持手动选择")
				return
			}
			if !slices.Contains(group["all"].([]string), patch.Name) {
				dashboardError(w, 400, "节点不属于已应用的代理组")
				return
			}
			// Reject cycles: the upstream UI follows now pointers to the leaf.
			seen := map[string]bool{name: true}
			for target := patch.Name; target != ""; target = s.runtime.Selected[target] {
				if seen[target] {
					dashboardError(w, 400, "代理组引用会形成循环")
					return
				}
				seen[target] = true
			}
			s.runtime.Selected[name] = patch.Name
			s.addLocalEvent("Zashboard 切换节点", name+" → "+patch.Name+"，YAML 未修改。")
			w.WriteHeader(204)
		case r.Method == "GET" && endpoint == "providers/proxies":
			providers := map[string]any{}
			for name, p := range cfg.Providers {
				providers[name] = map[string]any{"name": name, "type": "Proxy", "vehicleType": strings.ToUpper(p.Type), "proxies": []any{}, "updatedAt": "0001-01-01T00:00:00Z", "testUrl": ""}
			}
			jsonResponse(w, 200, map[string]any{"providers": providers})
		case r.Method == "GET" && endpoint == "providers/rules":
			providers := map[string]any{}
			for name, p := range cfg.RuleProviders {
				providers[name] = map[string]any{"name": name, "type": "Rule", "behavior": p.Behavior, "format": p.Format, "vehicleType": strings.ToUpper(p.Type), "ruleCount": 0, "updatedAt": "0001-01-01T00:00:00Z"}
			}
			jsonResponse(w, 200, map[string]any{"providers": providers})
		case r.Method == "GET" && endpoint == "rules":
			rules := []map[string]any{}
			for i, rule := range cfg.Rules {
				parts := strings.Split(rule, ",")
				if len(parts) < 2 {
					continue
				}
				// Keep nested logical-rule payloads intact, stripping no-resolve.
				if parts[len(parts)-1] == "no-resolve" {
					parts = parts[:len(parts)-1]
				}
				if len(parts) < 2 {
					continue
				}
				rules = append(rules, map[string]any{"type": parts[0], "payload": strings.Join(parts[1:len(parts)-1], ","), "proxy": parts[len(parts)-1], "size": -1, "index": i})
			}
			jsonResponse(w, 200, map[string]any{"rules": rules})
		case r.Method == "GET" && endpoint == "connections":
			jsonResponse(w, 200, dashboardEmptyConnections())
		case r.Method == "GET" && endpoint == "storage/zashboard":
			jsonResponse(w, 200, map[string]any{})
		default:
			unsupported()
		}
	})
}

func dashboardEmptyConnections() map[string]any {
	return map[string]any{"connections": []any{}, "uploadTotal": 0, "downloadTotal": 0, "simulation": true}
}
func (s *Server) dashboardStream(w http.ResponseWriter, r *http.Request, endpoint string) {
	// The outer handler already enforces the local Host and exact Origin list.
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(1024)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	write := func(value any) bool {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteJSON(value) == nil
	}
	last := ""
	if endpoint == "logs" && !write(map[string]string{"type": "warning", "payload": "[本地模拟] 当前为官方 Zashboard + 本地模拟接口，未启动 Mihomo。流量/连接为空，内存未采集；以下为管理器操作记录，不是内核日志。"}) {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		s.mu.Lock()
		valid := !s.routerOnly && s.core == nil && s.runtime.Running && r.PathValue("workspace") == s.dashboardKey()
		events := append([]LocalEvent{}, s.events...)
		s.mu.Unlock()
		if !valid {
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseGoingAway, "模拟器已停止或配置已改变，请从首页重新打开"), time.Now().Add(time.Second))
			return
		}
		switch endpoint {
		case "connections":
			if !write(dashboardEmptyConnections()) {
				return
			}
		case "traffic":
			if !write(map[string]any{"up": 0, "down": 0, "simulation": true}) {
				return
			}
		case "memory":
			if !write(map[string]any{"inuse": nil, "oslimit": 0, "simulation": true}) {
				return
			}
		case "logs":
			for i := len(events) - 1; i >= 0; i-- {
				e := events[i]
				if e.At <= last {
					continue
				}
				last = e.At
				if slices.Contains([]string{"warning", "error", "silent"}, r.URL.Query().Get("level")) {
					continue
				}
				if !write(map[string]string{"type": "info", "payload": fmt.Sprintf("[本地模拟] %s %s：%s", e.At, e.Title, e.Detail)}) {
					return
				}
			}
		}
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
