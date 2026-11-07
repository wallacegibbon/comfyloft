package agent

import (
	"strings"
	"testing"
	"time"
)

// kinds is a conversation as a page sees it: one word per event, in order.
func kinds(events []Event) string {
	words := make([]string, 0, len(events))
	for _, event := range events {
		words = append(words, event.Type)
	}
	return strings.Join(words, ",")
}

// TestTranscriptFoldsTheStreamingPlaneIntoTheMessage: the frames a turn arrives in are not the shapes it is
// drawn in. A sentence is a stream of tokens, a call is two frames, and a preview of either is not part of
// the conversation at all — what is kept is the message, the call and the answer.
func TestTranscriptFoldsTheStreamingPlaneIntoTheMessage(t *testing.T) {
	var talk transcript
	talk.record(&Frame{Tag: TagUserX, Value: `{"id":"1","type":"text","text":"remember the violet"}`})
	// A call is the name and then the arguments, with previews of the arguments in between.
	talk.record(&Frame{Tag: TagAssistantF, Value: `{"call_id":"call-1","name":"read_file","id":"3"}`})
	talk.record(&Frame{Tag: TagAssistantFDelta, Value: `{"call_id":"call-1","delta":"{\"path\":"}`})
	talk.record(&Frame{Tag: TagAssistantF, Value: `{"call_id":"call-1","input":{"path":"/skills/SKILL.md"},"id":"3"}`})
	talk.record(&Frame{Tag: TagUserF, Value: `{"call_id":"call-1","output":[{"type":"text","text":"a file"}],"id":"4"}`})
	talk.record(&Frame{Tag: TagUserFDelta, Value: `{"call_id":"call-1","text":"a fi"}`})
	// Reasoning and text are two parts with two ids, each said a token at a time and closed by a frame with
	// no text in it.
	talk.record(&Frame{Tag: TagAssistantXDelta, Value: `{"id":"2","type":"reasoning","text":"think"}`})
	talk.record(&Frame{Tag: TagAssistantXDelta, Value: `{"id":"2","type":"reasoning","text":"ing"}`})
	talk.record(&Frame{Tag: TagAssistantX, Value: `{"id":"2","type":"reasoning"}`})
	talk.record(&Frame{Tag: TagAssistantXDelta, Value: `{"id":"5","type":"text","text":"hel"}`})
	talk.record(&Frame{Tag: TagAssistantXDelta, Value: `{"id":"5","type":"text","text":"lo"}`})
	talk.record(&Frame{Tag: TagAssistantX, Value: `{"id":"5","type":"text"}`})

	events := talk.events()
	if got, want := kinds(events), "user,tool_call,tool_result,reasoning,delta"; got != want {
		t.Fatalf("conversation = %s, want %s (%+v)", got, want, events)
	}
	// One call, not one per frame it arrived in, and with both halves of it.
	if events[1].Name != "read_file" || !strings.Contains(events[1].Input, "SKILL.md") {
		t.Fatalf("call = %+v, want the name and the arguments together", events[1])
	}
	if events[3].Text != "thinking" {
		t.Fatalf("reasoning = %q, want the tokens joined", events[3].Text)
	}
	if events[4].Text != "hello" {
		t.Fatalf("answer = %q, want the tokens joined", events[4].Text)
	}
	// Reading does not change it: a page may ask twice, and the record is the same record.
	if again := talk.events(); len(again) != len(events) {
		t.Fatalf("second read = %d events, want %d", len(again), len(events))
	}
}

// TestTranscriptKeepsWhatWasSaidWhenTheTurnIsCut: a turn that never finished still said the words before it
// stopped, and those are exactly what a page that comes back should find.
func TestTranscriptKeepsWhatWasSaidWhenTheTurnIsCut(t *testing.T) {
	var talk transcript
	talk.record(&Frame{Tag: TagAssistantXDelta, Value: `{"id":"7","type":"text","text":"画布已整理完毕"}`})
	talk.record(&Frame{Tag: TagAssistantXDelta, Value: `{"id":"7","type":"text","text":"，现在聚焦到最终视频："}`})
	// No `AX` to close it: the step never came back.

	events := talk.events()
	if got, want := kinds(events), "delta"; got != want {
		t.Fatalf("conversation = %s, want %s", got, want)
	}
	if got, want := events[0].Text, "画布已整理完毕，现在聚焦到最终视频："; got != want {
		t.Fatalf("answer = %q, want %q", got, want)
	}
}

// TestTranscriptKeepsAToolResultWhole: the frame is the record, so a picture or a film a tool answered with is
// still there — this side translates only the text of it today, and that is a decision about drawing, not
// about what the conversation holds.
func TestTranscriptKeepsAToolResultWhole(t *testing.T) {
	video := `{"call_id":"call-9","output":[{"type":"video","uri":"data:video/mp4;base64,AAAAIGZ0eXBpc29t"}],"id":"8"}`
	var talk transcript
	talk.record(&Frame{Tag: TagUserF, Value: video})

	if len(talk.frames) != 1 {
		t.Fatalf("kept %d frames, want the result as it arrived", len(talk.frames))
	}
	if talk.frames[0].Value != video {
		t.Fatalf("kept %q, want it byte for byte", talk.frames[0].Value)
	}
}

// TestSessionKeepsTheConversationWithNobodyWatching: a turn that runs with no page attached is not a turn
// whose words are lost. They go into the session's transcript, which is what the next connection is shown.
func TestSessionKeepsTheConversationWithNobodyWatching(t *testing.T) {
	fs := openFakeSession(t)
	fs.session.Unwatch()

	if err := fs.session.Send(Request{Prompt: "hi"}); err != nil {
		t.Fatalf("send to a session nobody is watching: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var conversation []Event
	for {
		conversation = fs.session.replay()
		if len(conversation) > 0 && conversation[len(conversation)-1].Type == "delta" {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The fake agent answers without echoing the prompt (that echo is `UX`, and this one is not a
	// conversation, it is a stub), so the answer is the whole of what was kept — and it was kept.
	if got, want := kinds(conversation), "delta"; got != want {
		t.Fatalf("conversation with nobody watching = %s, want %s (%+v)", got, want, conversation)
	}
	if got := conversation[len(conversation)-1].Text; got != "hello world" {
		t.Fatalf("answer = %q, want the agent's words", got)
	}
}
