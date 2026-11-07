package server

// The agent routes, through the HTTP layer. The fake agent speaks the same wire the real one does, so
// these tests describe the translation: frames in, messages out, and nothing invented on the way.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"comfyloft/internal/comfy"
	"comfyloft/internal/config"
)

// The fake agent speaks AlayaCore's wire, including the part that matters for a reload: `--session <file>`
// is the conversation. It replays that file before it says it is ready, and appends each finished turn to
// it, which is the contract the server is written against.
const fakeAgentScript = `#!/bin/sh
printf '%s\n' "$$" >> "$FAKE_SPAWN_LOG"
if [ -n "$FAKE_ENV_LOG" ]; then
  printf '%s|%s\n' "$COMFYLOFT_MCP" "$COMFYLOFT_SESSION" >> "$FAKE_ENV_LOG"
fi
SESSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'SM{"type":"version","data":{"message_version":18,"core_version":"fake-1"}}\n'
printf 'SM{"type":"model_list","data":{"models":[{"id":1,"name":"Fake / one","protocol_type":"openai","base_url":"http://127.0.0.1:1/v1","api_key":"secret-key","model_name":"m","context_limit":1000},{"id":2,"name":"Fake / two","protocol_type":"openai","base_url":"http://127.0.0.1:1/v1","api_key":"secret-key-2","model_name":"m2","context_limit":2000}]}}\n'
printf 'SM{"type":"model","data":{"active_id":1,"active_name":"Fake / one","context_limit":1000}}\n'
printf 'SM{"type":"reasoning_level","data":{"level":1}}\n'
if [ -n "$SESSION" ] && [ -f "$SESSION" ]; then
  cat "$SESSION"
fi
printf 'SM{"type":"session","data":{"state":"ready"}}\n'
while IFS= read -r line; do
  case "$line" in
    CI*'"name":"model_sync"'*)
      if [ -n "$FAKE_SYNC_LOG" ]; then printf '%s\n' "$line" >> "$FAKE_SYNC_LOG"; fi
      printf 'SM{"type":"model_list","data":{"models":[{"id":1,"name":"Fake / renamed","protocol_type":"openai","base_url":"http://127.0.0.1:1/v1","api_key":"secret-key-2","model_name":"m2","context_limit":2000}]}}\n'
      printf 'CO{"command_id":"1","result":{"models":[{"id":1,"name":"Fake / renamed"}]}}\n' ;;
    CI*'"name":"model_set"'*)
      case "$line" in
        *'"args":"2"'*)
          printf 'SM{"type":"model","data":{"active_id":2,"active_name":"Fake / two","context_limit":2000}}\n'
          printf 'CO{"command_id":"1","result":{"active_id":2,"active_name":"Fake / two"}}\n' ;;
        *)
          printf 'CO{"command_id":"1","is_error":true,"result":{"code":"REQUEST_MODEL_UNKNOWN","message":"model_set: model not found: 99"}}\n' ;;
      esac ;;
    UX*'summarize'*)
      printf '%s\n' "$line"
      SUMMARIZE=1 ;;
    UX*'die'*)
      exit 0 ;;
    UX*slow*)
      printf '%s\n' "$line"
      if [ -n "$SESSION" ]; then printf '%s\n' "$line" >> "$SESSION"; fi
      printf 'SM{"type":"task","data":{"in_progress":true}}\n'
      sleep 2
      printf 'Ax{"id":"2","type":"text","text":"slow answer"}\n'
      printf 'SM{"type":"task","data":{"in_progress":false}}\n' ;;
    UX*'[comfyloft]'*)
      printf '%s\n' "$line"
      printf 'SM{"type":"task","data":{"in_progress":true}}\n'
      printf 'Ax{"id":"2","type":"text","text":"carrying on"}\n'
      printf 'SM{"type":"task","data":{"in_progress":false}}\n' ;;
    UX*text*)
      printf '%s\n' "$line"
      if [ -n "$SESSION" ]; then printf '%s\n' "$line" >> "$SESSION"; fi ;;
    UE)
      if [ -n "$SUMMARIZE" ]; then
        printf 'SM{"type":"notify","data":{"text":"Summarizing conversation..."}}\n'
        printf 'SM{"type":"task","data":{"in_progress":true}}\n'
        printf 'AF{"call_id":"call-2","name":"read_file","id":"3"}\n'
        printf 'UF{"call_id":"call-2","output":[{"type":"text","text":"no such file"}],"is_error":true,"id":"4"}\n'
        printf 'Ax{"id":"2","type":"text","text":"done"}\n'
        printf 'SM{"type":"task","data":{"in_progress":false}}\n'
        continue
      fi
      printf 'SM{"type":"steering","data":{"phase":"queued","text":"steering queued"}}\n'
      printf 'SM{"type":"task","data":{"in_progress":true,"current_step":1,"context_tokens":5}}\n'
      printf 'AF{"call_id":"call-1","name":"read_file","id":"3"}\n'
      printf 'AF{"call_id":"call-1","input":{"path":"/skills/SKILL.md"},"id":"3"}\n'
      printf 'UF{"call_id":"call-1","output":[{"type":"text","text":"a file"}],"id":"4"}\n'
      printf 'Ax{"id":"2","type":"text","text":"hello "}\n'
      printf 'Ax{"id":"2","type":"text","text":"world"}\n'
      printf 'SM{"type":"steering","data":{"phase":"delivered"}}\n'
      printf 'SM{"type":"task","data":{"in_progress":false,"context_tokens":9}}\n'
      if [ -n "$SESSION" ]; then
        printf 'AX{"type":"reasoning","text":"thinking about it"}\n' >> "$SESSION"
        printf 'AF{"call_id":"call-1","name":"read_file","input":{"path":"/skills/SKILL.md"}}\n' >> "$SESSION"
        printf 'UF{"call_id":"call-1","output":[{"type":"text","text":"a file"}],"id":"4"}\n' >> "$SESSION"
        printf 'AX{"type":"text","text":"hello world"}\n' >> "$SESSION"
      fi ;;
  esac
done
`

