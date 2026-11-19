package workflow

// Which node decides the shape of what a graph draws is derived here, and a derivation needs both halves
// pinned: the reading itself, and the answers it produces for the graphs that actually ship.
//
// The first half is a small set of graphs written to say one thing each — a latent a request sizes, a
// square a knob sizes, a picture a run is handed — so a change to the walk cannot quietly reclassify one
// of them. The second half is the shipped registry: every image and video graph must answer, and answer the
// way its graph is wired today. That second test is the one that earns its keep. A graph re-exported from
// ComfyUI, a node class this table does not know, a latent rewired behind a mode — any of those changes
// what a card should be drawn at, and this fails the day it happens instead of showing bands inside a
// frame a week later.

import (
	"io"
	"testing"

	"comfyloft/internal/logx"
)

func TestOutputShapeReadsWhoSizesAGraph(t *testing.T) {
	sizedByRequest := Graph{
		"1": map[string]any{"class_type": "EmptyLatentImage", "inputs": map[string]any{"width": 832, "height": 1216}},
		"2": map[string]any{"class_type": "KSampler", "inputs": map[string]any{"latent_image": []any{"1", 0}}},
		"3": map[string]any{"class_type": "VAEDecode", "inputs": map[string]any{"samples": []any{"2", 0}}},
		"4": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"3", 0}}},
	}
	entry := &Entry{
		Workflow: sizedByRequest,
		RawBindings: orderedOf(map[string]any{
			"width":  map[string]any{"node": "1", "input": "width", "from": "size.width"},
			"height": map[string]any{"node": "1", "input": "height", "from": "size.height"},
		}),
	}
	if got := entry.OutputShape(); got == nil || got.SizedBy != sizedByAsk || got.Pixels != "832x1216" {
		t.Fatalf("a graph whose latent a request writes answered %+v, want ask at 832x1216", got)
	}

	sizedByKnob := Graph{
		"1": map[string]any{"class_type": "TextEncodeQwenImage21", "inputs": map[string]any{"resolution": 1024}},
		"2": map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"latent_image": []any{"1", 2}}},
		"3": map[string]any{"class_type": "VAEDecode", "inputs": map[string]any{"samples": []any{"2", 0}}},
		"4": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"3", 0}}},
	}
	knob := &Entry{
		Workflow: sizedByKnob,
		RawBindings: orderedOf(map[string]any{
			"resolution": map[string]any{"node": "1", "input": "resolution", "from": "params.squareness", "default": 768},
		}),
	}
	got := knob.OutputShape()
	if got == nil || got.SizedBy != sizedBySquare || got.Key != "squareness" || got.Pixels != "768x768" {
		t.Fatalf("a graph sizing its own latent from one knob answered %+v, want squareOf squareness at 768x768", got)
	}

	fromSource := Graph{
		"1": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "in.png"}},
		"2": map[string]any{"class_type": "ImageUpscaleWithModel", "inputs": map[string]any{"image": []any{"1", 0}}},
		"3": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"2", 0}}},
	}
	handed := &Entry{Workflow: fromSource}
	if got := handed.OutputShape(); got == nil || got.SizedBy != sizedBySource {
		t.Fatalf("a graph that redraws the picture it was handed answered %+v, want source", got)
	}

	// A graph handed a canvas of its own: the request writes both sides of a node by name instead of
	// through `size`, which is how an outpaint is asked. The ask still owns the shape, so the answer is
	// `ask` — and nothing else, because the numbers left in that node are an author's, not any run's.
	canvasByParameters := Graph{
		"1": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "in.png"}},
		"2": map[string]any{"class_type": "ImagePadForOutpaint", "inputs": map[string]any{"image": []any{"1", 0}}},
		"3": map[string]any{"class_type": "ImageScale", "inputs": map[string]any{"image": []any{"2", 0}, "width": 1024, "height": 1024}},
		"4": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"3", 0}}},
	}
	canvas := &Entry{
		Workflow: canvasByParameters,
		RawBindings: orderedOf(map[string]any{
			"canvasWidth":  map[string]any{"node": "3", "input": "width", "from": "params.canvasWidth"},
			"canvasHeight": map[string]any{"node": "3", "input": "height", "from": "params.canvasHeight"},
		}),
	}
	if got := canvas.OutputShape(); got == nil || got.SizedBy != sizedByAsk || got.Pixels != "" {
		t.Fatalf("a graph sized by a canvas the request states answered %+v, want ask and no claimed pixels", got)
	}

	// One side from the request and one baked into the graph is not a canvas the ask owns: the walk keeps
	// going, and the picture this graph was handed answers for it.
	oneSided := &Entry{
		Workflow: canvasByParameters,
		RawBindings: orderedOf(map[string]any{
			"canvasWidth": map[string]any{"node": "3", "input": "width", "from": "params.canvasWidth"},
		}),
	}
	if got := oneSided.OutputShape(); got == nil || got.SizedBy != sizedBySource {
		t.Fatalf("a graph with one side stated answered %+v, want the picture it was handed", got)
	}

	// A graph the walk cannot read claims nothing, rather than answering with a plausible shape.
	unreadable := Graph{
		"1": map[string]any{"class_type": "MysterySampler", "inputs": map[string]any{"thing": 1}},
		"2": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"1", 0}}},
	}
	blank := &Entry{Workflow: unreadable}
	if got := blank.OutputShape(); got != nil {
		t.Fatalf("an unreadable graph answered %+v, want no claim at all", got)
	}
}

