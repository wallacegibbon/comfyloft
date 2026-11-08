package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Event is a frame the canvas may draw, and nothing more. The names are the protocol's, not ours:
// the agent already decided what happened, this struct only carries it.
type Event struct {
	Type string `json:"type"`

	// delta, reasoning(delta), done
	Text string `json:"text,omitempty"`

	// usage: the agent's own telemetry for the task it is running — SM `task`'s `context_tokens`,
	// `step_tps` and `ttft_ms`: how full the context is, and how fast the last step went, latency
	// included. Relayed as the agent restates it, never computed here, because the numbers are a
	// measurement only the agent can take (`docs/speed-tracking.md` in AlayaCore is where they come from).
	//
	// `models` carries the same three when the agent restored a count from a session file at startup, so a
	// reloaded page knows how full the context is before it asks anything: the frame is the agent's own
	// startup broadcast, and this is part of what it broadcasts.
	ContextTokens int64   `json:"contextTokens,omitempty"`
	StepTps       float64 `json:"stepTps,omitempty"`
	TtftMs        int64   `json:"ttftMs,omitempty"`

	// models: the startup broadcast of the spawn that produced this stream
	Models         []Model `json:"models,omitempty"`
	Active         *Model  `json:"active,omitempty"`
	Level          *int    `json:"level,omitempty"`
	CoreVersion    string  `json:"coreVersion,omitempty"`
	MessageVersion int     `json:"messageVersion,omitempty"`

	// command: the agent's answer to a CI frame
	OK bool `json:"ok,omitempty"`

	// turn: whether a turn is in flight, stated on connect and never guessed. A conversation replayed from
	// the agent looks exactly like a turn that has not said anything yet — every message in it is finished —
	// so a page that comes back has no way to tell the two apart from the transcript alone. This is the one
	// fact that tells them apart, and the server is the only side that knows it.
	//
	// Always stated, never omitted, for the reason `serialToolCalls` is: an absent field would read as
	// "not running", and a false answer is not the same thing as no answer.
	Running bool `json:"running"`

	// turn: how long the turn in flight had been running when this frame was written — the one thing a page
	// that joins a turn it did not start is missing, and what makes a reload continue the count instead of
	// restarting it (#342).
	//
	// A duration and not the instant it began, on purpose: the page and the session can be two machines, and
	// a turn on a clock that differs from the page's by two minutes is still exactly as long as it is. Absent
	// means "just began", which is the truth for a turn whose only news is this frame, and what a page counts
	// forward from — so the field needs no `running`-style always-stated rule.
	ElapsedMs int64 `json:"elapsedMs,omitempty"`

	// steering: `queued` when a message sent into a running task was taken into the queue, `delivered`
	// when the agent has worked it into the conversation.
	Phase string `json:"phase,omitempty"`

	// tool_call, tool_result: what the agent did between two sentences. A built-in tool runs inside
	// AlayaCore, so both frames come back from it — the server relays them and answers neither.
	CallID string `json:"callId,omitempty"`
	Name   string `json:"name,omitempty"`
	Input  string `json:"input,omitempty"`
	Output string `json:"output,omitempty"`
	// tool_result: the agent's own verdict on the call, UF's `is_error`. It is relayed as it comes, since
	// the step the canvas already drew needs one thing from the result — whether it worked.
	IsError bool `json:"isError,omitempty"`

	// tool: one of the server's own tools, on its way down to the canvas, which is the only thing that
	// can run it. The canvas answers with `{"toolResult":…}` on the same socket — see Session.CallTool.
	Arguments json.RawMessage `json:"arguments,omitempty"`

	// notice: an SM `notify`, the agent saying what it is doing to itself — summarizing a conversation,
	// retrying a step, deferring a prompt until MCP is ready. It is not part of the conversation (it is
	// not in the session file) and it is not an error, so it travels as a kind of its own. Its words are
	// `Text`.

	// error: the agent's own words
	Message string `json:"message,omitempty"`

	// history: the conversation this session is holding, as the events it sent live — what a page that
	// connects draws instead of an empty panel. It arrives on every connection, for a process that was just
	// started and for one that has been running for an hour, because it is the session's own record rather
	// than a transcript of its startup. A reloaded page draws this instead of nothing, and it replaces
	// whatever it had.
	History []Event `json:"history,omitempty"`
}

