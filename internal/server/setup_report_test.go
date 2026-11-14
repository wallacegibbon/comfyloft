package server

// The install page reports every registered workflow, tool or model.
//
// A presentation flag used to drop "helper" workflows from the totals and from the missing list,
// which is how the panel could read 14/14 while a toolbar button was missing three node classes.
// There is no such flag any more: a missing node behind a button is still missing.

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupReportsToolWorkflowProblems(t *testing.T) {
	fake := newFakeComfy(t)
	file, graph, entry := imageFixture()
	srv := newTestServerWith(t, fake, file, graph, entry)

	// A second workflow that needs a node class this ComfyUI does not have.
	toolGraph := map[string]any{
		"1": map[string]any{"class_type": "MissingUpscaleNode", "inputs": map[string]any{}},
	}
	writeFixture(t, filepath.Join(srv.cfg.WorkflowDir, "test-tool.json"), toolGraph)
	writeFixture(t, filepath.Join(srv.cfg.WorkflowDir, "registry.json"), map[string]any{
		"version": 1,
		"workflows": []any{
			entry,
			map[string]any{
				"id":         "video-tool",
				"name":       "video-tool",
				"type":       "video",
				"file":       "test-tool.json",
				"parameters": []any{},
				"bindings":   map[string]any{},
			},
		},
	})
	if _, err := srv.Setup().Scan(); err != nil {
		t.Fatalf("scan: %v", err)
	}

	status := srv.Setup().Status()
	if status.Counts.Total != 2 {
		t.Errorf("total = %d, want both workflows counted: %+v", status.Counts, status.Workflows)
	}
	found := false
	for _, missing := range status.Missing.Nodes {
		if strings.Contains(missing, "MissingUpscaleNode") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the tool workflow's missing node is not reported: %+v", status.Missing)
	}
}

// A workflow row no longer carries a presentation flag: the client decides what to offer.
func TestWorkflowsExposeNoHiddenFlag(t *testing.T) {
	fake := newFakeComfy(t)
	srv := newTestServer(t, fake)
	server := httptest.NewServer(srv.Handler())
	defer server.Close()

	code, payload := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/workflows", nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	rows, _ := payload["workflows"].([]any)
	if len(rows) == 0 {
		t.Fatal("no workflows")
	}
	row, _ := rows[0].(map[string]any)
	if _, present := row["hidden"]; present {
		t.Errorf("row still exposes hidden: %v", row)
	}
}

// A workflow no scan has judged is reported with a null verdict, not an unavailable one.
//
// "No verdict" is what a canvas sees the moment the server starts, and what it saw for two days when
// the first scan failed: the picker read "none configured on this canvas" while ComfyUI was fine. A
// null is the server saying it was unable to ask, which the canvas offers anyway (decisions #351).
func TestWorkflowsReportANullVerdictForAWorkflowNoScanHasJudged(t *testing.T) {
	fake := newFakeComfy(t)
	srv := newTestServer(t, fake)
	server := httptest.NewServer(srv.Handler())
	defer server.Close()

	// A second entry the scan has not seen. registry.json is the server's own file and a hand edit
	// takes effect on the next read (`ReloadIfChanged`), without a scan — so this is exactly the state
	// of a workflow that exists and has no verdict.
	_, graph, entry := imageFixture()
	second := map[string]any{}
	for key, value := range entry {
		second[key] = value
	}
	second["id"] = "image-two"
	second["name"] = "image-two"
	second["file"] = "test-two.json"
	writeFixture(t, filepath.Join(srv.cfg.WorkflowDir, "test-two.json"), graph)
	writeFixture(t, filepath.Join(srv.cfg.WorkflowDir, "registry.json"), map[string]any{
		"version":   1,
		"workflows": []any{entry, second},
	})

	code, payload := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/workflows", nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	rows := map[string]map[string]any{}
	for _, raw := range payload["workflows"].([]any) {
		row := raw.(map[string]any)
		rows[row["id"].(string)] = row
	}

	if verdict, _ := rows["image-test"]["availability"].(map[string]any); verdict == nil {
		t.Errorf("image-test availability = %v, want the scan's verdict", rows["image-test"]["availability"])
	}
	verdict, present := rows["image-two"]["availability"]
	if !present {
		t.Fatal("image-two has no availability key: every row carries one, null included")
	}
	if verdict != nil {
		t.Errorf("image-two availability = %v, want null: no scan has judged it", verdict)
	}
}