// startAgentServer is a server whose agent is the fake binary, plus the file it appends its pid to.
func startAgentServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "fake-agent")
	if err := os.WriteFile(binary, []byte(fakeAgentScript), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	spawnLog := filepath.Join(dir, "spawned")
	t.Setenv("FAKE_SPAWN_LOG", spawnLog)
	// config.Load reads this; newTestServer builds the config inside the call below.
	t.Setenv("ALAYACORE_BIN", binary)

	server := httptest.NewServer(newTestServer(t, newFakeComfy(t), config.WithAgentConfigPath(t.TempDir())).Handler())
	t.Cleanup(server.Close)
	return server, spawnLog
}

// spawns counts how many agent processes this server has started.
func spawns(t *testing.T, path string) int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return len(strings.Split(strings.TrimSpace(string(raw)), "\n"))
}

// canvasSession makes a canvas through the API and answers the name its panel gives the session: `canvas:`
// and the canvas id, which is also the canvas whose directory keeps the conversation (#178).
func canvasSession(t *testing.T, server *httptest.Server) string {
	t.Helper()
	response, err := server.Client().Post(server.URL+"/api/canvases", "application/json", strings.NewReader(`{"title":"Talked to"}`))
	if err != nil {
		t.Fatalf("create canvas: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create canvas: status %d", response.StatusCode)
	}
	var body struct {
		Canvas struct {
			ID string `json:"id"`
		} `json:"canvas"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("create canvas: %v", err)
	}
	if body.Canvas.ID == "" {
		t.Fatal("create canvas: no id")
	}
	return "canvas:" + body.Canvas.ID
}

// socketURL is one session's socket. Nothing in it says whether the conversation is kept: the server reads
// that from the name.
func socketURL(server *httptest.Server, session string) string {
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/api/agent/socket/" + session
}

// openSocket dials a canvas's conversation and drains what a client is given before it says anything: the
// startup broadcast, the conversation so far, and whether a turn is running.
func openSocket(t *testing.T, server *httptest.Server, session string) *comfy.WSConn {
	t.Helper()
	conn, _, _ := connect(t, server, session)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// connect is openSocket that keeps what it read: the conversation the session is holding, and whether a
// turn is in flight. Three messages, in this order, every time — a page draws itself from them and asks
// nothing else.
func connect(t *testing.T, server *httptest.Server, session string) (*comfy.WSConn, []any, bool) {
	t.Helper()
	conn, err := comfy.DialWS(context.Background(), socketURL(server, session))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if first := nextEvent(t, conn); first["type"] != "models" {
		t.Fatalf("first message = %v, want the agent's startup broadcast", first)
	}
	// Then the conversation the session is holding, always — empty for a fresh one.
	history := nextEvent(t, conn)
	if history["type"] != "history" {
		t.Fatalf("second message = %v, want the replayed history", history)
	}
	// Then whether a turn is in flight, which a page cannot tell from the transcript.
	turn := nextEvent(t, conn)
	if turn["type"] != "turn" {
		t.Fatalf("third message = %v, want the state of the turn", turn)
	}
	replayed, _ := history["history"].([]any)
	running, _ := turn["running"].(bool)
	return conn, replayed, running
}

// kindsOf is the types of a replayed conversation, in order: what a page would draw it from.
func kindsOf(replayed []any) string {
	kinds := make([]string, 0, len(replayed))
	for _, entry := range replayed {
		event, _ := entry.(map[string]any)
		kind, _ := event["type"].(string)
		kinds = append(kinds, kind)
	}
	return strings.Join(kinds, ",")
}

// replayedText is the answer as a replayed conversation carries it: the deltas, in order.
func replayedText(replayed []any) string {
	var text string
	for _, entry := range replayed {
		event, _ := entry.(map[string]any)
		if event["type"] == "delta" {
			if said, ok := event["text"].(string); ok {
				text += said
			}
		}
	}
	return text
}

// nextEvent reads one message from the socket.
func nextEvent(t *testing.T, conn *comfy.WSConn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, err := conn.ReadMessage(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var event map[string]any
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("message is not JSON: %v (%q)", err, raw)
	}
	return event
}

// textOf is the answer as a client assembles it: the deltas, in order.
func textOf(events []map[string]any) string {
	var text string
	for _, event := range events {
		if event["type"] == "delta" {
			text += event["text"].(string)
		}
	}
	return text
}

// until reads messages until one of this type arrives, and returns everything it saw.
func until(t *testing.T, conn *comfy.WSConn, kind string) []map[string]any {
	t.Helper()
	var seen []map[string]any
	for i := 0; i < 200; i++ {
		event := nextEvent(t, conn)
		seen = append(seen, event)
		if event["type"] == kind {
			return seen
		}
	}
	t.Fatalf("no %q among %v", kind, seen)
	return nil
}

func send(t *testing.T, conn *comfy.WSConn, message map[string]any) {
	t.Helper()
	payload, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := conn.WriteText(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestSocketStartsWithTheModelList(t *testing.T) {
	server, _ := startAgentServer(t)
	conn, err := comfy.DialWS(context.Background(), socketURL(server, canvasSession(t, server)))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	event := nextEvent(t, conn)
	if event["type"] != "models" {
		t.Fatalf("first message = %v, want models", event)
	}
	models, _ := event["models"].([]any)
	if len(models) != 2 {
		t.Errorf("models = %v, want the agent's list", models)
	}
	if active, _ := event["active"].(map[string]any); active["name"] != "Fake / one" {
		t.Errorf("active = %v, want the agent's own choice", event["active"])
	}
	// The agent's keys travel in SM model_list and must not reach the canvas. Where a model points does,
	// because two models called the same thing are told apart by it.
	encoded, _ := json.Marshal(event)
	if strings.Contains(string(encoded), "secret-key") || strings.Contains(string(encoded), "api_key") {
		t.Errorf("credentials reached the client: %s", encoded)
	}
	for _, model := range models {
		entry, _ := model.(map[string]any)
		if entry["hasKey"] != true {
			t.Errorf("%v: hasKey is not reported", entry)
		}
		if entry["baseUrl"] == nil || entry["modelName"] == nil {
			t.Errorf("%v: the canvas is not told where the model points", entry)
		}
	}
}

func TestSocketAnswersAPrompt(t *testing.T) {
	server, _ := startAgentServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	send(t, conn, map[string]any{"prompt": "hi"})
	seen := until(t, conn, "done")

	if text := textOf(seen); text != "hello world" {
		t.Fatalf("deltas = %q, want the answer", text)
	}
	// And the end of the turn carries no second copy of it.
	if last := seen[len(seen)-1]; last["text"] != nil {
		t.Fatalf("done = %v, want a marker rather than the answer again", last)
	}
}

// TestSocketAnswersAgainOnTheSameConnection is what a conversation is: the second message goes to the
// same process, so the agent still has the first in front of it.
func TestSocketAnswersAgainOnTheSameConnection(t *testing.T) {
	server, spawnLog := startAgentServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	for turn := 1; turn <= 2; turn++ {
		send(t, conn, map[string]any{"prompt": "hi"})
		if seen := until(t, conn, "done"); textOf(seen) != "hello world" {
			t.Fatalf("turn %d = %v", turn, seen)
		}
	}
	if got := spawns(t, spawnLog); got != 1 {
		t.Fatalf("spawned %d agents for one conversation, want 1", got)
	}
}

// TestTheNewestSocketTakesTheSessionOver: two connections to one name, and the agent's words go to the
// one that opened last — the tab the person is looking at. The first is told it lost the session instead
// of being left to wait for answers that will never arrive (#160).
func TestTheNewestSocketTakesTheSessionOver(t *testing.T) {
	server, _ := startAgentServer(t)
	session := canvasSession(t, server)
	first := openSocket(t, server, session)

	second, err := comfy.DialWS(context.Background(), socketURL(server, session))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer second.Close()

	// The new connection gets the startup broadcast, not a refusal.
	if event := nextEvent(t, second); event["type"] != "models" {
		t.Fatalf("second socket got %v, want the model list", event)
	}

	// And it is the one the agent answers.
	send(t, second, map[string]any{"prompt": "hi"})
	if seen := until(t, second, "done"); textOf(seen) != "hello world" {
		t.Fatalf("second connection did not get the answer: %v", seen)
	}

	// The first connection heard that it was replaced.
	replaced := nextEvent(t, first)
	if replaced["type"] != "closed" {
		t.Fatalf("the replaced socket got %v, want closed", replaced)
	}
}

// TestTheReplacedSocketDoesNotTakeTheAgentWithIt: losing the session is not the same as ending it. When
// the replaced tab is closed — the ordinary end of a socket nobody is reading any more — the agent has to
// keep running for the tab that took over, or closing an old tab silently kills the conversation the
// person is looking at.
func TestTheReplacedSocketDoesNotTakeTheAgentWithIt(t *testing.T) {
	server, spawnLog := startAgentServer(t)
	session := canvasSession(t, server)
	first := openSocket(t, server, session)

	second, err := comfy.DialWS(context.Background(), socketURL(server, session))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer second.Close()
	for _, want := range []string{"models", "history", "turn"} {
		if event := nextEvent(t, second); event["type"] != want {
			t.Fatalf("second socket got %v, want %s", event, want)
		}
	}
	if event := nextEvent(t, first); event["type"] != "closed" {
		t.Fatalf("the replaced socket got %v, want closed", event)
	}

	// The replaced connection goes away, which is the moment the session used to be released.
	if err := first.Close(); err != nil {
		t.Fatalf("close the replaced socket: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	// The agent still answers the tab that owns it now, and it is the same process.
	send(t, second, map[string]any{"prompt": "hi"})
	if seen := until(t, second, "done"); textOf(seen) != "hello world" {
		t.Fatalf("the agent stopped when the replaced socket closed: %v", seen)
	}
	if got := spawns(t, spawnLog); got != 1 {
		t.Fatalf("spawned %d agents, want the one the session already had", got)
	}
}

// TestSocketRelaysTheUsersWordsOnce: the agent echoes what the canvas sent, and that echo — not a copy the
// panel made — is what a user message is drawn from. Live and replayed arrive the same way.
func TestSocketRelaysTheUsersWordsOnce(t *testing.T) {
	server, _ := startAgentServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	send(t, conn, map[string]any{"prompt": "remember the violet"})
	seen := until(t, conn, "done")
	var said []string
	for _, event := range seen {
		if event["type"] == "user" {
			said = append(said, event["text"].(string))
		}
	}
	if len(said) != 1 || said[0] != "remember the violet" {
		t.Fatalf("user messages = %v, want the words once", said)
	}
}

// TestSessionThatIsNotACanvasKeepsNothing: the models editor has no canvas to keep a conversation in, so it
// gets no file — and that is a fact about the name, not a flag a client sets.
func TestSessionThatIsNotACanvasKeepsNothing(t *testing.T) {
	server, api, _ := startMCPServer(t)
	conn, err := comfy.DialWS(context.Background(), socketURL(server, "settings"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	t.Cleanup(func() { _ = conn.Close() })
	if first := nextEvent(t, conn); first["type"] != "models" {
		t.Fatalf("first message = %v, want the startup broadcast", first)
	}
	if next := nextEvent(t, conn); next["type"] != "history" {
		t.Fatalf("second message = %v, want an empty history", next)
	}

	send(t, conn, map[string]any{"prompt": "describe the sea"})
	until(t, conn, "done")

	// There is nowhere for it to go: a conversation is kept inside its canvas, and this name is not one.
	if file, err := api.sessionFile("settings"); err == nil {
		t.Fatalf("a session that is not a canvas has a conversation file: %s", file)
	}
}

// TestASessionWithoutAConversationEndsWithItsSocket: a name with nowhere to keep a conversation keeps no
// process either. The models editor is a form — opened and closed with its window, asked one command — so
// closing it is the end, and nothing would ever come back for the process (#83). A canvas is the opposite,
// and that is the rule the whole lifetime turns on (#100).
func TestASessionWithoutAConversationEndsWithItsSocket(t *testing.T) {
	server, _, _ := startMCPServer(t)
	conn, err := comfy.DialWS(context.Background(), socketURL(server, "settings"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	for _, want := range []string{"models", "history", "turn"} {
		if event := nextEvent(t, conn); event["type"] != want {
			t.Fatalf("first messages = %v, want %s", event, want)
		}
	}
	if got := spawns(t, os.Getenv("FAKE_SPAWN_LOG")); got != 1 {
		t.Fatalf("spawned %d agents, want 1", got)
	}

	_ = conn.Close()
	time.Sleep(300 * time.Millisecond)

	// A form that was closed is not a conversation waiting to be reopened: the next visit starts a new agent.
	again, err := comfy.DialWS(context.Background(), socketURL(server, "settings"))
	if err != nil {
		t.Fatalf("dial again: %v", err)
	}
	defer again.Close()
	t.Cleanup(func() { _ = again.Close() })
	if first := nextEvent(t, again); first["type"] != "models" {
		t.Fatalf("first message = %v, want the startup broadcast", first)
	}
	if got := spawns(t, os.Getenv("FAKE_SPAWN_LOG")); got != 2 {
		t.Fatalf("spawned %d agents, want a new one for the second visit", got)
	}
}

// TestSocketRelaysTheSteeringQueue: a message sent into a running task is queued by the agent, which says so
// and later says when it used it. The panel shows the difference; the server only carries it.
func TestSocketRelaysTheSteeringQueue(t *testing.T) {
	server, _ := startAgentServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	send(t, conn, map[string]any{"prompt": "write a long one"})
	seen := until(t, conn, "done")
	var phases []string
	for _, event := range seen {
		if event["type"] == "steering" {
			phases = append(phases, event["phase"].(string))
		}
	}
	if len(phases) != 2 || phases[0] != "queued" || phases[1] != "delivered" {
		t.Fatalf("steering phases = %v, want queued then delivered", phases)
	}
}

func TestSocketRelaysASettingChange(t *testing.T) {
	server, _ := startAgentServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	send(t, conn, map[string]any{"command": "model_set", "args": "2"})
	seen := until(t, conn, "command")

	var announced, answered bool
	for _, event := range seen {
		switch event["type"] {
		case "model":
			active, _ := event["active"].(map[string]any)
			announced = active["id"] == float64(2)
		case "command":
			answered = event["ok"] == true
		}
	}
	if !announced || !answered {
		t.Fatalf("messages = %v, want the agent's SM model and a successful CO", seen)
	}

	// A rejection is relayed as the agent worded it; the server has no opinion to add.
	send(t, conn, map[string]any{"command": "model_set", "args": "99"})
	seen = until(t, conn, "command")
	message, _ := seen[len(seen)-1]["message"].(string)
	if !strings.Contains(message, "model not found: 99") {
		t.Fatalf("messages = %v, want the agent's rejection", seen)
	}
}

// TestModelSyncPutsBackWhatTheCanvasCannotSee is the one command whose argument the canvas cannot complete:
// `model_sync` replaces every model in model.conf, and the list the canvas was shown has no key in it. What
// reaches the agent has to be the entry the agent announced, with the fields the canvas edited replaced —
// and the list the command writes is one every other session is told about, since they read the same file.
func TestModelSyncPutsBackWhatTheCanvasCannotSee(t *testing.T) {
	server, _ := startAgentServer(t)
	syncLog := filepath.Join(t.TempDir(), "sync")
	t.Setenv("FAKE_SYNC_LOG", syncLog)

	editor := openSocket(t, server, canvasSession(t, server))
	watcher := openSocket(t, server, canvasSession(t, server))

	send(t, editor, map[string]any{
		"command": "model_sync",
		"args":    `[{"id":2,"name":"Fake / renamed","protocol_type":"openai","base_url":"http://127.0.0.1:1/v1","model_name":"m2"}]`,
	})
	seen := until(t, editor, "command")

	// What the agent was handed: its own entry, key and all, with the name the canvas changed.
	raw, err := os.ReadFile(syncLog)
	if err != nil {
		t.Fatalf("the agent received no model_sync: %v", err)
	}
	synced := string(raw)
	if !strings.Contains(synced, `\"api_key\":\"secret-key-2\"`) {
		t.Errorf("the key was not put back: %s", synced)
	}
	if !strings.Contains(synced, "Fake / renamed") {
		t.Errorf("the canvas's own edit did not travel: %s", synced)
	}
	if strings.Contains(synced, "Fake / one") {
		t.Errorf("a model the canvas deleted survived: %s", synced)
	}

	// The agent's restated list comes back to the canvas that edited it, without the key.
	var restated []any
	for _, event := range seen {
		if event["type"] == "models" {
			restated, _ = event["models"].([]any)
		}
	}
	if len(restated) != 1 {
		t.Fatalf("models = %v, want the list the agent restated after the sync", restated)
	}
	if entry, _ := restated[0].(map[string]any); entry["name"] != "Fake / renamed" || entry["hasKey"] != true {
		t.Errorf("restated model = %v, want the renamed one with a key", entry)
	}
	if encoded, _ := json.Marshal(seen); strings.Contains(string(encoded), "secret-key-2") {
		t.Errorf("the restated list carried the key: %s", encoded)
	}

	// And the other surface, whose agent read model.conf at startup, is told rather than left stale.
	event := nextEvent(t, watcher)
	if event["type"] != "models" {
		t.Fatalf("the other session received %v, want the new model list", event)
	}
	if models, _ := event["models"].([]any); len(models) != 1 {
		t.Errorf("the other session holds %v, want the one model that was written", event["models"])
	}
}

