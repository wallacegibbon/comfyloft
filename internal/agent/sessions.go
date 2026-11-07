package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"comfyloft/internal/logx"
)

// Session is one agent process, held for as long as the canvas it belongs to exists.
//
// Its life is the canvas's, not a connection's. A socket starts one, but a socket that ends does not end
// it: a reload, a closed panel and a second tab are one event here — nobody is looking right now — and none
// of them is the user saying they are done. So a turn keeps running with no page attached, and the next
// connection finds the same process with the same conversation in front of it. Only an explicit end
// releases it: the `close` message, the delete route, the canvas going away, or the process dying.
//
// What that next connection is shown comes from `talk` — the frames the agent has said, kept because a live
// process has no way to repeat itself. The file named by `--session` is still what outlives the process;
// the transcript is what makes the conversation readable *while* it runs, and what a reload draws instead
// of an empty panel.
//
// The key is whatever the client called it (the canvas id, in practice). The server does not know or
// care what it means: it is a name a process is filed under, and the same name always finds the same
// process.
type Session struct {
	ID string

	proc *Process

	// Log is where this session says which server its turns go to. It is the sessions' logger, handed down at
	// creation: the pump is the only thing that sees the agent's own `model` frames, and the address is the one
	// fact about a turn that is worth a line (`events.go`'s `destination`).
	Log *logx.Logger

	// state is the startup broadcast as the agent last restated it: written by the pump, and read by a
	// second connection asking what this session is, so it has a lock of its own.
	stateMu sync.RWMutex
	state   startup

	// write keeps frames whole: two messages writing at once would interleave halves of two frames and
	// the agent would read nonsense.
	write sync.Mutex

	// talk is the conversation as the agent sent it, for the page that connects after the words were said —
	// a reload, a panel reopened, a second tab. Guarded by mu with the watcher, because the pump writes it
	// while a connection reads it.
	talk transcript

	// mu guards the watcher and the transcript above. The pump reads the process whether or not anyone is
	// listening — a socket can be closed at any moment, and a reader that was only alive while a socket
	// was would be stuck inside a blocking read nobody can interrupt.
	mu   sync.Mutex
	sink func(Event) error
	// watchGeneration counts watch handovers, so a connection replaced by a newer one cannot clear the
	// sink on its way out.
	watchGeneration uint64

	// busy says a turn is in flight: a prompt went in and its `done` has not come back. It is a fact
	// about the conversation, not about one connection, so it has a lock of its own — a second tab
	// asking, and the delete route refusing, both read it.
	busyMu sync.Mutex
	busy   bool

	// pending is the tool calls waiting for the canvas to answer them, by the id the server gave them,
	// and calls counts the ones asked so far. A tool call is a question only the page can answer, so it
	// leaves through the same sink and comes back as a message on the same socket.
	pending map[string]chan toolAnswer
	calls   int

	// gone releases the session's own entry when the process dies. Set by Connect.
	gone func(reason string)
}

// Connected is what a new connection gets: the session it now reads, the agent's own startup broadcast,
// which is where the model list comes from, and the conversation so far.
type Connected struct {
	Session *Session
	Startup Event
	// History is the conversation this session is holding, oldest first, as the events it sent live: the
	// frames it replayed from its file and everything it has said since. It is the same answer whether the
	// process was just started or has been running for an hour — a page that connects is drawing the
	// agent's conversation, and the agent's conversation is the same thing either way.
	History []Event
	Spawned bool
}

// Sessions holds the connected agents, one per client-chosen name.
type Sessions struct {
	// Readers are the common case — every MCP tool call looks its session up — so the lock is shared.
	mu   sync.RWMutex
	list map[string]*Session
	Log  *logx.Logger
}

func NewSessions(log *logx.Logger) *Sessions {
	return &Sessions{list: map[string]*Session{}, Log: log}
}

