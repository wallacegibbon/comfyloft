package agentconf

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// The keys of one `model.conf` block, spelled as AlayaCore's `config` tags spell them. `reference` below is
// the order they are written in, which is also the order AlayaCore's own writer emits: the field order of
// its `modelConfig` struct.
const (
	keyName            = "name"
	keyProtocolType    = "protocol_type"
	keyBaseURL         = "base_url"
	keyAPIKey          = "api_key"
	keyModelName       = "model_name"
	keyContextLimit    = "context_limit"
	keyMaxTokens       = "max_tokens"
	keyReasoning0      = "reasoning_0"
	keyReasoning1      = "reasoning_1"
	keyReasoning2      = "reasoning_2"
	keyReasoningField  = "reasoning_field"
	keySerialToolCalls = "serial_tool_calls"
	keyInputModalities = "input_modalities"
)

// reasoningKeys are the three blocks, by level.
var reasoningKeys = [3]string{keyReasoning0, keyReasoning1, keyReasoning2}

// Model is one block of `model.conf`: every field AlayaCore reads from it.
//
// The zero value is an entry that states nothing, which is not a model — `Validate` says so. `APIKey` is the
// one field no canvas is ever shown; it is read so a rewrite can put it back, and it is why this file is
// written with a mode only its owner can read.
type Model struct {
	Name            string
	ProtocolType    string
	BaseURL         string
	APIKey          string
	ModelName       string
	ContextLimit    int
	MaxTokens       int
	Reasoning0      json.RawMessage
	Reasoning1      json.RawMessage
	Reasoning2      json.RawMessage
	ReasoningField  string
	SerialToolCalls bool
	// InputModalities is nil for a model that declares nothing — the protocol decides what it is sent — and
	// an empty slice for one that declares it takes no media. The two are different settings (`[]` and
	// `["text"]` are one model), which is why this is a slice and not a list with a separate switch.
	InputModalities []string

	// extra is every line of this block that this package does not own: a comment, a key a newer AlayaCore
	// understands, a known key whose value would not parse. Written back verbatim at the end of the block,
	// so a save from the canvas cannot delete a line the canvas has never seen. Struct assignment carries it
	// along, which is what lets an edit start from the stored entry and change only the fields it means to.
	extra []string
}

// ParseModels reads `model.conf`.
//
// It never fails: a file whose lines do not parse is still a list of models with some of their lines kept as
// written, and `problems` says which, because the editor is the one place a broken `model.conf` can be
// repaired from — an agent that will not start on it cannot be asked anything (`internal/app/session.go` in
// AlayaCore). A block with neither `name` nor `model_name` is not a model: AlayaCore skips it on load, so it
// is skipped here rather than shown as an empty row.
func ParseModels(content []byte) (models []Model, problems []string) {
	for _, lines := range blocks(string(content)) {
		fields, others, blockProblems := parseBlock(lines)
		model, readProblems := readModel(fields, &others)
		model.extra = others
		blockProblems = append(blockProblems, readProblems...)
		if model.Name == "" && model.ModelName == "" {
			continue
		}
		models = append(models, model)
		who := fmt.Sprintf("model %d", len(models))
		if model.Name != "" {
			who = fmt.Sprintf("model %d (%q)", len(models), model.Name)
		}
		for _, problem := range blockProblems {
			problems = append(problems, who+": "+problem)
		}
	}
	return models, problems
}

