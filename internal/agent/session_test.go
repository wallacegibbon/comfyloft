package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"comfyloft/internal/logx"
)

// fakeAgent is a stand-in for the real binary that speaks the same wire, so these tests describe the
// server's translation rather than a model's behaviour. The protocol facts it encodes (an api key in
// model_list, a CO per command, a task that ends the prompt, a task that reports tokens and speed) were
// observed on the real agent.
const fakeAgent = `#!/bin/sh
printf 'SM{"type":"version","data":{"message_version":18,"core_version":"fake-1"}}\n'
printf 'SM{"type":"model_list","data":{"models":[{"id":1,"name":"Fake / one","protocol_type":"openai","base_url":"http://127.0.0.1:1/v1","api_key":"secret-key","model_name":"m","context_limit":1000},{"id":2,"name":"Fake / two","protocol_type":"openai","base_url":"http://127.0.0.1:1/v1","api_key":"secret-key-2","model_name":"m2","context_limit":2000}]}}\n'
printf 'SM{"type":"model","data":{"active_id":1,"active_name":"Fake / one","context_limit":1000}}\n'
printf 'SM{"type":"reasoning_level","data":{"level":1}}\n'
printf 'SM{"type":"task","data":{"in_progress":false,"context_tokens":1500}}\n'
printf 'SM{"type":"session","data":{"state":"ready"}}\n'
while IFS= read -r line; do
  [ -n "$FAKE_LOG" ] && printf '%s\n' "$line" >> "$FAKE_LOG"
  case "$line" in
    CI*'"name":"model_set"'*)
      case "$line" in
        *'"args":"2"'*)
          printf 'SM{"type":"model","data":{"active_id":2,"active_name":"Fake / two","context_limit":2000}}\n'
          printf 'CO{"command_id":"1","result":{"active_id":2,"active_name":"Fake / two"}}\n' ;;
        *)
          printf 'CO{"command_id":"1","is_error":true,"result":{"code":"REQUEST_MODEL_UNKNOWN","message":"model_set: model not found: 9"}}\n' ;;
      esac ;;
    CI*'"name":"reasoning_level_set"'*)
      printf 'SM{"type":"reasoning_level","data":{"level":2}}\n'
      printf 'CO{"command_id":"1","result":{"level":2}}\n' ;;
    UX*'"type":"image"'*)
      # A picture with no words is still a user message: the items are staged, and UE sends them.
      PICTURE=1 ;;
    UX*refuse*)
      REFUSE=1 ;;
    UX*'queue'*)
      QUEUE=1 ;;
    UE)
      if [ -n "$REFUSE" ]; then
        # A message the agent will not take: an error and no task at all — not even the task-start frame, so
        # nothing about this message is ever a turn.
        REFUSE=""
        printf 'SM{"type":"error","data":{"text":"the task could not start"}}\n'
        continue
      fi
      if [ -n "$QUEUE" ]; then
        # One message taken into the steering queue and then the batch going in: the agent states each phase and
        # never the size, and the pauses are what let a test see the size while it stands.
        QUEUE=""
        printf 'SM{"type":"task","data":{"in_progress":true,"current_step":1}}\n'
        sleep 1
        printf 'SM{"type":"steering","data":{"phase":"queued","text":"one"}}\n'
        sleep 1
        printf 'SM{"type":"steering","data":{"phase":"queued","text":"two"}}\n'
        sleep 1
        printf 'SM{"type":"steering","data":{"phase":"delivered"}}\n'
        printf 'Ax{"id":"2","type":"text","text":"the queue"}\n'
        printf 'SM{"type":"task","data":{"in_progress":false,"context_tokens":3}}\n'
        continue
      fi
      if [ -n "$PICTURE" ]; then
        # The real agent announces the task before the work starts (beginTask) and announces its end when the
        # task returns (handleTaskDone). The pause between the two is the model looking at the picture, and it
        # is what lets a test see the turn while it is running.
        PICTURE=""
        printf 'SM{"type":"task","data":{"in_progress":true,"current_step":1}}\n'
        printf 'Ax{"id":"2","type":"text","text":"a picture"}\n'
        sleep 1
        printf 'SM{"type":"task","data":{"in_progress":false,"context_tokens":3}}\n'
        continue
      fi
      printf 'SM{"type":"task","data":{"in_progress":true,"current_step":1,"context_tokens":0}}\n'
      printf 'Ax{"id":"2","type":"text","text":"hello "}\n'
      printf 'SM{"type":"task","data":{"in_progress":true,"current_step":1,"context_tokens":5,"step_tps":12.5,"ttft_ms":1200}}\n'
      printf 'Ax{"id":"2","type":"text","text":"world"}\n'
      printf 'SM{"type":"task","data":{"in_progress":false,"context_tokens":9}}\n' ;;
  esac
done
`