// TestSocketRelaysTheToolItUsed: a built-in tool runs inside AlayaCore, so the call and its result are
// both frames coming back. The server neither answers nor interprets them — it draws them.
func TestSocketRelaysTheToolItUsed(t *testing.T) {
	server, _ := startAgentServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	send(t, conn, map[string]any{"prompt": "read it"})
	seen := until(t, conn, "done")

	var named, withInput, result bool
	for _, event := range seen {
		switch event["type"] {
		case "tool_call":
			if event["name"] == "read_file" {
				named = true
			}
			if input, _ := event["input"].(string); strings.Contains(input, "SKILL.md") {
				withInput = true
			}
		case "tool_result":
			result = event["output"] == "a file"
		}
	}
	if !named || !withInput || !result {
		t.Fatalf("messages = %v, want the call, its arguments and its result", seen)
	}
}

// TestSocketRelaysTheSystemNoticeAndTheFailure: two frames the panel needs and the server used to drop.
// AlayaCore says what it is doing to itself as an SM `notify` (it is in no session file — it is the live
// stream only), and a UF carries `is_error`, which is the one thing a tool result adds to the step the
// canvas has already drawn.
func TestSocketRelaysTheSystemNoticeAndTheFailure(t *testing.T) {
	server, _ := startAgentServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	send(t, conn, map[string]any{"prompt": "summarize please"})
	seen := until(t, conn, "done")

	var notice, called, failed bool
	for _, event := range seen {
		switch event["type"] {
		case "notice":
			notice = event["text"] == "Summarizing conversation..."
		case "tool_call":
			called = event["name"] == "read_file"
		case "tool_result":
			failed = event["isError"] == true && event["output"] == "no such file"
		}
	}
	if !notice || !called || !failed {
		t.Fatalf("messages = %v, want the notice, the call and its failure", seen)
	}
}