// Connect returns the agent filed under this name, starting one if there is none. Connecting twice is
// the same as connecting once: a canvas has one agent. A page that comes back — a reload, a panel reopened,
// a second tab — finds that same process, still working, and is handed the conversation it is holding.
func (s *Sessions) Connect(ctx context.Context, id string, opts SpawnOptions) (Connected, error) {
	if id == "" {
		id = newSessionID()
	}
	if existing, ok := s.Lookup(id); ok {
		return Connected{Session: existing, Startup: snapshotEvent(existing), History: existing.replay()}, nil
	}

	// The spawn is outside the lock on purpose. It ends at the agent's `ready`, which is model loading,
	// not milliseconds — and this lock is also what `List` takes, which is how every MCP tool call finds
	// its session. Holding it here would stop the whole server while one canvas's agent starts.
	proc, err := Spawn(opts)
	if err != nil {
		return Connected{}, err
	}
	state, replay, err := readStartup(proc)
	if err != nil {
		proc.Release()
		return Connected{}, err
	}

	session := &Session{ID: id, proc: proc, state: state, pending: map[string]chan toolAnswer{}, Log: s.Log}
	// The conversation it replayed from its file is where this session's begins: the frames are what every
	// page from here on is shown, and a process that starts in the middle of one is not a special case.
	session.talk.keep(replay)
	session.gone = func(reason string) { s.Close(id, reason) }

	// Two connects can now race for one name. The first to file owns it and the other releases what it
	// started and answers with the session that exists — the contract is "one session per name", not
	// "one spawn per connect".
	s.mu.Lock()
	if existing, ok := s.list[id]; ok {
		s.mu.Unlock()
		proc.Release()
		if s.Log != nil {
			s.Log.Info("agent: connect session=%s raced; keeping pid=%d", id, existing.proc.Cmd.Process.Pid)
		}
		return Connected{Session: existing, Startup: snapshotEvent(existing), History: existing.replay()}, nil
	}
	s.list[id] = session
	s.mu.Unlock()
	go session.pump()

	if s.Log != nil {
		s.Log.Info("agent: connected session=%s pid=%d models=%d %s", id, proc.Cmd.Process.Pid, len(state.models), destinationLine(state.destination()))
	}
	return Connected{Session: session, Startup: state.event(), History: session.replay(), Spawned: true}, nil
}

// Lookup returns the session filed under this name, if there is one.
//
// This is how an MCP call says who it is: the bridge carries the session name it inherited, and the
// name is the whole identity — no derivation, nothing to keep in step with a directory name.
func (s *Sessions) Lookup(id string) (*Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.list[id]
	return session, ok
}

// Busy reports whether the session filed under this name has a turn in flight. A name nobody is behind
// is not busy: there is no process, and so nothing writing to the file a delete would remove.
func (s *Sessions) Busy(id string) bool {
	session, ok := s.Lookup(id)
	return ok && session.Busy()
}

// List is every connected session, read by the model broadcast: a model list that changed is news to every
// session but the one that sent it.
func (s *Sessions) List() []*Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	all := make([]*Session, 0, len(s.list))
	for _, session := range s.list {
		all = append(all, session)
	}
	return all
}

// Tell says one thing to a session as if the user had typed it: it goes in as a prompt, so the agent
// answers it in a turn of its own and the canvas draws the message like any other (docs/decisions.md
// #225).
//
// Nothing here waits for the agent to be idle. AlayaCore takes a prompt while it is working and works it
// into the run already in progress — that queue is the agent's, and waiting on this side would only turn
// "the run finished" into a message delivered at some later, arbitrary moment.
func (s *Sessions) Tell(id, text string) error {
	session, ok := s.Lookup(id)
	if !ok {
		return fmt.Errorf("no agent session %q is open", id)
	}
	return session.Send(Request{Prompt: text})
}

// Close releases a session and the process with it. Called when the client says so, when the process
// dies under it, and when the server is shutting down.
func (s *Sessions) Close(id, reason string) {
	s.mu.Lock()
	session, ok := s.list[id]
	delete(s.list, id)
	s.mu.Unlock()
	if !ok {
		return
	}
	session.Unwatch()
	session.proc.Release()
	if s.Log != nil {
		s.Log.Info("agent: released session=%s reason=%s", id, reason)
	}
}

