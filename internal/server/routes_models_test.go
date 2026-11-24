package server

// The model editor, through the HTTP layer: the file it reads and writes, and the one thing it asks an
// agent for.
//
// `model.conf` is the list — there is no command that takes one (AlayaCore's v19 removed `:model_sync`) — so
// these tests are about the file: that an edit keeps what the page was never shown, that a file this server
// writes is a file that loads, and that a running agent is told to read it again without the editor ever
// having to start one.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"comfyloft/internal/config"
)

// theOperatorModels is a `model.conf` as a person writes one: two models with keys, a reasoning block, token
// caps, a comment, and a key this build does not know (which a newer AlayaCore might).
const theOperatorModels = `name: "V100 / Qwen"
protocol_type: "openai"
base_url: "http://172.16.9.7:9999/v1"
api_key: "sk-one"
model_name: "qwen3.8-27b"
context_limit: 262144
max_tokens: 65536
---
# the model kept below is the one with the blocks and the line this build does not know
name: "DeepSeek / Flash"
protocol_type: "openai"
base_url: "https://api.deepseek.com"
api_key: "sk-two"
model_name: "deepseek-flash"
reasoning_1: {"reasoning_effort":"medium"}
serial_tool_calls: true
input_modalities: []
future_option: "kept"
`

// startModelServer is a server whose agent is the fake binary and whose configuration directory is this
// test's, so the file the route writes can be read back.
func startModelServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "fake-agent")
	if err := os.WriteFile(binary, []byte(fakeAgentScript), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	configDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(configDir, "model.conf"), []byte(theOperatorModels), 0o644); err != nil {
		t.Fatalf("write model.conf: %v", err)
	}
	t.Setenv("ALAYACORE_BIN", binary)
	t.Setenv("FAKE_SPAWN_LOG", filepath.Join(dir, "spawned"))
	t.Setenv("FAKE_LOAD_LOG", filepath.Join(dir, "loaded"))

	server := httptest.NewServer(newTestServer(t, newFakeComfy(t), config.WithAgentConfigPath(configDir)).Handler())
	t.Cleanup(server.Close)
	return server, configDir
}

// modelsOf is one answer's `models`, as the page reads them.
func modelsOf(t *testing.T, payload map[string]any) []map[string]any {
	t.Helper()
	raw, ok := payload["models"].([]any)
	if !ok {
		t.Fatalf("answer has no models: %v", payload)
	}
	entries := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("a model is not an object: %v", entry)
		}
		entries = append(entries, object)
	}
	return entries
}

