package workflow

// What a workflow's graph cannot read, and the declaration that has to say so.
//
// `PlanMedia` refuses a request that carries media a workflow declares it does not take — but only where the
// workflow declares anything at all. An undeclared kind is deliberately unconstrained (`media.go`), which is
// what keeps a workflow that only cares about images from having to describe video and audio too. The cost of
// that reading is silence: a text-to-image graph declares nothing, a picture wired into it is passed by
// `PlanMedia`, no binding reads it, and the run answers with a fresh draw and no error anywhere. The canvas had
// already promised the opposite in `connect`'s own words — "a picture connected into an image node is what
// makes its next generation an edit of it" — so the promise was made by one tool and broken by another with
// nothing in between saying which.
//
// Two directions, both derived from the bindings rather than from a list of ids, so the day a workflow is
// registered is the day it is covered:
//
//   - a declaration that takes no image must sit on a graph whose bindings read none (`max: 0` over a graph
//     that loads a picture would make a real workflow unreachable, which is worse than the silence);
//   - a graph whose bindings read no picture must say so, because silence is what the bug was.
//
// Only a picture has to be declared. A clip or a sound left undeclared stays the three-state reading it was:
// a kind the graph never mentions. A picture is the one pairing the canvas gives a meaning to.

import (
	"io"
	"testing"

	"comfyloft/internal/logx"
)

// contractUnderTest is one graph a request can reach: the entry itself, and every mode it offers.
//
// A mode is a different graph — Qwen's t2i shares nothing with its inpaint but the family name — so a
// declaration is only true of the graph whose bindings are beside it (`mergeVariant`).
type contractUnderTest struct {
	label string
	entry *Entry
}

func contractsUnderTest(registry *Registry, entry *Entry) []contractUnderTest {
	all := []contractUnderTest{{label: entry.ID, entry: entry}}
	for _, mode := range entry.VariantModes() {
		all = append(all, contractUnderTest{label: entry.ID + " as " + mode, entry: registry.ResolveForMode(entry, mode)})
	}
	return all
}

// mediaKinds are the three kinds a request may carry, named as a refusal names them.
var mediaKinds = []string{"image", "video", "audio"}

// declaredLimit is what one graph declares about one kind, or nil when it declares nothing.
func declaredLimit(accepts *Accepts, kind string) *MediaLimit {
	if accepts == nil {
		return nil
	}
	switch kind {
	case "image":
		return accepts.Images
	case "video":
		return accepts.Videos
	default:
		return accepts.Audios
	}
}

// readsMedia reports whether any of a graph's bindings consumes that kind of media.
//
// It is `applyOneBinding`'s own test read from the registry instead of from a request: a binding is about media
// when it takes its value from the request's uploads (`from: image/video/audio`), when it addresses one by
// index, or when it is the first/last-frame binding, which injects an image loader of its own.
func readsMedia(entry *Entry, kind string) bool {
	for _, key := range entry.RawBindings.Keys {
		binding := NewBinding(entry.RawBindings.Values[key].Values)
		from := binding.String(keyFrom)
		switch kind {
		case "image":
			if from == "image" || binding.Has(keyImageIndex) || binding.Bool(keyFrameMode) {
				return true
			}
		case "video":
			if from == "video" || binding.String(keyLoadType) == "video" {
				return true
			}
		default:
			if from == "audio" || binding.String(keyLoadType) == "audio" {
				return true
			}
		}
	}
	return false
}

// needsMedia reports whether a graph refuses a request that carries nothing at all.
//
// It is the other half of a contract: `max: 0` is what a graph takes, `min` and `minTotal` are what it cannot
// do without. A step like interpolation declares both — one clip and never a picture — so "no media is
// accepted" is not a fact about it.
func needsMedia(entry *Entry) bool {
	if entry.Accepts == nil {
		return entry.MinMedia > 0
	}
	if entry.MinMedia > 0 || entry.Accepts.MinTotal > 0 || entry.FrameMode != nil {
		return true
	}
	for _, limit := range []*MediaLimit{entry.Accepts.Images, entry.Accepts.Videos, entry.Accepts.Audios} {
		if limit != nil && limit.Min > 0 {
			return true
		}
	}
	return false
}

func TestShippedWorkflowsDeclareWhetherTheyReadAPicture(t *testing.T) {
	registry := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir, Logger: logx.NewWithWriter("test", io.Discard)})
	if err := registry.Load(); err != nil {
		t.Fatalf("load shipped registry: %v", err)
	}

	for _, entry := range registry.Entries() {
		for _, one := range contractsUnderTest(registry, entry) {
			for _, kind := range mediaKinds {
				limit := declaredLimit(one.entry.Accepts, kind)
				reads := readsMedia(one.entry, kind)
				if limit != nil && limit.Max == 0 && reads {
					t.Errorf("%s declares no %s, but a binding reads one: the declaration would make a run of it impossible", one.label, kind)
				}
				if kind != "image" || reads {
					continue
				}
				if limit == nil || limit.Max != 0 {
					t.Errorf("%s has no binding that reads a picture and does not declare `\"images\": {\"max\": 0}`: a wired picture would be dropped by the binding and the run would answer with a fresh draw instead of a refusal", one.label)
				}
			}

			// The declaration is the one `PlanMedia` enforces, and the code is the one the canvas and the agent
			// already read: a graph that reads no picture is a graph that must refuse one, not ignore it.
			if readsMedia(one.entry, "image") {
				continue
			}
			if _, err := PlanMedia(one.entry, MediaCounts{Images: 1}, "", nil); err == nil {
				t.Errorf("%s accepted a picture no binding reads", one.label)
			} else if errorCode(t, err) != "unsupported_media" {
				t.Errorf("%s with one image: code = %q, want unsupported_media", one.label, errorCode(t, err))
			}
			// A graph that asks for no media at all still runs from its words alone. One that asks for a clip
			// (interpolation) is answered by its own minimum, which is a different fact and a different code.
			if !needsMedia(one.entry) {
				if _, err := PlanMedia(one.entry, MediaCounts{}, "", nil); err != nil {
					t.Errorf("%s with no media: %v", one.label, err)
				}
			}
		}
	}
}

// A workflow that takes no picture says why, in words the caller can act on.
//
// The refusal already names the workflow and the count; the note is what turns "that did not work" into "this is
// the wrong workflow for that". Nothing else carries it: the panel's copy is i18n keyed by id (#66), so the
// registry's English prose reaches the agent through this field and nowhere else.
func TestShippedWorkflowsThatTakeNoPictureSayWhatToDoInstead(t *testing.T) {
	registry := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir, Logger: logx.NewWithWriter("test", io.Discard)})
	if err := registry.Load(); err != nil {
		t.Fatalf("load shipped registry: %v", err)
	}

	for _, entry := range registry.Entries() {
		for _, one := range contractsUnderTest(registry, entry) {
			if readsMedia(one.entry, "image") || one.entry.Accepts == nil {
				continue
			}
			if one.entry.Accepts.Note == "" {
				t.Errorf("%s refuses every picture and says nothing about what to do instead", one.label)
			}
		}
	}
}
