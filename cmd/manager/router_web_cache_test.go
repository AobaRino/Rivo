package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestSPAMutableFilesIgnoreUnchangedPackageTimestamp(t *testing.T) {
	packageTime := time.Date(2026, time.May, 25, 2, 36, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, file, path, before, after, contentType string
	}{
		{"root", "index.html", "/", "<h1>old</h1>", "<h1>new</h1>", "text/html; charset=utf-8"},
		{"explicit index", "index.html", "/index.html", "<h1>old</h1>", "<h1>new</h1>", "text/html; charset=utf-8"},
		{"SPA route", "index.html", "/groups", "<h1>old</h1>", "<h1>new</h1>", "text/html; charset=utf-8"},
		{"stable asset", "favicon.svg", "/favicon.svg", "<svg>old</svg>", "<svg>new</svg>", "image/svg+xml"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, tc.file)
			writePackage := func(content string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(path, packageTime, packageTime); err != nil {
					t.Fatal(err)
				}
			}
			writePackage(tc.before)
			handler := spaHandler(dir)
			before := httptest.NewRecorder()
			handler.ServeHTTP(before, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if before.Code != http.StatusOK || before.Body.String() != tc.before {
				t.Fatalf("initial resource: %d %q", before.Code, before.Body.String())
			}
			// The upgrade replaces bytes but retains the SDK's build timestamp and size.
			writePackage(tc.after)
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				for header, value := range map[string]string{
					"If-Modified-Since": packageTime.Format(http.TimeFormat),
					"If-None-Match":     `"old-version"`,
				} {
					r := httptest.NewRequest(method, tc.path, nil)
					r.Header.Set(header, value)
					w := httptest.NewRecorder()
					handler.ServeHTTP(w, r)
					if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
						t.Fatalf("%s %s reused stale resource: %d %v", method, header, w.Code, w.Header())
					}
					if w.Header().Get("Last-Modified") != "" || w.Header().Get("ETag") != "" {
						t.Fatalf("%s exposes a stale validator: %v", method, w.Header())
					}
					if w.Header().Get("Content-Type") != tc.contentType || w.Header().Get("Content-Length") != strconv.Itoa(len(tc.after)) {
						t.Fatalf("%s incorrect representation headers: %v", method, w.Header())
					}
					wantBody := tc.after
					if method == http.MethodHead {
						wantBody = ""
					}
					if w.Body.String() != wantBody {
						t.Fatalf("%s body %q, want %q", method, w.Body.String(), wantBody)
					}
				}
			}
		})
	}
}

func TestSPAFingerprintedAssetsRemainCacheable(t *testing.T) {
	dir := t.TempDir()
	assets := filepath.Join(dir, "assets")
	if err := os.Mkdir(assets, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index-aBcD1234.js", "rivo-aBcD1234.svg"} {
		if err := os.WriteFile(filepath.Join(assets, name), []byte("build-asset"), 0600); err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			w := httptest.NewRecorder()
			spaHandler(dir).ServeHTTP(w, httptest.NewRequest(method, "/assets/"+name, nil))
			if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
				t.Fatalf("%s %s: %d %v", method, name, w.Code, w.Header())
			}
			if method == http.MethodHead && w.Body.Len() != 0 {
				t.Fatal("HEAD response included a body")
			}
			cached := httptest.NewRequest(method, "/assets/"+name, nil)
			cached.Header.Set("If-Modified-Since", w.Header().Get("Last-Modified"))
			revalidated := httptest.NewRecorder()
			spaHandler(dir).ServeHTTP(revalidated, cached)
			if revalidated.Code != http.StatusNotModified || revalidated.Body.Len() != 0 {
				t.Fatalf("%s %s did not retain conditional caching: %d", method, name, revalidated.Code)
			}
		}
	}
}