// readModel turns one block's fields into a model, keeping what might still mean something and saying what it
// had to drop.
//
// A line this build cannot read is dropped and reported, not carried: AlayaCore cannot use it either — it
// reports the same value and keeps the field at its zero (`context_limit: 262144k` is a model with no limit,
// measured against the real binary) — and carrying it would state the same key twice the moment the user types
// the value the form was showing as empty. What is *kept* is what another reader might use: a comment, and a key
// this build does not know, which a newer AlayaCore may well read.
func readModel(fields []field, extra *[]string) (Model, []string) {
	var model Model
	var problems []string
	for _, f := range fields {
		// `keep` is for the two things that stay in the file; `drop` is for a value nobody can use.
		keep := func(problem string) {
			*extra = append(*extra, f.raw)
			problems = append(problems, problem)
		}
		drop := func(problem string) {
			problems = append(problems, problem)
		}
		switch f.key {
		case keyName:
			model.Name = f.value
		case keyProtocolType:
			model.ProtocolType = f.value
		case keyBaseURL:
			model.BaseURL = f.value
		case keyAPIKey:
			model.APIKey = f.value
		case keyModelName:
			model.ModelName = f.value
		case keyReasoningField:
			model.ReasoningField = f.value
		case keyContextLimit, keyMaxTokens:
			// An empty value is "unset" to AlayaCore (`setField` returns on one), so `context_limit:` is a
			// model with no limit rather than a broken line.
			if f.value == "" {
				continue
			}
			value, err := strconv.Atoi(f.value)
			if err != nil {
				drop(fmt.Sprintf("%s: %q is not a number — dropped, so the model has none", f.key, f.value))
				continue
			}
			if f.key == keyContextLimit {
				model.ContextLimit = value
			} else {
				model.MaxTokens = value
			}
		case keySerialToolCalls:
			switch strings.ToLower(f.value) {
			case "", "false", "0", "no", "off":
			case "true", "1", "yes", "on":
				model.SerialToolCalls = true
			default:
				drop(fmt.Sprintf("%s: %q is not true or false — dropped, so the model runs its tools in parallel", f.key, f.value))
			}
		case keyReasoning0, keyReasoning1, keyReasoning2:
			if f.value == "" {
				continue
			}
			var object map[string]any
			if err := json.Unmarshal([]byte(f.value), &object); err != nil || object == nil {
				drop(fmt.Sprintf("%s: %q is not a JSON object — dropped", f.key, f.value))
				continue
			}
			block := json.RawMessage(f.value)
			switch f.key {
			case keyReasoning0:
				model.Reasoning0 = block
			case keyReasoning1:
				model.Reasoning1 = block
			default:
				model.Reasoning2 = block
			}
		case keyInputModalities:
			if f.value == "" {
				continue
			}
			var list []string
			if err := json.Unmarshal([]byte(f.value), &list); err != nil {
				drop(fmt.Sprintf("%s: %q is not a JSON array — dropped", f.key, f.value))
				continue
			}
			model.InputModalities = list
		default:
			// A key this build does not write: kept as it stands, because a newer AlayaCore may read it, and
			// dropping it would be this server deleting a setting it has never heard of. Reported as a note
			// rather than a fault — AlayaCore will have its own opinion at the next start.
			keep(fmt.Sprintf("%s: not a key this build writes — kept as written", f.key))
		}
	}
	return model, problems
}

// FormatModels writes a list as `model.conf`: AlayaCore's field order, its `omitempty` rules, and every line
// this build did not write put back where it came from.
func FormatModels(models []Model) []byte {
	formatted := make([]string, 0, len(models))
	for _, model := range models {
		formatted = append(formatted, model.format())
	}
	return joinBlocks(formatted)
}

func (m Model) format() string {
	var w blockWriter
	// The five strings have no `omitempty` in AlayaCore's struct, so they are always stated — `api_key: ""`
	// is how a model with no key says so, and it is what `:model_list` reports back as `hasKey: false`.
	w.line(keyName, quote(m.Name))
	w.line(keyProtocolType, quote(m.ProtocolType))
	w.line(keyBaseURL, quote(m.BaseURL))
	w.line(keyAPIKey, quote(m.APIKey))
	w.line(keyModelName, quote(m.ModelName))
	if m.ContextLimit != 0 {
		w.line(keyContextLimit, strconv.Itoa(m.ContextLimit))
	}
	if m.MaxTokens != 0 {
		w.line(keyMaxTokens, strconv.Itoa(m.MaxTokens))
	}
	for level, block := range [3]json.RawMessage{m.Reasoning0, m.Reasoning1, m.Reasoning2} {
		if len(block) > 0 {
			w.line(reasoningKeys[level], string(block))
		}
	}
	if m.ReasoningField != "" {
		w.line(keyReasoningField, quote(m.ReasoningField))
	}
	if m.SerialToolCalls {
		w.line(keySerialToolCalls, "true")
	}
	if m.InputModalities != nil {
		// `[]` and `["text"]` are one model to AlayaCore, and `[]` has to stay `[]`: an absent line would
		// mean "not declared", which is a different setting (a model the protocol sends media to).
		list, _ := json.Marshal(m.InputModalities)
		w.line(keyInputModalities, string(list))
	}
	for _, line := range m.extra {
		w.raw(line)
	}
	return w.String()
}