// Model is what a canvas is told about one of the agent's models: enough to show it in a picker and to
// name it in a URL, and nothing else.
//
// `SM model_list` carries the whole `model.conf` entry in cleartext — the `api_key` above all, then the
// `reasoning_N` blocks and the token caps. None of that travels: `HasKey` says a key is stored without
// saying what it is, and the entry itself stays in the server (`modelObject`), which is where the list a
// canvas edits is completed from (#75: the surface edits models, the key never leaves the adapter).
type Model struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`
	ProtocolType string `json:"protocolType,omitempty"`
	BaseURL      string `json:"baseUrl,omitempty"`
	ModelName    string `json:"modelName,omitempty"`
	ContextLimit int    `json:"contextLimit,omitempty"`
	HasKey       bool   `json:"hasKey,omitempty"`
	MaxTokens    int    `json:"maxTokens,omitempty"`
	// The three reasoning blocks, as the agent holds them: raw JSON merged into a request body at each
	// reasoning level (0 off, 1 normal, 2 max). Sent as JSON rather than as text because that is what they
	// are; the form that edits them shows the text and parses it back (`lib/agent-models.ts`).
	Reasoning0 json.RawMessage `json:"reasoning0,omitempty"`
	Reasoning1 json.RawMessage `json:"reasoning1,omitempty"`
	Reasoning2 json.RawMessage `json:"reasoning2,omitempty"`
	// The response key that carries reasoning text for this endpoint; empty means the provider's default.
	ReasoningField string `json:"reasoningField,omitempty"`
	// Whether a step's tool calls run one at a time. Always stated, never omitted: an absent field would
	// read as "not known", and false is the answer that means "run them in parallel" (#249).
	SerialToolCalls bool `json:"serialToolCalls"`
	// The input modalities this model declares, exactly as `model.conf` holds them: nil is "not declared"
	// — the protocol decides what it is sent — and an empty list is a declaration too, meaning no media
	// at all. Always stated, never omitted, for the reason `serialToolCalls` is: `[]` travelling as an
	// absent field would come back through `model_sync` as an unrestricted model, which is a silent
	// widening of the file (#256).
	InputModalities []string `json:"inputModalities"`
}

// modelObject is one entry of `SM model_list`, exactly as the agent sent it.
//
// Kept whole, because `model_sync` takes the *whole list back* and AlayaCore writes `model.conf` from it:
// any field the server did not keep is a field one edit silently deletes — the `api_key` first of all,
// then every `reasoning_N` block and token cap that no control in the canvas reaches. Holding the object
// as it arrived means the server does not know those fields by name, so a field AlayaCore adds tomorrow
// survives a round trip through a page that never heard of it.
//
// Values stay `json.RawMessage`: the ones that travel back must travel untouched. The server reads the
// few a canvas is shown (`info`) and replaces the four an editor owns (`mergeModelSync`).
type modelObject map[string]json.RawMessage

// info is the part of an entry a canvas is shown.
func (o modelObject) info() Model {
	return Model{
		ID:              o.number("id"),
		Name:            o.text("name"),
		ProtocolType:    o.text("protocol_type"),
		BaseURL:         o.text("base_url"),
		ModelName:       o.text("model_name"),
		ContextLimit:    o.number("context_limit"),
		HasKey:          o.text("api_key") != "",
		MaxTokens:       o.number("max_tokens"),
		Reasoning0:      o.raw("reasoning_0"),
		Reasoning1:      o.raw("reasoning_1"),
		Reasoning2:      o.raw("reasoning_2"),
		ReasoningField:  o.text("reasoning_field"),
		SerialToolCalls: o.boolean("serial_tool_calls"),
		InputModalities: o.list("input_modalities"),
	}
}

// list is one array-of-strings field as it arrived, or nil for a field that is absent, JSON `null`, or
// something that is not an array of strings.
//
// Nil and empty are deliberately kept apart here, because they are kept apart everywhere else: an absent
// key means "not declared, the protocol decides", while `[]` means "declared, and it takes no media". The
// decode of `[]` into a nil slice yields an empty non-nil one, which is what makes the distinction survive
// without a pointer or a second boolean.
func (o modelObject) list(field string) []string {
	var values []string
	if raw, ok := o[field]; ok && len(raw) > 0 {
		_ = json.Unmarshal(raw, &values)
	}
	return values
}

// raw is one field exactly as it arrived, or nil for a field that is absent or JSON `null`.
//
// Nil rather than the four bytes of `null`: a reasoning block that is not there and one that is written as
// `null` are the same thing to AlayaCore (it merges a value only when it has length), and one of them should
// not appear in a page's JSON as something to edit.
func (o modelObject) raw(field string) json.RawMessage {
	value, ok := o[field]
	if !ok || len(value) == 0 || string(value) == "null" {
		return nil
	}
	return value
}

// boolean is one boolean field, or false for a field that is absent or not a boolean.
func (o modelObject) boolean(field string) bool {
	var value bool
	if raw, ok := o[field]; ok {
		_ = json.Unmarshal(raw, &value)
	}
	return value
}

// text is one string field, or "" for a field that is absent or not a string.
func (o modelObject) text(field string) string {
	var value string
	if raw, ok := o[field]; ok {
		_ = json.Unmarshal(raw, &value)
	}
	return value
}

// number is one numeric field, or 0 for a field that is absent or not a number.
func (o modelObject) number(field string) int {
	var value int
	if raw, ok := o[field]; ok {
		_ = json.Unmarshal(raw, &value)
	}
	return value
}

// clone is this entry as something that may be changed without touching the copy the session keeps.
func (o modelObject) clone() modelObject {
	copied := make(modelObject, len(o))
	for field, raw := range o {
		copied[field] = raw
	}
	return copied
}

// Startup is the model information the agent broadcasts before it accepts input.
type Startup = startup

// startup is the model information the agent broadcasts before it accepts input, and the telemetry that
// comes with it: a session started on a file announces the context it restored before it says `ready`.
type startup struct {
	models         []modelObject
	active         *Model
	level          *int
	coreVersion    string
	messageVersion int
	usage          *usage
}

func (s *startup) collect(kind string, data json.RawMessage) {
	switch kind {
	case "model_list":
		var payload struct {
			Models []modelObject `json:"models"`
		}
		if json.Unmarshal(data, &payload) != nil {
			return
		}
		s.models = payload.Models
	case "model":
		var payload struct {
			ActiveID     int    `json:"active_id"`
			ActiveName   string `json:"active_name"`
			ContextLimit int    `json:"context_limit"`
		}
		if json.Unmarshal(data, &payload) == nil {
			s.active = &Model{ID: payload.ActiveID, Name: payload.ActiveName, ContextLimit: payload.ContextLimit}
		}
	case "reasoning_level":
		var payload struct {
			Level int `json:"level"`
		}
		if json.Unmarshal(data, &payload) == nil {
			level := payload.Level
			s.level = &level
		}
	case "version":
		var payload struct {
			MessageVersion int    `json:"message_version"`
			CoreVersion    string `json:"core_version"`
		}
		if json.Unmarshal(data, &payload) == nil {
			s.messageVersion = payload.MessageVersion
			s.coreVersion = payload.CoreVersion
		}
	case "task":
		// The count the agent restored from the session file. A page that reconnects is drawing a
		// conversation that has one, and the number is only in this frame.
		if reported, ok := taskUsage(data); ok {
			s.usage = &reported
		}
	}
}

func (s *startup) event() Event {
	models := make([]Model, 0, len(s.models))
	for _, object := range s.models {
		models = append(models, object.info())
	}
	event := Event{Type: "models", Models: models, Active: s.active, Level: s.level, CoreVersion: s.coreVersion, MessageVersion: s.messageVersion}
	if s.usage != nil {
		event.ContextTokens = s.usage.contextTokens
		event.StepTps = s.usage.stepTps
		event.TtftMs = s.usage.ttftMs
	}
	return event
}

/**
 * Where the active model's requests are sent, as one line for the log.
 *
 * The address is looked up in the list rather than read off `active`, because a `model` frame carries the id, the
 * name and the context limit and nothing else — the `base_url` and the model name only ever arrive in
 * `model_list`. So this answers the question a reader actually has when something is slow, wrong or refused:
 * *which server, and as which model?* (`active` says which model, which is not the same answer.)
 *
 * Empty before the agent has said which model is active. The key is never part of it: `SM model_list` carries
 * every `api_key` in cleartext, and a log file is not the place for one.
 */
func (s *startup) destination() string {
	if s.active == nil {
		return ""
	}
	entry := s.modelByID(s.active.ID)
	if entry == nil {
		return fmt.Sprintf("%q (its entry is not in the list)", s.active.Name)
	}
	info := entry.info()
	parts := []string{info.BaseURL}
	if info.ModelName != "" {
		parts = append(parts, "model "+info.ModelName)
	}
	if info.ProtocolType != "" {
		parts = append(parts, info.ProtocolType)
	}
	return fmt.Sprintf("%q -> %s", info.Name, strings.Join(parts, ", "))
}

// modelByID is the entry with this id, or nil. Ids are positions (`model.conf` order, restated by every
// `SM model_list`), which is what makes them the handle a canvas may send back.
func (s *startup) modelByID(id int) modelObject {
	for _, object := range s.models {
		if object.number("id") == id {
			return object
		}
	}
	return nil
}

// systemMessage is the SM envelope: {"type":...,"data":{...}}.
func systemMessage(value string) (string, json.RawMessage, bool) {
	var envelope struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal([]byte(value), &envelope) != nil {
		return "", nil, false
	}
	return envelope.Type, envelope.Data, true
}

// contentDelta is the Ax body: a content item, `text` or `reasoning`.
func contentDelta(value string) (kind, text string, ok bool) {
	var item struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(value), &item) != nil {
		return "", "", false
	}
	return item.Type, item.Text, true
}

// sessionState is the SM session payload.
func sessionState(data json.RawMessage) string {
	var payload struct {
		State string `json:"state"`
	}
	if json.Unmarshal(data, &payload) != nil {
		return ""
	}
	return payload.State
}

// taskInProgress is the SM task payload; a task that ends is what ends a prompt.
func taskInProgress(data json.RawMessage) (done bool, known bool) {
	var payload struct {
		InProgress *bool `json:"in_progress"`
	}
	if json.Unmarshal(data, &payload) != nil || payload.InProgress == nil {
		return false, false
	}
	return !*payload.InProgress, true
}

// usage is what the agent reports about the work it is doing: how full the model's context is, and how
// the last step went. Both are the agent's measurements — `context_tokens` is what it counted, `step_tps`
// is output tokens over the whole round trip and `ttft_ms` is the wait for the first one — so this side
// only carries them (`docs/speed-tracking.md` in AlayaCore, decisions #224).
type usage struct {
	contextTokens int64
	stepTps       float64
	ttftMs        int64
}

// taskUsage is SM `task`'s telemetry. A frame that reports no context tokens is the start of a step
// before anything has been counted, and there is nothing to draw: the canvas shows the context and the
// speed the agent last stated rather than a zero it did not mean.
//
// `step_tps` is absent until a step produces output tokens and 0 for a step that produces none, which is
// the same thing to a reader — no speed to show — so both collapse to 0 here.
func taskUsage(data json.RawMessage) (usage, bool) {
	var payload struct {
		ContextTokens int64   `json:"context_tokens"`
		StepTPS       float64 `json:"step_tps"`
		TTFTMs        int64   `json:"ttft_ms"`
	}
	if json.Unmarshal(data, &payload) != nil || payload.ContextTokens <= 0 {
		return usage{}, false
	}
	return usage{contextTokens: payload.ContextTokens, stepTps: payload.StepTPS, ttftMs: payload.TTFTMs}, true
}

// event is this telemetry as the canvas draws it.
func (u usage) event() Event {
	return Event{Type: "usage", ContextTokens: u.contextTokens, StepTps: u.stepTps, TtftMs: u.ttftMs}
}

// commandOutput is the CO body.
func commandOutput(value string) (commandID string, ok bool, message string) {
	var payload struct {
		CommandID string `json:"command_id"`
		IsError   bool   `json:"is_error"`
		Result    struct {
			Message string `json:"message"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(value), &payload) != nil {
		return "", false, ""
	}
	return payload.CommandID, !payload.IsError, payload.Result.Message
}

