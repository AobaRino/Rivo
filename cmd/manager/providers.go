package main

import (
	"errors"
	"fmt"
	"net/url"
)

func validateProviders(data map[string]any) []Diagnostic {
	var issues []Diagnostic
	add := func(message string) { issues = append(issues, Diagnostic{"error", message}) }
	providers := map[string]any{}
	if raw, exists := data["proxy-providers"]; exists {
		var ok bool
		providers, ok = raw.(map[string]any)
		if !ok {
			add("proxy-providers 必须是映射")
			return issues
		}
	}
	for name, raw := range providers {
		p, ok := raw.(map[string]any)
		if !ok {
			add("订阅配置必须是映射：" + name)
			continue
		}
		kind, _ := p["type"].(string)
		if kind != "http" && kind != "file" && kind != "inline" {
			add("订阅类型无效：" + name)
		}
		if kind == "http" {
			value, _ := p["url"].(string)
			if _, err := providerURL(value); err != nil {
				add("订阅链接必须是 HTTP(S) 地址：" + name)
			}
		}
		if value, exists := p["interval"]; exists {
			n, ok := value.(int)
			if !ok || n < 0 {
				add("订阅更新间隔必须是非负整数：" + name)
			}
		}
	}
	if groups, ok := data["proxy-groups"].([]any); ok {
		graph := map[string][]string{}
		for _, raw := range groups {
			group, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			groupName, _ := group["name"].(string)
			graph[groupName] = []string{}
			if refs, ok := group["proxies"].([]any); ok {
				for _, ref := range refs {
					if name, ok := ref.(string); ok {
						graph[groupName] = append(graph[groupName], name)
					}
				}
			}
			if use, exists := group["use"]; exists {
				refs, ok := use.([]any)
				if !ok {
					add("代理组 use 必须是列表")
					continue
				}
				for _, ref := range refs {
					name, ok := ref.(string)
					if _, exists := providers[name]; !ok || !exists {
						add(fmt.Sprintf("代理组 %v 引用了不存在的订阅：%v", group["name"], ref))
					}
				}
			}
		}
		visiting, visited := map[string]bool{}, map[string]bool{}
		var walk func(string) bool
		walk = func(name string) bool {
			if visiting[name] {
				return true
			}
			if visited[name] {
				return false
			}
			refs, exists := graph[name]
			if !exists {
				return false
			}
			visiting[name] = true
			for _, ref := range refs {
				if walk(ref) {
					return true
				}
			}
			visiting[name] = false
			visited[name] = true
			return false
		}
		for name := range graph {
			if walk(name) {
				add("代理组之间存在循环引用，请调整组内成员")
				break
			}
		}
	}
	return issues
}
func providerURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
		return nil, errors.New("请输入有效的 HTTP(S) 订阅链接")
	}
	return u, nil
}
