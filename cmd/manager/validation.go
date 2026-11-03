package main

import (
	"fmt"
	"regexp"
	"strings"
)

var ruleSetRef = regexp.MustCompile(`(?:^|[,(])\s*RULE-SET\s*,\s*([^,()]+)`)

func ruleTarget(raw string) (string, string) {
	parts := strings.Split(raw, ",")
	kind := strings.ToUpper(strings.TrimSpace(parts[0]))
	index := 2
	switch kind {
	case "MATCH":
		index = 1
	case "NOT", "OR", "AND", "SUB-RULE", "DOMAIN-REGEX", "PROCESS-NAME-REGEX", "PROCESS-PATH-REGEX":
		index = len(parts) - 1
	}
	if index >= len(parts) || index == 0 {
		return kind, ""
	}
	return kind, strings.TrimSpace(parts[index])
}

func hasCycle(graph map[string][]string) bool {
	visiting, done := map[string]bool{}, map[string]bool{}
	var walk func(string) bool
	walk = func(name string) bool {
		if visiting[name] {
			return true
		}
		if done[name] {
			return false
		}
		visiting[name] = true
		for _, ref := range graph[name] {
			if walk(ref) {
				return true
			}
		}
		visiting[name] = false
		done[name] = true
		return false
	}
	for name := range graph {
		if walk(name) {
			return true
		}
	}
	return false
}

// Local structural checks only. The product does not claim this replaces -t.
func validateReferences(data map[string]any, names map[string]bool) []Diagnostic {
	issues := []Diagnostic{}
	add := func(m string) { issues = append(issues, Diagnostic{"error", m}) }
	object := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	list := func(v any) []any { a, _ := v.([]any); return a }
	target := func(value any, label string) {
		if value == nil || value == "" {
			return
		}
		ref, ok := value.(string)
		if !ok || !names[ref] {
			add(label + " 引用了不存在的目标")
		}
	}
	graph := map[string][]string{}
	for _, section := range []string{"proxies", "proxy-groups"} {
		for _, raw := range list(data[section]) {
			m := object(raw)
			name, _ := m["name"].(string)
			if kind, ok := m["type"].(string); !ok || kind == "" {
				add(section + " 中的项目缺少协议类型")
			}
			graph[name] = []string{}
			if section == "proxy-groups" {
				for _, v := range list(m["proxies"]) {
					if ref, ok := v.(string); ok {
						graph[name] = append(graph[name], ref)
					}
				}
			} else {
				target(m["dialer-proxy"], "节点 "+name)
				if ref, ok := m["dialer-proxy"].(string); ok && ref != "" {
					graph[name] = append(graph[name], ref)
				}
			}
		}
	}
	if hasCycle(graph) {
		add("代理组或链式代理之间存在循环引用")
	}
	for _, section := range []string{"proxy-providers", "rule-providers"} {
		for name, raw := range object(data[section]) {
			m := object(raw)
			target(m["proxy"], section+" / "+name)
			target(object(m["override"])["dialer-proxy"], section+" / "+name)
			for _, item := range list(m["payload"]) {
				target(object(item)["dialer-proxy"], section+" / "+name)
			}
		}
	}
	for _, raw := range list(data["listeners"]) {
		target(object(raw)["proxy"], "监听器")
	}

	providers := object(data["rule-providers"])
	if raw, ok := data["rule-providers"]; ok && providers == nil && raw != nil {
		add("rule-providers 必须是映射")
	}
	for name, raw := range providers {
		m := object(raw)
		kind, _ := m["type"].(string)
		behavior, _ := m["behavior"].(string)
		if kind != "http" && kind != "file" && kind != "inline" {
			add("规则集来源类型无效：" + name)
		}
		if behavior != "domain" && behavior != "ipcidr" && behavior != "classical" {
			add("规则集行为无效：" + name)
		}
		if format, ok := m["format"]; ok && format != "yaml" && format != "text" && format != "mrs" {
			add("规则集格式无效：" + name)
		}
		if m["format"] == "mrs" && behavior == "classical" {
			add("MRS 不支持 classical：" + name)
		}
		if kind == "http" {
			url, _ := m["url"].(string)
			if _, err := providerURL(url); err != nil {
				add("规则集地址无效：" + name)
			}
		}
		if kind == "file" {
			path, _ := m["path"].(string)
			if strings.TrimSpace(path) == "" {
				add("规则集缺少文件路径：" + name)
			}
		}
		if interval, ok := m["interval"]; ok {
			n, valid := interval.(int)
			if !valid || n < 0 {
				add("规则集更新间隔无效：" + name)
			}
		}
		if kind == "inline" {
			entries, ok := m["payload"].([]any)
			if !ok {
				add("规则集 payload 必须是列表：" + name)
			}
			for _, entry := range entries {
				if s, ok := entry.(string); !ok || strings.TrimSpace(s) == "" {
					add("规则集内容必须为非空字符串：" + name)
				}
			}
		}
	}

	subs := object(data["sub-rules"])
	if _, exists := data["sub-rules"]; exists && subs == nil {
		add("sub-rules 必须是映射")
	}
	subGraph := map[string][]string{}
	checkRules := func(raw any, label, owner string) {
		entries, ok := raw.([]any)
		if !ok {
			add(label + " 必须是列表")
			return
		}
		for i, entry := range entries {
			rule, ok := entry.(string)
			where := fmt.Sprintf("%s / %d", label, i+1)
			if !ok {
				add(where + " 必须是字符串")
				continue
			}
			kind, ref := ruleTarget(rule)
			if kind == "SUB-RULE" {
				if _, exists := subs[ref]; !exists || ref == "" {
					add(where + " 引用了不存在的子规则：" + ref)
				}
				if owner != "" {
					subGraph[owner] = append(subGraph[owner], ref)
				}
			} else if !names[ref] {
				add(where + " 引用了不存在的目标：" + ref)
			}
			for _, match := range ruleSetRef.FindAllStringSubmatch(rule, -1) {
				if _, ok := providers[strings.TrimSpace(match[1])]; !ok {
					add(where + " 引用了不存在的规则集")
				}
			}
		}
	}
	if raw, ok := data["rules"]; ok {
		checkRules(raw, "规则", "")
	}
	for name, raw := range subs {
		checkRules(raw, "子规则 "+name, name)
	}
	if hasCycle(subGraph) {
		add("子规则之间存在循环引用")
	}
	return issues
}
