package workflow

// This file converts internal entries into the exact JSON shapes the canvas
// consumes. Every struct here is a wire contract: renaming a field or dropping an
// omitempty silently breaks a screen, so they are declared explicitly rather than
// reusing the internal types.

// PublicEntry is the projection returned by /api/workflows and workflow import.
type PublicEntry struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Type          string            `json:"type"`
	Label         string            `json:"label"`
	Description   string            `json:"description"`
	Category      *string           `json:"category"`
	File          string            `json:"file"`
	Bindings      map[string]any    `json:"bindings"`
	Defaults      map[string]any    `json:"defaults"`
	Presets       map[string]any    `json:"presets"`
	Parameters    []any             `json:"parameters"`
	BaseModels    *BaseModelConfig  `json:"baseModels"`
	Lora          *Lora             `json:"lora"`
	VariantModes  []string          `json:"variantModes"`
	VariantLabels map[string]string `json:"variantLabels"`
	ImportedAt    string            `json:"importedAt,omitempty"`
	Source        *Source           `json:"source,omitempty"`

	// The request contract, so a client shows what a workflow needs instead of knowing it by name:
	// which media mix it accepts, the mode it runs in (text / frames / reference), and how a
	// first/last-frame graph counts its images. These are the same three fields `PlanMedia` reads
	// (#63), so the panel and the 400 cannot disagree about them.
	Accepts   *Accepts       `json:"accepts,omitempty"`
	Mode      string         `json:"mode,omitempty"`
	FrameMode *FrameModeRule `json:"frameMode,omitempty"`
	// The keys a run may carry, so a client can drop a value it no longer has a model for instead of
	// sending it and being refused. It is `AcceptedInputs`, the same set the validator enforces (#274).
	Inputs []string `json:"inputs"`
	// What decides the shape of what this graph draws, derived from the graph itself. A card is drawn at
	// a shape before a run answers, so this is the difference between a card that frames its picture and
	// one that bands it (#359). Absent means the graph was read and nothing can be claimed.
	Output *OutputShape `json:"output,omitempty"`
	// Per-mode contracts, present only for a workflow with variants. A mode is a different graph
	// with different wiring, so its media mix can differ (Qwen's inpaint wants a source and a mask;
	// t2i wants none) — the mode the reader picks must be the one whose contract they see.
	VariantContracts map[string]VariantContract `json:"variantContracts,omitempty"`
}

// VariantContract is one mode's request contract: what the entry declares, overridden by what the
// variant declares, exactly as `mergeVariant` merges them for a run.
type VariantContract struct {
	Accepts   *Accepts       `json:"accepts,omitempty"`
	Mode      string         `json:"mode,omitempty"`
	FrameMode *FrameModeRule `json:"frameMode,omitempty"`
	// A variant is a different graph, so it takes different keys: Qwen's outpaint binds the padding
	// numbers its siblings do not.
	Inputs []string `json:"inputs,omitempty"`
	// And a different graph decides its shape differently: Qwen's t2i sizes itself by the encoder's
	// resolution while its inpaint keeps the source's shape.
	Output *OutputShape `json:"output,omitempty"`
}

// contractOf is what one graph accepts, read off the entry a run of it uses. Both readers ask this, so the
// panel and a 400 cannot describe different graphs.
func contractOf(entry *Entry) VariantContract {
	return VariantContract{
		Accepts:   entry.Accepts,
		Mode:      entry.Mode,
		FrameMode: entry.FrameMode,
		Inputs:    entry.AcceptedInputs(),
		Output:    entry.OutputShape(),
	}
}

// Schema describes how a workflow maps request fields onto graph inputs.
type Schema struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Type           string            `json:"type"`
	Label          string            `json:"label"`
	BaseModel      *string           `json:"baseModel"`
	BaseModelLabel *string           `json:"baseModelLabel"`
	BaseModels     *BaseModelConfig  `json:"baseModels"`
	VariantModes   []string          `json:"variantModes"`
	VariantLabels  map[string]string `json:"variantLabels"`
	Fields         []map[string]any  `json:"fields"`
	Parameters     []any             `json:"parameters"`
	// Inputs is the typed request contract a run is validated against: the semantic keys
	// (prompt, size, count, …) plus every declared parameter and non-media binding.
	Inputs []InputSpec `json:"inputs"`
	Lora   *Lora       `json:"lora"`
}

