package main

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/dlclark/regexp2"
)

type GroupMember struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Source string `json:"source"`
}
type MemberSource struct {
	Name           string        `json:"name"`
	Manual         bool          `json:"manual"`
	Nodes          []GroupMember `json:"nodes"`
	AutomaticNodes []GroupMember `json:"automaticNodes,omitempty"`
}
type GroupOrderPreview struct {
	Filter        string         `json:"filter"`
	ExcludeFilter string         `json:"excludeFilter"`
	ExcludeType   string         `json:"excludeType"`
	Sources       []MemberSource `json:"sources"`
}

// Use the same regex dialect and provider/filter traversal as Mihomo v1.19.33
// adapter/outboundgroup/groupbase.go. This preview never fetches subscriptions,
// writes configuration or changes a selection. Bound work on untrusted regexes.
func previewGroupOrder(input GroupOrderPreview) ([]GroupMember, error) {
	deadline := time.Now().Add(time.Second)
	compile := func(value string) ([]*regexp2.Regexp, error) {
		var result []*regexp2.Regexp
		if value == "" {
			return result, nil
		}
		if len(value) > 131072 || strings.Count(value, "`") > 2048 {
			return nil, errors.New("排序表达式过大，请减少固定排序的节点")
		}
		for _, part := range strings.Split(value, "`") {
			re, err := regexp2.Compile(part, regexp2.None)
			if err != nil {
				return nil, errors.New("筛选或排序表达式无效，请检查 filter / exclude-filter")
			}
			re.MatchTimeout = 25 * time.Millisecond
			result = append(result, re)
		}
		return result, nil
	}
	filters, err := compile(input.Filter)
	if err != nil {
		return nil, err
	}
	excludes, err := compile(input.ExcludeFilter)
	if err != nil {
		return nil, err
	}
	match := func(re *regexp2.Regexp, name string) (bool, error) {
		if time.Now().After(deadline) {
			return false, errors.New("排序预览超时，请简化筛选表达式")
		}
		ok, err := re.MatchString(name)
		if err != nil {
			return false, errors.New("筛选表达式执行超时，请简化表达式")
		}
		return ok, nil
	}
	result := []GroupMember{}
	count := 0
	for _, source := range input.Sources {
		count += len(source.Nodes) + len(source.AutomaticNodes)
	}
	if count > 10000 || len(input.Sources) > 256 {
		return nil, errors.New("排序预览超过节点数量限制")
	}
	for _, source := range input.Sources {
		for _, node := range source.AutomaticNodes {
			if len(filters) == 0 {
				source.Nodes = append(source.Nodes, node)
				continue
			}
			for _, filter := range filters {
				ok, err := match(filter, node.Name)
				if err != nil {
					return nil, err
				}
				if ok {
					source.Nodes = append(source.Nodes, node)
				}
			}
		}
		if source.Manual || len(filters) == 0 {
			result = append(result, source.Nodes...)
			continue
		}
		seen := map[string]bool{}
		for _, filter := range filters {
			for _, node := range source.Nodes {
				if seen[node.Name] {
					continue
				}
				ok, err := match(filter, node.Name)
				if err != nil {
					return nil, err
				}
				if ok {
					result = append(result, node)
					seen[node.Name] = true
				}
			}
		}
	}
	if len(input.Sources) > 1 && len(filters) > 1 {
		sorted, seen := []GroupMember{}, map[string]bool{}
		for _, filter := range filters {
			for _, node := range result {
				if seen[node.Name] {
					continue
				}
				ok, err := match(filter, node.Name)
				if err != nil {
					return nil, err
				}
				if ok {
					sorted = append(sorted, node)
					seen[node.Name] = true
				}
			}
		}
		for _, node := range result {
			if !seen[node.Name] {
				sorted = append(sorted, node)
				seen[node.Name] = true
			}
		}
		result = sorted
	}
	final := []GroupMember{}
	for _, node := range result {
		excluded := false
		for _, re := range excludes {
			ok, err := match(re, node.Name)
			if err != nil {
				return nil, err
			}
			if ok {
				excluded = true
				break
			}
		}
		for _, typ := range strings.Split(input.ExcludeType, "|") {
			if typ != "" && strings.EqualFold(typ, node.Type) {
				excluded = true
			}
		}
		if !excluded {
			final = append(final, node)
		}
	}
	return final, nil
}

func (s *Server) groupOrderRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/group-order/preview", func(w http.ResponseWriter, r *http.Request) {
		var input GroupOrderPreview
		if !readJSON(w, r, &input) {
			return
		}
		members, err := previewGroupOrder(input)
		if err != nil {
			failure(w, 422, err.Error())
			return
		}
		jsonResponse(w, 200, map[string]any{"members": members})
	})
}