// TestSocketCloseReleasesTheAgent: closing the conversation is the one thing that ends an agent, and the
// only way a canvas can say "I am done with this" rather than "I am not looking right now".
func TestSocketCloseReleasesTheAgent(t *testing.T) {
	server, spawnLog := startAgentServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)
	if got := spawns(t, spawnLog); got != 1 {
		t.Fatalf("spawned %d agents, want 1", got)
	}

	send(t, conn, map[string]any{"close": true})
	// The socket ends, and the process with it.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := conn.ReadMessage(ctx); err == nil {
		t.Fatal("the socket stayed open after close")
	}

	// A new connection to the same name starts a new agent, which is what releasing it means.
	openSocket(t, server, session)
	if got := spawns(t, spawnLog); got != 2 {
		t.Fatalf("spawned %d agents after closing, want a new one", got)
	}
}

// TestASocketGoingAwayKeepsTheAgent: a dropped connection is not the end of a conversation. The agent belongs
// to the canvas, so it is still there — same process, same turn, same memory — and the page that comes back
// is shown the conversation it left without a new agent and without a file being read.
func TestASocketGoingAwayKeepsTheAgent(t *testing.T) {
	server, spawnLog := startAgentServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)
	if got := spawns(t, spawnLog); got != 1 {
		t.Fatalf("spawned %d agents, want 1", got)
	}

	send(t, conn, map[string]any{"prompt": "remember the violet"})
	until(t, conn, "done")
	_ = conn.Close()
	time.Sleep(300 * time.Millisecond)
	if got := spawns(t, spawnLog); got != 1 {
		t.Fatalf("closing the socket spawned %d agents, want none: the agent is the canvas's", got)
	}

	// The next connection: the conversation it left, relayed as the events a live turn sends.
	next, replayed, running := connect(t, server, session)
	defer next.Close()
	t.Cleanup(func() { _ = next.Close() })
	if running {
		t.Fatal("no turn was running, and the new socket says one is")
	}
	// What was said, the call it made, what came back, and the answer — the call once, not once per frame.
	if got, want := kindsOf(replayed), "user,tool_call,tool_result,delta"; got != want {
		t.Fatalf("replayed %s, want %s (%v)", got, want, replayed)
	}
	said := replayed[0].(map[string]any)
	if text, _ := said["text"].(string); !strings.Contains(text, "violet") {
		t.Fatalf("first replayed entry = %v, want the user's words", said)
	}
	called := replayed[1].(map[string]any)
	if called["name"] != "read_file" || !strings.Contains(called["input"].(string), "SKILL.md") {
		t.Fatalf("replayed call = %v, want the call and its arguments", called)
	}
	if got := replayedText(replayed); got != "hello world" {
		t.Fatalf("replayed answer = %q, want the words that were said", got)
	}
	if got := spawns(t, spawnLog); got != 1 {
		t.Fatalf("spawned %d agents, want the one the canvas already had", got)
	}
}

