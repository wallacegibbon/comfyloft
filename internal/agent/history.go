package agent

import (
	"encoding/json"
	"strings"
)

// transcript is the conversation as the agent sent it: the frames themselves, in the order they arrived.
//
// It exists for the one thing a socket cannot answer. A page that comes back — a reload, the panel closed
// and reopened, a second tab — has to be given the conversation, and a live agent has nothing to give: a
// process replays its session file only when it starts, and says the rest of it once. Without this, the
// agent would have to be killed to make it repeat itself (which is what it used to be), and the page would
// take a running turn down with it.
//
// The frames are kept, not the events they translate to. `UX` and `UF` carry pictures and films as data
// URLs, and a block this side does not understand is still content the conversation holds: keeping the wire
// form means nothing is dropped on the way in, and nothing has to be re-invented on the way out — the same
// `replayed()` that reads a session file at startup reads these.
//
// The one thing kept in a different shape is the streaming plane. `Ax` arrives a token at a time because
// the model is slow, which is a fact about generating, not about what was said. The tokens are folded into
// the `AX` frame that message would have carried, so the record reads as one message and not as the four
// hundred frames it took to say it: a replay is instantaneous, and a replay that reproduced the cadence
// would be inventing a delay that never happened.
//
// Not here: `Af`/`Uf` (argument and result previews, display-only and never authoritative), the `SM`
// frames (the agent's bookkeeping, and `notify` is deliberately not part of a conversation), and the
// server's own `tool` events — those are not frames at all, and replaying one would run a tool twice.
type transcript struct {
	frames []Frame
	open   *openPart
}

// openPart is the run of deltas being folded into one message part: the id AlayaCore gave it (text and
// reasoning are two parts with two ids) and the words so far.
type openPart struct {
	id   string
	kind string
	text strings.Builder
}

// record takes one frame off the wire, or one read back from a session file.
func (t *transcript) record(frame *Frame) {
	switch frame.Tag {
	case TagUserX, TagUserF:
		t.close()
		t.frames = append(t.frames, *frame)
	case TagAssistantF:
		t.close()
		t.keepCall(frame)
	case TagAssistantX:
		// Written whole: `--no-delta`, or a session file, where the text is in the frame. A live turn with
		// deltas on ends its messages with the same tag and no text at all — a terminator, and the words
		// are already folded.
		t.close()
		if _, text, ok := contentDelta(frame.Value); !ok || strings.TrimSpace(text) == "" {
			return
		}
		t.frames = append(t.frames, *frame)
	case TagAssistantXDelta:
		t.fold(frame)
	}
}

// keep takes the frames read before the agent was ready — the conversation it replayed from its file.
func (t *transcript) keep(frames []Frame) {
	for index := range frames {
		t.record(&frames[index])
	}
}

// keepCall adds one of the two frames a tool call arrives in, joined to the other when it is the same call.
//
// A call is said in two frames — the name, then the arguments — because the canvas draws the step before it
// knows what it is being asked, and the live relay keeps both for that reason. A conversation is not a
// packet capture, though: it holds the call, so the halves are joined here the way the tokens of a sentence
// are. `UF` is the other half of the call and arrives whole, as one frame.
func (t *transcript) keepCall(frame *Frame) {
	if n := len(t.frames); n > 0 && t.frames[n-1].Tag == TagAssistantF {
		if merged, ok := joinCall(&t.frames[n-1], frame); ok {
			t.frames[n-1] = merged
			return
		}
	}
	t.frames = append(t.frames, *frame)
}

// joinCall is two frames of one call, when they are one: same `call_id`, both objects.
func joinCall(previous, next *Frame) (Frame, bool) {
	var first, second map[string]json.RawMessage
	if json.Unmarshal([]byte(previous.Value), &first) != nil || json.Unmarshal([]byte(next.Value), &second) != nil {
		return Frame{}, false
	}
	var left, right struct {
		CallID string `json:"call_id"`
	}
	if json.Unmarshal([]byte(previous.Value), &left) != nil || json.Unmarshal([]byte(next.Value), &right) != nil {
		return Frame{}, false
	}
	if left.CallID == "" || left.CallID != right.CallID {
		return Frame{}, false
	}
	for key, value := range second {
		// The second frame carries the arguments and no name; a key it left empty is not a correction of
		// what the first one said.
		if prior, ok := first[key]; ok && !blankJSON(prior) && blankJSON(value) {
			continue
		}
		first[key] = value
	}
	body, err := json.Marshal(first)
	if err != nil {
		return Frame{}, false
	}
	return Frame{Tag: TagAssistantF, Value: string(body)}, true
}

// blankJSON reports whether a field says nothing: absent, null, or the empty string.
func blankJSON(raw json.RawMessage) bool {
	switch text := strings.TrimSpace(string(raw)); text {
	case "", "null", `""`:
		return true
	default:
		return false
	}
}

// fold appends one token to the part being written, opening a new one when the id or the kind changes.
func (t *transcript) fold(frame *Frame) {
	var item struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(frame.Value), &item) != nil || item.Text == "" {
		return
	}
	if t.open != nil && t.open.id == item.ID && t.open.kind == item.Type {
		t.open.text.WriteString(item.Text)
		return
	}
	t.close()
	t.open = &openPart{id: item.ID, kind: item.Type}
	t.open.text.WriteString(item.Text)
}

// close turns the part being written into the `AX` frame it would have been, if there is one.
//
// It runs whenever something else arrives and again when the conversation is read, so a part the agent was
// still writing when it went quiet — a turn killed mid-answer — is kept as the words that were said rather
// than as nothing.
func (t *transcript) close() {
	if t.open == nil {
		return
	}
	part := struct {
		ID   string `json:"id,omitempty"`
		Type string `json:"type"`
		Text string `json:"text"`
	}{ID: t.open.id, Type: t.open.kind, Text: t.open.text.String()}
	t.open = nil
	body, err := json.Marshal(part)
	if err != nil {
		return
	}
	t.frames = append(t.frames, Frame{Tag: TagAssistantX, Value: string(body)})
}

// events is the conversation as the events a live turn sends: what a page draws, in the order it happened.
//
// The translation is `replayed()`, unchanged and shared with the startup replay, because these are the same
// frames. One implementation is what keeps a conversation that a reload draws from drifting away from the
// one that was watched happen.
func (t *transcript) events() []Event {
	t.close()
	events := make([]Event, 0, len(t.frames))
	for index := range t.frames {
		if event, ok := replayed(&t.frames[index]); ok {
			events = append(events, event)
		}
	}
	return events
}
