//go:build linux

package main

import "testing"

func TestCoreDirectoryHasSingleOwner(t *testing.T) {
	dir := t.TempDir()
	first, err := acquireCoreLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := acquireCoreLock(dir); err == nil {
		second.Close()
		t.Fatal("second owner acquired active core directory")
	}
	first.Close()
	third, err := acquireCoreLock(dir)
	if err != nil {
		t.Fatal("lock not released after close", err)
	}
	third.Close()
}