// TestTheModelEditorNeedsNoAgent is the point of writing the file here: the list is visible, editable and
// written with no agent process anywhere — which is the state the editor is most needed in, because a
// `model.conf` with no usable model stops AlayaCore before it is ready.
func TestTheModelEditorNeedsNoAgent(t *testing.T) {
	server, configDir := startModelServer(t)

	status, payload := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agent/models", nil)
	if status != http.StatusOK {
		t.Fatalf("GET models = %d: %v", status, payload)
	}
	models := modelsOf(t, payload)
	if len(models) != 2 {
		t.Fatalf("models = %v, want the two in the file", models)
	}
	first := models[0]
	if first["id"] != float64(1) || first["name"] != "V100 / Qwen" || first["modelName"] != "qwen3.8-27b" {
		t.Errorf("first model = %v", first)
	}
	if first["hasKey"] != true || first["maxTokens"] != float64(65536) {
		t.Errorf("first model's key, cap or tool-call mode = %v", first)
	}
	if encoded, _ := json.Marshal(payload); strings.Contains(string(encoded), "sk-one") || strings.Contains(string(encoded), "sk-two") {
		t.Fatalf("a key travelled to the page: %s", encoded)
	}
	// `[]` reaches the page as an empty declaration, not as "not declared": the two are different settings.
	if list, ok := models[1]["inputModalities"].([]any); !ok || len(list) != 0 {
		t.Errorf("an empty declaration came out as %v", models[1]["inputModalities"])
	}
	if models[1]["serialToolCalls"] != true {
		t.Errorf("serial_tool_calls came out as %v", models[1]["serialToolCalls"])
	}
	// The one line this build does not write is reported as a note and left where it is: a newer AlayaCore may
	// read it, and deleting it is this server's call to make only if nobody can use it.
	if problems, ok := payload["problems"].([]any); !ok || len(problems) != 1 || !strings.Contains(problems[0].(string), "future_option") {
		t.Errorf("problems = %v, want the foreign key named once", payload["problems"])
	}

	// The page keeps the second model, renames it, and adds one of its own with a key.
	body := map[string]any{"models": []any{
		map[string]any{
			"id": 2, "name": "DeepSeek / renamed", "protocol_type": "openai",
			"base_url": "https://api.deepseek.com", "model_name": "deepseek-flash",
		},
		map[string]any{
			"name": "New / Claude", "protocol_type": "anthropic", "base_url": "https://api.anthropic.com",
			"model_name": "claude-haiku-4", "api_key": "sk-new", "context_limit": 200000,
		},
	}}
	status, payload = doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agent/models", body)
	if status != http.StatusOK {
		t.Fatalf("PUT models = %d: %v", status, payload)
	}
	if models := modelsOf(t, payload); len(models) != 2 || models[1]["hasKey"] != true {
		t.Fatalf("the answer = %v, want the two models that were written", models)
	}

	written, err := os.ReadFile(filepath.Join(configDir, "model.conf"))
	if err != nil {
		t.Fatalf("read model.conf: %v", err)
	}
	file := string(written)
	// The kept model: the page's name, and the key, the reasoning block, the tool-call mode, the declaration
	// and the unknown line it never saw.
	for _, want := range []string{`name: "DeepSeek / renamed"`, `api_key: "sk-two"`, `reasoning_1: {"reasoning_effort":"medium"}`, "serial_tool_calls: true", `future_option: "kept"`, "input_modalities: []"} {
		if !strings.Contains(file, want) {
			t.Errorf("the kept model lost %q:\n%s", want, file)
		}
	}
	// The one that was deleted is gone — and its key with it, rather than moving to another model.
	if strings.Contains(file, "V100 / Qwen") || strings.Contains(file, "sk-one") {
		t.Errorf("a deleted model survived:\n%s", file)
	}
	// The new one, with the key that was typed.
	for _, want := range []string{`name: "New / Claude"`, `api_key: "sk-new"`, `context_limit: 200000`, `protocol_type: "anthropic"`} {
		if !strings.Contains(file, want) {
			t.Errorf("the new model is missing %q:\n%s", want, file)
		}
	}
	// And the file is only its owner's to read: it holds keys.
	info, err := os.Stat(filepath.Join(configDir, "model.conf"))
	if err != nil {
		t.Fatalf("stat model.conf: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("model.conf mode = %v, want 0600", mode)
	}

	// The point: no agent was started to do any of it.
	if count := spawns(t, os.Getenv("FAKE_SPAWN_LOG")); count != 0 {
		t.Fatalf("the editor started %d agent(s); the file needs none", count)
	}
}

// TestSavingModelsReloadsALiveAgent: a running process holds the list it read at startup, so a write is
// followed by `:model_load` — and what that process says afterwards is what the canvas is shown.
func TestSavingModelsReloadsALiveAgent(t *testing.T) {
	server, _ := startModelServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	status, payload := doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agent/models", map[string]any{
		"models": []any{
			map[string]any{"id": 1, "name": "V100 / Qwen", "protocol_type": "openai", "base_url": "http://172.16.9.7:9999/v1", "model_name": "qwen3.8-27b"},
			map[string]any{"id": 2, "name": "DeepSeek / Flash", "protocol_type": "openai", "base_url": "https://api.deepseek.com", "model_name": "deepseek-flash"},
		},
	})
	if status != http.StatusOK {
		t.Fatalf("PUT models = %d: %v", status, payload)
	}

	// The canvas is told the list the agent restated — with the ids it assigned, and no key. `openSocket` has
	// already drained the startup broadcast, the history and the turn, so this is news the write caused.
	event := nextEvent(t, conn)
	if event["type"] != "models" {
		t.Fatalf("the canvas received %v, want the restated model list", event)
	}
	models, _ := event["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("models = %v, want the one the fake agent restated", event["models"])
	}
	if encoded, _ := json.Marshal(event); strings.Contains(string(encoded), "secret-key-2") {
		t.Fatalf("the restated list carried a key: %s", encoded)
	}

	// And the agent was asked to read the file again. Asserted after the restated list, because that is the
	// answer to this command: the log line is written before the frames it precedes.
	raw, err := os.ReadFile(os.Getenv("FAKE_LOAD_LOG"))
	if err != nil {
		t.Fatalf("the agent received no model_load: %v", err)
	}
	if !strings.Contains(string(raw), `"name":"model_load"`) {
		t.Fatalf("the agent was sent %q, want model_load", raw)
	}
}