// toolCall is the AF body: one call arrives in two frames, the name first and the arguments in the
// second, sharing a call_id. Both are relayed as they come rather than joined, because the canvas can
// show a step before it knows what the step is doing.
func toolCall(value string) (Event, bool) {
	var payload struct {
		CallID string          `json:"call_id"`
		Name   string          `json:"name"`
		Input  json.RawMessage `json:"input"`
	}
	if json.Unmarshal([]byte(value), &payload) != nil || payload.CallID == "" {
		return Event{}, false
	}
	return Event{Type: "tool_call", CallID: payload.CallID, Name: payload.Name, Input: string(payload.Input)}, true
}

// toolResult is the UF body. The output is a list of content items; the text of the first is what
// there is to show, and a result that carries no text is still a result. `is_error` is the tool's own
// verdict and travels with it: the canvas has already drawn the call, and success or failure is the one
// thing the result adds to that step.
func toolResult(value string) (Event, bool) {
	var payload struct {
		CallID string `json:"call_id"`
		Output []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"output"`
		IsError bool `json:"is_error"`
	}
	if json.Unmarshal([]byte(value), &payload) != nil || payload.CallID == "" {
		return Event{}, false
	}
	text := ""
	if len(payload.Output) > 0 {
		text = payload.Output[0].Text
	}
	return Event{Type: "tool_result", CallID: payload.CallID, Output: text, IsError: payload.IsError}, true
}

// systemNotice is the SM `notify` body: one sentence, and nothing else to it.
//
// These are the agent's own remarks about its work — "Summarizing conversation…", "retrying in 5s
// (retry 1/3)", "prompt deferred until MCP initialization completes". A blank one says nothing.
func systemNotice(data json.RawMessage) (string, bool) {
	var payload struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(data, &payload) != nil || strings.TrimSpace(payload.Text) == "" {
		return "", false
	}
	return payload.Text, true
}

// systemError is the SM error payload, which is a plain sentence.
func systemError(data json.RawMessage) Event {
	var payload struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal(data, &payload)
	return Event{Type: "error", Message: payload.Text}
}

// userContent is a `UX` frame's words: what the canvas sent, as the agent echoes it back.
//
// The tag travels in both directions, and the echo is the only place a user message comes from — live or
// replayed, the panel draws what the agent said was said, and keeps no copy of its own to keep in step.
func userContent(value string) (string, bool) {
	var item struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(value), &item) != nil || item.Type != "text" || strings.TrimSpace(item.Text) == "" {
		return "", false
	}
	return item.Text, true
}

// replayed reads a frame that arrived before the agent was ready as part of the conversation it loaded
// from its session file, and turns it into the event it would have been live.
//
// It is the same translation live turns get, because it is the same frames: the file holds what the agent
// said, and AlayaCore replays it as `UX` (the user's words) and `AX` (assistant content: text or
// reasoning) plus the `AF`/`UF` pair of every tool call. Reading only the text of that stream is what used
// to make a reloaded conversation lose its reasoning and its tool steps; nothing has to be merged,
// reordered or summarised here — the file is already in order, so each frame is passed on as it comes.
//
// The one thing skipped is the textless `AX` that closes a message written as deltas: it is a marker, and
// a turn whose stream already ended says nothing more.
func replayed(frame *Frame) (Event, bool) {
	switch frame.Tag {
	case TagUserX:
		if text, ok := userContent(frame.Value); ok {
			return Event{Type: "user", Text: text}, true
		}
		return Event{}, false
	case TagAssistantX:
		kind, text, ok := contentDelta(frame.Value)
		if !ok || strings.TrimSpace(text) == "" {
			return Event{}, false
		}
		switch kind {
		case "text":
			return Event{Type: "delta", Text: text}, true
		case "reasoning":
			return Event{Type: "reasoning", Text: text}, true
		}
		return Event{}, false
	case TagAssistantF:
		return toolCall(frame.Value)
	case TagUserF:
		return toolResult(frame.Value)
	default:
		// `Af`/`Uf` are argument and result previews — display only, and never authoritative — and every
		// other tag is the agent's own bookkeeping rather than something it said.
		return Event{}, false
	}
}

// waitReady reads startup frames until the session accepts input, then hands the collected state to
// onReady. Everything before that is the agent's own startup broadcast and, when it was started with a
// session file, the conversation it replayed from it — which is collected into replay as the frames it
// arrived as, so the session can keep them rather than only draw them once.
//
// An agent that stops before `ready` is an error, not an empty startup: it said nothing about itself, so
// the only account of why is the last line of its stderr, and a caller told "connected" would show an
// empty model list over a process that is already gone.
func waitReady(proc *Process, state *startup, replay *[]Frame, emit func(Event), onReady func() error) error {
	for {
		frame, err := proc.Read()
		if err != nil || frame == nil {
			return fmt.Errorf("the agent stopped before it was ready: %s", startFailure(proc, err))
		}
		if _, ok := replayed(frame); ok {
			if replay != nil {
				*replay = append(*replay, *frame)
			}
			continue
		}
		if frame.Tag != TagSystemMsg {
			continue
		}
		kind, data, ok := systemMessage(frame.Value)
		if !ok {
			continue
		}
		switch kind {
		case "session":
			if sessionState(data) != "ready" {
				continue
			}
			emit(state.event())
			return onReady()
		case "error":
			var payload struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(data, &payload)
			emit(Event{Type: "error", Message: payload.Text})
		default:
			state.collect(kind, data)
		}
	}
}

// startFailure is what to tell a caller whose agent died at startup: the read error, and the agent's own
// last words when it had any. AlayaCore reports a refused config or an unknown model only on stderr, so
// leaving that out turns "your model name is wrong" into "connection closed".
func startFailure(proc *Process, err error) string {
	reason := "the process ended"
	if err != nil {
		reason = err.Error()
	}
	proc.Stderr.settled(time.Second)
	if tail := proc.Stderr.Last(); tail != "" {
		return fmt.Sprintf("%s (stderr: %s)", reason, tail)
	}
	return reason
}
