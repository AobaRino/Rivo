package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/AobaRino/Rivo/internal/dashboardbundle"
)

const dashboardReleaseAPI = "https://api.github.com/repos/Zephyruso/zashboard/releases/"

type dashboardUpdateState struct {
	Current     string                   `json:"current"`
	Previous    string                   `json:"previous,omitempty"`
	Latest      *dashboardbundle.Release `json:"latest,omitempty"`
	AutoCheck   bool                     `json:"autoCheck"`
	LastChecked string                   `json:"lastChecked,omitempty"`
	LastAttempt string                   `json:"lastAttempt,omitempty"`
	CheckError  string                   `json:"checkError,omitempty"`
}

type DashboardManager struct {
	mu           sync.Mutex
	dir          string
	state        dashboardUpdateState
	operation    CoreOperation
	busy, closed bool
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	get          func(context.Context, string, int64) ([]byte, error)
}

func newDashboardManager(dir string, get func(context.Context, string, int64) ([]byte, error)) (*DashboardManager, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	d := &DashboardManager{dir: dir, get: get, state: dashboardUpdateState{Current: dashboardVersion, AutoCheck: true}}
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err == nil {
		if err = json.Unmarshal(b, &d.state); err != nil {
			return nil, fmt.Errorf("面板更新状态无效，未覆盖: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	for _, version := range []string{d.state.Current, d.state.Previous} {
		if version == "" {
			continue
		}
		if _, err = dashboardbundle.Read(dir, version); err != nil {
			return nil, fmt.Errorf("面板 %s 无法读取: %w", version, err)
		}
	}
	if d.state.Current == "" {
		return nil, errors.New("缺少当前面板版本")
	}
	if d.state.Latest != nil {
		if err = d.state.Latest.Validate(); err != nil {
			return nil, err
		}
	}
	d.ctx, d.cancel = context.WithCancel(context.Background())
	return d, nil
}

func (d *DashboardManager) Close() {
	d.mu.Lock()
	d.closed = true
	d.cancel()
	d.mu.Unlock()
	d.wg.Wait()
}
func (d *DashboardManager) persistLocked(next dashboardUpdateState) error {
	b, err := json.MarshalIndent(next, "", "  ")
	if err == nil {
		err = atomicWriteFile(filepath.Join(d.dir, "state.json"), b, 0600)
	}
	if err == nil {
		d.state = next
	}
	return err
}
func newerDashboard(a, b string) bool {
	if !dashboardbundle.ValidVersion(a) || !dashboardbundle.ValidVersion(b) {
		return false
	}
	x, y := strings.Split(a[1:], "."), strings.Split(b[1:], ".")
	for i := range x {
		xi, ex := strconv.ParseUint(x[i], 10, 64)
		yi, ey := strconv.ParseUint(y[i], 10, 64)
		if ex != nil || ey != nil {
			return false
		}
		if xi != yi {
			return xi > yi
		}
	}
	return false
}
func (d *DashboardManager) nextCheckLocked() time.Time {
	t, _ := time.Parse(time.RFC3339Nano, d.state.LastAttempt)
	delay := 24 * time.Hour
	if d.state.CheckError != "" {
		delay = time.Hour
	}
	return t.Add(delay)
}
func (d *DashboardManager) status() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := map[string]any{"enabled": true, "current": d.state.Current, "previous": d.state.Previous, "latest": d.state.Latest, "autoCheck": d.state.AutoCheck, "lastChecked": d.state.LastChecked, "checkError": d.state.CheckError, "busy": d.busy, "operation": d.operation, "updateAvailable": d.state.Latest != nil && newerDashboard(d.state.Latest.Version, d.state.Current)}
	if d.state.AutoCheck {
		out["nextCheck"] = d.nextCheckLocked().Format(time.RFC3339)
	}
	return out
}
func (d *DashboardManager) current() string { d.mu.Lock(); defer d.mu.Unlock(); return d.state.Current }

func (d *DashboardManager) release(ctx context.Context, suffix string) (dashboardbundle.Release, error) {
	var result dashboardbundle.Release
	b, err := d.get(ctx, dashboardReleaseAPI+suffix, 2<<20)
	if err != nil {
		return result, err
	}
	var release githubRelease
	if err = json.Unmarshal(b, &release); err != nil {
		return result, err
	}
	if release.Draft || release.Prerelease || !dashboardbundle.ValidVersion(release.Tag) {
		return result, errors.New("发布源未提供有效的稳定版面板")
	}
	for _, a := range release.Assets {
		if a.Name != "dist-no-fonts.zip" {
			continue
		}
		result = dashboardbundle.Release{Version: release.Tag, URL: a.URL, SHA256: strings.TrimPrefix(a.Digest, "sha256:"), Size: a.Size, Published: release.Published}
		if !strings.HasPrefix(a.Digest, "sha256:") || a.Size <= 0 {
			return result, errors.New("面板发布包缺少大小或 SHA-256")
		}
		return result, result.Validate()
	}
	return result, errors.New("此版本没有官方 dist-no-fonts.zip 发布包")
}

// startLocked holds the single operation slot across download and atomic switch.
func (d *DashboardManager) startLocked(kind, phase string, work func() error) error {
	if d.busy || d.closed {
		return errors.New("面板正在处理其他操作，请稍后重试")
	}
	d.busy = true
	d.operation = CoreOperation{Kind: kind, Phase: phase, Status: "running"}
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		err := work()
		d.mu.Lock()
		defer d.mu.Unlock()
		d.busy = false
		d.operation.Status, d.operation.Phase = "success", "完成"
		if err != nil {
			d.operation.Status, d.operation.Phase, d.operation.Error = "failed", "未完成", err.Error()
		}
	}()
	return nil
}
func (d *DashboardManager) check(automatic bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if automatic && (!d.state.AutoCheck || time.Now().Before(d.nextCheckLocked())) {
		return nil
	}
	return d.startLocked("check", "检查官方稳定版", func() error {
		r, err := d.release(d.ctx, "latest")
		d.mu.Lock()
		defer d.mu.Unlock()
		next := d.state
		next.LastAttempt = timestamp()
		if err != nil {
			next.CheckError = err.Error()
		} else {
			next.Latest, next.LastChecked, next.CheckError = &r, next.LastAttempt, ""
		}
		if e := d.persistLocked(next); e != nil {
			return e
		}
		return err
	})
}
func (d *DashboardManager) schedule() {
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			_ = d.check(true)
			select {
			case <-d.ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
func (d *DashboardManager) settings(auto bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.busy || d.closed {
		return errors.New("请等待当前面板操作完成")
	}
	next := d.state
	next.AutoCheck = auto
	return d.persistLocked(next)
}
func (d *DashboardManager) update(expected, target, digest string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.state.Current != expected || d.state.Latest == nil || d.state.Latest.Version != target || d.state.Latest.SHA256 != digest || !newerDashboard(target, expected) {
		return errors.New("面板版本信息已变化，请重新检查并确认")
	}
	return d.startLocked("update", "下载并校验面板", func() error {
		r, err := d.release(d.ctx, "tags/"+target)
		if err != nil {
			return err
		}
		if r.Version != target || r.SHA256 != digest {
			return errors.New("发布包已变化，请重新检查版本；当前面板未改变")
		}
		data, err := d.get(d.ctx, r.URL, dashboardbundle.MaxArchive)
		if err != nil {
			return err
		}
		if err = dashboardbundle.Install(d.dir, r, data); err != nil {
			return err
		}
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.closed {
			return errors.New("管理服务已关闭，未切换面板")
		}
		next := d.state
		next.Previous, next.Current = next.Current, target
		return d.persistLocked(next)
	})
}
func (d *DashboardManager) rollback(expected, target string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.state.Current != expected || target == "" || d.state.Previous != target {
		return errors.New("可回退的面板版本已变化，请刷新后确认")
	}
	return d.startLocked("rollback", "恢复上一版面板", func() error {
		if _, err := dashboardbundle.Read(d.dir, target); err != nil {
			return err
		}
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.closed {
			return errors.New("管理服务已关闭，未切换面板")
		}
		next := d.state
		next.Previous, next.Current = next.Current, target
		return d.persistLocked(next)
	})
}
func (s *Server) dashboardManagerRoutes(mux *http.ServeMux) {
	ready := func(w http.ResponseWriter) bool {
		if s.dashboard == nil || s.core != nil {
			failure(w, 409, "当前环境未开放 Dashboard 更新")
			return false
		}
		return true
	}
	mux.HandleFunc("GET /api/dashboard-manager", func(w http.ResponseWriter, r *http.Request) {
		if s.dashboard == nil || s.core != nil {
			jsonResponse(w, 200, map[string]any{"enabled": false, "reason": "Dashboard 更新目前仅接入本地环境"})
			return
		}
		jsonResponse(w, 200, s.dashboard.status())
	})
	mux.HandleFunc("POST /api/dashboard-manager/check", func(w http.ResponseWriter, r *http.Request) {
		if !ready(w) {
			return
		}
		var req struct{}
		if !readJSON(w, r, &req) {
			return
		}
		if err := s.dashboard.check(false); err != nil {
			failure(w, 409, err.Error())
			return
		}
		jsonResponse(w, 202, s.dashboard.status())
	})
	mux.HandleFunc("PUT /api/dashboard-manager/settings", func(w http.ResponseWriter, r *http.Request) {
		if !ready(w) {
			return
		}
		var req struct {
			AutoCheck *bool `json:"autoCheck"`
		}
		if !readJSON(w, r, &req) {
			return
		}
		if req.AutoCheck == nil {
			failure(w, 400, "缺少自动检查设置")
			return
		}
		if err := s.dashboard.settings(*req.AutoCheck); err != nil {
			failure(w, 409, err.Error())
			return
		}
		jsonResponse(w, 200, s.dashboard.status())
	})
	for _, action := range []string{"update", "rollback"} {
		mux.HandleFunc("POST /api/dashboard-manager/"+action, func(w http.ResponseWriter, r *http.Request) {
			if !ready(w) {
				return
			}
			var req struct {
				Expected string `json:"expected"`
				Target   string `json:"target"`
				Digest   string `json:"digest"`
			}
			if !readJSON(w, r, &req) {
				return
			}
			var err error
			if action == "update" {
				err = s.dashboard.update(req.Expected, req.Target, req.Digest)
			} else {
				err = s.dashboard.rollback(req.Expected, req.Target)
			}
			if err != nil {
				failure(w, 409, err.Error())
				return
			}
			jsonResponse(w, 202, s.dashboard.status())
		})
	}
}