// TestAnEditReplacesOnlyWhatItSays is the merge the page relies on: it can see every field but the key, so an
// entry it sends has to say exactly what changed and nothing about what it has never been shown.
func TestAnEditReplacesOnlyWhatItSays(t *testing.T) {
	server, configDir := startModelServer(t)

	// Model 2: a key retyped, the reasoning block cleared, and the media declaration stated as "none". Model 1:
	// nothing said at all, so everything it has stays — key, caps, and the block the page never opened.
	save := map[string]any{"models": []any{
		map[string]any{"id": 1},
		map[string]any{"id": 2, "api_key": "sk-rotated", "reasoning_1": nil, "input_modalities": []any{}},
	}}
	status, payload := doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agent/models", save)
	if status != http.StatusOK {
		t.Fatalf("PUT models = %d: %v", status, payload)
	}
	// The ids are the positions, and the answer says which is which.
	for index, model := range modelsOf(t, payload) {
		if model["id"] != float64(index+1) {
			t.Errorf("model %d has id %v, want its position", index, model["id"])
		}
	}

	written, err := os.ReadFile(filepath.Join(configDir, "model.conf"))
	if err != nil {
		t.Fatalf("read model.conf: %v", err)
	}
	file := string(written)
	// The first model is untouched: a page that says nothing about a field does not clear it.
	for _, want := range []string{`api_key: "sk-one"`, "max_tokens: 65536"} {
		if !strings.Contains(file, want) {
			t.Errorf("an untouched model lost %q:\n%s", want, file)
		}
	}
	// The second: the key replaced, the block gone, the declaration now empty, and the rest as it was.
	if !strings.Contains(file, `api_key: "sk-rotated"`) || strings.Contains(file, `api_key: "sk-two"`) {
		t.Errorf("the key was not replaced:\n%s", file)
	}
	if strings.Contains(file, "reasoning_1") {
		t.Errorf("a cleared block is still in the file:\n%s", file)
	}
	if !strings.Contains(file, "input_modalities: []") {
		t.Errorf("an empty declaration did not survive as one:\n%s", file)
	}
	if !strings.Contains(file, `future_option: "kept"`) {
		t.Errorf("a line this build does not know was dropped by an unrelated edit:\n%s", file)
	}
}

// TestSavingModelsRefusesWhatAlayaCoreWouldSkip: the file is the only place a model exists, so an entry
// AlayaCore would reject at load is refused before it is written — otherwise the row is on screen and the
// model is not in the picker, with nothing but a startup line to explain it.
func TestSavingModelsRefusesWhatAlayaCoreWouldSkip(t *testing.T) {
	server, configDir := startModelServer(t)

	for name, body := range map[string]map[string]any{
		"unknown protocol":           {"models": []any{map[string]any{"name": "x", "protocol_type": "ollama", "base_url": "http://h/v1", "model_name": "m"}}},
		"no address":                 {"models": []any{map[string]any{"name": "x", "protocol_type": "openai", "model_name": "m"}}},
		"address is a host and port": {"models": []any{map[string]any{"name": "x", "protocol_type": "openai", "base_url": "localhost:11434", "model_name": "m"}}},
		"no model name":              {"models": []any{map[string]any{"name": "x", "protocol_type": "openai", "base_url": "http://h/v1"}}},
		"unknown media":              {"models": []any{map[string]any{"name": "x", "protocol_type": "openai", "base_url": "http://h/v1", "model_name": "m", "input_modalities": []any{"vision"}}}},
		"one name twice": {"models": []any{
			map[string]any{"name": "same", "protocol_type": "openai", "base_url": "http://h/v1", "model_name": "m"},
			map[string]any{"name": "same", "protocol_type": "openai", "base_url": "http://h2/v1", "model_name": "m2"},
		}},
	} {
		status, payload := doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agent/models", body)
		if status != http.StatusBadRequest {
			t.Errorf("%s answered %d, want a 400: %v", name, status, payload)
		}
	}

	// Nothing was written: the file is exactly what it was, keys and all.
	written, err := os.ReadFile(filepath.Join(configDir, "model.conf"))
	if err != nil {
		t.Fatalf("read model.conf: %v", err)
	}
	if string(written) != theOperatorModels {
		t.Fatalf("a refused save wrote the file:\n%s", written)
	}

	// A reasoning block that is not an object is the one the page cannot check on its own path: it is refused
	// with the field named.
	status, payload := doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agent/models", map[string]any{
		"models": []any{map[string]any{
			"id": 1, "name": "V100 / Qwen", "protocol_type": "openai",
			"base_url": "http://172.16.9.7:9999/v1", "model_name": "qwen3.8-27b",
			"reasoning_1": "{\"reasoning_effort\":\"high\"}",
		}},
	})
	if encoded, _ := json.Marshal(payload); status != http.StatusBadRequest || !strings.Contains(string(encoded), "reasoning_1") {
		t.Fatalf("a block that is not an object answered %d: %v", status, payload)
	}
}

