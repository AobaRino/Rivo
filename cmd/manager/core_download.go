package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var stableCoreVersion = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)

type CoreRelease struct {
	Version   string `json:"version"`
	Published string `json:"published"`
	Asset     string `json:"asset"`
}
type releaseAsset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}
type githubRelease struct {
	Tag        string         `json:"tag_name"`
	Draft      bool           `json:"draft"`
	Prerelease bool           `json:"prerelease"`
	Published  string         `json:"published_at"`
	Assets     []releaseAsset `json:"assets"`
}
type coreCatalog struct {
	client   *http.Client
	platform string
}

func corePlatform() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	switch runtime.GOARCH {
	case "amd64":
		return "linux-amd64-v1"
	case "arm64":
		return "linux-arm64"
	}
	return ""
}

func newCoreCatalog() *coreCatalog {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil // Do not depend on the core being upgraded for downloads.
	c := &http.Client{Transport: transport, Timeout: 2 * time.Minute}
	c.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !trustedDownloadURL(r.URL.String()) {
			return errors.New("下载重定向不在允许的 HTTPS 来源中")
		}
		return nil
	}
	return &coreCatalog{client: c, platform: corePlatform()}
}
func trustedDownloadURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "registry.npmjs.org":
		return true
	}
	return false
}
func limitedRead(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err == nil && int64(len(b)) > limit {
		err = errors.New("下载或解压内容超过大小限制")
	}
	return b, err
}
func (c *coreCatalog) get(ctx context.Context, raw string, max int64) ([]byte, error) {
	if !trustedDownloadURL(raw) {
		return nil, errors.New("仅允许可信发布源的 HTTPS 地址")
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("User-Agent", "Rivo/0.1")
	r.Header.Set("Accept", "application/json, application/octet-stream")
	res, err := c.client.Do(r)
	if err != nil {
		return nil, fmt.Errorf("下载连接失败: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("发布源返回 HTTP %d", res.StatusCode)
	}
	if res.ContentLength > max {
		return nil, errors.New("发布包超过大小限制")
	}
	return limitedRead(res.Body, max)
}
func (c *coreCatalog) releases(ctx context.Context) ([]CoreRelease, error) {
	b, e := c.get(ctx, "https://api.github.com/repos/MetaCubeX/mihomo/releases?per_page=30", 8<<20)
	if e != nil {
		return nil, e
	}
	var list []githubRelease
	if e = json.Unmarshal(b, &list); e != nil {
		return nil, e
	}
	out := []CoreRelease{}
	for _, r := range list {
		if r.Draft || r.Prerelease || !stableCoreVersion.MatchString(r.Tag) {
			continue
		}
		name := "mihomo-" + c.platform + "-" + r.Tag + ".gz"
		for _, a := range r.Assets {
			if a.Name == name {
				out = append(out, CoreRelease{r.Tag, r.Published, name})
				break
			}
		}
	}
	return out, nil
}
func (c *coreCatalog) binary(ctx context.Context, version string) ([]byte, string, error) {
	if !stableCoreVersion.MatchString(version) {
		return nil, "", errors.New("只支持稳定版 vX.Y.Z")
	}
	b, e := c.get(ctx, "https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/"+version, 8<<20)
	if e != nil {
		return nil, "", e
	}
	var release githubRelease
	if e = json.Unmarshal(b, &release); e != nil {
		return nil, "", e
	}
	if release.Tag != version || release.Draft || release.Prerelease {
		return nil, "", errors.New("发布版本不符或不是稳定版")
	}
	name := "mihomo-" + c.platform + "-" + version + ".gz"
	for _, a := range release.Assets {
		if a.Name != name {
			continue
		}
		expected := "https://github.com/MetaCubeX/mihomo/releases/download/" + version + "/" + name
		if a.URL != expected || !strings.HasPrefix(a.Digest, "sha256:") || len(a.Digest) != 71 {
			return nil, "", errors.New("发布包缺少可信 SHA256 或下载路径不符")
		}
		data, err := c.get(ctx, a.URL, 64<<20)
		if err != nil {
			return nil, "", err
		}
		h := sha256.Sum256(data)
		if int64(len(data)) != a.Size || "sha256:"+hex.EncodeToString(h[:]) != a.Digest {
			return nil, "", errors.New("内核发布包大小或 SHA256 校验失败")
		}
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, "", err
		}
		defer gz.Close()
		binary, err := limitedRead(gz, 160<<20)
		return binary, a.Digest, err
	}
	return nil, "", errors.New("此版本没有当前平台的内核发布包")
}

func (c *coreCatalog) schema(ctx context.Context, version string) ([]byte, error) {
	v := strings.TrimPrefix(version, "v")
	b, e := c.get(ctx, "https://registry.npmjs.org/meta-json-schema/"+v, 2<<20)
	if e != nil {
		return nil, e
	}
	var metadata struct {
		Version string `json:"version"`
		Dist    struct {
			Tarball   string `json:"tarball"`
			Integrity string `json:"integrity"`
		} `json:"dist"`
	}
	if e = json.Unmarshal(b, &metadata); e != nil {
		return nil, e
	}
	if metadata.Version != v || metadata.Dist.Tarball != "https://registry.npmjs.org/meta-json-schema/-/meta-json-schema-"+v+".tgz" {
		return nil, errors.New("Schema 包版本或来源不符")
	}
	data, e := c.get(ctx, metadata.Dist.Tarball, 8<<20)
	if e != nil {
		return nil, e
	}
	h := sha512.Sum512(data)
	if metadata.Dist.Integrity != "sha512-"+base64.StdEncoding.EncodeToString(h[:]) {
		return nil, errors.New("Schema 包完整性校验失败")
	}
	gz, e := gzip.NewReader(bytes.NewReader(data))
	if e != nil {
		return nil, e
	}
	defer gz.Close()
	tr := tar.NewReader(io.LimitReader(gz, 32<<20))
	var schema []byte
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if header.Name == "package/schemas/meta-json-schema.json" {
			if header.Typeflag != tar.TypeReg || schema != nil {
				return nil, errors.New("Schema 归档结构无效")
			}
			schema, err = limitedRead(tr, 8<<20)
			if err != nil {
				return nil, err
			}
		}
	}
	if e = checkCoreSchema(schema); e != nil {
		return nil, e
	}
	return schema, nil
}
func checkCoreSchema(data []byte) error {
	var root map[string]any
	if len(data) > 8<<20 || json.Unmarshal(data, &root) != nil || root == nil {
		return errors.New("Schema 不是有效的 JSON 对象")
	}
	defs, ok := root["definitions"].(map[string]any)
	if !ok {
		return errors.New("Schema 缺少 definitions")
	}
	proxies, ok := defs["proxies"].(map[string]any)
	if !ok || proxies["items"] == nil || root["allOf"] == nil {
		return errors.New("Schema 缺少 Mihomo 配置结构")
	}
	count := 0
	var walk func(any, int) error
	walk = func(v any, depth int) error {
		count++
		if depth > 96 || count > 150000 {
			return errors.New("Schema 结构超过限制")
		}
		switch n := v.(type) {
		case map[string]any:
			if ref, ok := n["$ref"].(string); ok && !strings.HasPrefix(ref, "#/") {
				return errors.New("Schema 不允许引用外部资源")
			}
			for _, child := range n {
				if e := walk(child, depth+1); e != nil {
					return e
				}
			}
		case []any:
			for _, child := range n {
				if e := walk(child, depth+1); e != nil {
					return e
				}
			}
		}
		return nil
	}
	return walk(root, 0)
}
