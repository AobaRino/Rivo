//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func acquireCoreLock(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, ".manager.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("该内核目录已由另一个管理服务使用")
	}
	// Keep the inode in place. Removing it would let a new process lock a
	// different file while the current owner still holds the original lock.
	return f, nil
}