// shippedShapeAnswers is what each shipped graph is wired to today. Stating them here, and deriving them
// from the graphs, is what keeps the two from drifting apart.
var shippedShapeAnswers = map[string]string{
	// A latent the request writes: the numbers are what the graph falls back to when told nothing.
	"image-z-image-turbo":       "ask 832x1216",
	"image-moss-sft-8step":      "ask 1024x1024",
	"image-moss-sft-int8-8step": "ask 1024x1024",
	"image-moss-balanced-8step": "ask 1024x1024",
	"video-h3-ref2va":           "ask 1344x768",
	"video-h3-t2v":              "ask 1344x768",
	"video-h3-frames":           "ask 1344x768",
	"video-h3-character-swap":   "ask 1344x768",
	// The family's own file is the edit graph, and a run resolves a mode before it runs, so the family
	// answer is what its wiring gives when nothing is asked. Its modes answer for themselves: t2i takes a
	// canvas from the request, edit takes one through `editCanvasSize`, inpaint keeps the shape of the
	// picture it was handed, and outpaint is asked for a canvas of its own — stated through its own
	// parameters, so it is the ask, with no shape claimed for the run that states none.
	"image-qwen21":             "squareOf resolution 1024x1024",
	"image-qwen21 as edit":     "ask 1024x1024",
	"image-qwen21 as t2i":      "ask 1024x1024",
	"image-qwen21 as inpaint":  "source",
	"image-qwen21 as outpaint": "ask",
	// A re-render from a new angle draws its own square at the encoder's resolution: the picture it is
	// given decides what is drawn, not how big it is.
	"image-qwen21-angle": "squareOf resolution 1024x1024",
	// Steps: the picture handed in decides.
	"image-esrgan-upscale": "source",
	"video-rife":           "source",
}

func TestShippedGraphsSayWhatSizesThem(t *testing.T) {
	registry := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir, Logger: logx.NewWithWriter("test", io.Discard)})
	if err := registry.Load(); err != nil {
		t.Fatalf("load shipped registry: %v", err)
	}
	for _, entry := range registry.Entries() {
		if entry.Type != "image" && entry.Type != "video" {
			continue
		}
		for _, contract := range contractsUnderTest(registry, entry) {
			want, declared := shippedShapeAnswers[contract.label]
			if !declared {
				t.Errorf("%s ships but states no expected shape; say what its graph is wired to", contract.label)
				continue
			}
			got := contract.entry.OutputShape()
			if got == nil {
				t.Errorf("%s answered nothing; it is expected to answer %q", contract.label, want)
				continue
			}
			answer := got.SizedBy
			if got.Key != "" {
				answer += " " + got.Key
			}
			if got.Pixels != "" {
				answer += " " + got.Pixels
			}
			if answer != want {
				t.Errorf("%s answered %q, want %q", contract.label, answer, want)
			}
		}
	}
}

// TestSquareAnswersAreReadableByAClient is the other half of the square answer: a client has to be able to
// act on it. Either the knob is one the workflow publishes, so a card can follow it as the user changes it,
// or the pixels are stated, which is what a card falls back to. The angle workflow is the case that needs
// the second half: it binds the encoder's resolution without offering it as a knob, so the answer is the
// number, not the knob.
func TestSquareAnswersAreReadableByAClient(t *testing.T) {
	registry := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir, Logger: logx.NewWithWriter("test", io.Discard)})
	if err := registry.Load(); err != nil {
		t.Fatalf("load shipped registry: %v", err)
	}
	for _, entry := range registry.Entries() {
		for _, contract := range contractsUnderTest(registry, entry) {
			shape := contract.entry.OutputShape()
			if shape == nil || shape.SizedBy != sizedBySquare {
				continue
			}
			if shape.Pixels != "" {
				continue
			}
			published := false
			for _, raw := range contract.entry.Parameters {
				parameter, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				if key, _ := parameter["key"].(string); key == shape.Key {
					published = true
					break
				}
			}
			if !published {
				t.Errorf("%s says its shape comes from %q, which is neither a published knob nor a stated size", contract.label, shape.Key)
			}
		}
	}
}

// orderedOf builds the ordered-map shape a registry entry holds, from a plain map, for tests only. Key
// order is not what these tests are about.
func orderedOf(values map[string]any) OrderedMap[OrderedMap[any]] {
	out := OrderedMap[OrderedMap[any]]{Values: map[string]OrderedMap[any]{}}
	for key, value := range values {
		object, _ := value.(map[string]any)
		out.Keys = append(out.Keys, key)
		out.Values[key] = orderedOfInner(object)
	}
	return out
}

func orderedOfInner(values map[string]any) OrderedMap[any] {
	out := OrderedMap[any]{Values: map[string]any{}}
	for key, value := range values {
		out.Keys = append(out.Keys, key)
		out.Values[key] = value
	}
	return out
}
