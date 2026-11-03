package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

type CoreConfiguration struct {
	ID        string `json:"id"`
	Hash      string `json:"hash"`
	At        string `json:"at"`
	Bootstrap bool   `json:"bootstrap,omitempty"`
}

func (s coreState) ConfigurationValues() []CoreConfiguration {
	out := []CoreConfiguration{}
	for _, c := range []*CoreConfiguration{s.Configuration, s.PreviousConfiguration} {
		if c != nil {
			out = append(out, *c)
		}
	}
	return out
}
func (c *CoreManager) loadControlIdentity() error {
	b, e := os.ReadFile(c.configPath)
	if e != nil {
		return e
	}
	var v struct {
		Controller string `yaml:"external-controller"`
		Secret     string `yaml:"secret"`
	}
	if e = yaml.Unmarshal(b, &v); e != nil {
		return errors.New("托管启动配置 YAML 无效")
	}
	host, port, e := net.SplitHostPort(v.Controller)
	n, pe := strconv.Atoi(port)
	if e != nil || pe != nil || n < 1 || n > 65535 || host != "127.0.0.1" || len(v.Secret) < 16 {
		return errors.New("启动配置须设置回环控制端口和至少 16 字符的 secret")
	}
	c.controller, c.secret = v.Controller, v.Secret
	_, _, _, e = c.validateManagedConfiguration(b)
	return e
}
func (c *CoreManager) coreEnvironment() []string {
	env := []string{}
	// No inherited command hooks or overrides can bypass the reviewed YAML.
	for _, v := range os.Environ() {
		if !strings.HasPrefix(v, "CLASH_") {
			env = append(env, v)
		}
	}
	return append(env, "CLASH_OVERRIDE_EXTERNAL_CONTROLLER="+c.controller, "CLASH_OVERRIDE_SECRET="+c.secret)
}
func (c *CoreManager) configDir(v *CoreConfiguration) string {
	return filepath.Join(c.dir, "configurations", v.ID)
}
func (c *CoreManager) configurationText(v *CoreConfiguration) ([]byte, error) {
	path := c.configPath
	if v != nil {
		path = filepath.Join(c.configDir(v), "config.yaml")
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := limitedRead(f, maxTextBytes)
	if e == nil && v != nil && revision(string(b)) != v.Hash {
		return nil, errors.New("已应用配置完整性检查失败，未覆盖")
	}
	return b, e
}
func (c *CoreManager) homeFor(v *CoreConfiguration) string {
	if v == nil || v.Bootstrap {
		return filepath.Join(c.dir, "home")
	}
	return filepath.Join(c.configDir(v), "home")
}
func (c *CoreManager) activeHome() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.homeFor(c.state.Configuration)
}
func (c *CoreManager) stageConfiguration(text []byte, from string) (*CoreConfiguration, error) {
	id := make([]byte, 16)
	if _, e := rand.Read(id); e != nil {
		return nil, e
	}
	v := &CoreConfiguration{ID: hex.EncodeToString(id), Hash: revision(string(text)), At: timestamp()}
	dir := c.configDir(v)
	if e := os.Mkdir(dir, 0700); e != nil {
		return nil, e
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(dir)
		}
	}()
	if e := copyCoreHome(from, c.homeFor(v)); e != nil {
		return nil, e
	}
	if e := atomicCoreFile(filepath.Join(dir, "config.yaml"), text, 0600); e != nil {
		return nil, e
	}
	parent, e := os.Open(filepath.Dir(dir))
	if e != nil {
		return nil, e
	}
	e = parent.Sync()
	parent.Close()
	if e != nil {
		return nil, e
	}
	ok = true
	return v, nil
}
func proxyAddresses(text []byte) ([]string, error) {
	var v struct {
		HTTP  int `yaml:"port"`
		Socks int `yaml:"socks-port"`
		Mixed int `yaml:"mixed-port"`
	}
	if e := yaml.Unmarshal(text, &v); e != nil {
		return nil, errors.New("代理端口格式无效")
	}
	out := []string{}
	used := map[int]bool{}
	for _, port := range []int{v.HTTP, v.Socks, v.Mixed} {
		if port < 0 || port > 65535 || (port != 0 && used[port]) {
			return nil, errors.New("代理端口须在 0–65535 范围，且不能重复")
		}
		if port != 0 {
			used[port] = true
			out = append(out, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		}
	}
	return out, nil
}
func validateProviderPaths(text []byte) error {
	var v struct {
		Proxies map[string]struct {
			Path string `yaml:"path"`
		} `yaml:"proxy-providers"`
		Rules map[string]struct {
			Path string `yaml:"path"`
		} `yaml:"rule-providers"`
	}
	if yaml.Unmarshal(text, &v) != nil {
		return errors.New("provider 配置格式无效")
	}
	used := map[string]bool{}
	for _, providers := range []map[string]struct {
		Path string `yaml:"path"`
	}{v.Proxies, v.Rules} {
		for _, p := range providers {
			if p.Path == "" {
				continue // Mihomo derives its own cache name when omitted.
			}
			raw := strings.ReplaceAll(p.Path, "\\", "/")
			// This is a Linux core path, including when checks run on Windows.
			clean := path.Clean(raw)
			if path.IsAbs(raw) || strings.Contains(raw, ":") || clean == ".." || strings.HasPrefix(clean, "../") {
				return errors.New("provider 缓存路径必须位于当前配置资源目录内，请使用相对路径")
			}
			if clean == "." || clean == "cache.db" || strings.HasPrefix(clean, ".manager-") || clean == "check.yaml" {
				return errors.New("provider 路径不能覆盖内核缓存或管理器配置文件")
			}
			if used[clean] {
				return errors.New("不同 provider 不能共用同一个缓存文件")
			}
			used[clean] = true
		}
	}
	return nil
}
func (c *CoreManager) configurationHealthy(client *http.Client, controller, secret string, text []byte, addresses []string) bool {
	r, e := http.NewRequestWithContext(c.ctx, "GET", "http://"+controller+"/configs", nil)
	if e != nil {
		return false
	}
	r.Header.Set("Authorization", "Bearer "+secret)
	res, e := client.Do(r)
	if e != nil {
		return false
	}
	defer res.Body.Close()
	var actual struct {
		Mode  string `json:"mode"`
		HTTP  int    `json:"port"`
		Socks int    `json:"socks-port"`
		Mixed int    `json:"mixed-port"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&actual) != nil {
		return false
	}
	var expected struct {
		Mode  string `yaml:"mode"`
		HTTP  int    `yaml:"port"`
		Socks int    `yaml:"socks-port"`
		Mixed int    `yaml:"mixed-port"`
	}
	if yaml.Unmarshal(text, &expected) != nil {
		return false
	}
	if expected.Mode == "" {
		expected.Mode = "rule"
	}
	if actual.Mode != expected.Mode || actual.HTTP != expected.HTTP || actual.Socks != expected.Socks || actual.Mixed != expected.Mixed {
		return false
	}
	for _, addr := range addresses {
		conn, e := net.DialTimeout("tcp", addr, 300*time.Millisecond)
		if e != nil {
			return false
		}
		conn.Close()
	}
	return true
}

// One operation gate serializes version changes and configuration application.
// The committed configuration pointer remains unchanged until health succeeds.
func (c *CoreManager) applyConfiguration(text []byte, expectedApplied string) error {
	c.mu.Lock()
	old := c.state
	c.mu.Unlock()
	if old.Current == nil {
		return errors.New("请先安装托管内核")
	}
	before, _, _, e := c.configuration()
	if e != nil {
		return e
	}
	if revision(string(before)) != expectedApplied {
		return errors.New("已应用配置已经变化，请重新预览")
	}
	if _, _, _, e = c.validateManagedConfiguration(text); e != nil {
		return e
	}
	// Reject multiple documents and non-map roots without constraining native
	// protocol fields through the editor's intentionally partial static validator.
	var root, extra yaml.Node
	decoder := yaml.NewDecoder(strings.NewReader(string(text)))
	if decoder.Decode(&root) != nil || len(root.Content) != 1 || root.Content[0].Kind != yaml.MappingNode || decoder.Decode(&extra) != io.EOF {
		return errors.New("配置必须是单个 YAML 映射文档")
	}
	if old.Configuration == nil {
		baseline, err := c.stageConfiguration(before, c.homeFor(nil))
		if err != nil {
			return err
		}
		// The original process still uses this home until an application commits.
		// Recording its YAML must not silently point at an unused cache copy.
		if err = os.RemoveAll(filepath.Join(c.configDir(baseline), "home")); err != nil {
			return err
		}
		baseline.Bootstrap = true
		baseline.At = ""
		c.mu.Lock()
		next := c.state
		next.Configuration = baseline
		e = c.persistLocked(next)
		c.mu.Unlock()
		if e != nil {
			return e
		}
		old.Configuration = baseline
	}
	c.phase("暂存配置并执行 mihomo -t")
	candidate, e := c.stageConfiguration(text, c.homeFor(old.Configuration))
	if e != nil {
		return e
	}
	if e = c.checkBinaryConfig(c.ctx, old.Current, text, c.homeFor(candidate)); e != nil {
		return e
	}
	if _, e = c.configurationText(candidate); e != nil {
		return e
	}
	c.mu.Lock()
	next := c.state
	next.Transition = true
	e = c.persistLocked(next)
	c.mu.Unlock()
	if e != nil {
		return e
	}
	c.phase("应用配置并检查运行状态")
	c.stop()
	e = refreshStoppedCache(c.homeFor(old.Configuration), c.homeFor(candidate))
	if e == nil {
		e = c.startConfiguration(old.Current, text, c.homeFor(candidate))
	}
	if e == nil {
		c.mu.Lock()
		next = c.state
		next.Configuration = candidate
		next.PreviousConfiguration = old.Configuration
		next.ConfigHistory = append([]CoreConfiguration{*candidate}, next.ConfigHistory...)
		if len(next.ConfigHistory) > 30 {
			next.ConfigHistory = next.ConfigHistory[:30]
		}
		next.Prepared = nil
		next.Transition = false
		e = c.persistLocked(next)
		c.mu.Unlock()
		if e == nil {
			return nil
		}
	}
	c.stop()
	if c.ctx.Err() != nil {
		return errors.New("配置应用被中断，重启后恢复最后确认的配置")
	}
	c.phase("应用失败，恢复原配置")
	if recovery := c.restore(old.Current); recovery != nil {
		return fmt.Errorf("应用失败，原配置恢复也失败：%v", recovery)
	}
	return fmt.Errorf("应用失败，已恢复原配置及资源目录：%w", e)
}
func (c *CoreManager) pruneConfigurationsLocked() {
	keep := map[string]bool{}
	homes := map[string]bool{}
	for _, v := range c.state.ConfigurationValues() {
		keep[v.ID] = true
		homes[v.ID] = true
	}
	for _, v := range c.state.ConfigHistory {
		keep[v.ID] = true
	}
	entries, _ := os.ReadDir(filepath.Join(c.dir, "configurations"))
	for _, entry := range entries {
		if !entry.IsDir() || !coreBundleID.MatchString(entry.Name()) {
			continue
		}
		dir := filepath.Join(c.dir, "configurations", entry.Name())
		if !keep[entry.Name()] {
			_ = os.RemoveAll(dir)
		} else if !homes[entry.Name()] {
			_ = os.RemoveAll(filepath.Join(dir, "home"))
		}
	}
}
func (c *CoreManager) workspaceSnapshot(out map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	text, e := c.configurationText(c.state.Configuration)
	running := false
	if c.process != nil {
		select {
		case <-c.process.done:
		default:
			running = true
		}
	}
	out["simulation"] = false
	out["core"] = map[string]any{"currentID": currentID(c.state), "busy": c.busy, "running": running, "operation": c.state.Operation}
	out["appliedRevision"] = ""
	if e != nil {
		out["applied"] = ""
		out["applicationError"] = "无法读取已应用配置，请检查服务状态"
		return
	}
	out["applied"] = string(text)
	out["appliedRevision"] = revision(string(text))
	out["appliedAt"] = ""
	runtime := runtimeFrom(string(text))
	runtime.Running = running
	runtime.Selected = map[string]string{}
	out["runtime"] = runtime
	if c.state.Configuration != nil {
		out["appliedAt"] = c.state.Configuration.At
	}
	history := append([]History{}, out["history"].([]History)...)
	for _, v := range c.state.ConfigHistory {
		data, err := c.configurationText(&v)
		if err == nil {
			history = append(history, History{ID: v.ID, Kind: "core-apply", At: v.At, Text: string(data)})
		}
	}
	sort.SliceStable(history, func(i, j int) bool { return history[i].At > history[j].At })
	if len(history) > 30 {
		history = history[:30]
	}
	out["history"] = history
}
