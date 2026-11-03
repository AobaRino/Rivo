package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.yaml.in/yaml/v3"
)

func dashboardCall(t *testing.T, s *Server, method, endpoint string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return workspaceCall(t, s, method, "/api/dashboard/"+s.dashboardKey()+"/"+endpoint, body, s.state.ProfileID)
}
func TestDashboardRuntimeSharesStateWithoutSavingYaml(t *testing.T) {
	s := newTestServer(t)
	before, _ := os.ReadFile(s.path)
	if w := dashboardCall(t, s, "PATCH", "configs", map[string]any{"mode": "global"}); w.Code != 204 || s.runtime.Mode != "global" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := dashboardCall(t, s, "PUT", "proxies/GLOBAL", map[string]string{"name": "REJECT"}); w.Code != 204 || s.runtime.Selected["GLOBAL"] != "REJECT" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := workspaceCall(t, s, "PATCH", "/api/runtime", map[string]string{"mode": "direct"}, s.state.ProfileID); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := dashboardCall(t, s, "GET", "configs", nil)
	if !strings.Contains(w.Body.String(), `"mode":"direct"`) {
		t.Fatal(w.Body.String())
	}
	after, _ := os.ReadFile(s.path)
	if string(before) != string(after) {
		t.Fatal("dashboard runtime operation persisted YAML")
	}
}
func TestDashboardRejectsUnsupportedActionsAtomically(t *testing.T) {
	s := newTestServer(t)
	for _, fields := range []map[string]any{{"mode": "global", "tun": map[string]bool{"enable": true}}, {"mode": "global", "mixed-port": 7890}, {"mode": "invalid"}} {
		w := dashboardCall(t, s, "PATCH", "configs", fields)
		if w.Code < 400 || s.runtime.Mode != "rule" {
			t.Fatal("partial or unsupported patch applied", w.Code)
		}
	}
	for _, action := range []struct{ method, path string }{{"POST", "upgrade"}, {"POST", "restart"}, {"PUT", "configs"}, {"PUT", "providers/proxies/test"}, {"GET", "proxies/DIRECT/delay"}, {"GET", "dns/query"}} {
		w := dashboardCall(t, s, action.method, action.path, nil)
		if w.Code != 501 || !strings.Contains(w.Body.String(), "message") {
			t.Fatal(action, w.Code, w.Body.String())
		}
	}
	w := dashboardCall(t, s, "PUT", "proxies/GLOBAL", map[string]string{"name": "missing"})
	if w.Code != 400 || s.runtime.Selected["GLOBAL"] != "DIRECT" {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestDashboardOldWindowAndProductionGuards(t *testing.T) {
	s := newTestServer(t)
	oldPath := "/api/dashboard/" + s.dashboardKey() + "/configs"
	s.state.ProfileID = "different" // Identical YAML still belongs to a different workspace.
	w := workspaceCall(t, s, "PATCH", oldPath, map[string]string{"mode": "global"}, "")
	if w.Code != 409 || s.runtime.Mode != "rule" {
		t.Fatal(w.Code, w.Body.String())
	}
	s.state.ProfileID = "default"
	s.state.Applied += "\n# new applied revision\n"
	w = workspaceCall(t, s, "PATCH", oldPath, map[string]string{"mode": "global"}, "")
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.runtime.Running = false
	if w = dashboardCall(t, s, "GET", "version", nil); w.Code != 503 {
		t.Fatal(w.Code)
	}
	s.runtime.Running = true
	s.routerOnly = true
	if w = dashboardCall(t, s, "GET", "version", nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
	s.routerOnly = false
	s.core = &CoreManager{}
	if w = dashboardCall(t, s, "PATCH", "configs", map[string]string{"mode": "global"}); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
func TestDashboardNeverExposesNodeSecretsOrInventsLatency(t *testing.T) {
	s := newTestServer(t)
	s.state.Applied = "mode: rule\nproxies:\n  - {name: private-node, type: trojan, password: PRIVATE_PASSWORD, server: PRIVATE_SERVER, port: 443}\nproxy-groups:\n  - {name: '中文/组', type: select, proxies: [private-node, DIRECT]}\nproxy-providers:\n  subscription: {type: http, url: 'https://private.invalid/?token=PRIVATE_TOKEN'}\nrules: [MATCH,DIRECT]\n"
	s.runtime = runtimeFrom(s.state.Applied)
	for _, endpoint := range []string{"proxies", "providers/proxies"} {
		w := dashboardCall(t, s, "GET", endpoint, nil)
		if w.Code != 200 || strings.Contains(w.Body.String(), "PRIVATE_") || strings.Contains(w.Body.String(), `"delay"`) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := dashboardCall(t, s, "PUT", "proxies/"+url.PathEscape("中文/组"), map[string]string{"name": "DIRECT"})
	if w.Code != 204 || s.runtime.Selected["中文/组"] != "DIRECT" {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestDashboardLaunchUsesOfficialSameOriginSetupAndOriginGuard(t *testing.T) {
	s := newTestServer(t)
	w := workspaceCall(t, s, "GET", "/api/dashboard/open", nil, "")
	location := w.Header().Get("Location")
	if w.Code != 302 || !strings.HasPrefix(location, "/dashboard-ui/"+dashboardVersion+"/#/setup?") {
		t.Fatal(w.Code, location)
	}
	query, err := url.ParseQuery(strings.SplitN(location, "?", 2)[1])
	if err != nil || query.Get("hostname") != "127.0.0.1" || query.Get("secondaryPath") != "/api/dashboard/"+s.dashboardKey() || query.Get("disableTunMode") != "1" {
		t.Fatal(query, err)
	}
	r := httptest.NewRequest("PATCH", "/api/dashboard/"+s.dashboardKey()+"/configs", strings.NewReader(`{"mode":"global"}`))
	r.Host = "127.0.0.1:18787"
	r.Header.Set("Origin", "https://untrusted.invalid")
	w = httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	if w.Code != 403 || s.runtime.Mode != "rule" {
		t.Fatal(w.Code)
	}
}
func TestDashboardWebSocketStopsOnProfileChange(t *testing.T) {
	s := newTestServer(t)
	server := httptest.NewServer(s.handler())
	defer server.Close()
	wsURL := strings.Replace(server.URL, "http://", "ws://", 1) + "/api/dashboard/" + s.dashboardKey() + "/connections"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": []string{"http://127.0.0.1:5173"}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(4 * time.Second))
	var message map[string]any
	if err = conn.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if message["simulation"] != true || message["downloadTotal"] != float64(0) || len(message["connections"].([]any)) != 0 {
		t.Fatal(message)
	}
	s.mu.Lock()
	s.state.ProfileID = "new-profile"
	s.mu.Unlock()
	_, _, err = conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseGoingAway) {
		t.Fatal("stale stream did not close", err)
	}
}
func TestDashboardLogsStreamContainsRealLocalEvents(t *testing.T) {
	s := newTestServer(t)
	s.addLocalEvent("测试操作", "YAML 未修改")
	server := httptest.NewServer(s.handler())
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1)+"/api/dashboard/"+s.dashboardKey()+"/logs", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for _, needle := range []string{"未启动 Mihomo", "测试操作"} {
		var message map[string]string
		if err = conn.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(message)
		if !strings.Contains(string(b), needle) {
			t.Fatal(string(b))
		}
	}
}

func TestDashboardCyclicUnvalidatedYamlCannotHangFrontend(t *testing.T) {
	s := newTestServer(t)
	s.state.Applied = "proxy-groups:\n  - {name: A, type: select, proxies: [B, DIRECT]}\n  - {name: B, type: select, proxies: [A, DIRECT]}\n"
	s.runtime = runtimeFrom(s.state.Applied)
	var cfg dashboardConfig
	if err := yaml.Unmarshal([]byte(s.state.Applied), &cfg); err != nil {
		t.Fatal(err)
	}
	proxies := s.dashboardProxies(cfg)
	if proxies["A"]["now"] != "" || proxies["B"]["now"] != "" {
		t.Fatal("cyclic pointers exposed")
	}
	w := dashboardCall(t, s, "PUT", "proxies/A", map[string]string{"name": "B"})
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
}
