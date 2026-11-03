// Download a pinned, unmodified upstream release into the ignored local cache.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type release struct{ Version, URL, SHA256 string }

func setup() error {
	manifest, err := os.ReadFile("web/src/vendor/zashboard/release.json")
	if err != nil {
		return err
	}
	var r release
	if err = json.Unmarshal(manifest, &r); err != nil {
		return err
	}
	if !strings.HasPrefix(r.URL, "https://github.com/Zephyruso/zashboard/releases/download/") || !strings.HasPrefix(r.Version, "v") || strings.ContainsAny(r.Version, "/\\") {
		return fmt.Errorf("invalid release manifest")
	}
	base, err := filepath.Abs(".local/zashboard")
	if err != nil {
		return err
	}
	target := filepath.Join(base, r.Version)
	if b, err := os.ReadFile(filepath.Join(target, "release.json")); err == nil && bytes.Equal(b, manifest) {
		if _, err = os.Stat(filepath.Join(target, "dist/index.html")); err == nil {
			return nil
		}
	}
	if _, err := os.Stat(target); err == nil {
		return fmt.Errorf("incomplete cache at %s; inspect before removing it", target)
	}
	archive := filepath.Join(".local", "zashboard-"+r.Version+".zip")
	data, err := os.ReadFile(archive)
	if os.IsNotExist(err) {
		fmt.Println("Downloading official Zashboard", r.Version)
		client := &http.Client{Timeout: 90 * time.Second}
		resp, e := client.Get(r.URL)
		if e != nil {
			return e
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
		}
		data, err = io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	}
	if err != nil {
		return err
	}
	hash := sha256.Sum256(data)
	if len(data) > 16<<20 || hex.EncodeToString(hash[:]) != r.SHA256 {
		return fmt.Errorf("Zashboard release SHA-256 mismatch; nothing installed")
	}
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	if err = os.MkdirAll(base, 0700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(base, ".prepare-")
	if err != nil {
		return err
	}
	defer func() {
		// Only the directory created above is eligible for cleanup.
		if filepath.Dir(stage) == base && strings.HasPrefix(filepath.Base(stage), ".prepare-") {
			_ = os.RemoveAll(stage)
		}
	}()
	var total uint64
	for _, f := range z.File {
		total += f.UncompressedSize64
		if total > 64<<20 || len(z.File) > 2000 {
			return fmt.Errorf("archive exceeds limits")
		}
		path := filepath.Join(stage, filepath.FromSlash(f.Name))
		rel, err := filepath.Rel(stage, path)
		if err != nil || !filepath.IsLocal(rel) || strings.Contains(f.Name, "\\") || f.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe archive path")
		}
		if f.FileInfo().IsDir() {
			if err = os.MkdirAll(path, 0755); err != nil {
				return err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		b, e := io.ReadAll(io.LimitReader(rc, 64<<20+1))
		rc.Close()
		if e != nil {
			return e
		}
		if err = os.WriteFile(path, b, 0644); err != nil {
			return err
		}
	}
	if _, err = os.Stat(filepath.Join(stage, "dist/index.html")); err != nil {
		return err
	}
	license, err := os.ReadFile("web/src/vendor/zashboard/LICENSE")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(stage, "dist/LICENSE"), license, 0644); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(stage, "release.json"), manifest, 0644); err != nil {
		return err
	}
	if err = os.Rename(stage, target); err != nil {
		return err
	}
	fmt.Println("Official Zashboard ready:", r.Version, "(SHA-256 verified)")
	return nil
}
func main() {
	if err := setup(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
