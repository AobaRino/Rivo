package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Local profiles are intentionally unavailable to router/managed-core requests.
// A switch is a single atomic state-file write; it never starts an OS process.
type LocalProfile struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Draft   string    `json:"draft"`
	SavedAt string    `json:"savedAt"`
	History []History `json:"history"`
}
type LocalEvent struct {
	At     string `json:"at"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

func (s *Server) initializeLocalWorkspace() {
	if s.state.ProfileID == "" {
		s.state.ProfileID = "default"
	}
	if s.state.ProfileName == "" {
		s.state.ProfileName = "config.yaml"
	}
}
func (s *Server) matchWorkspace(w http.ResponseWriter, r *http.Request) bool {
	if s.core != nil || s.routerOnly {
		return true
	}
	id := r.Header.Get("X-Profile-ID")
	if id == "" {
		id = "default"
	}
	if id != s.state.ProfileID {
		failure(w, 409, "当前配置已在其他窗口切换，请重新载入后操作")
		return false
	}
	return true
}
func (s *Server) addLocalEvent(title, detail string) {
	if s.core != nil || s.routerOnly {
		return
	}
	s.events = append([]LocalEvent{{timestamp(), title, detail}}, s.events...)
	if len(s.events) > 20 {
		s.events = s.events[:20]
	}
}
func profileRevision(st State) string {
	// Includes both current and closed drafts, so a preview cannot overwrite a
	// concurrent rename, save or switch (even for identical YAML documents).
	b, _ := json.Marshal(st)
	return revision(string(b))
}
func (s *Server) localSnapshot(out map[string]any) {
	profiles := []map[string]string{{"id": s.state.ProfileID, "name": s.state.ProfileName, "savedAt": s.state.SavedAt, "revision": revision(s.state.Draft)}}
	for _, p := range s.state.Profiles {
		profiles = append(profiles, map[string]string{"id": p.ID, "name": p.Name, "savedAt": p.SavedAt, "revision": revision(p.Draft)})
	}
	out["profileID"] = s.state.ProfileID
	out["profileName"] = s.state.ProfileName
	out["profiles"] = profiles
	out["profilesRevision"] = profileRevision(s.state)
	out["autoStart"] = s.state.AutoStart == nil || *s.state.AutoStart
	out["events"] = append([]LocalEvent{}, s.events...)
}
func (s *Server) localRoutes(mux *http.ServeMux) {
	local := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if s.routerOnly || s.core != nil {
				failure(w, 409, "多配置与首页控制当前仅用于本地模拟预览")
				return
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			fn(w, r)
		}
	}
	current := func() LocalProfile {
		return LocalProfile{s.state.ProfileID, s.state.ProfileName, s.state.Draft, s.state.SavedAt, s.state.History}
	}
	find := func(id string) (LocalProfile, int) {
		if id == s.state.ProfileID {
			return current(), -1
		}
		for i, p := range s.state.Profiles {
			if p.ID == id {
				return p, i
			}
		}
		return LocalProfile{}, -2
	}
	check := func(w http.ResponseWriter, expected string) bool {
		if expected != profileRevision(s.state) {
			failure(w, 409, "配置库已变化，请关闭预览并重新载入后再操作")
			return false
		}
		return true
	}
	commit := func(w http.ResponseWriter, next State, title string) bool {
		encoded, _ := json.Marshal(next)
		if len(encoded) > 64<<20 {
			failure(w, 413, "本地配置库超过 64 MB，请先删除不需要的配置或修订")
			return false
		}
		if err := s.persist(next); err != nil {
			failure(w, 500, "保存失败，原配置与运行状态保持不变")
			return false
		}
		s.state = next
		s.addLocalEvent(title, "本地配置库已更新。")
		return true
	}
	validName := func(w http.ResponseWriter, name string) bool {
		if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 80 || strings.ContainsAny(name, "\r\n/\\") {
			failure(w, 400, "名称需为 1–80 个字符，不包含路径或换行")
			return false
		}
		return true
	}
	mux.HandleFunc("GET /api/profiles/{id}", local(func(w http.ResponseWriter, r *http.Request) {
		p, i := find(r.PathValue("id"))
		if i == -2 {
			failure(w, 404, "配置不存在")
			return
		}
		jsonResponse(w, 200, map[string]any{"profile": p, "profilesRevision": profileRevision(s.state)})
	}))
	mux.HandleFunc("POST /api/profiles", local(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name     string `json:"name"`
			Text     string `json:"text"`
			Expected string `json:"expected"`
		}
		if !readJSON(w, r, &req) || !validText(w, req.Text) || !validName(w, req.Name) || !check(w, req.Expected) {
			return
		}
		if len(s.state.Profiles) >= 15 {
			failure(w, 400, "本地预览最多保存 16 份配置")
			return
		}
		all := append([]LocalProfile{current()}, s.state.Profiles...)
		for _, p := range all {
			if p.Name == strings.TrimSpace(req.Name) {
				failure(w, 409, "配置名称已存在")
				return
			}
		}
		var id [12]byte
		if _, e := rand.Read(id[:]); e != nil {
			failure(w, 500, "无法生成配置标识")
			return
		}
		now := timestamp()
		p := LocalProfile{hex.EncodeToString(id[:]), strings.TrimSpace(req.Name), req.Text, now, []History{{ID: "initial-" + now, Kind: "initial", At: now, Text: req.Text}}}
		next := s.state
		next.Profiles = append(append([]LocalProfile{}, s.state.Profiles...), p)
		if commit(w, next, "新增配置") {
			jsonResponse(w, 201, s.snapshot())
		}
	}))
	mux.HandleFunc("PATCH /api/profiles/{id}", local(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name     string `json:"name"`
			Expected string `json:"expected"`
		}
		if !readJSON(w, r, &req) || !validName(w, req.Name) || !check(w, req.Expected) {
			return
		}
		p, i := find(r.PathValue("id"))
		if i == -2 {
			failure(w, 404, "配置不存在")
			return
		}
		all := append([]LocalProfile{current()}, s.state.Profiles...)
		for _, other := range all {
			if other.ID != p.ID && other.Name == strings.TrimSpace(req.Name) {
				failure(w, 409, "配置名称已存在")
				return
			}
		}
		next := s.state
		next.Profiles = append([]LocalProfile{}, s.state.Profiles...)
		if i == -1 {
			next.ProfileName = strings.TrimSpace(req.Name)
		} else {
			next.Profiles[i].Name = strings.TrimSpace(req.Name)
		}
		if commit(w, next, "重命名配置") {
			jsonResponse(w, 200, s.snapshot())
		}
	}))
	mux.HandleFunc("DELETE /api/profiles/{id}", local(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Expected string `json:"expected"`
		}
		if !readJSON(w, r, &req) || !check(w, req.Expected) {
			return
		}
		_, i := find(r.PathValue("id"))
		if i < 0 {
			failure(w, 409, "当前使用的配置不能删除")
			return
		}
		next := s.state
		next.Profiles = append([]LocalProfile{}, s.state.Profiles[:i]...)
		next.Profiles = append(next.Profiles, s.state.Profiles[i+1:]...)
		if commit(w, next, "删除配置") {
			jsonResponse(w, 200, s.snapshot())
		}
	}))
	mux.HandleFunc("POST /api/profiles/{id}/switch", local(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Expected    string  `json:"expected"`
			Revision    string  `json:"revision"`
			SaveCurrent *string `json:"saveCurrent"`
		}
		if !readJSON(w, r, &req) || !check(w, req.Expected) || !s.matchWorkspace(w, r) {
			return
		}
		if req.Revision != revision(s.state.Draft) {
			failure(w, 409, "当前草稿已在其他窗口修改，请重新载入后再切换")
			return
		}
		p, i := find(r.PathValue("id"))
		if i < 0 {
			failure(w, 409, "请选择另一份已保存配置")
			return
		}
		if issues := validate(p.Draft); len(issues) > 0 {
			failure(w, 422, "目标配置未通过静态检查，当前配置与运行状态保持不变")
			return
		}
		old := current()
		if req.SaveCurrent != nil {
			if !validText(w, *req.SaveCurrent) {
				return
			}
			if *req.SaveCurrent != old.Draft {
				old.Draft = *req.SaveCurrent
				old.SavedAt = timestamp()
				old.History = append([]History{{ID: revision(old.Draft)[:12] + "-" + old.SavedAt, Kind: "save", At: old.SavedAt, Text: old.Draft}}, old.History...)
				if len(old.History) > 30 {
					old.History = old.History[:30]
				}
			}
		}
		next := s.state
		next.Profiles = append([]LocalProfile{}, s.state.Profiles...)
		next.Profiles[i] = old
		next.ProfileID = p.ID
		next.ProfileName = p.Name
		next.Draft = p.Draft
		next.SavedAt = p.SavedAt
		next.Applied = p.Draft
		next.AppliedAt = timestamp()
		next.History = append([]History{{ID: revision(p.Draft)[:12] + "-" + next.AppliedAt, Kind: "apply", At: next.AppliedAt, Text: p.Draft}}, p.History...)
		if len(next.History) > 30 {
			next.History = next.History[:30]
		}
		if commit(w, next, "切换配置") {
			s.runtime = runtimeFrom(next.Applied)
			jsonResponse(w, 200, s.snapshot())
		}
	}))
}
