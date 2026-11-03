package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestGroupOrderPreviewPreservesMembershipAndNeverChangesSelection(t *testing.T) {
	s := newTestServer(t)
	s.runtime.Selected["Group"] = "Sub-A"
	before, _ := os.ReadFile(s.path)
	input := GroupOrderPreview{
		Filter:        "(?=(?s:.*?)(?:Sub))\\ASub-B\\z`\\ASelf\\z`(?=(?s:.*?)(?:Sub))\\ADrop\\z`Sub",
		ExcludeFilter: "Skip",
		Sources: []MemberSource{
			{Manual: true, Nodes: []GroupMember{{Name: "Self", Type: "Direct"}}},
			{Name: "test", Nodes: []GroupMember{{Name: "Sub-A"}, {Name: "Drop"}, {Name: "Sub-Skip"}, {Name: "Sub-B"}}},
		},
	}
	w := workspaceCall(t, s, "POST", "/api/group-order/preview", input, s.state.ProfileID)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		Members []GroupMember `json:"members"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	names := []string{}
	for _, n := range result.Members {
		names = append(names, n.Name)
	}
	if !reflect.DeepEqual(names, []string{"Sub-B", "Self", "Sub-A"}) {
		t.Fatal(names)
	}
	after, _ := os.ReadFile(s.path)
	if string(before) != string(after) || s.runtime.Selected["Group"] != "Sub-A" {
		t.Fatal("preview changed state")
	}
	input.Filter = "["
	if w = workspaceCall(t, s, "POST", "/api/group-order/preview", input, s.state.ProfileID); w.Code != 422 {
		t.Fatal(w.Code)
	}
}

func TestGroupOrderLocalApplyRetainsInlineSubscriptionSelection(t *testing.T) {
	s := newTestServer(t)
	s.state.Applied = "profile: {store-selected: true}\nproxies: [{name: Self, type: direct}]\nproxy-providers:\n  test:\n    type: inline\n    payload: [{name: Sub-A, type: direct}, {name: Sub-B, type: direct}]\nproxy-groups:\n  - {name: Group, type: select, proxies: [Self, DIRECT], use: [test]}\nrules: ['MATCH,DIRECT']\n"
	s.state.Draft = s.state.Applied
	s.runtime = runtimeFrom(s.state.Applied)
	if w := dashboardCall(t, s, "PUT", "proxies/Group", map[string]string{"name": "Sub-A"}); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.state.Draft += "# order edit\n"
	// Amend only the group filter; the selected provider node remains a member.
	s.state.Draft = "proxy-groups:\n  - name: Group\n    type: select\n    proxies: [Self, DIRECT]\n    use: [test]\n    filter: '\\ASub-B\\z`\\ASelf\\z`[\\s\\S]*'\n" + "proxies: [{name: Self, type: direct}]\nproxy-providers:\n  test:\n    type: inline\n    payload: [{name: Sub-A, type: direct}, {name: Sub-B, type: direct}]\nrules: ['MATCH,DIRECT']\n"
	w := workspaceCall(t, s, "POST", "/api/apply", map[string]string{"revision": revision(s.state.Draft)}, s.state.ProfileID)
	if w.Code != 200 || s.runtime.Selected["Group"] != "Sub-A" {
		t.Fatal(w.Code, w.Body.String(), s.runtime.Selected)
	}
}

func TestGroupOrderPreviewFiltersAutomaticMembersBeforeMerging(t *testing.T) {
	input := GroupOrderPreview{
		Filter: "\\ASub-A\\z`\\AAuto-B\\z`Auto|Sub",
		Sources: []MemberSource{
			{Manual: true, Nodes: []GroupMember{{Name: "Self"}}, AutomaticNodes: []GroupMember{{Name: "Auto-A"}, {Name: "Auto-B"}, {Name: "Drop"}}},
			{Name: "test", Nodes: []GroupMember{{Name: "Sub-A"}}},
		},
	}
	members, err := previewGroupOrder(input)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, member := range members {
		names = append(names, member.Name)
	}
	if !reflect.DeepEqual(names, []string{"Sub-A", "Auto-B", "Auto-A", "Self"}) {
		t.Fatal(names)
	}
}