// TestAReloadInTheMiddleOfATurnKeepsIt: the page goes away and comes back while the agent is still working.
// Nothing is interrupted — AlayaCore's turn is nobody's socket's — the new connection is told that a turn is
// in flight (the one thing a replayed conversation cannot say), and the answer lands on it.
func TestAReloadInTheMiddleOfATurnKeepsIt(t *testing.T) {
	server, spawnLog := startAgentServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)

	// The fake agent takes two seconds over this one, which is the window the reload has to fit in.
	send(t, conn, map[string]any{"prompt": "answer slowly"})
	time.Sleep(300 * time.Millisecond)
	_ = conn.Close()

	next, replayed, running := connect(t, server, session)
	defer next.Close()
	t.Cleanup(func() { _ = next.Close() })
	if !running {
		t.Fatal("the new socket was told the agent is idle while a turn was running")
	}
	// The prompt is already part of the conversation: it is not waiting for a page to be watching.
	if got, want := kindsOf(replayed), "user"; got != want {
		t.Fatalf("replayed %s, want %s (%v)", got, want, replayed)
	}

	// And the answer arrives here — from the replay if it landed while nobody was reading, live if not.
	seen := until(t, next, "done")
	if got := replayedText(replayed) + textOf(seen); got != "slow answer" {
		t.Fatalf("the answer was %q, want the agent's words whatever the reload did", got)
	}
	if got := spawns(t, spawnLog); got != 1 {
		t.Fatalf("spawned %d agents, want the one that was already running", got)
	}
}

