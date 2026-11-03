// Package dashboardbundle installs unmodified official Zashboard archives.
package dashboardbundle

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	assets "github.com/AobaRino/Rivo"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const MaxArchive = 16 << 20
const maxExpanded = 64 << 20

var versionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)
var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Release struct {
	Version   string `json:"version"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size,omitempty"`
	Published string `json:"published,omitempty"`
}

func ValidVersion(version string) bool { return versionPattern.MatchString(version) }
func (r Release) Validate() error {
	if !ValidVersion(r.Version) || r.URL != "https://github.com/Zephyruso/zashboard/releases/download/"+r.Version+"/dist-no-fonts.zip" || !digestPattern.MatchString(r.SHA256) || r.Size < 0 || r.Size > MaxArchive {
		return errors.New("Zashboard 发布信息、下载来源或 SHA-256 无效")
	}
	return nil
}

// Read verifies the installed marker and the entry page. Content is installed
// only after archive verification; callers never accept a path from the browser.
func Read(root, version string) (Release, error) {
	var r Release
	if !ValidVersion(version) {
		return r, errors.New("无效的面板版本")
	}
	b, err := os.ReadFile(filepath.Join(root, version, "release.json"))
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(b, &r); err != nil {
		return r, err
	}
	if err = r.Validate(); err != nil {
		return r, err
	}
	if r.Version != version {
		return r, errors.New("面板目录与版本不符")
	}
	f, err := os.Stat(filepath.Join(root, version, "dist", "index.html"))
	if err == nil && (!f.Mode().IsRegular() || f.Size() == 0) {
		err = errors.New("面板入口无效")
	}
	return r, err
}

func Install(root string, r Release, data []byte) error {
	if err := r.Validate(); err != nil {
		return err
	}
	h := sha256.Sum256(data)
	if len(data) > MaxArchive || hex.EncodeToString(h[:]) != r.SHA256 || (r.Size > 0 && int64(len(data)) != r.Size) {
		return errors.New("Zashboard 发布包大小或 SHA-256 校验失败")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	if installed, e := Read(root, r.Version); e == nil {
		if installed.SHA256 != r.SHA256 {
			return errors.New("已安装的同版本面板校验值不同")
		}
		return nil
	}
	if _, e := os.Stat(filepath.Join(root, r.Version)); !os.IsNotExist(e) {
		return errors.New("目标版本目录已存在但不完整，请检查本地缓存")
	}
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	if len(z.File) > 2000 {
		return errors.New("面板归档文件过多")
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(root, ".prepare-")
	if err != nil {
		return err
	}
	defer func() {
		// Remove only the staging directory created in this call.
		if filepath.Dir(stage) == root && strings.HasPrefix(filepath.Base(stage), ".prepare-") {
			_ = os.RemoveAll(stage)
		}
	}()
	var total uint64
	seen := map[string]bool{}
	for _, f := range z.File {
		if f.UncompressedSize64 > maxExpanded-total {
			return errors.New("面板解压内容超过大小限制")
		}
		total += f.UncompressedSize64
		name := strings.TrimSuffix(f.Name, "/")
		target := filepath.Join(stage, filepath.FromSlash(name))
		rel, e := filepath.Rel(stage, target)
		key := strings.ToLower(filepath.ToSlash(rel))
		if e != nil || !filepath.IsLocal(rel) || strings.ContainsAny(name, "\\:") || (name != "dist" && !strings.HasPrefix(name, "dist/")) || filepath.ToSlash(rel) != name || seen[key] || (!f.FileInfo().IsDir() && !f.Mode().IsRegular()) {
			return errors.New("面板归档含有不安全或重复的路径")
		}
		seen[key] = true
		if f.FileInfo().IsDir() {
			if err = os.MkdirAll(target, 0755); err != nil {
				return err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		rc, e := f.Open()
		if e != nil {
			return e
		}
		b, e := io.ReadAll(io.LimitReader(rc, int64(f.UncompressedSize64)+1))
		rc.Close()
		if e != nil {
			return e
		}
		if uint64(len(b)) != f.UncompressedSize64 {
			return errors.New("面板文件解压长度不符")
		}
		if err = os.WriteFile(target, b, 0644); err != nil {
			return err
		}
	}
	index, err := os.ReadFile(filepath.Join(stage, "dist", "index.html"))
	if err != nil || !bytes.Contains(bytes.ToLower(index), []byte("<html")) {
		return errors.New("面板归档缺少有效的 dist/index.html")
	}
	if err = os.WriteFile(filepath.Join(stage, "dist", "LICENSE"), assets.DashboardLicense, 0644); err != nil {
		return err
	}
	manifest, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(stage, "release.json"), manifest, 0644); err != nil {
		return err
	}
	if err = os.Rename(stage, filepath.Join(root, r.Version)); err != nil {
		return fmt.Errorf("面板安装失败: %w", err)
	}
	return nil
}
