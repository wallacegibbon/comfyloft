package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"

	"comfyloft/internal/agent"
	"comfyloft/internal/httpx"
	"comfyloft/internal/ws"
)

// routesAgent registers the agent routes.
//
// A session is one agent process with one name, and the name is the client's — the canvas panel calls
// its own `canvas:<canvasId>`, and the models editor calls `settings`. The client owns the lifetime,
// because the client is what knows when a surface went away. The server only files processes under
// names, and keeps the conversation that has somewhere to go — a canvas's — inside that canvas.
func (s *Server) routesAgent(mux *http.ServeMux) {
	s.route(mux, "GET /api/agent/socket/{session}", s.handleAgentSocket)
	s.route(mux, "DELETE /api/agent/session/{session}", s.handleAgentSessionDelete)
}

// handleAgentSessionDelete implements DELETE /api/agent/session/{session}: forget this conversation.
//
// The canvas owns the name and is the only thing that knows a conversation is over. The file lives inside
// the canvas, so deleting the canvas is what normally ends it; this route is the other half — the process
// is released first, so nothing writes the file back after it is removed, and the client can end a
// conversation without ending the canvas.
//
// A session with a turn in flight is refused with `409 agent_busy` and left exactly as it was: the turn
// is writing the next entry of the file this would remove, and releasing it would cancel work nobody
// asked to cancel. Nothing is half-done on that path — no release, no removal.
func (s *Server) handleAgentSessionDelete(ctx *httpx.Ctx) error {
	id := ctx.R.PathValue("session")
	// A turn in flight is writing the next entry of the file this would delete, and releasing the agent
	// would cancel work nobody asked to cancel. The panel disables its button for the same reason
	// (docs/decisions.md #187) — this is the rule, and the button is the courtesy.
	if s.agentSessions.Busy(id) {
		return httpx.NewError(http.StatusConflict, "agent_busy", "the agent is in the middle of a turn: stop it, or wait for it to finish")
	}
	s.agentSessions.Close(id, "forgotten")

	removed := false
	if file, err := s.sessionFile(id); err == nil {
		switch err := os.Remove(file); {
		case err == nil:
			removed = true
		case !errors.Is(err, fs.ErrNotExist):
			return err
		}
	}

	httpx.OK(ctx.W, map[string]any{"ok": true, "removed": removed})
	return nil
}

// agentOptions is what every spawn needs. The wording (skills) and the tools are passed through from
// configuration: the server has no opinion about either.
//
// Every spawn gets the same options, and `read_file` is the only tool: the H3 prompt rewrite works by
// reading a `SKILL.md`, and an agent that could not read one could not load a skill at all. Nothing
// here can hand itself a shell.
func (s *Server) agentOptions() agent.SpawnOptions {
	return agent.SpawnOptions{
		Binary:     s.cfg.AgentBin,
		ConfigPath: s.cfg.AgentConfigPath,
		Skills:     s.cfg.AgentSkills,
		Tools:      "read_file",
		// The one number the operator may set that AlayaCore cannot read from its own config file: the
		// context threshold for summarizing (`AGENT_AUTO_SUMMARIZE`). 0 leaves the flag off entirely.
		AutoSummarize: s.cfg.AgentAutoSummarize,
		// The one thing the server says on its own account: the rule that chooses between the canvas
		// tools, which no single tool's description can state (`agent_instructions.go`).
		System: []string{canvasInstructions},
		Log:    s.logger,
	}
}

// socketMessage is what a client may say on the socket. One of them per message: a prompt, a setting,
// a cancel, a tool's answer, or the end of the conversation.
type socketMessage struct {
	Prompt  string   `json:"prompt"`
	Images  []string `json:"images"`
	Command string   `json:"command"`
	// Args is what a command carries, and — for a cancel — the one optional word AlayaCore accepts there
	// (`keep_steering`). It is forwarded unchanged either way; the server does not read it.
	Args   string `json:"args"`
	Cancel bool   `json:"cancel"`
	// ToolResult is the canvas answering a `tool` event: what running the tool did. It is not the same
	// pipe as the agent's own `tool_call` / `tool_result` events, which run inside AlayaCore and which
	// the server only relays.
	ToolResult *toolAnswer `json:"toolResult"`
	// Close ends the conversation: the agent is released, history and all. Closing the tab is not this: a
	// socket that goes away releases the process too, and what makes coming back a continuation is the file
	// the next process replays, not a process left running.
	Close bool `json:"close"`
}

