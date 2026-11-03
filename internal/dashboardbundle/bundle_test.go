package dashboardbundle

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testArchive(t *testing.T, names []string, symlink bool, html string) (Release, []byte) {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for _, name := range names {
		h := &zip.FileHeader{Name: name}
		if symlink {
			h.SetMode(os.ModeSymlink | 0777)
		}
		f, e := w.CreateHeader(h)
		if e != nil {
			t.Fatal(e)
		}
		_, _ = f.Write([]byte(html))
	}
	if e := w.Close(); e != nil {
		t.Fatal(e)
	}
	h := sha256.Sum256(b.Bytes())
	return Release{Version: "v1.0.0", URL: "https://github.com/Zephyruso/zashboard/releases/download/v1.0.0/dist-no-fonts.zip", SHA256: hex.EncodeToString(h[:]), Size: int64(b.Len())}, b.Bytes()
}
func TestInstallRejectsUnsafeArchivesWithoutPublishing(t *testing.T) {
	for _, tc := range []struct {
		name    string
		files   []string
		symlink bool
		html    string
	}{
		{"traversal", []string{"dist/../../escape"}, false, "<html>"},
		{"backslash", []string{`dist\escape`}, false, "<html>"},
		{"absolute", []string{"/dist/index.html"}, false, "<html>"},
		{"outside-dist", []string{"state.json"}, false, "<html>"},
		{"symlink", []string{"dist/index.html"}, true, "<html>"},
		{"duplicate", []string{"dist/index.html", "dist/index.html"}, false, "<html>"},
		{"case-duplicate", []string{"dist/index.html", "dist/INDEX.html"}, false, "<html>"},
		{"missing-entry", []string{"dist/other.js"}, false, "<html>"},
		{"invalid-entry", []string{"dist/index.html"}, false, "not html"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, b := testArchive(t, tc.files, tc.symlink, tc.html)
			root := t.TempDir()
			if Install(root, r, b) == nil {
				t.Fatal("unsafe archive accepted")
			}
			entries, _ := os.ReadDir(root)
			if len(entries) != 0 {
				t.Fatal("partial files published", entries)
			}
		})
	}
}
func TestInstallIntegrityLicenseAndIdempotence(t *testing.T) {
	r, b := testArchive(t, []string{"dist/index.html"}, false, "<!doctype html><html></html>")
	root := t.TempDir()
	if e := Install(root, r, append(b, 0)); e == nil {
		t.Fatal("bad digest accepted")
	}
	if e := Install(root, r, b); e != nil {
		t.Fatal(e)
	}
	if e := Install(root, r, b); e != nil {
		t.Fatal("repeat install failed", e)
	}
	if _, e := Read(root, r.Version); e != nil {
		t.Fatal(e)
	}
	license, e := os.ReadFile(filepath.Join(root, r.Version, "dist", "LICENSE"))
	if e != nil || !strings.Contains(string(license), "Zephyruso") {
		t.Fatal("license missing", e)
	}
	other, b2 := testArchive(t, []string{"dist/index.html"}, false, "<html>changed</html>")
	if Install(root, other, b2) == nil {
		t.Fatal("same version overwritten")
	}
	for _, v := range []string{"../v1.0.0", "v1.0.0/evil", "v1.0.0-beta"} {
		r.Version = v
		if r.Validate() == nil {
			t.Fatal("invalid version accepted", v)
		}
	}
}
