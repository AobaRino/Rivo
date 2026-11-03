package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const routerControlDir = "/var/run/mihomo-manager-control"

type routerCoreRequest struct {
	Action          string `json:"action"`
	ExpectedApplied string `json:"expectedApplied"`
}

func decodeRouterCoreRequest(r io.Reader) (routerCoreRequest, error) {
	var req routerCoreRequest
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	if d.Decode(&req) != nil || d.Decode(new(any)) != io.EOF ||
		(req.Action != "start" && req.Action != "stop" && req.Action != "restart") || req.ExpectedApplied == "" {
		return req, errors.New("无效的内核操作请求")
	}
	return req, nil
}

// Fixed operations only: callers never choose an executable, path or service.
// The same locks serialize apply, core control and the LuCI master switch.
func (t routerRuntimeTransport) controlCore(r *http.Request) *http.Response {
	fail := func(code int, message string) *http.Response {
		return routerJSONResponse(code, map[string]string{"error": message})
	}
	req, err := decodeRouterCoreRequest(r.Body)
	if err != nil {
		return fail(400, err.Error())
	}
	if err = os.MkdirAll(routerControlDir, 0700); err != nil {
		return fail(500, "无法准备内核操作")
	}
	control, err := acquireCoreLock(routerControlDir)
	if err != nil {
		return fail(409, "另一项服务操作正在进行")
	}
	defer func() {
		if control != nil {
			control.Close()
		}
	}()
	lock, err := acquireCoreLock(routerRuntimeDir)
	if err != nil {
		return fail(409, "另一项内核操作正在进行")
	}
	defer func() {
		if lock != nil {
			lock.Close()
		}
	}()
	for _, name := range []string{"apply-pending", "control-pending"} {
		if _, err := os.Stat(filepath.Join(routerRuntimeDir, name)); !os.IsNotExist(err) {
			return fail(409, "上一项内核操作尚未完成")
		}
	}
	if _, err := os.Stat("/etc/mihomo-manager.disabled"); !os.IsNotExist(err) {
		return fail(409, "请先在 LuCI 打开服务总开关")
	}
	active, err := os.ReadFile(routerRuntimeDir + "/active.yaml")
	if err != nil || revision(string(active)) != req.ExpectedApplied {
		return fail(409, "已应用配置发生变化，请刷新后重试")
	}
	pid, err := routerCoreProcess(context.Background())
	if err != nil {
		return fail(503, "无法确认内核进程状态")
	}
	if req.Action == "restart" && pid == 0 {
		return fail(409, "内核已停止，请使用启动内核")
	}
	sr, _ := http.NewRequest("GET", "http://localhost/api/state", nil)
	response, err := t.editor.RoundTrip(sr)
	if err != nil {
		return fail(503, "无法读取工作区")
	}
	defer response.Body.Close()
	var state map[string]any
	if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 80<<20)).Decode(&state) != nil {
		return fail(503, "无法读取工作区")
	}
	if routerFileExists("network-enabled") {
		if err = atomicWriteFile(routerRuntimeDir+"/network-wanted", []byte("wanted\n"), 0600); err != nil {
			return fail(500, "无法保存流量接管设置")
		}
	}
	if err = atomicWriteFile(routerRuntimeDir+"/control-pending", []byte(req.Action), 0600); err != nil {
		return fail(500, "无法记录内核操作")
	}
	kind := map[string]string{"start": "启动内核", "stop": "停止内核", "restart": "重启内核"}[req.Action]
	if err = writeRouterOperation(routerOperation{kind, "等待执行", "running", ""}); err != nil {
		_ = os.Remove(routerRuntimeDir + "/control-pending")
		return fail(500, "无法记录操作状态")
	}
	routerRuntimeSnapshot(state)
	jobControl, jobLock := control, lock
	control, lock = nil, nil // The job owns both locks, independent of HTTP cancellation.
	go func() {
		defer jobControl.Close()
		defer jobLock.Close()
		ops := newRouterCoreOps(kind, string(active))
		err := ops.run(req.Action, routerFileExists("network-wanted"), pid)
		finishRouterCoreControl(kind, err)
	}()
	return routerJSONResponse(http.StatusAccepted, state)
}

func routerFileExists(name string) bool {
	_, err := os.Stat(filepath.Join(routerRuntimeDir, name))
	return err == nil
}

type routerCoreOps struct {
	validate func() error
	suspend  func() error
	stop     func() error
	start    func() error
	health   func(int) error
	resume   func() error
	phase    func(string)
}

