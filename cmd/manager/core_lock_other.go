//go:build !linux

package main

import (
	"errors"
	"os"
)

func acquireCoreLock(string) (*os.File, error) {
	return nil, errors.New("托管内核仅支持 Linux")
}
