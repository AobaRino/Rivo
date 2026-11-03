package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func routerCommand(timeout time.Duration, command string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return exec.CommandContext(ctx, command, args...).Output()
}
func routerWebAddress() (string, int) {
	b, _ := routerCommand(2*time.Second, "/sbin/uci", "-q", "get", "network.lan.ipaddr")
	host := strings.Split(strings.TrimSpace(string(b)), "/")[0]
	b, _ = routerCommand(2*time.Second, "/sbin/uci", "-q", "get", "mihomo-manager.web.port")
	port, e := strconv.Atoi(strings.TrimSpace(string(b)))
	if e != nil {
		port = 18888
	}
	return host, port
}
func routerWebURLHost() string {
	b, _ := routerCommand(2*time.Second, "/sbin/uci", "-q", "get", "mihomo-manager.web.hostname")
	host := strings.TrimSpace(string(b))
	if len(host) > 253 {
		return ""
	}
	for _, c := range host {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
			return ""
		}
	}
	return host
}
func routerInit(name, action string) error {
	_, e := routerCommand(50*time.Second, "/etc/init.d/"+name, action)
	return e
}

// Boot policy is independent of the current process state. Changing it must
// never start/stop the Web service, core or network interception.
func routerSetAutostart(enabled bool, init func(string, string) error) error {
	action := "disable"
	if enabled {
		action = "enable"
	}
	return init("mihomo-manager-system", action)
}
func setRouterWebPort(port int) error {
	_, e := routerCommand(3*time.Second, "/sbin/uci", "set", fmt.Sprintf("mihomo-manager.web.port=%d", port))
	if e != nil {
		return e
	}
	_, e = routerCommand(3*time.Second, "/sbin/uci", "commit", "mihomo-manager")
	return e
}
func routerWebHealthy(host string, port int) bool {
	// Fixed local interface, never an address supplied by an HTTP client. This
	// probe also works with the application's generated self-signed certificate.
	c := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer c.CloseIdleConnections()
	r, e := c.Get("https://" + net.JoinHostPort(host, strconv.Itoa(port)) + "/api/auth/session")
	if e != nil {
		return false
	}
	defer r.Body.Close()
	var status map[string]any
	return r.StatusCode == 200 && json.NewDecoder(io.LimitReader(r.Body, 2048)).Decode(&status) == nil && status["authenticated"] == false
}
func routerWebRunning() bool {
	b, e := routerCommand(2*time.Second, "/bin/ubus", "call", "service", "list", `{"name":"mihomo-manager"}`)
	if e != nil {
		return false
	}
	var services map[string]struct {
		Instances map[string]struct {
			Running bool `json:"running"`
		} `json:"instances"`
	}
	return json.Unmarshal(b, &services) == nil && services["mihomo-manager"].Instances["manager"].Running
}
func routerControl() error {
	if os.Getuid() != 0 || len(os.Args) != 3 {
		return errors.New("无效的服务管理请求")
	}
	var req struct {
		Port    int   `json:"port"`
		Enabled *bool `json:"enabled"`
	}
	// rpcd may append ubus_rpc_session; it is ignored, never forwarded or logged.
	if e := json.NewDecoder(io.LimitReader(os.Stdin, 4096)).Decode(&req); e != nil {
		return e
	}
	host, port := routerWebAddress()
	result := map[string]any{}
	var operationErr error
	if os.Args[2] != "status" && os.Args[2] != "bootstrap" {
		if e := os.MkdirAll("/var/run/mihomo-manager-control", 0700); e != nil {
			return e
		}
		lock, e := acquireCoreLock("/var/run/mihomo-manager-control")
		if e != nil {
			return json.NewEncoder(os.Stdout).Encode(map[string]string{"error": "另一项服务操作正在进行"})
		}
		defer lock.Close()
	}
	switch os.Args[2] {
	case "status":
		var version map[string]any
		_, disabledErr := os.Stat("/etc/mihomo-manager.disabled")
		result = map[string]any{"enabled": os.IsNotExist(disabledErr), "autoStart": routerInit("mihomo-manager-system", "enabled") == nil, "web": routerWebHealthy(host, port), "core": routerCoreGet("/version", &version) == nil, "port": port, "host": host}
		result["urlHost"] = routerWebURLHost()
		_, e := os.Stat(routerRuntimeDir + "/network-enabled")
		result["network"] = e == nil
		_, e = os.Stat("/etc/mihomo-manager/auth/credentials.json")
		result["setupRequired"] = os.IsNotExist(e)
	case "bootstrap":
		if _, e := os.Stat("/etc/mihomo-manager/auth/credentials.json"); !os.IsNotExist(e) {
			break
		}
		b, e := os.ReadFile("/etc/mihomo-manager/auth/setup-token")
		if e != nil {
			operationErr = errors.New("请先启动 Web 服务")
		} else {
			result["token"] = strings.TrimSpace(string(b))
		}
	case "set_enabled":
		// Prevent a master start/stop from racing an apply worker. Core control
		// already holds the service-control lock acquired above.
		if _, e := os.Stat(routerRuntimeDir); e == nil {
			lock, e := acquireCoreLock(routerRuntimeDir)
			if e != nil {
				operationErr = errors.New("另一项内核操作正在进行，请稍后重试")
				break
			}
			defer lock.Close()
			if routerFileExists("apply-pending") || routerFileExists("control-pending") {
				operationErr = errors.New("上一项内核操作尚未完成，请稍后重试")
				break
			}
		}
		if req.Enabled == nil {
			operationErr = errors.New("缺少开关状态")
			break
		}
		if *req.Enabled {
			if e := os.Remove("/etc/mihomo-manager.disabled"); e != nil && !os.IsNotExist(e) {
				operationErr = e
				break
			}
			operationErr = routerInit("mihomo-manager-system", "start")
		} else {
			if e := atomicWriteFile("/etc/mihomo-manager.disabled", []byte("disabled\n"), 0600); e != nil {
				operationErr = e
				break
			}
			operationErr = routerInit("mihomo-manager-system", "stop")
			if e := routerInit("mihomo-manager-system", "disable"); operationErr == nil {
				operationErr = e
			}
		}
	case "set_autostart":
		if req.Enabled == nil {
			operationErr = errors.New("缺少开机启动设置")
			break
		}
		if *req.Enabled {
			if _, e := os.Stat("/etc/mihomo-manager.disabled"); !os.IsNotExist(e) {
				operationErr = errors.New("请先打开服务总开关，再启用开机启动")
				break
			}
		}
		operationErr = routerSetAutostart(*req.Enabled, routerInit)
	case "configure":
		if req.Port < 1024 || req.Port > 65535 {
			operationErr = errors.New("端口范围为 1024–65535")
			break
		}
		if req.Port == port {
			break
		}
		l, e := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(req.Port)))
		if e != nil {
			operationErr = errors.New("端口已被占用或无法监听")
			break
		}
		_ = l.Close()
		wasRunning := routerWebRunning() || routerWebHealthy(host, port)
		operationErr = setRouterWebPort(req.Port)
		if operationErr == nil && wasRunning {
			operationErr = routerInit("mihomo-manager", "restart")
			ready := false
			if operationErr == nil {
				for i := 0; i < 20; i++ {
					if routerWebHealthy(host, req.Port) {
						ready = true
						break
					}
					time.Sleep(250 * time.Millisecond)
				}
			}
			if !ready {
				_ = setRouterWebPort(port)
				_ = routerInit("mihomo-manager", "restart")
				operationErr = errors.New("新端口启动失败，已恢复原端口")
			}
		}
	default:
		operationErr = errors.New("不支持的服务操作")
	}
	if operationErr != nil {
		result["error"] = operationErr.Error()
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