// CloseAll releases every session, in parallel, and is the shutdown path.
//
// Parallel because each release is bounded but not instant (a wedged agent gets a second, then a signal), and
// a server with five stale agents should stop in the time one takes, not five. Nothing else touches the list
// while this runs: the HTTP server has already stopped taking requests when the shutdown path gets here.
func (s *Sessions) CloseAll(reason string) {
	s.mu.RLock()
	ids := make([]string, 0, len(s.list))
	for id := range s.list {
		ids = append(ids, id)
	}
	s.mu.RUnlock()
	if len(ids) == 0 {
		return
	}

	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			s.Close(id, reason)
		}(id)
	}
	wg.Wait()
}

// Watch makes this connection the session's reader, replacing whoever had it.
//
// The newest connection wins, and the one it replaces is told: the alternative — refusing the new one —
// is what a second tab on the same canvas used to hit, and the tab that gets refused is the one the
// person is looking at. Deltas are still never split: exactly one sink receives them, and the old one
// hears `closed` and can reconnect.
//
// The returned function detaches this connection. It does nothing to the agent: a socket going away is not
// the end of the conversation (#160's rule, now the rule for every socket rather than only a replaced one),
// and the process stays for whoever connects next. What is left to do on the way out is the tool calls this
// connection was supposed to answer — the page that would have run them is gone, and that is the answer.
//
// It reports whether this connection was still the reader. A socket that a newer one replaced has nothing to
// detach, and the caller that has an ending to decide — a name with no conversation to come back to — must
// not end a session that now belongs to somebody else (#83, #160).
func (s *Session) Watch(sink func(Event) error) (stop func() bool) {
	s.mu.Lock()
	previous := s.sink
	s.watchGeneration++
	generation := s.watchGeneration
	s.sink = sink
	s.mu.Unlock()
	if previous != nil {
		_ = previous(Event{Type: "closed"})
	}
	released := false
	return func() bool {
		s.mu.Lock()
		if released {
			s.mu.Unlock()
			return false
		}
		released = true
		if s.watchGeneration != generation {
			s.mu.Unlock()
			return false
		}
		pending := s.detachLocked()
		s.mu.Unlock()
		answerDropped(pending)
		return true
	}
}

// snapshotEvent is the startup broadcast of a live session, read under its own lock.
func snapshotEvent(session *Session) Event {
	state := session.snapshot()
	return state.event()
}

// snapshot is the session's current startup broadcast, safe to read while the pump is running.
func (s *Session) snapshot() startup {
	s.stateMu.RLock()
	defer s.stateMu.RUnlock()
	return s.state
}

// Unwatch detaches the connection. The pump keeps reading until the process is released — a reader that
// stopped with its socket could not be restarted, and whatever the agent says while it winds down still
// belongs in its log.
//
// Any tool call still waiting is answered here rather than left to time out: the page that would have
// run it is gone, and that is the answer.
func (s *Session) Unwatch() {
	s.mu.Lock()
	pending := s.detachLocked()
	s.mu.Unlock()
	answerDropped(pending)
}

// detachLocked drops the reader and hands back the tool calls that were waiting on it, which the caller
// answers outside the lock. One implementation, because a detached session answers the same question
// whether it was replaced or released.
func (s *Session) detachLocked() map[string]chan toolAnswer {
	s.sink = nil
	pending := s.pending
	s.pending = map[string]chan toolAnswer{}
	return pending
}

// answerDropped tells every waiting tool call that the canvas went away. Delivering does not block: the
// channel holds one answer and nothing may wait on a call that is already lost.
func answerDropped(pending map[string]chan toolAnswer) {
	for _, waiting := range pending {
		deliver(waiting, toolAnswer{content: TextContent("the canvas went away"), isError: true})
	}
}

