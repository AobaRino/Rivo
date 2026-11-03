package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.yaml.in/yaml/v3"
	assets "github.com/AobaRino/Rivo"
)

type CoreBundle struct {
	ID            string `json:"id"`
	Version       string `json:"version"`
	BinaryHash    string `json:"binaryHash"`
	ReleaseDigest string `json:"releaseDigest"`
	SchemaVersion string `json:"schemaVersion"`
	SchemaHash    string `json:"schemaHash"`
	SchemaWarning string `json:"schemaWarning,omitempty"`
	ConfigHash    string `json:"configHash"`
	CreatedAt     string `json:"createdAt"`
}
type CoreOperation struct {
	Kind   string `json:"kind"`
	Phase  string `json:"phase"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}
type coreState struct {
	Current               *CoreBundle         `json:"current"`
	Previous              *CoreBundle         `json:"previous"`
	Prepared              *CoreBundle         `json:"prepared"`
	Transition            bool                `json:"transition"`
	Operation             CoreOperation       `json:"operation"`
	Configuration         *CoreConfiguration  `json:"configuration,omitempty"`
	PreviousConfiguration *CoreConfiguration  `json:"previousConfiguration,omitempty"`
	ConfigHistory         []CoreConfiguration `json:"configHistory,omitempty"`
}
type coreProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
	log  *os.File
}
type CoreManager struct {
	mu                 sync.Mutex
	dir, configPath    string
	catalog            *coreCatalog
	state              coreState
	process            *coreProcess
	lock               *os.File
	ctx                context.Context
	cancel             context.CancelFunc
	wg                 sync.WaitGroup
	busy, closed       bool
	controller, secret string
}

var coreBundleID = regexp.MustCompile(`^[a-f0-9]{32}$`)

func atomicCoreFile(path string, b []byte, mode os.FileMode) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".write-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	if e = os.Rename(name, path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func newCoreManager(dir, config string, catalog *coreCatalog) (*CoreManager, error) {
	if dir == "" || config == "" || catalog.platform == "" {
		return nil, errors.New("托管内核需要 Linux amd64/arm64、独立目录和明确的配置路径")
	}
	dir, e := filepath.Abs(dir)
	if e != nil {
		return nil, e
	}
	config, e = filepath.Abs(config)
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Join(dir, "releases"), 0700); e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Join(dir, "home"), 0700); e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Join(dir, "configurations"), 0700); e != nil {
		return nil, e
	}
	lock, e := acquireCoreLock(dir)
	if e != nil {
		return nil, e
	}
	initialized := false
	defer func() {
		if !initialized {
			lock.Close()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	c := &CoreManager{dir: dir, configPath: config, catalog: catalog, ctx: ctx, cancel: cancel, lock: lock}
	if e = c.loadControlIdentity(); e != nil {
		cancel()
		return nil, e
	}
	b, e := os.ReadFile(filepath.Join(dir, "core-state.json"))
	if e == nil {
		if e = json.Unmarshal(b, &c.state); e != nil {
			cancel()
			return nil, e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		cancel()
		return nil, e
	}
	for _, bundle := range []*CoreBundle{c.state.Current, c.state.Previous, c.state.Prepared} {
		if bundle != nil && (!coreBundleID.MatchString(bundle.ID) || !stableCoreVersion.MatchString(bundle.Version)) {
			cancel()
			return nil, errors.New("内核状态文件无效，未覆盖")
		}
	}
	for _, config := range append(append([]CoreConfiguration{}, c.state.ConfigHistory...), c.state.ConfigurationValues()...) {
		if !coreBundleID.MatchString(config.ID) || len(config.Hash) != 64 {
			cancel()
			return nil, errors.New("已应用配置记录无效，未覆盖")
		}
	}
	// The current pointer is committed only after health checks. An interrupted
	// transition therefore always restarts the last confirmed bundle.
	if c.state.Current != nil {
		c.state.Operation = CoreOperation{Kind: "恢复已确认版本", Phase: "恢复中", Status: "running"}
		c.busy = true
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			c.phase("恢复已确认版本")
			e := c.restore(c.state.Current)
			c.finish("恢复已确认版本", e)
		}()
	} else {
		c.state.Transition = false
		c.state.Operation = CoreOperation{Status: "idle"}
	}
	initialized = true
	return c, nil
}
func (c *CoreManager) persistLocked(next coreState) error {
	b, e := json.MarshalIndent(next, "", "  ")
	if e != nil {
		return e
	}
	if e = atomicCoreFile(filepath.Join(c.dir, "core-state.json"), b, 0600); e != nil {
		return e
	}
	c.state = next
	return nil
}
func (c *CoreManager) phase(phase string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state.Operation.Phase = phase
}
func (c *CoreManager) finish(phase string, e error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	next := c.state
	next.Operation.Phase = phase
	next.Operation.Status = "succeeded"
	next.Operation.Error = ""
	if e != nil {
		next.Operation.Status = "failed"
		next.Operation.Error = e.Error()
	}
	if err := c.persistLocked(next); err != nil {
		c.state.Operation = CoreOperation{Status: "failed", Error: "状态写入失败，请检查磁盘；恢复时仍以已落盘版本为准"}
	} else if !c.state.Transition {
		// Only this manager's generated release directories are eligible. Run
		// before clearing busy, so a concurrent prepare cannot lose its staging dir.
		keep := map[string]bool{}
		for _, b := range []*CoreBundle{c.state.Current, c.state.Previous, c.state.Prepared} {
			if b != nil {
				keep[b.ID] = true
			}
		}
		c.pruneConfigurationsLocked()
		entries, _ := os.ReadDir(filepath.Join(c.dir, "releases"))
		for _, entry := range entries {
			if entry.IsDir() && coreBundleID.MatchString(entry.Name()) && !keep[entry.Name()] {
				_ = os.RemoveAll(filepath.Join(c.dir, "releases", entry.Name()))
			}
		}
	}
	c.busy = false
}
func currentID(state coreState) string {
	if state.Current == nil {
		return ""
	}
	return state.Current.ID
}
func (c *CoreManager) begin(kind, expected string, job func() error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.busy {
		return errors.New("已有内核任务执行中")
	}
	if currentID(c.state) != expected {
		return errors.New("内核版本已经变化，请刷新后操作")
	}
	next := c.state
	next.Operation = CoreOperation{Kind: kind, Phase: "准备中", Status: "running"}
	if e := c.persistLocked(next); e != nil {
		return e
	}
	c.busy = true
	c.wg.Add(1)
	go func() { defer c.wg.Done(); e := job(); c.finish(kind, e) }()
	return nil
}
func (c *CoreManager) status() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	running := false
	if c.process != nil {
		select {
		case <-c.process.done:
		default:
			running = true
		}
	}
	return map[string]any{"enabled": true, "platform": c.catalog.platform, "current": c.state.Current, "previous": c.state.Previous, "prepared": c.state.Prepared, "operation": c.state.Operation, "busy": c.busy, "running": running, "configuration": c.state.Configuration}
}
func (c *CoreManager) bundlePath(b *CoreBundle, name string) string {
	return filepath.Join(c.dir, "releases", b.ID, name)
}
func (c *CoreManager) configuration() ([]byte, string, string, error) {
	c.mu.Lock()
	config := c.state.Configuration
	c.mu.Unlock()
	b, e := c.configurationText(config)
	if e != nil {
		return nil, "", "", e
	}
	return c.validateManagedConfiguration(b)
}
func (c *CoreManager) validateManagedConfiguration(b []byte) ([]byte, string, string, error) {
	if len(b) > maxTextBytes {
		return nil, "", "", errors.New("托管配置超过大小限制")
	}
	var config struct {
		Controller string `yaml:"external-controller"`
		Secret     string `yaml:"secret"`
		TLS        string `yaml:"external-controller-tls"`
		Unix       string `yaml:"external-controller-unix"`
		Pipe       string `yaml:"external-controller-pipe"`
		Redir      int    `yaml:"redir-port"`
		TProxy     int    `yaml:"tproxy-port"`
		AllowLAN   bool   `yaml:"allow-lan"`
		Listeners  []any  `yaml:"listeners"`
		Tunnels    []any  `yaml:"tunnels"`
		DNS        struct {
			Enable bool   `yaml:"enable"`
			Listen string `yaml:"listen"`
		} `yaml:"dns"`
		Tun struct {
			Enable bool `yaml:"enable"`
		} `yaml:"tun"`
		IPTables struct {
			Enable bool `yaml:"enable"`
		} `yaml:"iptables"`
	}
	if e := yaml.Unmarshal(b, &config); e != nil {
		return nil, "", "", errors.New("托管配置 YAML 解析失败")
	}
	if (config.Controller != "" && config.Controller != c.controller) || (config.Secret != "" && config.Secret != c.secret) {
		return nil, "", "", errors.New("管理接口由服务固定；请移除草稿中的 external-controller 和 secret，或保持与服务一致")
	}
	if config.Tun.Enable || config.IPTables.Enable || config.Redir != 0 || config.TProxy != 0 || config.AllowLAN || config.TLS != "" || config.Unix != "" || config.Pipe != "" || len(config.Listeners) > 0 || len(config.Tunnels) > 0 {
		return nil, "", "", errors.New("当前托管模式仅支持回环显式代理；TUN、透明代理和局域网监听尚未开放")
	}
	if config.DNS.Enable && config.DNS.Listen != "" {
		host, _, err := net.SplitHostPort(config.DNS.Listen)
		if err != nil || (host != "127.0.0.1" && host != "::1") {
			return nil, "", "", errors.New("当前托管模式的 DNS 只允许回环监听")
		}
	}
	if _, e := proxyAddresses(b); e != nil {
		return nil, "", "", e
	}
	if e := validateProviderPaths(b); e != nil {
		return nil, "", "", e
	}
	return b, c.controller, c.secret, nil
}

type cappedWriter struct {
	mu sync.Mutex
	w  io.Writer
	n  int
}

func (w *cappedWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	size := len(b)
	remaining := (2 << 20) - w.n
	if remaining > 0 {
		if len(b) > remaining {
			b = b[:remaining]
		}
		n, e := w.w.Write(b)
		w.n += n
		if e != nil {
			return n, e
		}
	}
	return size, nil
}
func (c *CoreManager) checkBinary(ctx context.Context, b *CoreBundle, testConfig bool) error {
	var config []byte
	var e error
	if testConfig {
		config, _, _, e = c.configuration()
		if e != nil {
			return e
		}
	}
	return c.checkBinaryConfig(ctx, b, config, c.activeHome())
}
func (c *CoreManager) checkBinaryConfig(ctx context.Context, b *CoreBundle, config []byte, home string) error {
	testConfig := config != nil
	binary, e := os.ReadFile(c.bundlePath(b, "mihomo"))
	if e != nil || revision(string(binary)) != b.BinaryHash {
		return errors.New("已暂存内核完整性检查失败")
	}
	schema, e := os.ReadFile(c.bundlePath(b, "schema.json"))
	if e != nil || revision(string(schema)) != b.SchemaHash || checkCoreSchema(schema) != nil {
		return errors.New("已暂存 Schema 完整性检查失败")
	}
	args := []string{"-v"}
	if testConfig {
		// Validation may download GEO/providers. Use a separate copy so preparation
		// cannot overwrite resources used by the currently running process.
		checkHome, err := os.MkdirTemp(c.dir, ".check-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(checkHome)
		if err = copyCoreHome(home, checkHome); err != nil {
			return err
		}
		path := filepath.Join(checkHome, "check.yaml")
		if err = os.WriteFile(path, config, 0600); err != nil {
			return err
		}
		args = []string{"-t", "-d", checkHome, "-f", path}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.bundlePath(b, "mihomo"), args...)
	cmd.Env = c.coreEnvironment()
	protectCoreProcess(cmd)
	var out bytes.Buffer
	writer := &cappedWriter{w: &out}
	cmd.Stdout = writer
	cmd.Stderr = writer
	if e = cmd.Run(); e != nil {
		if testConfig {
			return errors.New("候选内核的 mihomo -t 检查失败；当前版本保持不变")
		}
		return errors.New("候选内核无法执行")
	}
	if !testConfig && !strings.Contains(out.String(), " "+b.Version+" ") {
		return errors.New("二进制报告版本与发布版本不符")
	}
	return nil
}

func copyCoreHome(src, dst string) error {
	var total int64
	return filepath.WalkDir(src, func(path string, entry os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		relative, e := filepath.Rel(src, path)
		if e != nil {
			return e
		}
		target := filepath.Join(dst, relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("内核资源目录含符号链接，无法安全暂存检查")
		}
		if entry.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		total += info.Size()
		if total > 256<<20 {
			return errors.New("内核资源检查副本超过 256 MB")
		}
		input, e := os.Open(path)
		if e != nil {
			return e
		}
		defer input.Close()
		output, e := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		_, e = io.Copy(output, io.LimitReader(input, info.Size()+1))
		closeErr := output.Close()
		if e != nil {
			return e
		}
		return closeErr
	})
}

// cache.db may be updated in-place while the old core runs. Recopy it only after
// that process has exited, so selection/fake-IP state isn't a torn live copy.
func refreshStoppedCache(src, dst string) error {
	cache := filepath.Join(src, "cache.db")
	info, err := os.Lstat(cache)
	if errors.Is(err, os.ErrNotExist) {
		err = os.Remove(filepath.Join(dst, "cache.db"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return errors.New("内核缓存不是有效的普通文件")
	}
	input, err := os.Open(cache)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.CreateTemp(dst, ".cache-*")
	if err != nil {
		return err
	}
	name := output.Name()
	defer os.Remove(name)
	n, err := io.Copy(output, io.LimitReader(input, info.Size()+1))
	if err == nil && n != info.Size() {
		err = errors.New("内核缓存仍在变化")
	}
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, filepath.Join(dst, "cache.db"))
}
func (c *CoreManager) prepare(version string) error {
	if !stableCoreVersion.MatchString(version) {
		return errors.New("版本格式无效")
	}
	config, _, _, e := c.configuration()
	if e != nil {
		return e
	}
	c.phase("下载并校验官方内核")
	binary, digest, e := c.catalog.binary(c.ctx, version)
	if e != nil {
		return e
	}
	id := make([]byte, 16)
	if _, e = rand.Read(id); e != nil {
		return e
	}
	b := &CoreBundle{ID: hex.EncodeToString(id), Version: version, BinaryHash: revision(string(binary)), ReleaseDigest: digest, CreatedAt: timestamp(), ConfigHash: revision(string(config))}
	dir := filepath.Join(c.dir, "releases", b.ID)
	if e = os.Mkdir(dir, 0700); e != nil {
		return e
	}
	keep := false
	defer func() {
		if !keep {
			os.RemoveAll(dir)
		}
	}()
	if e = atomicCoreFile(filepath.Join(dir, "mihomo"), binary, 0700); e != nil {
		return e
	}
	c.phase("获取匹配版本的 Schema")
	schema, e := c.catalog.schema(c.ctx, version)
	if e != nil {
		b.SchemaVersion = assets.SchemaVersion
		schema = assets.Schema
		c.mu.Lock()
		current := c.state.Current
		c.mu.Unlock()
		if current != nil {
			schema, e = os.ReadFile(c.bundlePath(current, "schema.json"))
			if e != nil || revision(string(schema)) != current.SchemaHash {
				return errors.New("无法读取用于保留的现有 Schema")
			}
			b.SchemaVersion = current.SchemaVersion
		}
		b.SchemaWarning = "未取得内核 " + version + " 对应的有效 Schema，保留 " + b.SchemaVersion + "；新字段提示可能不完整"
	} else {
		b.SchemaVersion = strings.TrimPrefix(version, "v")
	}
	b.SchemaHash = revision(string(schema))
	if e = atomicCoreFile(filepath.Join(dir, "schema.json"), schema, 0600); e != nil {
		return e
	}
	c.phase("检查候选内核及现有配置")
	if e = c.checkBinary(c.ctx, b, false); e != nil {
		return e
	}
	if e = c.checkBinary(c.ctx, b, true); e != nil {
		return e
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	next := c.state
	next.Prepared = b
	if e = c.persistLocked(next); e != nil {
		return e
	}
	keep = true
	return nil
}
func (c *CoreManager) stop() {
	c.mu.Lock()
	p := c.process
	c.process = nil
	c.mu.Unlock()
	if p == nil {
		return
	}
	select {
	case <-p.done:
		return
	default:
	}
	_ = p.cmd.Process.Signal(os.Interrupt)
	select {
	case <-p.done:
	case <-time.After(4 * time.Second):
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}
func (c *CoreManager) start(b *CoreBundle) error {
	config, _, _, e := c.configuration()
	if e != nil {
		return e
	}
	return c.startConfiguration(b, config, c.activeHome())
}
func (c *CoreManager) startConfiguration(b *CoreBundle, config []byte, home string) error {
	_, controller, secret, e := c.validateManagedConfiguration(config)
	if e != nil {
		return e
	}
	addresses, e := proxyAddresses(config)
	if e != nil {
		return e
	}
	for _, addr := range addresses {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return fmt.Errorf("代理监听端口 %s 已被占用", addr)
		}
		ln.Close()
	}
	// Refuse to attach to an unrelated process that happens to own the API port.
	ln, e := net.Listen("tcp", controller)
	if e != nil {
		return errors.New("控制端口已被占用，未接管其他进程")
	}
	ln.Close()
	f, e := os.OpenFile(c.bundlePath(b, "runtime.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if e != nil {
		return e
	}
	path := filepath.Join(home, ".manager-runtime.yaml")
	if e = atomicCoreFile(path, config, 0600); e != nil {
		f.Close()
		return e
	}
	cmd := exec.Command(c.bundlePath(b, "mihomo"), "-d", home, "-f", path)
	cmd.Env = c.coreEnvironment()
	protectCoreProcess(cmd)
	w := &cappedWriter{w: f}
	cmd.Stdout = w
	cmd.Stderr = w
	if e = cmd.Start(); e != nil {
		f.Close()
		return e
	}
	p := &coreProcess{cmd: cmd, done: make(chan struct{}), log: f}
	c.mu.Lock()
	c.process = p
	c.mu.Unlock()
	go func() { _ = cmd.Wait(); f.Close(); close(p.done) }()
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	defer client.CloseIdleConnections()
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	success := 0
	for {
		select {
		case <-c.ctx.Done():
			return c.ctx.Err()
		case <-p.done:
			return errors.New("候选内核提前退出")
		case <-deadline.C:
			return errors.New("候选内核健康检查超时")
		case <-ticker.C:
			r, _ := http.NewRequestWithContext(c.ctx, "GET", "http://"+controller+"/version", nil)
			r.Header.Set("Authorization", "Bearer "+secret)
			response, err := client.Do(r)
			if err != nil {
				success = 0
				continue
			}
			var info struct {
				Version string `json:"version"`
			}
			err = json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&info)
			response.Body.Close()
			if err == nil && response.StatusCode == 200 && info.Version == b.Version && c.configurationHealthy(client, controller, secret, config, addresses) {
				success++
			} else {
				success = 0
			}
			if success >= 5 {
				return nil
			}
		}
	}
}
func (c *CoreManager) restore(b *CoreBundle) error {
	if e := c.checkBinary(c.ctx, b, true); e != nil {
		return e
	}
	if e := c.start(b); e != nil {
		c.stop()
		return e
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	next := c.state
	next.Transition = false
	return c.persistLocked(next)
}
func (c *CoreManager) activate(id string, rollback bool) error {
	c.mu.Lock()
	old := c.state
	target := old.Prepared
	if rollback {
		target = old.Previous
	}
	c.mu.Unlock()
	if target == nil || target.ID != id {
		return errors.New("待切换版本已经变化")
	}
	config, _, _, e := c.configuration()
	if e != nil {
		return e
	}
	if !rollback && revision(string(config)) != target.ConfigHash {
		return errors.New("配置在准备后发生变化，请重新准备版本")
	}
	c.phase("使用目标版本检查配置")
	if e = c.checkBinary(c.ctx, target, true); e != nil {
		return e
	}
	latestConfig, _, _, e := c.configuration()
	if e != nil || !bytes.Equal(latestConfig, config) {
		return errors.New("配置在检查期间发生变化，请重新准备版本")
	}
	// A candidate core may rewrite GEO, provider caches or cache.db before its
	// health checks pass. Never let it write the last confirmed core's home.
	var candidateConfig *CoreConfiguration
	if old.Current != nil {
		candidateConfig, e = c.stageConfiguration(config, c.homeFor(old.Configuration))
		if e != nil {
			return e
		}
		candidateConfig.At = ""
		if old.Configuration != nil {
			candidateConfig.At = old.Configuration.At
		}
	}
	c.mu.Lock()
	next := c.state
	next.Transition = true
	e = c.persistLocked(next)
	c.mu.Unlock()
	if e != nil {
		return e
	}
	c.phase("切换进程并检查健康状态")
	c.stop()
	if candidateConfig != nil {
		e = refreshStoppedCache(c.homeFor(old.Configuration), c.homeFor(candidateConfig))
		if e == nil {
			e = c.startConfiguration(target, config, c.homeFor(candidateConfig))
		}
	} else {
		e = c.start(target)
	}
	if e == nil {
		c.mu.Lock()
		next = c.state
		next.Current = target
		next.Previous = old.Current
		next.Prepared = nil
		next.Transition = false
		if candidateConfig != nil {
			next.Configuration = candidateConfig
			next.PreviousConfiguration = old.Configuration
		}
		e = c.persistLocked(next)
		c.mu.Unlock()
		if e == nil {
			return nil
		}
	}
	c.stop()
	if c.ctx.Err() != nil {
		return errors.New("切换被中断，下次启动恢复已确认版本")
	}
	c.phase("切换失败，恢复原版本")
	if old.Current != nil {
		if recoverErr := c.restore(old.Current); recoverErr != nil {
			return fmt.Errorf("切换失败，原版本恢复也失败：%v；请检查托管配置或端口", recoverErr)
		}
	} else {
		c.mu.Lock()
		next = c.state
		next.Transition = false
		_ = c.persistLocked(next)
		c.mu.Unlock()
	}
	return fmt.Errorf("切换失败，已恢复切换前状态：%w", e)
}
func (c *CoreManager) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()
	c.cancel()
	c.wg.Wait()
	c.stop()
	if c.lock != nil {
		c.lock.Close()
	}
}

func (s *Server) coreRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/core/providers", func(w http.ResponseWriter, r *http.Request) {
		if s.core == nil {
			failure(w, 409, "托管内核未启用")
			return
		}
		status, err := s.core.providerStatus(r.Context())
		if err != nil {
			failure(w, 503, err.Error())
			return
		}
		jsonResponse(w, 200, status)
	})
	mux.HandleFunc("GET /api/core", func(w http.ResponseWriter, r *http.Request) {
		if s.core == nil {
			jsonResponse(w, 200, map[string]any{"enabled": false, "reason": "此服务未启用托管内核；本地配置编辑仍可使用内置 Schema", "busy": false, "running": false})
			return
		}
		jsonResponse(w, 200, s.core.status())
	})
	mux.HandleFunc("GET /api/core/schema", func(w http.ResponseWriter, r *http.Request) {
		data := assets.Schema
		version := assets.SchemaVersion
		coreVersion := ""
		warning := ""
		id := "bundled"
		if s.core != nil {
			s.core.mu.Lock()
			current := s.core.state.Current
			s.core.mu.Unlock()
			if current != nil {
				var e error
				data, e = os.ReadFile(s.core.bundlePath(current, "schema.json"))
				if e != nil || revision(string(data)) != current.SchemaHash {
					failure(w, 500, "当前 Schema 读取或完整性检查失败")
					return
				}
				version = current.SchemaVersion
				coreVersion = current.Version
				warning = current.SchemaWarning
				id = current.ID
			}
		}
		jsonResponse(w, 200, map[string]any{"id": id, "version": version, "coreVersion": coreVersion, "warning": warning, "hash": revision(string(data)), "schema": json.RawMessage(data)})
	})
	mux.HandleFunc("GET /api/core/releases", func(w http.ResponseWriter, r *http.Request) {
		if s.core == nil {
			failure(w, 409, "托管内核未启用")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		list, e := s.core.catalog.releases(ctx)
		if e != nil {
			failure(w, 502, e.Error())
			return
		}
		jsonResponse(w, 200, list)
	})
	for _, action := range []string{"prepare", "activate", "rollback"} {
		action := action
		mux.HandleFunc("POST /api/core/"+action, func(w http.ResponseWriter, r *http.Request) {
			if s.core == nil {
				failure(w, 409, "托管内核未启用")
				return
			}
			var req struct {
				Version         string `json:"version"`
				ID              string `json:"id"`
				ExpectedCurrent string `json:"expectedCurrent"`
			}
			if !readJSON(w, r, &req) {
				return
			}
			if action == "prepare" && !stableCoreVersion.MatchString(req.Version) {
				failure(w, 400, "只支持稳定版 vX.Y.Z")
				return
			}
			if action != "prepare" && !coreBundleID.MatchString(req.ID) {
				failure(w, 400, "版本标识无效")
				return
			}
			kind := map[string]string{"prepare": "准备版本", "activate": "更新内核", "rollback": "回退内核"}[action]
			e := s.core.begin(kind, req.ExpectedCurrent, func() error {
				if action == "prepare" {
					return s.core.prepare(req.Version)
				}
				return s.core.activate(req.ID, action == "rollback")
			})
			if e != nil {
				failure(w, 409, e.Error())
				return
			}
			jsonResponse(w, 202, s.core.status())
		})
	}
}
