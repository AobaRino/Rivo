//go:build !linux

package main

import "os/exec"

func protectCoreProcess(cmd *exec.Cmd) {}
