package main

import (
	"sync"
	"time"
)

// Only aggregate statistics leave the broker; connection metadata is discarded.
type coreConnections struct {
	DownloadTotal uint64     `json:"downloadTotal"`
	UploadTotal   uint64     `json:"uploadTotal"`
	Memory        *uint64    `json:"memory"`
	Connections   []struct{} `json:"connections"`
}

type coreMetrics struct {
	Available    bool     `json:"available"`
	SampledAt    string   `json:"sampledAt,omitempty"`
	DownloadRate *float64 `json:"downloadRate"`
	UploadRate   *float64 `json:"uploadRate"`
	Connections  int      `json:"connections"`
	Memory       *uint64  `json:"memory"`
	Error        string   `json:"error,omitempty"`
}

type routerMetricsCollector struct {
	mu         sync.Mutex
	get        func(string, any) error
	now        func() time.Time
	at         time.Time
	generation string
	previous   coreConnections
	cached     coreMetrics
}

var routerMetrics = routerMetricsCollector{get: routerCoreGet, now: time.Now}

func (c *routerMetricsCollector) snapshot(running bool, generation string) coreMetrics {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !running {
		c.at = time.Time{}
		c.cached = coreMetrics{Error: "内核未运行"}
		return c.cached
	}
	now := c.now()
	elapsed := now.Sub(c.at)
	if generation == c.generation && !c.at.IsZero() && elapsed >= 0 && elapsed < time.Second {
		return c.cached
	}
	var sample coreConnections
	err := c.get("/connections", &sample)
	result := coreMetrics{Error: "暂时无法读取内核统计"}
	if err == nil {
		result = coreMetrics{Available: true, SampledAt: now.UTC().Format(time.RFC3339Nano), Connections: len(sample.Connections), Memory: sample.Memory}
		// A restart, failed sample or long pause starts a fresh rate baseline.
		if c.cached.Available && generation == c.generation && elapsed >= time.Second && elapsed <= 10*time.Second && sample.DownloadTotal >= c.previous.DownloadTotal && sample.UploadTotal >= c.previous.UploadTotal {
			down := float64(sample.DownloadTotal-c.previous.DownloadTotal) / elapsed.Seconds()
			up := float64(sample.UploadTotal-c.previous.UploadTotal) / elapsed.Seconds()
			result.DownloadRate, result.UploadRate = &down, &up
		}
	}
	c.at, c.generation, c.previous, c.cached = now, generation, sample, result
	// Do not retain per-connection allocations between samples.
	c.previous.Connections = nil
	return result
}
