package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An agent that dies before `ready` used to be reported as a successful connect: `waitReady` returned nil
// on EOF, `Connect` filed an empty session, and the socket sent `models: []` to a page whose agent was
// already gone. The only account of why is the child's stderr, so that is what the error has to carry.
func TestConnectFailsWithTheAgentsLastWords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dying-agent")
	script := "#!/bin/sh\necho 'model.conf: unknown model \"a/b\"' >&2\nexit 1\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}

	sessions := NewSessions(nil)
	connected, err := sessions.Connect(context.Background(), "dying", SpawnOptions{Binary: path})
	if err == nil {
		sessions.Close("dying", "test over")
		t.Fatalf("connect reported success: %+v", connected)
	}
	if !strings.Contains(err.Error(), "stopped before it was ready") {
		t.Errorf("error = %q, want it to say the agent stopped before ready", err)
	}
	if !strings.Contains(err.Error(), "unknown model") {
		t.Errorf("error = %q, want the agent's stderr in it", err)
	}
	// Nothing is filed: a caller that gets an error has no session, so a later connect must start fresh.
	if list := sessions.List(); len(list) != 0 {
		t.Errorf("a failed connect filed %d session(s)", len(list))
	}
}

// A process that ends without a word still has to produce a sentence rather than an empty one.
func TestConnectFailsWhenTheAgentSaysNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "silent-agent")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	sessions := NewSessions(nil)
	if _, err := sessions.Connect(context.Background(), "silent", SpawnOptions{Binary: path}); err == nil {
		sessions.Close("silent", "test over")
		t.Fatal("connect reported success for an agent that never spoke")
	} else if !strings.Contains(err.Error(), "ready") {
		t.Errorf("error = %q", err)
	}
}

// Which server a turn is sent to is the question behind most "why is it slow / why is it refused" reports, and the
// `model` frame cannot answer it: it carries the name and the id, and the address only ever arrives in
// `model_list`. So the answer is looked up, and the key is never part of it — `model_list` carries every `api_key`
// in cleartext and a log file is not the place for one (#255).
func TestDestinationNamesTheAddressTheActiveModelIsSentTo(t *testing.T) {
	state := startup{}
	if where := state.destination(); where != "" {
		t.Errorf("destination = %q before the agent named a model, want nothing", where)
	}

	state.collect("model_list", json.RawMessage(`{"models":[
		{"id":1,"name":"one","protocol_type":"openai","base_url":"http://127.0.0.1:1/v1","api_key":"sk-secret","model_name":"m1"},
		{"id":2,"name":"two","protocol_type":"anthropic","base_url":"https://api.example.com","api_key":"sk-secret","model_name":"claude-x"}
	]}`))
	state.collect("model", json.RawMessage(`{"active_id":2,"active_name":"two","context_limit":1000}`))

	want := `"two" -> https://api.example.com, model claude-x, anthropic`
	if where := state.destination(); where != want {
		t.Errorf("destination = %q, want %q", where, want)
	}
	if where := state.destination(); strings.Contains(where, "sk-secret") {
		t.Errorf("destination = %q, carries a key", where)
	}

	// A model with no name of its own is a server that names nothing (`whisper.cpp`'s `/inference` shape, and a
	// local llama.cpp with no alias): the address alone still says where the turn goes.
	state.collect("model_list", json.RawMessage(`{"models":[{"id":1,"name":"bare","protocol_type":"openai","base_url":"http://127.0.0.1:8080/v1"}]}`))
	state.collect("model", json.RawMessage(`{"active_id":1,"active_name":"bare","context_limit":0}`))
	if where := state.destination(); where != `"bare" -> http://127.0.0.1:8080/v1, openai` {
		t.Errorf("destination = %q, want the address without a model name", where)
	}

	// An active model whose entry is not in the list still says so, rather than looking like "no model".
	state.collect("model", json.RawMessage(`{"active_id":9,"active_name":"gone","context_limit":0}`))
	if where := state.destination(); where != `"gone" (its entry is not in the list)` {
		t.Errorf("destination = %q, want it to say the entry is missing", where)
	}
}

// The active model's limit comes out of the list, because the list is what an editor rewrites: `model_sync`
// restates it, and the `model` frame that named the active model is not sent again — to this session or to any
// other one. A limit copied out of that frame is a denominator nobody can correct, and the panel would keep
// drawing `22K/262144` for a model that now holds half of it (#347).
func TestTheActiveModelsLimitIsTheLists(t *testing.T) {
	state := startup{}
	state.collect("model_list", json.RawMessage(`{"models":[{"id":1,"name":"one","context_limit":1000}]}`))
	state.collect("model", json.RawMessage(`{"active_id":1,"active_name":"one","context_limit":1000}`))
	if got := state.event().Active.ContextLimit; got != 1000 {
		t.Fatalf("limit = %d, want the one the model frame stated", got)
	}

	// The file was edited and the agent restated the list; the model frame was not sent again.
	state.collect("model_list", json.RawMessage(`{"models":[{"id":1,"name":"one","context_limit":5000}]}`))
	if got := state.event().Active.ContextLimit; got != 5000 {
		t.Errorf("limit = %d after the list was restated, want 5000", got)
	}
	// What the agent said about which model this is stays what it said: the derived value is a copy, so a
	// state read twice cannot depend on what a page was told once.
	if got := state.active.ContextLimit; got != 1000 {
		t.Errorf("state.active was rewritten to %d; the frame stated 1000", got)
	}

	// A list that does not name the active model leaves the stated limit standing: it is the only account of
	// it there is.
	state.collect("model", json.RawMessage(`{"active_id":9,"active_name":"gone","context_limit":2000}`))
	if got := state.event().Active.ContextLimit; got != 2000 {
		t.Errorf("limit = %d for an active model its list does not name, want 2000", got)
	}
}
