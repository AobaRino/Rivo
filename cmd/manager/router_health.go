package main

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"time"
)

func routerCoreProcess(ctx context.Context) (int, error) {
	ctx, done := context.WithTimeout(ctx, 2*time.Second)
	defer done()
	b, err := exec.CommandContext(ctx, "/bin/ubus", "call", "service", "list", `{"name":"mihomo-manager-core"}`).Output()
	if err != nil {
		return 0, err
	}
	var services map[string]struct {
		Instances map[string]struct {
			PID     int  `json:"pid"`
			Running bool `json:"running"`
		} `json:"instances"`
	}
	if err = json.Unmarshal(b, &services); err != nil {
		return 0, err
	}
	core := services["mihomo-manager-core"].Instances["core"]
	if !core.Running {
		return 0, nil
	}
	return core.PID, nil
}

func routerProxyProbe(ctx context.Context) error {
	ctx, done := context.WithTimeout(ctx, 5*time.Second)
	defer done()
	b, err := exec.CommandContext(ctx, "/usr/bin/curl", "-fsS", "--max-time", "4", "--proxy", "http://127.0.0.1:17890", "https://www.gstatic.com/generate_204", "-o", "/dev/null", "-w", "%{http_code}").Output()
	if err != nil || strings.TrimSpace(string(b)) != "204" {
		return errors.New("代理连通性检查未通过")
	}
	return nil
}

type routerHealthCheck struct {
	pid   func(context.Context) (int, error)
	get   func(string, any) error
	proxy func(context.Context) error
}

func (h routerHealthCheck) probe(ctx context.Context, previousPID int) error {
	pid, err := h.pid(ctx)
	if err != nil || pid == 0 || pid == previousPID {
		return errors.New("新内核进程尚未就绪")
	}
	var version map[string]any
	if h.get("/version", &version) != nil {
		return errors.New("新内核管理接口尚未就绪")
	}
	var dns struct {
		Status int               `json:"Status"`
		Answer []json.RawMessage `json:"Answer"`
	}
	if h.get("/dns/query?name=www.baidu.com&type=A", &dns) != nil || dns.Status != 0 || len(dns.Answer) == 0 {
		return errors.New("内核 DNS 检查未通过")
	}
	if h.proxy(ctx) != nil {
		return errors.New("代理连通性检查未通过")
	}
	if current, err := h.pid(ctx); err != nil || current != pid {
		return errors.New("内核进程在检查期间发生变化")
	}
	return nil
}

func (h routerHealthCheck) wait(ctx context.Context, previousPID int, interval time.Duration) error {
	for {
		err := h.probe(ctx, previousPID)
		if err == nil {
			return nil
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return err
		case <-timer.C:
		}
	}
}