// toolAnswer is what the canvas says about a tool call: the content blocks to hand the agent, and whether
// the tool failed rather than did something.
type toolAnswer struct {
	content json.RawMessage
	isError bool
}

// TextContent is a tool result that is only words, which is what the server says when it cannot get an
// answer at all.
func TextContent(text string) json.RawMessage {
	content, err := json.Marshal([]map[string]string{{"type": "text", "text": text}})
	if err != nil {
		return json.RawMessage(`[{"type":"text","text":"the canvas did not answer"}]`)
	}
	return content
}

// toolTimeout is how long a tool call waits for the canvas. Short of forever is the point: a call that
// never returns holds the agent's whole turn open, and a page that is not answering is not going to.
const toolTimeout = 30 * time.Second

// CallTool runs one of the server's tools by asking the canvas. The server knows the vocabulary, the
// page knows the nodes, so the call goes down the session's socket and this waits for the answer.
//
// The answer is whatever content blocks the page produced, carried through untouched: the protocol says
// what they are, so nothing here has to know. Every way of not getting an answer — nobody watching, a
// canvas that left, a page that never replied — is a text block with `isError` rather than an error: an
// agent told "the canvas did not answer" can say so to the user, while an aborted turn just disappears.
func (s *Session) CallTool(name string, arguments json.RawMessage) (json.RawMessage, bool) {
	s.mu.Lock()
	if s.sink == nil {
		s.mu.Unlock()
		return TextContent("no canvas is connected to this session"), true
	}
	s.calls++
	callID := "tool-" + strconv.Itoa(s.calls)
	waiting := make(chan toolAnswer, 1)
	s.pending[callID] = waiting
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.pending, callID)
		s.mu.Unlock()
	}()

	s.publish(Event{Type: "tool", CallID: callID, Name: name, Arguments: arguments})
	select {
	case answer := <-waiting:
		return answer.content, answer.isError
	case <-time.After(toolTimeout):
		return TextContent("the canvas did not answer"), true
	}
}

// AnswerTool completes a call the canvas ran, and reports whether anyone was still waiting for it: an
// answer that arrives after the timeout has nobody left to tell.
func (s *Session) AnswerTool(callID string, content json.RawMessage, isError bool) bool {
	s.mu.Lock()
	waiting, ok := s.pending[callID]
	delete(s.pending, callID)
	s.mu.Unlock()
	if ok {
		deliver(waiting, toolAnswer{content: content, isError: isError})
	}
	return ok
}

// deliver hands over an answer without ever blocking: the channel holds one, and an answer that arrives
// twice (a canvas and a timeout both finishing) is not worth waiting on.
func deliver(waiting chan toolAnswer, answer toolAnswer) {
	select {
	case waiting <- answer:
	default:
	}
}

// publish hands one event to the watcher, if there is one. A failed write means the connection is gone,
// so it is detached — the pump carries on.
func (s *Session) publish(event Event) {
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil {
		return
	}
	if err := sink(event); err != nil {
		s.Unwatch()
	}
}

// recordFrame files one frame of the conversation, whether or not anyone is listening.
//
// It is a frame and not an event because a frame is what the conversation is: `UX` and `UF` carry their
// media, and a page that connects later is shown them through the same translation a session file gets.
// The `tool` events the canvas runs are not frames and never reach here, which is what keeps a replay from
// running a tool a second time.
func (s *Session) recordFrame(frame *Frame) {
	s.mu.Lock()
	s.talk.record(frame)
	s.mu.Unlock()
}

// replay is the conversation so far, as the events a page draws it with.
func (s *Session) replay() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.talk.events()
}

