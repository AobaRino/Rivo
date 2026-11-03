//go:build linux && !cgo

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRouterNoNewPrivilegesAllThreads(t *testing.T) {
	if os.Getenv("MIHOMO_TEST_NNP_CHILD") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestRouterNoNewPrivilegesAllThreads$")
		command.Env = append(os.Environ(), "MIHOMO_TEST_NNP_CHILD=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("no_new_privs subprocess: %v\n%s", err, output)
		}
		return
	}
	ready := make(chan struct{}, 4)
	release := make(chan struct{})
	defer close(release)
	for i := 0; i < 4; i++ {
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			ready <- struct{}{}
			<-release
		}()
	}
	for i := 0; i < 4; i++ {
		<-ready
	}
	if err := restrictRouterProcess(); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("/proc/self/task/*/status")
	if err != nil || len(files) < 4 {
		t.Fatalf("missing thread statuses: %v, count=%d", err, len(files))
	}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "NoNewPrivs:\t1\n") {
			t.Errorf("no_new_privs was not applied to %s", file)
		}
	}
}
