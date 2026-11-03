//go:build !linux

package main

import "errors"

func restrictRouterProcess() error {
	return errors.New("路由器进程仅支持 Linux")
}
