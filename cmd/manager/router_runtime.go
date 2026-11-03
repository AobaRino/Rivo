package main

// The local privileged broker accepts the standalone service through its Unix socket. Only
// its fixed transport can reach these operations; the editor daemon stays
// unprivileged and cannot execute service commands or modify active config.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

const routerRuntimeDir = "/etc/mihomo-manager-runtime"
const routerCoreSocket = "/var/run/mihomo-manager-core/control.sock"

func routerCoreGet(path string, target any) error {
	t := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", routerCoreSocket)
	}}
	defer t.CloseIdleConnections()
	c := &http.Client{Transport: t, Timeout: 2 * time.Second}
	r, e := c.Get("http://localhost" + path)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return errors.New("内核接口未就绪")
	}
	return json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(target)
}

type routerOperation struct {
	Kind   string `json:"kind"`
	Phase  string `json:"phase"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

func routerOperationStatus() routerOperation {
	b, e := os.ReadFile(routerRuntimeDir + "/operation.json")
	var op routerOperation
	if e == nil {
		_ = json.Unmarshal(b, &op)
	}
	if op.Status == "" {
		op = routerOperation{Kind: "应用配置", Phase: "已应用", Status: "success"}
	}
	return op
}
func writeRouterOperation(op routerOperation) error {
	b, _ := json.Marshal(op)
	return atomicWriteFile(routerRuntimeDir+"/operation.json", b, 0600)
}

func routerRuntimeSnapshot(out map[string]any) {
	b, e := os.ReadFile(routerRuntimeDir + "/active.yaml")
	if e != nil {
		return
	}
	var version map[string]any
	running := routerCoreGet("/version", &version) == nil
	processState := "running"
	if !running {
		pid, err := routerCoreProcess(context.Background())
		switch {
		case err != nil:
			processState = "unknown"
		case pid == 0:
			processState = "stopped"
		}
	}
	op := routerOperationStatus()
	out["simulation"] = false
	out["applied"] = string(b)
	out["appliedRevision"] = revision(string(b))
	if info, e := os.Stat(routerRuntimeDir + "/active.yaml"); e == nil {
		out["appliedAt"] = info.ModTime().UTC().Format(time.RFC3339)
	}
	out["core"] = map[string]any{"currentID": "router-procd-v1.19.33", "controlAvailable": true, "version": version["version"], "processState": processState, "apiReady": running, "running": running, "busy": op.Status == "running" || routerFileExists("control-pending"), "operation": op}
	rt := runtimeFrom(string(b))
	rt.Running = running
	rt.StartedAt = ""
	var live struct {
		Mode     string `json:"mode"`
		LogLevel string `json:"log-level"`
	}
	if running && routerCoreGet("/configs", &live) == nil {
		rt.Mode = live.Mode
		rt.LogLevel = live.LogLevel
	}
	var proxies struct {
		Proxies map[string]struct {
			Now string `json:"now"`
		} `json:"proxies"`
	}
	if running && routerCoreGet("/proxies", &proxies) == nil {
		// Provider-only groups do not have an explicit proxies list in YAML.
		for name, p := range proxies.Proxies {
			if p.Now != "" {
				rt.Selected[name] = p.Now
			}
		}
	}
	out["runtime"] = rt
	out["metrics"] = routerMetrics.snapshot(running, revision(string(b)))
	_, bootErr := os.Stat("/etc/rc.d/S94mihomo-manager-system")
	out["autoStart"] = bootErr == nil
	if _, e := os.Stat(routerRuntimeDir + "/network-enabled"); e == nil {
		out["networkEnabled"] = true
	} else {
		out["networkEnabled"] = false
	}
}

type routerRuntimeTransport struct{ editor http.RoundTripper }

func routerJSONResponse(status int, v any) *http.Response {
	b, _ := json.Marshal(v)
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(b))}
}
func (t routerRuntimeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if _, e := os.Stat(routerRuntimeDir + "/active.yaml"); e != nil {
		return t.editor.RoundTrip(r)
	}
	switch {
	case r.Method == "POST" && r.URL.Path == "/api/core/control":
		return t.controlCore(r), nil
	case r.Method == "POST" && r.URL.Path == "/api/apply":
		return t.apply(r), nil
	case r.Method == "GET" && r.URL.Path == "/api/core":
		var v map[string]any
		running := routerCoreGet("/version", &v) == nil
		return routerJSONResponse(200, map[string]any{"enabled": true, "running": running, "busy": routerOperationStatus().Status == "running", "platform": "OpenWrt procd / LAN IPv4", "current": map[string]string{"id": "router-procd-v1.19.33", "version": "v1.19.33", "schemaVersion": "1.19.32", "schemaWarning": "当前使用内置 Schema 1.19.32，配置应用时以真实内核校验为准。"}, "operation": routerOperationStatus()}), nil
	case r.Method == "GET" && r.URL.Path == "/api/core/providers":
		config, err := os.ReadFile(routerRuntimeDir + "/active.yaml")
		var live json.RawMessage
		if err != nil || routerCoreGet("/providers/proxies", &live) != nil {
			return routerJSONResponse(503, map[string]string{"error": "暂时无法读取内核订阅状态"}), nil
		}
		rows, err := summarizeProviders(config, live)
		if err != nil {
			return routerJSONResponse(503, map[string]string{"error": err.Error()}), nil
		}
		return routerJSONResponse(200, map[string]any{"providers": rows, "appliedRevision": revision(string(config))}), nil
	}
	response, e := t.editor.RoundTrip(r)
	if e != nil {
		return nil, e
	}
	if response.StatusCode == 200 && (r.URL.Path == "/api/state" || r.URL.Path == "/api/status" || r.URL.Path == "/api/draft") {
		defer response.Body.Close()
		var out map[string]any
		if e = json.NewDecoder(io.LimitReader(response.Body, 80<<20)).Decode(&out); e != nil {
			return nil, e
		}
		routerRuntimeSnapshot(out)
		if r.URL.Path == "/api/status" {
			delete(out, "applied")
		}
		return routerJSONResponse(200, out), nil
	}
	return response, nil
}

func validateRouterRuntime(text string) error {
	if issues := validate(text); len(issues) > 0 {
		return errors.New("配置静态检查未通过，请先修正 YAML")
	}
	var c map[string]any
	if e := yaml.Unmarshal([]byte(text), &c); e != nil {
		return e
	}
	for _, key := range []string{"external-controller", "external-controller-tls", "external-controller-unix", "external-controller-pipe", "external-ui", "external-ui-url", "external-ui-name", "secret", "iptables", "tunnels"} {
		if _, ok := c[key]; ok {
			return errors.New("路由器管理接口和外部脚本路径由服务管理，请移除 " + key)
		}
	}
	for _, key := range []string{"port", "socks-port", "redir-port", "tproxy-port"} {
		if n, ok := c[key]; ok && n != 0 {
			return errors.New("当前 LAN 接管只支持预设监听端口")
		}
	}
	if c["mixed-port"] != 17890 || c["allow-lan"] != false || c["bind-address"] != "127.0.0.1" || c["ipv6"] != false {
		return errors.New("请保留路由器预设的 mixed-port、allow-lan、bind-address 和 IPv4 设置")
	}
	if tun, ok := c["tun"].(map[string]any); ok && tun["enable"] != false {
		return errors.New("当前路由器使用 TPROXY，不能同时启用 TUN")
	}
	dns, ok := c["dns"].(map[string]any)
	if !ok || dns["enable"] != true || dns["listen"] != "127.0.0.1:1053" || dns["enhanced-mode"] != "redir-host" {
		return errors.New("请保留路由器 DNS 监听 127.0.0.1:1053 和 redir-host 模式")
	}
	listeners, ok := c["listeners"].([]any)
	if !ok || len(listeners) != 1 {
		return errors.New("必须保留唯一的 lan-tproxy 监听")
	}
	l, ok := listeners[0].(map[string]any)
	if !ok || l["type"] != "tproxy" || l["listen"] != "0.0.0.0" || l["port"] != 17891 || l["udp"] != true || len(l) != 5 || l["name"] != "lan-tproxy" {
		return errors.New("lan-tproxy 监听参数与网络服务不一致")
	}
	if e := validateProviderPaths([]byte(text)); e != nil {
		return e
	}
	return nil
}

func (t routerRuntimeTransport) apply(r *http.Request) *http.Response {
	fail := func(code int, msg string) *http.Response {
		return routerJSONResponse(code, map[string]string{"error": msg})
	}
	var req struct {
		Revision        string `json:"revision"`
		ExpectedCurrent string `json:"expectedCurrent"`
		ExpectedApplied string `json:"expectedApplied"`
	}
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(&req) != nil || d.Decode(new(any)) != io.EOF {
		return fail(400, "应用请求无效")
	}
	lock, e := acquireCoreLock(routerRuntimeDir)
	if e != nil {
		return fail(409, "另一项内核操作正在进行")
	}
	defer lock.Close()
	if routerFileExists("control-pending") {
		return fail(409, "上一项内核启停操作尚未完成")
	}
	if _, e = os.Stat(routerRuntimeDir + "/apply-pending"); e == nil {
		return fail(409, "上一项应用尚未完成")
	}
	if pid, err := routerCoreProcess(context.Background()); err != nil || pid == 0 {
		return fail(409, "内核未运行，请先启动内核再应用配置")
	}
	sr, _ := http.NewRequest("GET", "http://localhost/api/state", nil)
	response, e := t.editor.RoundTrip(sr)
	if e != nil {
		return fail(503, "无法读取已保存草稿")
	}
	defer response.Body.Close()
	var state map[string]any
	if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 80<<20)).Decode(&state) != nil {
		return fail(503, "无法读取已保存草稿")
	}
	text, ok := state["draft"].(string)
	active, e := os.ReadFile(routerRuntimeDir + "/active.yaml")
	if !ok || e != nil || req.Revision != revision(text) || req.ExpectedApplied != revision(string(active)) || req.ExpectedCurrent != "router-procd-v1.19.33" {
		return fail(409, "配置版本已变化，请重新预览")
	}
	if e = validateRouterRuntime(text); e != nil {
		return fail(422, e.Error())
	}
	if e = atomicWriteFile(routerRuntimeDir+"/candidate.yaml", []byte(text), 0600); e != nil {
		return fail(500, "无法暂存配置")
	}
	if e = atomicWriteFile(routerRuntimeDir+"/previous.yaml", active, 0600); e != nil {
		return fail(500, "无法备份已应用配置")
	}
	// The independent procd watchdog handles a killed apply worker or API crash.
	if e = atomicWriteFile(routerRuntimeDir+"/apply-pending", []byte(time.Now().Add(90*time.Second).Format(time.RFC3339)), 0600); e != nil {
		return fail(500, "无法准备回退")
	}
	if e = writeRouterOperation(routerOperation{"应用配置", "内核校验", "running", ""}); e != nil {
		return fail(500, "无法写入操作状态")
	}
	cmd := exec.Command("/etc/init.d/mihomo-manager-apply", "start")
	if e = cmd.Run(); e != nil {
		_ = os.Remove(routerRuntimeDir + "/apply-pending")
		_ = writeRouterOperation(routerOperation{"应用配置", "启动应用任务失败", "failed", "草稿已保留"})
		return fail(500, "无法启动应用任务")
	}
	routerRuntimeSnapshot(state)
	return routerJSONResponse(202, state)
}

func routerService(action string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "/etc/init.d/mihomo-manager-core", action).Run()
}
func routerApply() error {
	if os.Getuid() != 0 {
		return errors.New("应用任务需要特权服务")
	}
	var lock *os.File
	var e error
	for i := 0; i < 30; i++ {
		lock, e = acquireCoreLock(routerRuntimeDir)
		if e == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if e != nil {
		return e
	}
	defer lock.Close()
	if _, e = os.Stat(routerRuntimeDir + "/apply-pending"); e != nil {
		return e
	}
	text, e := os.ReadFile(routerRuntimeDir + "/candidate.yaml")
	if e != nil {
		return e
	}
	if e = validateRouterRuntime(string(text)); e != nil {
		routerApplyFailed("配置检查失败")
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	// Never return raw core output: it may include subscription URLs or node keys.
	home := routerRuntimeDir + "/data/" + revision(string(text))
	current, err := os.ReadFile(routerRuntimeDir + "/active.yaml")
	if err != nil {
		return err
	}
	currentHome := routerRuntimeDir + "/data/" + revision(string(current))
	if home != currentHome {
		if err = os.MkdirAll(home, 0700); err != nil {
			return err
		}
		// Resource updates from a candidate cannot mutate the old configuration's
		// provider caches. cp receives only fixed paths and SHA-256 directory names.
		if err = exec.Command("/bin/cp", "-a", currentHome+"/.", home+"/").Run(); err != nil {
			return err
		}
	}
	cmd := exec.CommandContext(ctx, "/usr/libexec/mihomo-manager-core", "-t", "-d", home, "-f", routerRuntimeDir+"/candidate.yaml")
	if e = cmd.Run(); e != nil {
		routerApplyFailed("Mihomo 校验失败，原配置保持不变")
		return nil
	}
	_ = writeRouterOperation(routerOperation{"应用配置", "重启内核并检查 DNS 和代理", "running", ""})
	previousPID, _ := routerCoreProcess(context.Background())
	if e = atomicWriteFile(routerRuntimeDir+"/active.yaml", text, 0600); e != nil {
		routerApplyFailed("写入失败")
		return e
	}
	if e = routerService("restart"); e != nil {
		return routerRecoverApply(fmt.Sprintf("内核服务重启失败（%v），已恢复上一份配置", e))
	}
	// procd restarts asynchronously. The old process may still answer requests;
	// a refused connection while the new one starts is not a failed configuration.
	checkCtx, done := context.WithTimeout(context.Background(), 25*time.Second)
	defer done()
	health := routerHealthCheck{pid: routerCoreProcess, get: routerCoreGet, proxy: routerProxyProbe}
	if e = health.wait(checkCtx, previousPID, time.Second); e != nil {
		return routerRecoverApply(e.Error() + "，已恢复上一份配置")
	}
	_ = writeRouterOperation(routerOperation{"应用配置", "已应用", "success", ""})
	_ = os.Remove(routerRuntimeDir + "/apply-pending")
	return nil
}
func routerApplyFailed(message string) {
	_ = writeRouterOperation(routerOperation{"应用配置", "应用失败", "failed", message})
	_ = os.Remove(routerRuntimeDir + "/apply-pending")
}
func routerRecoverApply(message string) error {
	b, e := os.ReadFile(routerRuntimeDir + "/previous.yaml")
	if e != nil {
		return e
	}
	if e = atomicWriteFile(routerRuntimeDir+"/active.yaml", b, 0600); e != nil {
		return e
	}
	if e = routerService("restart"); e != nil {
		return e
	}
	routerApplyFailed(message)
	return nil
}
func routerWatchApply() {
	b, e := os.ReadFile(routerRuntimeDir + "/apply-pending")
	if e != nil {
		return
	}
	deadline, e := time.Parse(time.RFC3339, strings.TrimSpace(string(b)))
	if e == nil && time.Now().Before(deadline) {
		return
	}
	// The worker's maximum run time is less than this deadline. If it hangs,
	// terminate that procd instance before restoring, preventing a late commit.
	_ = exec.Command("/etc/init.d/mihomo-manager-apply", "stop").Run()
	lock, e := acquireCoreLock(routerRuntimeDir)
	if e != nil {
		return
	}
	defer lock.Close()
	if _, e = os.Stat(routerRuntimeDir + "/apply-pending"); e == nil {
		_ = routerRecoverApply("应用超时，已自动恢复上一份配置")
	}
}

// Atomic helper shared by the fixed privileged operations, never caller paths.
func atomicWriteFile(path string, b []byte, mode os.FileMode) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".runtime-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(mode); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