// recorder is the session's watcher in these tests: it keeps every event and lets a test wait for the
// one it is about, because the answer arrives as the agent produces it rather than as a return value.
type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) sink(event Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
	return nil
}

func (r *recorder) all() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Event(nil), r.events...)
}

func (r *recorder) waitFor(t *testing.T, what string, match func(Event) bool) Event {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, event := range r.all() {
			if match(event) {
				return event
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s; events: %+v", what, r.all())
	return Event{}
}

// fakeSession is one live session plus the pieces a test asks it about.
type fakeSession struct {
	sessions *Sessions
	session  *Session
	startup  Event
	watcher  *recorder
	log      string
}

// openFakeSession is the live path a socket takes: one session filed under a name, its startup
// broadcast read before it is ready, and the watcher attached before anything is said.
func openFakeSession(t *testing.T) fakeSession {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-agent")
	if err := os.WriteFile(path, []byte(fakeAgent), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	log := filepath.Join(t.TempDir(), "frames.log")
	t.Setenv("FAKE_LOG", log)

	sessions := NewSessions(nil)
	t.Cleanup(func() { sessions.Close("test", "test over") })
	connected, err := sessions.Connect(context.Background(), "test", SpawnOptions{Binary: path})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}

	watcher := &recorder{}
	stopWatching := connected.Session.Watch(watcher.sink)
	if stopWatching == nil {
		t.Fatal("Watch returned nothing to stop it with")
	}
	t.Cleanup(func() { stopWatching() })
	return fakeSession{sessions: sessions, session: connected.Session, startup: connected.Startup, watcher: watcher, log: log}
}

func TestSessionStreamsTheAnswerAndKeepsKeysHome(t *testing.T) {
	fs := openFakeSession(t)
	session, watcher, log := fs.session, fs.watcher, fs.log
	if err := session.Send(Request{Prompt: "hi"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	done := watcher.waitFor(t, "the end of the turn", func(event Event) bool { return event.Type == "done" })

	var text strings.Builder
	for _, event := range watcher.all() {
		if event.Type == "delta" {
			text.WriteString(event.Text)
		}
	}
	if text.String() != "hello world" {
		t.Errorf("deltas = %q, want %q", text.String(), "hello world")
	}
	// `done` marks the end of the turn; the answer is the deltas, and only the deltas.
	if done.Text != "" {
		t.Errorf("done = %v, want a marker rather than the answer again", done)
	}

	// The prompt went out as one user message, and nothing else was sent.
	frames, err := os.ReadFile(log)
	if err != nil {
		t.Fatalf("read frames: %v", err)
	}
	if !strings.Contains(string(frames), `"hi"`) {
		t.Errorf("stdin frames = %q, want the prompt", string(frames))
	}
	if !strings.HasSuffix(string(frames), "UE\n") {
		t.Errorf("the prompt was not flushed with UE: %q", string(frames))
	}

	// Every event the canvas can see, as the transport would encode it.
	encoded, _ := json.Marshal(watcher.all())
	if strings.Contains(string(encoded), "secret-key") || strings.Contains(string(encoded), "127.0.0.1:1") {
		t.Errorf("the agent's credentials reached the events: %s", encoded)
	}
}

// TestAnImageOnlyMessageIsATurn: a message is content items and a flush, whatever the items are — `UX` carries
// text or a picture, `UE` sends the message (`wire.go`) — and a picture with no words is a message the agent
// takes like any other: it announces the task, works, and announces the end. The session reads those two frames
// (#342), which is why a page that connects while the model is looking at the picture is told the agent is
// running instead of idle — and why the delete route refuses to cancel it.
func TestAnImageOnlyMessageIsATurn(t *testing.T) {
	fs := openFakeSession(t)
	if err := fs.session.Send(Request{Images: []string{"data:image/png;base64,cGljdHVyZQ=="}}); err != nil {
		t.Fatalf("send: %v", err)
	}
	// The task-start frame comes before the answer and the task-end frame comes after it, so the first word is
	// the middle of a turn that the session already knows is running.
	fs.watcher.waitFor(t, "the first word of the answer", func(event Event) bool { return event.Type == "delta" })
	if running, _ := fs.session.Turn(); !running {
		t.Fatal("a message carrying a picture left the session idle while the agent was working on it")
	}

	fs.watcher.waitFor(t, "the end of the turn", func(event Event) bool { return event.Type == "done" })
	if running, _ := fs.session.Turn(); running {
		t.Fatal("the turn the picture opened never ended")
	}

	// What went out: the picture, and the flush that makes it one message.
	frames, err := os.ReadFile(fs.log)
	if err != nil {
		t.Fatalf("read frames: %v", err)
	}
	if !strings.Contains(string(frames), `"type":"image"`) {
		t.Errorf("stdin frames = %q, want the picture", string(frames))
	}
	if !strings.HasSuffix(string(frames), "UE\n") {
		t.Errorf("the picture was not flushed with UE: %q", string(frames))
	}
}

// TestAMessageTheAgentRefusesIsNoTurn: the agent answers a message it will not take with an error and no task
// at all — no task-start frame, so nothing running and nothing to end (#342). Reading the turn off the frames
// is what makes this true; a session that recorded a turn because it had written a prompt would answer "busy"
// for the life of the process, showing a working panel over a conversation nobody is working on and refusing
// to clear it (#187).
func TestAMessageTheAgentRefusesIsNoTurn(t *testing.T) {
	fs := openFakeSession(t)
	if err := fs.session.Send(Request{Prompt: "refuse this one"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	fs.watcher.waitFor(t, "the agent's refusal", func(event Event) bool { return event.Type == "error" })
	if running, _ := fs.session.Turn(); running {
		t.Fatal("a message the agent refused was recorded as a turn, and no frame will ever end it")
	}
}

// TestTheQueueIsCountedOnceAndStated: the agent says when it takes a message into the steering queue and when the
// batch goes in, and it never says how many are there. The session counts the announcements and states the size
// with every phase and on the connect frame, so a page that comes back joins the number instead of counting from
// nothing — which is what a tally kept by the page did, and lost on every reload (#345).
func TestTheQueueIsCountedOnceAndStated(t *testing.T) {
	fs := openFakeSession(t)
	if err := fs.session.Send(Request{Prompt: "queue please"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	first := fs.watcher.waitFor(t, "the first queued message", func(event Event) bool { return event.Type == "steering" && event.Phase == "queued" })
	if first.Queued != 1 {
		t.Fatalf("the first queued event stated a queue of %d, want 1", first.Queued)
	}
	if got := fs.session.Queued(); got != 1 {
		t.Fatalf("the session holds a queue of %d, want 1", got)
	}

	second := fs.watcher.waitFor(t, "the second queued message", func(event Event) bool { return event.Type == "steering" && event.Queued == 2 })
	if second.Phase != "queued" {
		t.Fatalf("second event = %+v, want the second queued message", second)
	}
	if got := fs.session.Queued(); got != 2 {
		t.Fatalf("the session holds a queue of %d, want 2", got)
	}

	delivered := fs.watcher.waitFor(t, "the batch going in", func(event Event) bool { return event.Type == "steering" && event.Phase == "delivered" })
	if delivered.Queued != 0 {
		t.Fatalf("the delivered event stated a queue of %d, want none", delivered.Queued)
	}
	if got := fs.session.Queued(); got != 0 {
		t.Fatalf("the session holds a queue of %d after delivery, want none", got)
	}
	fs.watcher.waitFor(t, "the end of the turn", func(event Event) bool { return event.Type == "done" })
}

// TestAWhitespaceOnlyMessageIsNoTurn: a message of spaces is no content item, so nothing is written and no task
// is announced — and the session says idle, which is the truth. It is the same fact as the two tests above seen
// from the other side: the turn is what the agent announces, not what a caller meant to send.
func TestAWhitespaceOnlyMessageIsNoTurn(t *testing.T) {
	fs := openFakeSession(t)
	if err := fs.session.Send(Request{Prompt: "   "}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if running, _ := fs.session.Turn(); running {
		t.Fatal("a message of spaces was recorded as a turn, and nothing will ever end it")
	}
	if frames, err := os.ReadFile(fs.log); err == nil && strings.Contains(string(frames), "UX") {
		t.Errorf("a message of spaces wrote frames: %q", string(frames))
	}
}

// The numbers the agent takes of itself — how full the context is, how fast the last step went — are
// relayed as it restates them, and the count it restored from a session file arrives with the startup
// broadcast, so a page that reconnects knows it before it asks anything.
func TestSessionRelaysTheContextAndTheStepSpeed(t *testing.T) {
	fs := openFakeSession(t)
	if fs.startup.ContextTokens != 1500 {
		t.Errorf("startup contextTokens = %d, want the count the agent restored (1500)", fs.startup.ContextTokens)
	}
	if fs.startup.StepTps != 0 || fs.startup.TtftMs != 0 {
		t.Errorf("a conversation that was just reloaded has no step to report: %+v", fs.startup)
	}

	if err := fs.session.Send(Request{Prompt: "hi"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	step := fs.watcher.waitFor(t, "the step's speed", func(event Event) bool {
		return event.Type == "usage" && event.StepTps > 0
	})
	if step.StepTps != 12.5 || step.TtftMs != 1200 || step.ContextTokens != 5 {
		t.Errorf("usage = %+v, want 12.5 tok/s, a 1200 ms ttft and 5 tokens", step)
	}

	fs.watcher.waitFor(t, "the end of the turn", func(event Event) bool { return event.Type == "done" })
	events := fs.watcher.all()
	// The frame that ends a turn still carries the count, and it is relayed before `done` — the canvas is
	// told how full the context is one last time rather than one frame too late.
	final, ended := -1, -1
	for index, event := range events {
		if event.Type == "usage" && event.ContextTokens == 9 {
			final = index
		}
		if event.Type == "done" {
			ended = index
		}
	}
	if final < 0 {
		t.Fatalf("the count the turn ended on was dropped; events: %+v", events)
	}
	if final > ended {
		t.Errorf("the last usage arrived after done (%d > %d); events: %+v", final, ended, events)
	}
	// A step that has counted nothing yet says nothing: a `0` on screen would be a number the agent never
	// reported (it sends `context_tokens: 0` as the step starts, before anything is counted).
	for _, event := range events {
		if event.Type == "usage" && event.ContextTokens == 0 {
			t.Errorf("an uncounted step was drawn as 0: %+v", event)
		}
	}
}

// A setting change is the same stream as a question: one command, no prompt, and the agent's own
// frames are the whole result.
func TestSessionRelaysACommandAndTheAgentsStatement(t *testing.T) {
	fs := openFakeSession(t)
	session, watcher, log := fs.session, fs.watcher, fs.log
	if err := session.Send(Request{Command: "model_set", Args: "2"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	answered := watcher.waitFor(t, "the agent's answer to the command", func(event Event) bool {
		return event.Type == "command"
	})
	if !answered.OK {
		t.Errorf("the command was reported as failed: %+v", answered)
	}
	announced := watcher.waitFor(t, "the agent's own model frame", func(event Event) bool {
		return event.Type == "model" && event.Active != nil && event.Active.ID == 2
	})
	if announced.Active == nil || announced.Active.Name != "Fake / two" {
		t.Errorf("the agent's SM model was not relayed: %+v", announced)
	}

	frames, _ := os.ReadFile(log)
	if !strings.Contains(string(frames), `"name":"model_set"`) || !strings.Contains(string(frames), `"args":"2"`) {
		t.Fatalf("the command was not forwarded: %q", string(frames))
	}
	if strings.Contains(string(frames), "UE") {
		t.Errorf("a bare command must not flush an empty prompt: %q", string(frames))
	}
}

// A cancel carries the word the panel chose, and the server forwards it rather than translating it:
// `keep_steering` is AlayaCore's own argument, and the two fates it picks between — the queue dropped with
// the task, or left to run as the next prompt — are AlayaCore's to carry out. An empty word is the bare
// cancel the socket-closed path sends, and it has to stay an empty word rather than vanish: the frame the
// agent reads is `args` present and empty, not `args` missing.
func TestCancelForwardsTheWordThePanelChose(t *testing.T) {
	fs := openFakeSession(t)
	session, log := fs.session, fs.log

	if err := session.Cancel("keep_steering"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	kept := waitForFrame(t, log, func(frames string) bool { return strings.Contains(frames, `"name":"cancel"`) })
	if !strings.Contains(kept, `"args":"keep_steering"`) {
		t.Fatalf("the word the panel chose was not forwarded: %q", kept)
	}

	if err := session.Cancel(""); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	dropped := waitForFrame(t, log, func(frames string) bool { return strings.Count(frames, `"name":"cancel"`) == 2 })
	if !strings.Contains(dropped, `"args":""`) {
		t.Fatalf("a bare cancel must still carry an empty args, not drop the field: %q", dropped)
	}
}

// waitForFrame polls the fake agent's log until the frames it has read satisfy the test. The agent reads
// its stdin on its own goroutine, so "written" and "read" are two moments and a test that read the file
// once would be racing the child process.
func waitForFrame(t *testing.T, log string, done func(frames string) bool) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		frames, _ := os.ReadFile(log)
		if done(string(frames)) {
			return string(frames)
		}
		if time.Now().After(deadline) {
			t.Fatalf("the frames never arrived: %q", string(frames))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestSessionRelaysARejection(t *testing.T) {
	fs := openFakeSession(t)
	session, watcher := fs.session, fs.watcher
	if err := session.Send(Request{Command: "model_set", Args: "99"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	rejected := watcher.waitFor(t, "the agent's rejection", func(event Event) bool {
		return event.Type == "command" && !event.OK
	})
	if !strings.Contains(rejected.Message, "model not found") {
		t.Errorf("the agent's message was not relayed: %+v", rejected)
	}
}

// A watcher that goes away leaves the agent's words in the log rather than in a failed write: the pump
// keeps reading (a goroutine inside `read` cannot be interrupted) and simply has nobody to publish to,
// so the next thing the agent says is dropped instead of detaching the session.
func TestSessionWithoutAWatcherDropsTheEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fake-agent")
	if err := os.WriteFile(path, []byte(fakeAgent), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	sessions := NewSessions(nil)
	t.Cleanup(func() { sessions.Close("lonely", "test over") })
	connected, err := sessions.Connect(context.Background(), "lonely", SpawnOptions{Binary: path})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	watcher := &recorder{}
	stopWatching := connected.Session.Watch(watcher.sink)
	if stopWatching == nil {
		t.Fatal("Watch returned nothing to stop it with")
	}
	t.Cleanup(func() { stopWatching() })
	connected.Session.Unwatch()

	if err := connected.Session.Send(Request{Prompt: "hi"}); err != nil {
		t.Fatalf("send to a session nobody is watching: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	if events := watcher.all(); len(events) != 0 {
		t.Errorf("a detached watcher still received %d event(s): %+v", len(events), events)
	}
}

// A session can be told something the user did not type: a run finished, and the agent that asked for it
// has to know. It goes in through the same door — a prompt on stdin, flushed as one user message — and
// nothing here waits for the agent to be idle, because AlayaCore takes a prompt mid-turn and queues it
// into the run already going (docs/decisions.md #225).
func TestTellSendsTheWordsAsAPrompt(t *testing.T) {
	fs := openFakeSession(t)
	said := "[comfyloft] the image generation on n12 has finished"
	if err := fs.sessions.Tell("test", said); err != nil {
		t.Fatalf("tell: %v", err)
	}
	// The agent treated it as a turn of its own: the fake answers every prompt with its two deltas.
	fs.watcher.waitFor(t, "the end of the turn the message started", func(event Event) bool { return event.Type == "done" })

	frames, err := os.ReadFile(fs.log)
	if err != nil {
		t.Fatalf("read frames: %v", err)
	}
	if !strings.Contains(string(frames), said) {
		t.Errorf("frames = %q, want the words on their way to the agent", string(frames))
	}
	// One user message, not a stray fragment: the prompt goes out as UX and is finished with UE.
	if !strings.HasSuffix(string(frames), "UE\n") {
		t.Errorf("the message was not flushed with UE: %q", string(frames))
	}
}

// A name nobody is behind is answered, not dropped: the caller logs which conversation ended with nobody
// left to hear about it.
func TestTellReportsASessionThatIsGone(t *testing.T) {
	sessions := NewSessions(nil)
	err := sessions.Tell("canvas:nobody", "[comfyloft] a run finished")
	if err == nil {
		t.Fatal("Tell to a session that does not exist reported success")
	}
	if !strings.Contains(err.Error(), "canvas:nobody") {
		t.Errorf("error = %q, want it to name the session", err)
	}
}

// The two moments a reader needs in the log: what a session was sending to when it started, and that it moved.
// Both are the agent's own words translated (`events.go`'s `destination`), and neither may carry an API key.
func TestSessionLogsWhereItsTurnsGo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fake-agent")
	if err := os.WriteFile(path, []byte(fakeAgent), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	var logged strings.Builder
	sessions := NewSessions(logx.NewWithWriter("test", &logged))
	t.Cleanup(func() { sessions.Close("test", "test over") })

	connected, err := sessions.Connect(context.Background(), "test", SpawnOptions{Binary: path})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	watcher := &recorder{}
	stopWatching := connected.Session.Watch(watcher.sink)
	t.Cleanup(func() { stopWatching() })

	line := logged.String()
	for _, want := range []string{"sending to", `"Fake / one"`, "http://127.0.0.1:1/v1", "model m", "openai"} {
		if !strings.Contains(line, want) {
			t.Errorf("connect log = %q, want it to contain %q", line, want)
		}
	}
	if strings.Contains(line, "secret-key") {
		t.Errorf("connect log = %q, carries an api_key", line)
	}

	// Switching model is a switch of server, so the pump says so — and says it once, not on every restatement.
	logged.Reset()
	if err := connected.Session.Send(Request{Command: "model_set", Args: "2"}); err != nil {
		t.Fatalf("send model_set: %v", err)
	}
	watcher.waitFor(t, "the model the agent switched to", func(event Event) bool {
		return event.Type == "model" && event.Active != nil && event.Active.Name == "Fake / two"
	})
	if line := logged.String(); !strings.Contains(line, `"Fake / two"`) || !strings.Contains(line, "model m2") {
		t.Errorf("switch log = %q, want the model that is now in use", line)
	}

	// A model frame that says the same thing again is the agent restating itself, which is not news.
	logged.Reset()
	if err := connected.Session.Send(Request{Command: "model_set", Args: "2"}); err != nil {
		t.Fatalf("send model_set: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if line := logged.String(); strings.Contains(line, "sending to") {
		t.Errorf("log = %q, want no line when the destination did not move", line)
	}
}