// pump is the session's one reader, for the whole life of the process.
func (s *Session) pump() {
	for {
		frame, err := s.proc.Read()
		if err != nil || frame == nil {
			s.publish(Event{Type: "closed"})
			s.gone("exited")
			return
		}
		// Before it is relayed, and before the turn is asked what it ended on: the conversation has to be
		// readable by whoever connects next, and there may be nobody connected now — the words of a turn
		// that runs while the panel is closed are exactly what a reload is meant to find.
		s.recordFrame(frame)
		// The end of a turn is a marker, not a second copy of the answer: the deltas already carried it,
		// and two strings that agree until they do not are worse than one.
		//
		// `destination` is taken either side of the frame, because this is where the agent announces that it is
		// sending somewhere else — a model switch, or a list that repointed the active one. A line per change, and
		// none when the answer is the same, so a `model` frame repeated with the same id (the agent restates its
		// state) does not fill the log.
		s.stateMu.Lock()
		before := s.state.destination()
		ended := turnStep(&s.state, frame, true, s.publish)
		after := s.state.destination()
		s.stateMu.Unlock()
		if after != before {
			s.Log.Info("agent: session=%s %s", s.ID, destinationLine(after))
		}
		if ended {
			// Cleared before the `done` leaves, so a caller that acts on the end of a turn — the panel
			// reopening its session, the delete route deciding — sees an idle agent.
			s.setBusy(false)
			s.publish(Event{Type: "done"})
		}
	}
}

// Send writes one message into the process. Writing is what a connection does when the user types; the
// answer arrives through the watcher, not here.
//
// A prompt is a turn, and a turn ends at the agent's `done` — the one place this flag is cleared. A
// command is not: it answers with its own `CO` and the session is as idle afterwards as it was before.
func (s *Session) Send(req Request) error {
	s.write.Lock()
	defer s.write.Unlock()
	if err := writeRequest(s.proc, req); err != nil {
		return err
	}
	if req.Prompt != "" {
		s.setBusy(true)
	}
	return nil
}

// Busy reports whether a turn is in flight.
func (s *Session) Busy() bool {
	s.busyMu.Lock()
	defer s.busyMu.Unlock()
	return s.busy
}

func (s *Session) setBusy(busy bool) {
	s.busyMu.Lock()
	s.busy = busy
	s.busyMu.Unlock()
}

// Cancel asks the agent to wind its current task down. A turn is the agent's to finish, so this is a
// request rather than a kill; what it already said is in the session file either way.
//
// The word, if there is one, is AlayaCore's own cancel argument and is forwarded unchanged: `keep_steering`
// is the only value it declares (`commands.CancelArgKeepSteering`), and what it means is that the words
// queued into the running task become the next prompt instead of being dropped with it. An empty word is
// the drop — the behaviour a bare cancel has always had, and the only one a signal can ask for. Which of
// the two a cancel means is the panel's decision, made where the queue is on screen; the server writes
// what it was given and does not choose.
func (s *Session) Cancel(args string) error {
	s.write.Lock()
	defer s.write.Unlock()
	payload, err := json.Marshal(map[string]string{"command_id": "cancel", "name": "cancel", "args": args})
	if err != nil {
		return err
	}
	if err := s.proc.Write(TagCmdInput, string(payload)); err != nil {
		return ErrGone
	}
	return nil
}

func newSessionID() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return "session"
	}
	return hex.EncodeToString(buffer)
}

// destinationLine is where a session's turns go, as the end of a log line.
//
// This is the line to look at when a turn is slow, refused or answered by the wrong provider: it names the model
// and the address it is actually sent to, which the model picker alone does not (`destination`), and an empty one
// is said rather than left blank.
func destinationLine(where string) string {
	if where == "" {
		return "no model active"
	}
	return "sending to " + where
}

// readStartup reads the frames an agent emits before it accepts input: its own startup broadcast, and
// the conversation it replayed from its session file. The frames come back as they arrived, because they
// are the beginning of the session's transcript rather than something to draw once and throw away.
func readStartup(proc *Process) (startup, []Frame, error) {
	state := startup{}
	var replay []Frame
	err := waitReady(proc, &state, &replay, func(Event) {}, func() error { return nil })
	return state, replay, err
}