// TestDeletingASessionForgetsTheConversation: the canvas can also end its conversation without ending
// itself. The file goes, and the next connection starts clean.
func TestDeletingASessionForgetsTheConversation(t *testing.T) {
	server, api, _ := startMCPServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)
	send(t, conn, map[string]any{"prompt": "remember the violet"})
	until(t, conn, "done")

	file, err := api.sessionFile(session)
	if err != nil {
		t.Fatalf("session file: %v", err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("the fake agent wrote no session file: %v", err)
	}

	request, err := http.NewRequest(http.MethodDelete, server.URL+"/api/agent/session/"+session, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("the session file survived the canvas: %v", err)
	}

	// The next connection is a new conversation: nothing to replay.
	next, err := comfy.DialWS(context.Background(), socketURL(server, session))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer next.Close()
	t.Cleanup(func() { _ = next.Close() })
	if first := nextEvent(t, next); first["type"] != "models" {
		t.Fatalf("first message = %v, want the startup broadcast", first)
	}
	history := nextEvent(t, next)
	if replayed, _ := history["history"].([]any); len(replayed) != 0 {
		t.Fatalf("history = %v, want none after the canvas was deleted", history["history"])
	}
}

// TestDeletingABusySessionIsRefused: a turn in flight is writing the next entry of the file a delete would
// remove, so the server refuses and changes nothing — no release, no removal. The panel disables its
// button for the same reason (#187); this is the rule it is being courteous about.
func TestDeletingABusySessionIsRefused(t *testing.T) {
	server, api, _ := startMCPServer(t)
	session := canvasSession(t, server)
	conn := openSocket(t, server, session)
	file, err := api.sessionFile(session)
	if err != nil {
		t.Fatalf("session file: %v", err)
	}

	// The fake agent takes two seconds over this one, which is the window the refusal has to fit in.
	send(t, conn, map[string]any{"prompt": "answer slowly"})
	time.Sleep(300 * time.Millisecond)

	status, body := deleteSession(t, server, session)
	if status != http.StatusConflict || !strings.Contains(body, "agent_busy") {
		t.Fatalf("delete during a turn answered %d %q, want 409 agent_busy", status, body)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("the refused delete removed the conversation anyway: %v", err)
	}
	if got := spawns(t, os.Getenv("FAKE_SPAWN_LOG")); got != 1 {
		t.Fatalf("spawned %d agents, want the busy one still running", got)
	}

	// The turn ends, and now the same request goes through.
	until(t, conn, "done")
	if status, body := deleteSession(t, server, session); status != http.StatusOK {
		t.Fatalf("delete after the turn answered %d %q, want 200", status, body)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("the session file survived an idle delete: %v", err)
	}
}

