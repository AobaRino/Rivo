package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"time"

	"go.yaml.in/yaml/v3"
)

type ProviderStatus struct {
	Name      string           `json:"name"`
	Type      string           `json:"type"`
	Nodes     int              `json:"nodes"`
	UpdatedAt string           `json:"updatedAt,omitempty"`
	State     string           `json:"state"`
	Members   []ProviderMember `json:"members"`
}

type ProviderMember struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Only expose counts and display names/types. No subscription URLs, credentials or raw
// core errors are forwarded to the browser by this endpoint.
func summarizeProviders(config []byte, data []byte) ([]ProviderStatus, error) {
	var cfg struct {
		Providers map[string]struct {
			Type string `yaml:"type"`
		} `yaml:"proxy-providers"`
	}
	if yaml.Unmarshal(config, &cfg) != nil {
		return nil, errors.New("无法读取已应用的订阅配置")
	}
	var live struct {
		Providers map[string]struct {
			Proxies   []json.RawMessage `json:"proxies"`
			UpdatedAt string            `json:"updatedAt"`
		} `json:"providers"`
	}
	if json.Unmarshal(data, &live) != nil || live.Providers == nil {
		return nil, errors.New("内核订阅状态格式无效")
	}
	rows := []ProviderStatus{}
	for name, provider := range cfg.Providers {
		row := ProviderStatus{Name: name, Type: provider.Type, State: "missing"}
		row.Members = []ProviderMember{}
		if actual, ok := live.Providers[name]; ok {
			for _, raw := range actual.Proxies {
				var member ProviderMember
				if json.Unmarshal(raw, &member) == nil && member.Name != "" {
					row.Members = append(row.Members, member)
				}
			}
			row.Nodes = len(actual.Proxies)
			row.State = "empty"
			if row.Nodes > 0 {
				row.State = "loaded"
			}
			if at, e := time.Parse(time.RFC3339Nano, actual.UpdatedAt); e == nil && !at.IsZero() {
				row.UpdatedAt = actual.UpdatedAt
			}
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	return rows, nil
}

func (c *CoreManager) providerStatus(ctx context.Context) (map[string]any, error) {
	c.mu.Lock()
	if c.busy || c.process == nil {
		c.mu.Unlock()
		return nil, errors.New("内核尚未运行或正在切换，订阅状态待确认")
	}
	select {
	case <-c.process.done:
		c.mu.Unlock()
		return nil, errors.New("内核未运行，订阅状态待确认")
	default:
	}
	config := c.state.Configuration
	process := c.process
	c.mu.Unlock()
	text, err := c.configurationText(config)
	if err != nil {
		return nil, errors.New("无法读取已应用配置")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+c.controller+"/providers/proxies", nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Authorization", "Bearer "+c.secret)
	client := &http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	defer client.CloseIdleConnections()
	res, err := client.Do(r)
	if err != nil {
		return nil, errors.New("暂时无法读取内核订阅状态")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, errors.New("内核未返回可用的订阅状态")
	}
	data, err := limitedRead(res.Body, 8<<20)
	if err != nil {
		return nil, errors.New("订阅状态超过读取限制")
	}
	rows, err := summarizeProviders(text, data)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.busy || c.process != process || c.state.Configuration != config {
		return nil, errors.New("内核状态已变化，正在重新读取订阅")
	}
	return map[string]any{"appliedRevision": revision(string(text)), "providers": rows}, nil
}