// toolAnswer is one tool's result, on its way from the canvas to the agent: the content blocks the page
// produced, in the protocol's own shape, and whether the tool failed rather than did something.
type toolAnswer struct {
	CallID  string          `json:"callId"`
	Content json.RawMessage `json:"content"`
	IsError bool            `json:"isError"`
}

// handleAgentSocket implements GET /api/agent/socket/{session}: the conversation.
//
// Everything after the upgrade is a message, in both directions. That is why this route reports its
// failures as messages rather than status codes — once the header is out, a status code has nowhere to
// go, and a server that pretended otherwise would be lying with a 200.
func (s *Server) handleAgentSocket(ctx *httpx.Ctx) error {
	// Origin is checked before the upgrade by the middleware, which treats an upgrade as the write it
	// becomes: a cross-site page must not be able to talk to a canvas's agent.
	conn, err := ws.Accept(ctx.W, ctx.R)
	if err != nil {
		// Nothing has been hijacked, so this is still an ordinary failed request.
		return httpx.NewError(http.StatusBadRequest, "not_a_websocket", err.Error())
	}
	defer conn.Close()
	go conn.KeepAlive()

	id := ctx.R.PathValue("session")
	send := func(event agent.Event) error {
		payload, err := json.Marshal(event)
		if err != nil {
			return nil // an event that cannot be encoded is not worth closing a conversation over
		}
		return conn.WriteText(payload)
	}

	// Where a conversation is kept is the name's business, not the client's: a canvas keeps one inside itself,
	// and a name that is not a canvas keeps nothing (the models editor is a form, not a dialogue). File
	// processes under names — do not teach it which names mean what.
	options, err := s.agentOptionsFor(id)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("agent: socket %q cannot keep its conversation: %v", id, err)
		}
		_ = send(agent.Event{Type: "error", Message: err.Error()})
		return nil
	}
	connected, err := s.agentSessions.Connect(ctx.R.Context(), id, options)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("agent: socket %q could not connect: %v", id, err)
		}
		_ = send(agent.Event{Type: "error", Message: err.Error()})
		return nil
	}
	session := connected.Session
	// The newest connection reads the session, and the one it replaces is told so (#160). Refusing the
	// new one meant a second tab — or a socket somebody forgot to close — left every later question
	// unanswered, with only `closed` in the log to show for it.
	stopWatching := session.Watch(send)
	// The socket going away is not the end of the conversation: the agent belongs to the canvas, so it keeps
	// running — a turn in flight finishes with nobody reading it, and the words land in the session's
	// transcript for the page that comes back. Ending it is an act, not an accident: `close` on this socket,
	// the delete route, or the canvas being deleted.
	//
	// Except for a name with nowhere to put a conversation: the models editor is a form, opened and closed
	// with its window (#83), and nothing would ever come back to its process because there is nothing to come
	// back to. The canvas is the surface that outlives its socket, and it is the one that keeps a file.
	defer func() {
		if !stopWatching() {
			return // a newer connection reads this session now, and the ending is not ours to decide
		}
		if _, err := s.sessionFile(session.ID); errors.Is(err, errNotACanvas) {
			s.agentSessions.Close(session.ID, "socket closed")
		}
	}()
	if s.logger != nil {
		s.logger.Info("agent: socket open session=%s spawned=%t", session.ID, connected.Spawned)
	}

	// The agent's own startup broadcast first, so the model list is there before anything is asked.
	if err := send(connected.Startup); err != nil {
		return nil
	}
	// Then the conversation this session is holding — always, even when empty: a page that opens this
	// socket is drawing the agent's conversation, and the agent has just said what that is. It is the same
	// answer for a process that was started for this connection and for one that has been running all
	// along, which is what makes a reload look like nothing happened.
	if err := send(agent.Event{Type: "history", History: connected.History}); err != nil {
		return nil
	}
	// Then whether a turn is running, and for how long, which the transcript cannot say: a replayed
	// conversation is all finished messages, and so is a turn that has not produced its first one. The agent
	// outlives this socket, so the answer is not "no" by construction — and the age of the turn is the one
	// thing a page that comes back cannot count for itself (docs/decisions.md #342).
	running, elapsed := session.Turn()
	if err := send(agent.Event{Type: "turn", Running: running, ElapsedMs: elapsed.Milliseconds(), Queued: session.Queued()}); err != nil {
		return nil
	}
	// Then what this conversation is owed: runs it asked about that ended while nobody could be told
	// (docs/decisions.md #285). Off the read loop, because telling the agent is a write into its process and
	// the conversation must not wait on it.
	go s.flushRunNotices(session.ID)

	// One goroutine, and it is the reading half of the conversation: what the agent says reaches this
	// socket through the pump, and what the user says is applied here until the socket ends.
	s.readSocket(conn, session, send)

	// The socket is gone, and that is all that has happened. `defer stopWatching()` detaches this
	// connection; the agent, the turn it is running and the conversation stay where they are, for this page
	// when it comes back or for the tab that takes over.
	return nil
}