// deleteSession asks the server to forget a conversation and reports what it answered.
func deleteSession(t *testing.T, server *httptest.Server, session string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodDelete, server.URL+"/api/agent/session/"+session, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	defer response.Body.Close()
	body := make([]byte, 512)
	read, _ := response.Body.Read(body)
	return response.StatusCode, string(body[:read])
}

// TestDeletingACanvasTakesItsConversationWithIt: the conversation is part of the canvas, so deleting the
// canvas is all it takes for the conversation to be gone — there is no second file anywhere to forget.
func TestDeletingACanvasTakesItsConversationWithIt(t *testing.T) {
	server, api, _ := startMCPServer(t)
	session := canvasSession(t, server)
	id := strings.TrimPrefix(session, canvasSessionPrefix)
	conn := openSocket(t, server, session)
	send(t, conn, map[string]any{"prompt": "remember the violet"})
	until(t, conn, "done")

	file, err := api.canvases.SessionPath(id)
	if err != nil {
		t.Fatalf("SessionPath: %v", err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("the fake agent wrote no conversation: %v", err)
	}
	// One directory holds the document, the media and the conversation.
	if want := filepath.Join(api.cfg.CanvasRoot, id); filepath.Dir(file) != want {
		t.Fatalf("conversation at %q, want a file in %q", file, want)
	}

	request, err := http.NewRequest(http.MethodDelete, server.URL+"/api/canvases/"+id, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("delete canvas: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete canvas: status %d", response.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(api.cfg.CanvasRoot, id)); !os.IsNotExist(err) {
		t.Fatalf("the canvas directory survived: %v", err)
	}
}

// TestSocketReportsADeadProcess: an agent killed under a live conversation has to be reported, not
// waited on.
func TestSocketReportsADeadProcess(t *testing.T) {
	server, _ := startAgentServer(t)
	conn := openSocket(t, server, canvasSession(t, server))

	// The fake agent exits on this prompt, which is what a crash looks like from here.
	send(t, conn, map[string]any{"prompt": "die"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, err := conn.ReadMessage(ctx); err != nil {
			return // the socket closed: the conversation is over and the client knows
		}
	}
}

// TestARunFinishingTellsTheAgentThatAskedForIt: `generate` is answered the moment the run starts, so the
// agent's turn can end with the picture still rendering. When the run ends, the agent that asked is told,
// as a message from the user — it goes in as a prompt, the agent echoes it, and the socket relays that
// echo, which is what makes the panel draw it like anything typed (docs/decisions.md #225).
func TestARunFinishingTellsTheAgentThatAskedForIt(t *testing.T) {
	server, _ := startAgentServer(t)
	session := canvasSession(t, server)
	canvas := strings.TrimPrefix(session, "canvas:")
	conn := openSocket(t, server, session)

	// The request the page submits after answering `generate`: the run, and who is waiting to hear of it.
	status, payload := doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/canvases/"+canvas+"/runs", map[string]any{
		"workflow": "image-test",
		"inputs":   map[string]any{"prompt": "a cat"},
		"askedBy":  map[string]any{"session": session, "node": "n12"},
	})
	if status != http.StatusAccepted {
		t.Fatalf("submit status = %d, body = %v", status, payload)
	}
	id, _ := payload["id"].(string)
	if id == "" {
		t.Fatalf("no run id: %v", payload)
	}
	if finished := waitForRun(t, server, id); finished["status"] != "succeeded" {
		t.Fatalf("the run did not succeed: %v", finished)
	}

	// The agent was told, as a user message: the notice names the node it asked about, so it can carry on.
	seen := until(t, conn, "delta")
	var told string
	for _, event := range seen {
		if event["type"] == "user" {
			told, _ = event["text"].(string)
		}
	}
	if !strings.Contains(told, "n12") || !strings.Contains(told, "finished") {
		t.Fatalf("the agent was not told which run ended; events: %v", seen)
	}
	// And it answered the message as a turn of its own, so the conversation goes on from there.
	if answer := textOf(seen); answer != "carrying on" {
		t.Errorf("answer = %q, want the fake agent's reply to the notice", answer)
	}
}

// TestARunNobodyAskedAboutTellsNoOne: a run the user started by pressing the button is not news to the
// agent, and a message nobody is waiting for would be noise in the conversation.
func TestARunNobodyAskedAboutTellsNoOne(t *testing.T) {
	server, _ := startAgentServer(t)
	session := canvasSession(t, server)
	canvas := strings.TrimPrefix(session, "canvas:")
	conn := openSocket(t, server, session)

	status, payload := doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/canvases/"+canvas+"/runs", map[string]any{
		"workflow": "image-test",
		"inputs":   map[string]any{"prompt": "a cat"},
	})
	if status != http.StatusAccepted {
		t.Fatalf("submit status = %d, body = %v", status, payload)
	}
	id, _ := payload["id"].(string)
	waitForRun(t, server, id)

	// Nothing is said on the socket. A prompt the user typed would echo at once, so a short wait for one
	// is what tells the two apart — and the fake agent answers everything it is sent.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if raw, err := conn.ReadMessage(ctx); err == nil {
		t.Fatalf("the socket said %q about a run nobody asked about", raw)
	}
}
