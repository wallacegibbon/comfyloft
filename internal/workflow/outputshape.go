package workflow

import (
	"fmt"
	"strconv"
	"strings"
)

// What decides the shape of what a graph draws — the one question every reader of a picture card
// answers, from the box a card is drawn at to the size a request states.
//
// Why this is derived rather than declared: the answer lives in the graph that runs. registry.json already
// names the node a request's size is written into, and the graph already carries the latent it draws when
// the request says nothing. Restating either in the registry would put a second copy of the fact where it
// can go stale, which is the failure #302 and #306 kept deleting — and a stale copy here is not cosmetic:
// a card drawn at a shape the graph cannot produce shows the mismatch as bands inside the frame, and the
// next run is then asked for a shape nothing on screen matches.
//
// Three owners, and only three appear in the shipped graphs:
//
//   - "ask" — the request states it: a `size.width`/`size.height` binding, the canvas an
//     `outputSize` rewrites, or a pair of the request's own parameters writing a node's width and height.
//     `pixels` is then what the graph draws when the request states nothing — with one exception, noted
//     where the canvas pair is answered.
//   - "squareOf" — one numeric knob sizes the latent on its own (the `resolution` of a text-encoder node
//     whose output *is* the latent), so the picture is square, of that number.
//   - "source" — the picture handed to it decides: an upscaler, an interpolation, an inpaint.
//
// A graph this cannot read reports nothing, which is the three-state reading every other contract field
// uses: a client is told what is known and guesses nothing about the rest. `outputshape_test.go` walks the
// shipped registry and pins each entry's answer, so re-importing a graph that sizes itself some new way
// fails a test instead of quietly letterboxing a card.

// OutputShape is the published answer. `SizedBy` names the owner; `Key` is the request parameter a square
// graph sizes itself by; `Pixels` is the shape ("832x1216") the graph draws when the request states none.
type OutputShape struct {
	SizedBy string `json:"sizedBy"`
	Key     string `json:"key,omitempty"`
	Pixels  string `json:"pixels,omitempty"`
}

// The three owners, as published.
const (
	sizedByAsk    = "ask"
	sizedBySquare = "squareOf"
	sizedBySource = "source"
)

// shapeWalk names, for a node class, the input whose content carries a picture's shape through it. The
// walk goes backwards: from the node that writes the file out, up to whatever gave it a shape.
//
// Only classes the shipped graphs use are listed. `ModelLoaderSpecs` is the same pattern for model files,
// and for the same reason: the graph layer keeps ComfyUI's node classes as data, and an unlisted class is
// an honest unknown rather than a guess.
var shapeWalk = map[string][]string{
	// The artifact writers, where a backwards walk starts.
	"SaveImage":        {"images"},
	"SaveAnimatedWEBP": {"images"},
	"VHS_VideoCombine": {"images"},
	// Everything between the writer and the shape: nodes that carry an image or a latent through.
	"VAEDecode":               {"samples"},
	"VAEEncode":               {"pixels"},
	"KSampler":                {"latent_image"},
	"SamplerCustomAdvanced":   {"latent_image"},
	"SelfLiftH3Sampler":       {"latent_image"},
	"MiniMaxH3AVDecodeT8":     {"av_latent"},
	"SetLatentNoiseMask":      {"samples"},
	"ImageScale":              {"image"},
	"ImageScaleBy":            {"image"},
	"ImageScaleToTotalPixels": {"image"},
	"ImageUpscaleWithModel":   {"image"},
	"ImagePadForOutpaint":     {"image"},
	"DrawMaskOnImage":         {"image"},
	"InpaintStitchImproved":   {"stitcher"},
	"InpaintCropImproved":     {"image"},
	"RIFE VFI":                {"frames"},
	// A reference-conditioned Qwen encoder carries the shape of the picture it was told to keep.
	"TextEncodeQwenImage21": {"images.image_1"},
}

// shapeWriters are the classes that start a walk: whatever writes the file out is what a run returns, and
// its shape is the one a card has to frame. Starting here rather than at every node is what keeps a
// reference image wired into a conditioning input from being mistaken for the output's shape.
var shapeWriters = map[string]bool{"SaveImage": true, "SaveAnimatedWEBP": true, "VHS_VideoCombine": true, "SaveAnimatedPNG": true}

// shapeStop names a class a walk ends at, and what reaching it says about the shape.
//
// `Sides` are the inputs holding the width and the height — a latent the graph bakes for itself.
// `SquareOf` is a single input that sets both sides. `FromSource` means the shape is whatever media was
// loaded here.
type shapeStop struct {
	Sides      []string
	SquareOf   string
	FromSource bool
	// FromAsk names a node whose two sides the request writes by name: a graph handed a canvas of its own
	// instead of a size — the `outpaintWidth`/`outpaintHeight` of an outpaint — is still sized by the ask,
	// only through its own keys rather than the `size` field.
	FromAsk bool
}