// Validate reports what would make AlayaCore skip this entry on load, so a file this server writes is a file
// every later process can use.
//
// The rules are AlayaCore's `validateModel` and `baseURLProblem` (`internal/agent/model_manager.go` there),
// field for field: a block with neither a name nor a model name is dropped whole, then `protocol_type`,
// `base_url` and `model_name` are required, and the input modalities have to be words it knows. They are
// copied rather than guessed because the failure they prevent is silent: a rejected block is a model that
// disappears from the picker, and the only trace is a line on the agent's stderr at the next start.
func (m Model) Validate() []string {
	var problems []string
	if m.Name == "" && m.ModelName == "" {
		problems = append(problems, "a model needs a name")
	}
	switch strings.ToLower(strings.TrimSpace(m.ProtocolType)) {
	case "":
		problems = append(problems, "missing required field protocol_type (openai or anthropic)")
	case "openai", "anthropic":
	default:
		problems = append(problems, fmt.Sprintf("unknown protocol_type %q (expected openai or anthropic)", m.ProtocolType))
	}
	switch {
	case m.BaseURL == "":
		problems = append(problems, "missing required field base_url")
	case baseURLProblem(m.BaseURL) != "":
		problems = append(problems, fmt.Sprintf("invalid base_url %q: %s", m.BaseURL, baseURLProblem(m.BaseURL)))
	}
	if m.ModelName == "" {
		problems = append(problems, "missing required field model_name")
	}
	for _, modality := range m.InputModalities {
		if !knownModalities[modality] {
			problems = append(problems, fmt.Sprintf("unknown input_modalities value %q (expected some of %s)", modality, modalityWords))
		}
	}
	for level, block := range [3]json.RawMessage{m.Reasoning0, m.Reasoning1, m.Reasoning2} {
		if len(block) == 0 {
			continue
		}
		var object map[string]any
		if err := json.Unmarshal(block, &object); err != nil || object == nil {
			problems = append(problems, reasoningKeys[level]+" must be a JSON object")
		}
	}
	return problems
}

// knownModalities is the vocabulary `input_modalities` is drawn from — AlayaCore's `protocol.PlaneKinds` for
// the user plane. `text` costs nothing to list and is never filtered; the other four are the media a message
// can carry.
var knownModalities = map[string]bool{
	"text": true, "image": true, "video": true, "audio": true, "document": true,
}

const modalityWords = "text, image, video, audio, document"

// baseURLProblem explains why an address cannot be a request target, or returns "" when it can.
//
// A URL parse alone is not a check: `localhost:11434` and `api.example.com/v1` both parse, as a relative
// reference, and the failure then surfaces from inside a task as "unsupported protocol scheme" — a sentence
// that names neither the file nor the line. The three questions here are the ones a request will ask anyway.
func baseURLProblem(raw string) string {
	address := strings.TrimSpace(raw)
	parsed, err := url.Parse(address)
	switch {
	case err != nil:
		return err.Error()
	case parsed.Scheme == "":
		return "it has no scheme (expected an absolute URL such as https://api.example.com/v1)"
	case parsed.Scheme != "http" && parsed.Scheme != "https":
		// A host and port written as a URL parses with the host as the scheme, so showing the corrected form
		// is the shortest way to say what went wrong.
		return fmt.Sprintf("scheme %q is not http or https — for a host and port, write %q", parsed.Scheme, "https://"+address)
	case parsed.Host == "":
		return "it names no host"
	}
	return ""
}
