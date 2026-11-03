package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

const routerSocket = "/var/run/mihomo-manager/api.sock"

// A separate entry point deliberately cannot enable CoreManager through env.
// The public service and editor run without root privileges.
func serveRouter() error {
	if runtime.GOOS != "linux" || os.Getuid() == 0 {
		return errors.New("路由器服务必须以专用非 root 用户运行")
	}
	if err := restrictRouterProcess(); err != nil {
		return err
	}
	lock, err := acquireCoreLock(filepath.Dir(routerSocket))
	if err != nil {
		return err
	}
	defer lock.Close()
	seed, err := os.ReadFile("/usr/share/mihomo-manager/initial.yaml")
	if err != nil {
		return err
	}
	s, err := newServer("/etc/mihomo-manager/state.json", string(seed))
	if err != nil {
		return err
	}
	s.routerOnly = true
	if _, e := os.Stat("/etc/mihomo-manager/dashboard"); os.IsNotExist(e) {
		if e = os.CopyFS("/etc/mihomo-manager/dashboard", os.DirFS("/usr/share/mihomo-manager/dashboard")); e != nil {
			return e
		}
	}
	s.dashboard, err = newDashboardManager("/etc/mihomo-manager/dashboard", newCoreCatalog().get)
	if err != nil {
		return err
	}
	defer s.dashboard.Close()
	s.dashboard.schedule()
	web, err := routerWebServer(s)
	if err != nil {
		return err
	}
	webListener, err := net.Listen("tcp", web.Addr)
	if err != nil {
		return err
	}
	defer webListener.Close()
	if info, e := os.Lstat(routerSocket); e == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("API 路径已被其他文件占用")
		}
		if e = os.Remove(routerSocket); e != nil {
			return e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	listener, err := net.Listen("unix", routerSocket)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = os.Chmod(routerSocket, 0600); err != nil {
		return err
	}
	h := &http.Server{Handler: s.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.Shutdown(shutdown)
		_ = web.Shutdown(shutdown)
	}()
	go func() {
		if e := web.ServeTLS(webListener, "", ""); e != nil && !errors.Is(e, http.ErrServerClosed) {
			_ = h.Close()
		}
	}()
	err = h.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func routerAPIPermission(method, path string) string {
	if method == "GET" {
		switch path {
		case "/api/health", "/api/state", "/api/status", "/api/core", "/api/core/schema", "/api/core/providers":
			return "read"
		}
	}
	if method == "PUT" && path == "/api/draft" {
		return "write"
	}
	if method == "POST" && (path == "/api/validate" || path == "/api/group-order/preview") {
		return "read"
	}
	if method == "POST" && (path == "/api/apply" || path == "/api/core/control") {
		return "write"
	}
	return ""
}
