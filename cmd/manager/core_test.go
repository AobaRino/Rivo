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
	"io"
	"net/http"
	"strings"
	"testing"

	assets "github.com/AobaRino/Rivo"
)

type coreRoundTrip func(*http.Request) (*http.Response, error)

func (f coreRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func catalogFor(t *testing.T, responses map[string][]byte) *coreCatalog {
	t.Helper()
	return &coreCatalog{platform: "linux-amd64-v1", client: &http.Client{Transport: coreRoundTrip(func(r *http.Request) (*http.Response, error) {
		data, ok := responses[r.URL.String()]
		status := 200
		if !ok {
			status = 404
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}, nil
	})}}
}
func zipped(data []byte) []byte {
	var out bytes.Buffer
	g := gzip.NewWriter(&out)
	g.Write(data)
	g.Close()
	return out.Bytes()
}
func TestCoreReleaseIntegrityAndPinning(t *testing.T) {
	version := "v1.19.32"
	name := "mihomo-linux-amd64-v1-" + version + ".gz"
	url := "https://github.com/MetaCubeX/mihomo/releases/download/" + version + "/" + name
	data := zipped([]byte("test binary"))
	h := sha256.Sum256(data)
	r := githubRelease{Tag: version, Assets: []releaseAsset{{Name: name, URL: url, Digest: "sha256:" + hex.EncodeToString(h[:]), Size: int64(len(data))}}}
	meta, _ := json.Marshal(r)
	responses := map[string][]byte{"https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/" + version: meta, url: data}
	c := catalogFor(t, responses)
	b, _, e := c.binary(context.Background(), version)
	if e != nil || string(b) != "test binary" {
		t.Fatal(e)
	}
	responses[url] = append([]byte("corrupt"), data...)
	if _, _, e = c.binary(context.Background(), version); e == nil {
		t.Fatal("corrupt artifact accepted")
	}
	r.Assets[0].URL = "https://attacker.invalid/core.gz"
	responses["https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/"+version], _ = json.Marshal(r)
	if _, _, e = c.binary(context.Background(), version); e == nil {
		t.Fatal("foreign URL accepted")
	}
	if _, _, e = c.binary(context.Background(), "../latest"); e == nil {
		t.Fatal("invalid version accepted")
	}
}
func TestCoreSchemaIntegrityAndNoExternalReferences(t *testing.T) {
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "package/schemas/meta-json-schema.json", Mode: 0600, Size: int64(len(assets.Schema))})
	tw.Write(assets.Schema)
	tw.Close()
	gz.Close()
	pack := archive.Bytes()
	hash := sha512.Sum512(pack)
	url := "https://registry.npmjs.org/meta-json-schema/-/meta-json-schema-1.19.32.tgz"
	meta, _ := json.Marshal(map[string]any{"version": "1.19.32", "dist": map[string]string{"tarball": url, "integrity": "sha512-" + base64.StdEncoding.EncodeToString(hash[:])}})
	responses := map[string][]byte{"https://registry.npmjs.org/meta-json-schema/1.19.32": meta, url: pack}
	c := catalogFor(t, responses)
	schema, e := c.schema(context.Background(), "v1.19.32")
	if e != nil || !bytes.Equal(schema, assets.Schema) {
		t.Fatal(e)
	}
	responses[url] = []byte("corrupt")
	if _, e = c.schema(context.Background(), "v1.19.32"); e == nil {
		t.Fatal("corrupt schema accepted")
	}
	bad := bytes.Replace(assets.Schema, []byte(`"$ref":"#/`), []byte(`"$ref":"https://example.com/`), 1)
	if bytes.Equal(bad, assets.Schema) {
		t.Fatal("fixture did not change")
	}
	if checkCoreSchema(bad) == nil {
		t.Fatal("external ref accepted")
	}
}
func TestCoreDownloadTrustAndLimits(t *testing.T) {
	for _, raw := range []string{"http://github.com/a", "https://user@github.com/a", "https://github.com.evil.test/a", "https://127.0.0.1/a", "https://github.com:8443/a"} {
		if trustedDownloadURL(raw) {
			t.Fatal(raw)
		}
	}
	if _, e := limitedRead(strings.NewReader("12345"), 4); e == nil {
		t.Fatal("oversized data accepted")
	}
}
func TestDisabledCoreCannotBeStartedThroughAPI(t *testing.T) {
	s := newTestServer(t)
	if w := call(s, "POST", "/api/core/prepare", `{"version":"v1.19.32","expectedCurrent":""}`, ""); w.Code != 409 {
		t.Fatal(w.Code)
	}
	w := call(s, "GET", "/api/core/schema", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"version":"1.19.32"`) {
		t.Fatal(w.Code)
	}
}
