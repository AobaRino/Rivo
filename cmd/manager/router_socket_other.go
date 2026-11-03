//go:build !linux

package main

import "os"

func inheritSocketGroup(path string, info os.FileInfo) error { return nil }
