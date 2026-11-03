package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const (
	webSessionLimit      = 64
	webSessionLifetime   = 12 * time.Hour
	rememberedLifetime   = 30 * 24 * time.Hour
	webSessionsFileLimit = 64 << 10
)

// Only hashes of random bearer tokens are persisted. Binding the file to the
// configured password verifier invalidates it when credentials are replaced.
type storedWebSessions struct {
	Version     int                  `json:"version"`
	Credentials string               `json:"credentials"`
	Sessions    map[string]time.Time `json:"sessions"`
}

func (a *webAuth) credentialsFingerprint() string {
	hash := sha256.Sum256([]byte(a.credentials.Salt + "\x00" + a.credentials.Hash))
	return hex.EncodeToString(hash[:])
}

func (a *webAuth) loadSessions() error {
	path := filepath.Join(a.dir, "sessions.json")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > webSessionsFileLimit {
		return errors.New("会话文件类型或大小无效")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, webSessionsFileLimit+1))
	if err != nil {
		return err
	}
	if len(b) > webSessionsFileLimit {
		return errors.New("会话文件过大")
	}
	var stored storedWebSessions
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil {
		return errors.New("会话文件 JSON 无效")
	}
	if decoder.Decode(new(any)) != io.EOF || stored.Version != 1 || stored.Sessions == nil || len(stored.Sessions) > webSessionLimit {
		return errors.New("会话文件格式无效")
	}
	if a.credentials.Hash == "" || stored.Credentials != a.credentialsFingerprint() {
		a.storeDirty = true
		log.Print("Rivo: 登录凭据已变化，已取消已保存的保持登录会话")
		return nil
	}
	now := a.now()
	valid := make(map[[32]byte]time.Time, len(stored.Sessions))
	for encoded, expires := range stored.Sessions {
		key, err := hex.DecodeString(encoded)
		if err != nil || len(key) != sha256.Size || hex.EncodeToString(key) != encoded || expires.IsZero() {
			return errors.New("会话文件包含无效记录")
		}
		if !now.Before(expires) {
			a.storeDirty = true
			continue
		}
		valid[[32]byte(key)] = expires
	}
	// Validate the entire document before allowing any restored session.
	for key, expires := range valid {
		ctx, cancel := context.WithDeadline(context.Background(), expires)
		a.sessions[key] = webSession{expires: expires, remembered: true, ctx: ctx, cancel: cancel}
	}
	return nil
}

func (a *webAuth) persistSessions(next map[[32]byte]webSession) error {
	stored := storedWebSessions{Version: 1, Credentials: a.credentialsFingerprint(), Sessions: map[string]time.Time{}}
	for key, session := range next {
		if session.remembered {
			stored.Sessions[hex.EncodeToString(key[:])] = session.expires
		}
	}
	b, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	return atomicWriteFile(filepath.Join(a.dir, "sessions.json"), b, 0600)
}

// Called with a.mu held. Requests only read in-memory state; disk writes happen
// on explicit login/logout, including any pending expiry or corruption cleanup.
func (a *webAuth) commitSessions(next map[[32]byte]webSession) error {
	changed := a.storeDirty
	for key, old := range a.sessions {
		fresh, exists := next[key]
		if old.remembered && (!exists || !fresh.remembered || !fresh.expires.Equal(old.expires)) {
			changed = true
		}
	}
	for key, fresh := range next {
		old, exists := a.sessions[key]
		if fresh.remembered && (!exists || !old.remembered || !fresh.expires.Equal(old.expires)) {
			changed = true
		}
	}
	if changed {
		if err := a.persistSessions(next); err != nil {
			return err
		}
		a.storeDirty = false
	}
	for key, old := range a.sessions {
		if _, exists := next[key]; !exists {
			old.cancel()
		}
	}
	a.sessions = next
	return nil
}

func (a *webAuth) liveSessions(exclude *http.Cookie) map[[32]byte]webSession {
	next := make(map[[32]byte]webSession, len(a.sessions))
	var replaced [32]byte
	if exclude != nil {
		replaced = sha256.Sum256([]byte(exclude.Value))
	}
	for key, session := range a.sessions {
		if a.now().Before(session.expires) && (exclude == nil || key != replaced) {
			next[key] = session
		}
	}
	return next
}

func (a *webAuth) setSession(w http.ResponseWriter, r *http.Request, remember bool) error {
	if remember && a.credentials.Hash == "" {
		return errors.New("登录凭据尚未初始化")
	}
	current, _ := r.Cookie(a.cookieName())
	next := a.liveSessions(current)
	if len(next) >= webSessionLimit {
		var oldest [32]byte
		first := true
		for key, session := range next {
			if first || session.expires.Before(next[oldest].expires) ||
				(session.expires.Equal(next[oldest].expires) && bytes.Compare(key[:], oldest[:]) < 0) {
				oldest, first = key, false
			}
		}
		delete(next, oldest)
	}
	lifetime := webSessionLifetime
	if remember {
		lifetime = rememberedLifetime
	}
	token := randomToken()
	expires := a.now().Add(lifetime)
	ctx, cancel := context.WithDeadline(context.Background(), expires)
	next[sha256.Sum256([]byte(token))] = webSession{expires: expires, remembered: remember, ctx: ctx, cancel: cancel}
	if err := a.commitSessions(next); err != nil {
		cancel()
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: a.cookieName(), Value: token, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: int(lifetime.Seconds())})
	return nil
}

func (a *webAuth) revokeSession(r *http.Request) error {
	current, _ := r.Cookie(a.cookieName())
	return a.commitSessions(a.liveSessions(current))
}