var shapeStops = map[string]shapeStop{
	"EmptyLatentImage":             {Sides: []string{"width", "height"}},
	"EmptyFlux2LatentImage":        {Sides: []string{"width", "height"}},
	"EmptyImage":                   {Sides: []string{"width", "height"}},
	"MiniMaxH3AudioConditioningT8": {Sides: []string{"width", "height"}},
	"TextEncodeQwenImage21":        {SquareOf: "resolution"},
	"LoadImage":                    {FromSource: true},
	"VHS_LoadVideo":                {FromSource: true},
}

// walkShapeLimit bounds the backwards walk. The shipped graphs reach their shape source in four hops; the
// limit is what stops a cycle in a hand-edited graph from spinning.
const walkShapeLimit = 24

// OutputShape answers the shape question for the entry as it would be run — the whole workflow, or one
// resolved mode, which is the same entry object `ResolveForMode` hands a run.
func (e *Entry) OutputShape() *OutputShape {
	if e == nil {
		return nil
	}
	source := walkGraphShape(e)

	// What the graph draws when the request states no shape, read from the wiring it actually has. This
	// is deliberately not taken from the node a size binding points at: an `outputSize` rewires that node
	// only while a canvas size is being asked for, so its baked numbers describe a path the graph is not
	// on when the request says nothing.
	var fallback string
	if source.ok {
		switch {
		case len(source.stop.Sides) == 2:
			fallback = nodePixels(source.node, source.stop.Sides)
		case source.stop.SquareOf != "":
			if side := e.squareSide(source.id, source.node, source.stop.SquareOf); side > 0 {
				fallback = fmt.Sprintf("%dx%d", side, side)
			}
		}
	}

	if e.sizingNodeID() != "" {
		return &OutputShape{SizedBy: sizedByAsk, Pixels: fallback}
	}
	if source.ok && source.stop.FromAsk {
		// Deliberately no `pixels` here. A size-binding target's baked numbers are the picture that graph
		// draws at rest, so publishing them lets a card framed for an unstated ask match what arrives. A
		// canvas pair's numbers are only whatever an author's tool left in the node: a run only reaches an
		// outpaint graph with a canvas already stated, and a card drawn at the graph's resting square would
		// band the answer the dialog sized itself for.
		return &OutputShape{SizedBy: sizedByAsk}
	}
	if source.ok && source.stop.SquareOf != "" {
		return &OutputShape{
			SizedBy: sizedBySquare,
			Key:     e.parameterForInput(source.id, source.stop.SquareOf),
			Pixels:  fallback,
		}
	}
	if source.ok && source.stop.FromSource {
		return &OutputShape{SizedBy: sizedBySource}
	}
	// A graph that bakes a latent no request can move, or one this walk could not read, claims nothing:
	// a client keeps whatever it was told about the ask and invents no shape.
	return nil
}

// sizingNodeID is the node the request's own numbers are written into: the target of a `size.width` or
// `size.height` binding, or the canvas an `outputSize` rewrites. "" means the request cannot size this
// graph at all.
func (e *Entry) sizingNodeID() string {
	for _, key := range e.RawBindings.Keys {
		binding, ok := e.Binding(key)
		if !ok {
			continue
		}
		if binding.String(keyFrom) == "size.width" || binding.String(keyFrom) == "size.height" {
			if node := binding.String(keyNode); node != "" {
				return node
			}
		}
	}
	if e.OutputSize != nil && e.OutputSize.Node != "" {
		return e.OutputSize.Node
	}
	return ""
}

// statedCanvas reports whether the request writes both sides of one node by name. This is "the ask states the
// shape" spelled without the `size` field: an outpaint graph is handed a canvas through its own parameters.
// Both sides must come from the request — a number the ask owns next to one the graph baked is not a canvas the
// ask controls, and claiming it would draw a card that moves when nothing was asked to move it.
func (e *Entry) statedCanvas(nodeID string) bool {
	if nodeID == "" {
		return false
	}
	sides := map[string]bool{}
	for _, key := range e.RawBindings.Keys {
		binding, ok := e.Binding(key)
		if !ok || binding.String(keyNode) != nodeID || !strings.HasPrefix(binding.String(keyFrom), "params.") {
			continue
		}
		if input := binding.String(keyInput); input == "width" || input == "height" {
			sides[input] = true
		}
	}
	return sides["width"] && sides["height"]
}

// squareSide is the number a square graph would draw at: the value its request parameter takes when that
// parameter is left out, else the number the graph itself carries.
func (e *Entry) squareSide(nodeID string, source Node, input string) int {
	if binding := e.bindingWritingInput(nodeID, input); binding != nil && binding.Has(keyDefault) {
		if value, err := intValue(binding.Value(keyDefault)); err == nil && value > 0 {
			return value
		}
	}
	if value, err := intValue(source.Inputs()[input]); err == nil && value > 0 {
		return value
	}
	return 0
}