// readSocket applies what the user says, one message at a time, until the socket ends.
func (s *Server) readSocket(conn *ws.Conn, session *agent.Session, send func(agent.Event) error) {
	for {
		raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var message socketMessage
		if err := json.Unmarshal(raw, &message); err != nil {
			_ = send(agent.Event{Type: "error", Message: "the canvas sent a message that is not JSON"})
			continue
		}
		switch {
		case message.ToolResult != nil:
			if s.logger != nil {
				s.logger.Info("agent: tool answered session=%s callId=%s isError=%t", session.ID, message.ToolResult.CallID, message.ToolResult.IsError)
			}
			session.AnswerTool(message.ToolResult.CallID, message.ToolResult.Content, message.ToolResult.IsError)
		case message.Close:
			s.agentSessions.Close(session.ID, "closed by the client")
			_ = conn.Close()
			return
		case message.Cancel:
			// The optional word travels with it (`keep_steering`), so a stop can either take the queued
			// messages with it or leave them to run as the next prompt. The panel decides which; the
			// server forwards — see `agent.Session.Cancel`.
			if err := session.Cancel(message.Args); err != nil {
				return
			}
		default:
			request := agent.Request{Prompt: message.Prompt, Images: message.Images, Command: message.Command, Args: message.Args}
			// A model list is the one argument the canvas cannot make complete on its own (see
			// `agent.Sessions.ModelSync`): it may edit the four fields it can see, and the server puts back
			// the key and the reasoning blocks it cannot — for the whole list, since `model_sync` replaces
			// every model in the file.
			if request.Command == "model_sync" {
				completed, err := s.agentSessions.ModelSync(session, request.Args)
				if err != nil {
					_ = send(agent.Event{Type: "error", Message: err.Error()})
					continue
				}
				request.Args = completed
			}
			if s.logger != nil {
				s.logger.Info("agent: socket in session=%s command=%q prompt=%q images=%d", session.ID, request.Command, truncateText(request.Prompt, 120), len(request.Images))
			}
			if err := session.Send(request); err != nil {
				_ = send(agent.Event{Type: "error", Message: "the agent process is gone; reconnect to start a new one"})
				return
			}
		}
	}
}

// truncateText keeps a prompt's head for the log: a full one can be a page long, and the first line is
// what identifies it.
func truncateText(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + fmt.Sprintf("… (%d runes)", len(runes))
}
