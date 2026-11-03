//go:build linux

package main

import (
	"fmt"
	"os"
	"syscall"
)

func inheritSocketGroup(path string, info os.FileInfo) error {
	return os.Chown(path, 0, int(info.Sys().(*syscall.Stat_t).Gid))
}

func restrictRouterProcess() error {
	// no_new_privs is per-thread. A normal prctl call would only constrain the
	// goroutine's current OS thread. Router packages are built with CGO_ENABLED=0
	// so Go can apply this to all threads; future threads inherit the flag.
	const prSetNoNewPrivs = 38
	_, _, errno := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0)
	if errno != 0 {
		return fmt.Errorf("无法启用路由器进程 no_new_privs: %w", errno)
	}
	return nil
}