func (o routerCoreOps) run(action string, network bool, previousPID int) error {
	if action != "stop" {
		o.phase("校验已应用配置")
		if err := o.validate(); err != nil {
			return err
		} // Do not disrupt a working core on validation failure.
	}
	if action == "stop" || action == "restart" {
		o.phase("撤销流量接管并恢复 DNS")
		if err := o.suspend(); err != nil {
			return err
		} // Never stop a core still serving intercepted traffic.
		o.phase("停止内核")
		if err := o.stop(); err != nil {
			return err
		}
		if action == "stop" {
			return nil
		}
	} else {
		previousPID = 0 // An already-running start is idempotent; restart requires a new PID.
	}
	o.phase("启动内核并检查 DNS 和代理")
	err := o.start()
	if err == nil {
		err = o.health(previousPID)
	}
	if err == nil && network {
		o.phase("恢复流量接管")
		err = o.resume()
	}
	if err != nil {
		// Fail open: preserve the applied YAML and network preference, restore
		// direct networking, and keep the Web service available for correction.
		if cleanup := o.suspend(); cleanup != nil {
			return errors.Join(err, cleanup)
		}
		if cleanup := o.stop(); cleanup != nil {
			return errors.Join(err, cleanup)
		}
		return errors.New(err.Error() + "；已停止内核并恢复直连，已应用配置保持不变")
	}
	return nil
}

func newRouterCoreOps(kind, active string) routerCoreOps {
	return routerCoreOps{
		phase: func(phase string) { _ = writeRouterOperation(routerOperation{kind, phase, "running", ""}) },
		validate: func() error {
			if err := validateRouterRuntime(active); err != nil {
				return err
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			home := routerRuntimeDir + "/data/" + revision(active)
			if err := exec.CommandContext(ctx, "/usr/libexec/mihomo-manager-core", "-t", "-d", home, "-f", routerRuntimeDir+"/active.yaml").Run(); err != nil {
				return errors.New("已应用配置未通过 Mihomo 校验，未执行启停")
			}
			return nil
		},
		suspend: routerSuspendNetwork,
		stop: func() error {
			if err := routerService("stop"); err != nil {
				return errors.New("停止内核服务失败")
			}
			for i := 0; i < 30; i++ {
				if pid, err := routerCoreProcess(context.Background()); err == nil && pid == 0 {
					return nil
				}
				time.Sleep(200 * time.Millisecond)
			}
			return errors.New("内核进程尚未退出，请刷新状态")
		},
		start: func() error {
			if err := routerService("start"); err != nil {
				return errors.New("启动内核服务失败")
			}
			return nil
		},
		health: func(previousPID int) error {
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			return (routerHealthCheck{routerCoreProcess, routerCoreGet, routerProxyProbe}).wait(ctx, previousPID, time.Second)
		},
		resume: func() error {
			if routerFileExists("network-enabled") {
				return nil
			}
			for _, action := range []string{"prepare", "on", "commit"} {
				if _, err := routerCommand(30*time.Second, "/usr/libexec/mihomo-manager-network", action); err != nil {
					return errors.New("恢复流量接管失败（" + action + "）")
				}
			}
			return nil
		},
	}
}

func routerSuspendNetwork() error {
	// Stop the watchdog before removing rules, so it cannot put them back.
	if err := routerInit("mihomo-manager-network", "stop"); err != nil {
		return errors.New("停止流量接管服务失败，内核未停止")
	}
	if _, err := routerCommand(30*time.Second, "/usr/libexec/mihomo-manager-network", "off"); err != nil {
		return errors.New("恢复直连 DNS 失败，内核未停止")
	}
	return nil
}

func finishRouterCoreControl(kind string, err error) {
	op := routerOperation{kind, "已完成", "success", ""}
	if err != nil {
		op.Phase, op.Status, op.Error = "操作失败", "failed", err.Error()
	}
	_ = writeRouterOperation(op)
	_ = os.Remove(routerRuntimeDir + "/control-pending")
}

// A killed broker cannot finish its goroutine. On restart, recover the pending
// operation before accepting another one; never silently resume interception.
func recoverRouterCoreControl() {
	if !routerFileExists("control-pending") {
		return
	}
	for routerFileExists("control-pending") {
		if err := os.MkdirAll(routerControlDir, 0700); err != nil {
			return
		}
		control, err := acquireCoreLock(routerControlDir)
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		lock, err := acquireCoreLock(routerRuntimeDir)
		if err != nil {
			control.Close()
			time.Sleep(time.Second)
			continue
		}
		if routerFileExists("control-pending") {
			o := newRouterCoreOps("恢复中断操作", "")
			err = o.suspend()
			if err == nil {
				err = o.stop()
			}
			if err == nil {
				err = errors.New("上次内核操作被中断，已停止内核并恢复直连，请重新启动")
			}
			finishRouterCoreControl("恢复中断操作", err)
		}
		lock.Close()
		control.Close()
	}
}
