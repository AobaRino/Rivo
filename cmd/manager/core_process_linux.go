//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

// A crashed manager must not leave an orphan core owning the controller port.
func protectCoreProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