// TestSavingModelsRefusesAnIdTheFileDoesNotHave: an id is a position, and a page working from a list that has
// moved would otherwise duplicate a model rather than being told to reload.
func TestSavingModelsRefusesAnIdTheFileDoesNotHave(t *testing.T) {
	server, _ := startModelServer(t)
	status, payload := doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agent/models", map[string]any{
		"models": []any{map[string]any{"id": 9, "name": "x", "protocol_type": "openai", "base_url": "http://h/v1", "model_name": "m"}},
	})
	if status != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %v", status, payload)
	}
}

// TestAFileThisBuildCannotFullyReadIsShownAndRepaired: the editor is where a broken `model.conf` is repaired
// from, so it shows what it can, says what it could not read, and the next save writes a file that parses —
// without the lines nothing could read, and with everything else untouched.
func TestAFileThisBuildCannotFullyReadIsShownAndRepaired(t *testing.T) {
	server, configDir := startModelServer(t)
	broken := `# a note that stays
name: "one"
protocol_type: "openai"
base_url: "http://h/v1"
model_name: "m"
context_limit: 262144k
this line has no colon
`
	if err := os.WriteFile(filepath.Join(configDir, "model.conf"), []byte(broken), 0o644); err != nil {
		t.Fatalf("write model.conf: %v", err)
	}

	status, payload := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agent/models", nil)
	if status != http.StatusOK {
		t.Fatalf("GET models = %d: %v", status, payload)
	}
	if models := modelsOf(t, payload); len(models) != 1 {
		t.Fatalf("models = %v, want the one block", models)
	}
	problems, _ := payload["problems"].([]any)
	if len(problems) != 2 {
		t.Fatalf("problems = %v, want the value and the line named", problems)
	}
	joined := problems[0].(string) + " / " + problems[1].(string)
	if !strings.Contains(joined, "context_limit") || !strings.Contains(joined, "key: value") {
		t.Fatalf("problems = %q, want the two lines named", joined)
	}

	// Saving the entry: the note stays, the two unusable lines do not, and the field the page did not state is
	// not invented — an entry edited for its name is not an entry with a context limit of zero.
	save := map[string]any{"models": []any{map[string]any{
		"id": 1, "name": "renamed", "protocol_type": "openai", "base_url": "http://h/v1", "model_name": "m",
	}}}
	status, payload = doJSON(t, server.Client(), http.MethodPut, server.URL+"/api/agent/models", save)
	if status != http.StatusOK {
		t.Fatalf("PUT models = %d: %v", status, payload)
	}
	if remaining, ok := payload["problems"]; ok {
		t.Errorf("the file still has problems after the save: %v", remaining)
	}
	written, err := os.ReadFile(filepath.Join(configDir, "model.conf"))
	if err != nil {
		t.Fatalf("read model.conf: %v", err)
	}
	file := string(written)
	if !strings.Contains(file, `name: "renamed"`) || !strings.Contains(file, "# a note that stays") {
		t.Errorf("the edit or the note was lost:\n%s", file)
	}
	for _, gone := range []string{"262144k", "this line has no colon", "context_limit"} {
		if strings.Contains(file, gone) {
			t.Errorf("%q is still in the file after a save:\n%s", gone, file)
		}
	}
}

// TestTheModelFileIsReadFromTheAgentConfigurationDirectory: the file is not somewhere this server invents.
// A server with no configuration directory to name says so instead of writing `model.conf` into its working
// directory.
func TestTheModelFileIsReadFromTheAgentConfigurationDirectory(t *testing.T) {
	srv := newTestServer(t, newFakeComfy(t), config.WithAgentConfigPath(""))
	server := httptest.NewServer(srv.Handler())
	defer server.Close()

	status, payload := doJSON(t, server.Client(), http.MethodGet, server.URL+"/api/agent/models", nil)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %v", status, payload)
	}
	if encoded, _ := json.Marshal(payload); !strings.Contains(string(encoded), "AGENT_CONFIG_PATH") {
		t.Fatalf("message = %v, want it to name the setting", payload)
	}
}