// parameterForInput names the request key that sets a graph input, so a client can read the number out of
// the knobs it already holds. The graph's own input name is the answer when no binding writes it.
func (e *Entry) parameterForInput(nodeID, input string) string {
	binding := e.bindingWritingInput(nodeID, input)
	if binding == nil {
		return input
	}
	if from := binding.String(keyFrom); strings.HasPrefix(from, "params.") {
		return strings.TrimPrefix(from, "params.")
	}
	return input
}

// bindingWritingInput finds the binding that writes an input of a node, matched by node id so a graph with
// two nodes of one class cannot be answered for the wrong one.
func (e *Entry) bindingWritingInput(nodeID, input string) *Binding {
	if nodeID == "" {
		return nil
	}
	for _, key := range e.RawBindings.Keys {
		binding, ok := e.Binding(key)
		if !ok {
			continue
		}
		if binding.String(keyInput) == input && binding.String(keyNode) == nodeID {
			return binding
		}
	}
	return nil
}

// shapeFound is what the backwards walk learned: the node that decides the shape, its id (a Node does not
// carry one, and the bindings name nodes by id), and what reaching it says.
type shapeFound struct {
	id   string
	node Node
	stop shapeStop
	ok   bool
}

// walkGraphShape walks up from whatever writes the artifact out until it reaches a node that decides the
// shape itself.
func walkGraphShape(entry *Entry) shapeFound {
	graph := entry.Workflow
	if graph == nil {
		return shapeFound{}
	}
	for _, start := range graph.IDs() {
		node, ok := graph.NodeAt(start)
		if !ok || !shapeWriters[node.ClassType()] {
			continue
		}
		id, current := start, node
		for hops := 0; hops < walkShapeLimit; hops++ {
			// A node the request writes both sides of is the nearest thing to the file that states a shape,
			// so it is asked before the class tables: an outpaint's canvas outranks whatever latent the
			// graph was built around.
			if entry.statedCanvas(id) {
				return shapeFound{id: id, node: current, stop: shapeStop{FromAsk: true}, ok: true}
			}
			if stop, isStop := resolveStop(entry, id, current); isStop {
				return shapeFound{id: id, node: current, stop: stop, ok: true}
			}
			next, nextID, found := followShapeInput(graph, current)
			if !found {
				break
			}
			id, current = nextID, next
		}
	}
	return shapeFound{}
}

// resolveStop confirms a table hit against the node standing in front of it.
//
// The Qwen text encoder is the one shipped class whose answer depends on its own inputs: while its
// `resolution` holds a number it draws that square latent itself, and with it left at 0 — which is what
// the outpaint graph sets — it encodes the reference picture it was handed, so the shape came in through
// that picture. Returning false there is what lets the walk keep going instead of claiming a 0×0 square.
func resolveStop(entry *Entry, id string, node Node) (shapeStop, bool) {
	stop, known := shapeStops[node.ClassType()]
	if !known {
		return shapeStop{}, false
	}
	if stop.SquareOf != "" && entry.squareSide(id, node, stop.SquareOf) <= 0 {
		return shapeStop{}, false
	}
	return stop, true
}

// followShapeInput takes one step back along the input this class carries its picture through.
func followShapeInput(graph Graph, node Node) (Node, string, bool) {
	inputs := node.Inputs()
	for _, name := range shapeWalk[node.ClassType()] {
		for _, id := range linkNodeIDs(inputs[name]) {
			if next, ok := graph.NodeAt(id); ok {
				return next, id, true
			}
		}
	}
	return nil, "", false
}

// nodePixels reads the shape a node bakes, from the inputs the stop named.
func nodePixels(node Node, sides []string) string {
	if len(sides) != 2 {
		return ""
	}
	width, errW := intValue(node.Inputs()[sides[0]])
	height, errH := intValue(node.Inputs()[sides[1]])
	if errW != nil || errH != nil || width <= 0 || height <= 0 {
		return ""
	}
	return fmt.Sprintf("%dx%d", width, height)
}

// linkNodeIDs reads a ComfyUI link — ["7", 0] — tolerating the numeric node id a hand-edited graph can
// carry.
func linkNodeIDs(value any) []string {
	switch typed := value.(type) {
	case []any:
		if len(typed) == 0 {
			return nil
		}
		if id := textValue(typed[0]); id != "" {
			return []string{id}
		}
	}
	return nil
}

func textValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	}
	return ""
}

// intValue coerces a graph or binding number the way the binding layer already does: JSON numbers, and
// numeric strings from hand edits.
func intValue(value any) (int, error) {
	switch typed := value.(type) {
	case float64:
		return int(typed), nil
	case int:
		return typed, nil
	case string:
		return strconv.Atoi(textValue(typed))
	}
	return 0, fmt.Errorf("not a number")
}
