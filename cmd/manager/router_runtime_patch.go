package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// Runtime mode/log-level changes are temporary. No listener, DNS or TUN option
// may bypass the persistent configuration validation and rollback transaction.
func sanitizeRuntimePatch(w http.ResponseWriter, r *http.Request) bool {
	var req struct {
		Mode     string `json:"mode,omitempty"`
		LogLevel string `json:"log-level,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if !readJSON(w, r, &req) {
		return false
	}
	if req.Mode != "" && req.Mode != "rule" && req.Mode != "global" && req.Mode != "direct" {
		failure(w, 400, "无效的运行模式")
		return false
	}
	if req.LogLevel != "" {
		switch req.LogLevel {
		case "debug", "info", "warning", "error", "silent":
		default:
			failure(w, 400, "无效的日志等级")
			return false
		}
	}
	if req.Mode == "" && req.LogLevel == "" {
		failure(w, 400, "缺少运行选项")
		return false
	}
	b, _ := json.Marshal(req)
	r.Body = io.NopCloser(bytes.NewReader(b))
	r.ContentLength = int64(len(b))
	r.URL.RawQuery = ""
	return true
}
