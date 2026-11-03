package main

import (
	"errors"
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"
)

func TestRouterMetricsSampling(t *testing.T) {
	now := time.Unix(1000, 0)
	memory := uint64(1024)
	sample := coreConnections{DownloadTotal: 100, UploadTotal: 200, Memory: &memory, Connections: make([]struct{}, 3)}
	calls, failed := 0, false
	c := routerMetricsCollector{now: func() time.Time { return now }, get: func(path string, target any) error {
		calls++
		if path != "/connections" {
			t.Fatalf("unexpected route: %s", path)
		}
		if failed {
			return errors.New("private internal error")
		}
		*target.(*coreConnections) = sample
		return nil
	}}
	first := c.snapshot(true, "a")
	if !first.Available || first.Connections != 3 || *first.Memory != 1024 || first.DownloadRate != nil {
		t.Fatalf("first sample: %+v", first)
	}
	now = now.Add(500 * time.Millisecond)
	if cached := c.snapshot(true, "a"); calls != 1 || cached.SampledAt != first.SampledAt {
		t.Fatal("state/status bypassed shared cache")
	}
	now = now.Add(1500 * time.Millisecond)
	sample.DownloadTotal += 4096
	sample.UploadTotal += 2048
	next := c.snapshot(true, "a")
	if next.DownloadRate == nil || *next.DownloadRate != 2048 || *next.UploadRate != 1024 {
		t.Fatalf("rates: %+v", next)
	}
	now = now.Add(2 * time.Second)
	sample.DownloadTotal, sample.UploadTotal = 1, 1
	if c.snapshot(true, "a").DownloadRate != nil {
		t.Fatal("core restart produced a false rate")
	}
	now = now.Add(2 * time.Second)
	idle := c.snapshot(true, "a")
	if idle.DownloadRate == nil || *idle.DownloadRate != 0 {
		t.Fatal("idle traffic should be a real zero")
	}
	now = now.Add(2 * time.Second)
	failed = true
	broken := c.snapshot(true, "a")
	if broken.Available || broken.Memory != nil || broken.Error != "暂时无法读取内核统计" {
		t.Fatal("stale data or private error leaked")
	}
	failed = false
	now = now.Add(2 * time.Second)
	if c.snapshot(true, "a").DownloadRate != nil {
		t.Fatal("failed sample was used as a baseline")
	}
	if c.snapshot(true, "b").DownloadRate != nil {
		t.Fatal("new config reused old baseline")
	}
	now = now.Add(time.Minute)
	if c.snapshot(true, "b").DownloadRate != nil {
		t.Fatal("long pause produced a misleading rate")
	}
	if c.snapshot(false, "b").Available {
		t.Fatal("stopped core retained statistics")
	}
	if c.snapshot(true, "b").DownloadRate != nil {
		t.Fatal("stopped core reused old baseline")
	}
}

func TestRouterBrokerCanLaunchProcdJobs(t *testing.T) {
	// OpenWrt's procd_lock uses fd 1000. Both inherited limits must allow it,
	// including the hard limit that exec children cannot raise for themselves.
	b, err := os.ReadFile("../../packaging/openwrt/mihomo-manager/files/mihomo-manager.init")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?s)procd_open_instance broker.*?nofile="(\d+) (\d+)".*?procd_close_instance`).FindSubmatch(b)
	if len(match) != 3 {
		t.Fatal("broker nofile limit is missing")
	}
	for _, raw := range match[1:] {
		n, _ := strconv.Atoi(string(raw))
		if n <= 1000 {
			t.Fatalf("broker limit %d cannot open procd lock descriptor 1000", n)
		}
	}
}