// PublicProjection renders one entry for the workflows list.
func PublicProjection(entry *Entry) PublicEntry {
	out := PublicEntry{
		ID:            entry.ID,
		Name:          entry.Name,
		Type:          entry.Type,
		Label:         defaultString(entry.Label, entry.Name),
		Description:   entry.Description,
		File:          entry.File,
		Bindings:      rawBindingsToMap(entry.RawBindings),
		Defaults:      nonNilMap(entry.Defaults),
		Presets:       nonNilMap(entry.Presets),
		Parameters:    nonNilSlice(entry.Parameters),
		BaseModels:    entry.BaseModels,
		Lora:          entry.Lora,
		VariantModes:  entry.VariantModes(),
		VariantLabels: entry.VariantLabelsMap(),
		ImportedAt:    entry.ImportedAt,
		Source:        entry.Source,
		Accepts:       entry.Accepts,
		Mode:          entry.Mode,
		FrameMode:     entry.FrameMode,
		Inputs:        entry.AcceptedInputs(),
		Output:        entry.OutputShape(),
	}
	if entry.Variants.Len() > 0 {
		out.VariantContracts = make(map[string]VariantContract, entry.Variants.Len())
		for _, mode := range entry.Variants.Keys {
			out.VariantContracts[mode] = contractOf(mergeVariant(entry, mode, entry.Variants.Values[mode]))
		}
	}
	if entry.Category != "" {
		category := entry.Category
		out.Category = &category
	}
	return out
}

// BuildSchema renders the schema projection of an entry.
func BuildSchema(entry *Entry) Schema {
	fields := make([]map[string]any, 0, len(entry.RawBindings.Keys))
	for _, key := range entry.RawBindings.Keys {
		binding := NewBinding(entry.RawBindings.Values[key].Values)
		field := map[string]any{"key": key}
		if value := binding.String(keyNode); value != "" {
			field["node"] = value
		}
		if value := binding.String(keyInput); value != "" {
			field["input"] = value
		}
		if value := binding.Value(keyFrom); value != nil {
			field["from"] = value
		}
		if binding.Has(keyDefault) {
			field["default"] = binding.Value(keyDefault)
		}
		field["required"] = binding.Bool(keyRequired) || key == "prompt"
		field["random"] = binding.Bool(keyRandom)
		if value := binding.Value(keyTransform); value != nil {
			field["transform"] = value
		}
		if value := binding.Value(keyImageIndex); value != nil {
			field["imageIndex"] = value
		}
		fields = append(fields, field)
	}

	out := Schema{
		ID:            entry.ID,
		Name:          entry.Name,
		Type:          entry.Type,
		Label:         defaultString(entry.Label, entry.Name),
		BaseModels:    entry.BaseModels,
		VariantModes:  entry.VariantModes(),
		VariantLabels: entry.VariantLabelsMap(),
		Fields:        fields,
		Parameters:    nonNilSlice(entry.Parameters),
		Inputs:        entry.InputSpecs(InputLimits{}),
		Lora:          entry.Lora,
	}
	if entry.BaseModel != "" {
		value := entry.BaseModel
		out.BaseModel = &value
	}
	if entry.BaseModelLabel != "" {
		value := entry.BaseModelLabel
		out.BaseModelLabel = &value
	}
	return out
}

// rawBindingsToMap flattens ordered bindings into a plain object.
func rawBindingsToMap(source OrderedMap[OrderedMap[any]]) map[string]any {
	out := make(map[string]any, len(source.Keys))
	for _, key := range source.Keys {
		out[key] = map[string]any(source.Values[key].Values)
	}
	return out
}
