package agentconf

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// A file as an operator writes one: comments, a quoted name with a slash and spaces, one block with every
// field AlayaCore reads, one model that declares no media, and one that declares it declares nothing.
//
// The second half of this test is the whole point of the package: what comes out of `FormatModels` has to
// parse back into the same list, or an edit from the canvas would change something nobody edited.
const handWritten = `# the workstation
name: "V100 / Qwen"
protocol_type: "openai"
base_url: "http://172.16.9.7:9999/v1"
api_key: "sk-one"
model_name: "qwen3.8-27b"
context_limit: 262144
max_tokens: 65536
reasoning_0: {"thinking":{"type":"disabled"}}
reasoning_1: {"reasoning_effort":"medium"}
reasoning_2: {"reasoning_effort":"xhigh"}
reasoning_field: reasoning_content
serial_tool_calls: true
input_modalities: ["text","image"]

---

name: 'DeepSeek / Flash'
protocol_type: openai
base_url: https://api.deepseek.com
api_key: "sk-two"
model_name: deepseek-flash
input_modalities: []
---
name: "Local"
base_url: "http://127.0.0.1:11434/v1"
model_name: "qwen3:8b"
`

func TestParseAndFormatRoundTrip(t *testing.T) {
	models, problems := ParseModels([]byte(handWritten))
	if len(problems) != 0 {
		t.Fatalf("a file that parses was reported as %v", problems)
	}
	if len(models) != 3 {
		t.Fatalf("parsed %d model(s), want 3", len(models))
	}

	first := models[0]
	if first.Name != "V100 / Qwen" || first.BaseURL != "http://172.16.9.7:9999/v1" || first.ModelName != "qwen3.8-27b" {
		t.Errorf("first model = %+v", first)
	}
	if first.APIKey != "sk-one" || first.ContextLimit != 262144 || first.MaxTokens != 65536 {
		t.Errorf("first model's key or caps = %q %d %d", first.APIKey, first.ContextLimit, first.MaxTokens)
	}
	if string(first.Reasoning1) != `{"reasoning_effort":"medium"}` {
		t.Errorf("reasoning_1 = %s", first.Reasoning1)
	}
	if first.ReasoningField != "reasoning_content" || !first.SerialToolCalls {
		t.Errorf("reasoning_field/serial_tool_calls = %q/%t", first.ReasoningField, first.SerialToolCalls)
	}
	if !slices.Equal(first.InputModalities, []string{"text", "image"}) {
		t.Errorf("input_modalities = %v", first.InputModalities)
	}
	// The comment a block carried is not part of the model, and it is not thrown away either.
	if !slices.Equal(first.extra, []string{"# the workstation"}) {
		t.Errorf("the block's comment was not kept: %v", first.extra)
	}

	// Unquoted values, both single-quoted strings and a bare address, read the same as quoted ones.
	second := models[1]
	if second.Name != "DeepSeek / Flash" || second.ProtocolType != "openai" || second.BaseURL != "https://api.deepseek.com" || second.ModelName != "deepseek-flash" {
		t.Errorf("second model = %+v", second)
	}
	// `[]` is a declaration, and it stays one: nil here would mean "the protocol decides" on the way out.
	if second.InputModalities == nil || len(second.InputModalities) != 0 {
		t.Errorf("input_modalities = %#v, want an empty declaration", second.InputModalities)
	}

	// A block with no protocol is still a model (AlayaCore rejects it on load, and the editor is where that is
	// fixed), and a model that says nothing about media keeps the nil that means "not declared".
	third := models[2]
	if third.ProtocolType != "" || third.InputModalities != nil {
		t.Errorf("third model = %+v", third)
	}

	formatted := FormatModels(models)
	if !strings.HasSuffix(string(formatted), "\n") || strings.HasSuffix(string(formatted), "\n\n") {
		t.Fatalf("the file ends with %q, want exactly one newline", string(formatted)[len(formatted)-4:])
	}
	again, problems := ParseModels(formatted)
	if len(problems) != 0 {
		t.Fatalf("what this package wrote did not parse: %v", problems)
	}
	if !reflect.DeepEqual(again, models) {
		t.Fatalf("a round trip changed the list:\n%+v\n%+v\nit wrote:\n%s", models, again, formatted)
	}
	if string(FormatModels(again)) != string(formatted) {
		t.Errorf("formatting is not idempotent:\n%s\n%s", formatted, FormatModels(again))
	}
}

// The output is pinned field by field: the order is AlayaCore's own (the field order of its `modelConfig`),
// and a field it marks `omitempty` is absent when it is zero. A file this server writes has to look like one
// AlayaCore wrote, or a diff between the two is unreadable.
func TestFormatModelsIsTheShapeAlayaCoreWrites(t *testing.T) {
	got := string(FormatModels([]Model{{
		Name:            "V100 / Qwen",
		ProtocolType:    "openai",
		BaseURL:         "http://172.16.9.7:9999/v1",
		APIKey:          "sk-one",
		ModelName:       "qwen3.8-27b",
		ContextLimit:    262144,
		MaxTokens:       65536,
		Reasoning1:      json.RawMessage(`{"reasoning_effort":"medium"}`),
		ReasoningField:  "reasoning_content",
		SerialToolCalls: true,
		InputModalities: []string{"image"},
	}}))
	want := `name: "V100 / Qwen"
protocol_type: "openai"
base_url: "http://172.16.9.7:9999/v1"
api_key: "sk-one"
model_name: "qwen3.8-27b"
context_limit: 262144
max_tokens: 65536
reasoning_1: {"reasoning_effort":"medium"}
reasoning_field: "reasoning_content"
serial_tool_calls: true
input_modalities: ["image"]
`
	if got != want {
		t.Fatalf("format =\n%s\nwant\n%s", got, want)
	}

	// And the zero value of every omitted field is absent, with the five strings still stated: `api_key: ""`
	// is how a model with no key says so.
	bare := string(FormatModels([]Model{{Name: "x", ProtocolType: "openai", BaseURL: "http://h/v1", ModelName: "m"}}))
	for _, absent := range []string{"context_limit", "max_tokens", "reasoning_", "reasoning_field", "serial_tool_calls", "input_modalities"} {
		if strings.Contains(bare, absent) {
			t.Errorf("a zero %s was written anyway:\n%s", absent, bare)
		}
	}
	if !strings.Contains(bare, `api_key: ""`) {
		t.Errorf("a model with no key does not say so:\n%s", bare)
	}
}

// The four escapes are the four AlayaCore unquotes, and nothing else is escaped: a tab stays a tab, because
// its reader would keep `\t` as two characters and the name would change under the user.
func TestValuesSurviveTheEscapesAlayaCoreKnows(t *testing.T) {
	awkward := Model{
		Name:         "a \"quoted\" \\ name\twith a tab and\na newline",
		ProtocolType: "openai",
		BaseURL:      "http://h/v1",
		APIKey:       `sk-"weird"\key`,
		ModelName:    "m",
	}
	written := string(FormatModels([]Model{awkward}))
	if strings.Contains(written, `\t`) || !strings.Contains(written, "\t") {
		t.Errorf("the tab was escaped as something its reader does not know:\n%q", written)
	}

	back, problems := ParseModels([]byte(written))
	if len(problems) != 0 {
		t.Fatalf("problems: %v", problems)
	}
	if len(back) != 1 || back[0].Name != awkward.Name || back[0].APIKey != awkward.APIKey {
		t.Fatalf("the values did not survive: %+v from\n%s", back, written)
	}
}

// A value this build cannot read is reported and dropped; a key it does not know is reported and kept. The two
// are different on purpose: AlayaCore cannot use the first either — it reports the same value and leaves the
// field at its zero — while the second is a setting a newer AlayaCore may well read, and this server is not the
// one to delete it.
func TestUnreadableValuesAreReportedAndDroppedAndForeignKeysKept(t *testing.T) {
	content := `name: "one"
model_name: "m"
context_limit: 262144k
reasoning_1: {"thinking":{"type":"enabled"}
input_modalities: [image]
serial_tool_calls: sometimes
oracle: "what a newer core reads"
`
	models, problems := ParseModels([]byte(content))
	if len(models) != 1 {
		t.Fatalf("parsed %d model(s), want the one", len(models))
	}
	model := models[0]
	if model.ContextLimit != 0 || model.Reasoning1 != nil || model.InputModalities != nil || model.SerialToolCalls {
		t.Errorf("a value that does not parse was read as something: %+v", model)
	}
	// Every line it could not read is named, because the form shows an empty field where the file says
	// something — and a silence there looks like a field nobody set.
	keys := []string{"context_limit", "reasoning_1", "input_modalities", "serial_tool_calls", "oracle"}
	if len(problems) != len(keys) {
		t.Fatalf("problems = %v, want one per line this build could not read", problems)
	}
	for index, problem := range problems {
		// Each says what it did: `dropped` for a value nothing can read, `kept` for a key another core may.
		wanted := []string{"dropped", "dropped", "dropped", "dropped", "kept"}
		if !strings.Contains(problem, keys[index]) || !strings.Contains(problem, wanted[index]) {
			t.Errorf("problem %d = %q, want it to name the key and say it was %s", index, problem, wanted[index])
		}
	}

	written := string(FormatModels(models))
	// What a newer core wrote is still there, and so is the rest of the entry.
	for _, kept := range []string{`oracle: "what a newer core reads"`, `name: "one"`, `model_name: "m"`} {
		if !strings.Contains(written, kept) {
			t.Errorf("a line another reader may use was dropped: %q is not in\n%s", kept, written)
		}
	}
	// What nothing can read is gone: the form was showing an empty field where the file said something, and a
	// save writes what the form holds.
	for _, dropped := range []string{"262144k", "input_modalities", "serial_tool_calls", "reasoning_1"} {
		if strings.Contains(written, dropped) {
			t.Errorf("%q survived a save it cannot survive:\n%s", dropped, written)
		}
	}
}

// A line that is not a field at all, and a key stated twice, are the two things that make a block's *shape*
// wrong — they are reported, and the block still parses so the rest of it can be edited.
func TestBrokenShapeIsReportedAndTheRestStillParses(t *testing.T) {
	models, problems := ParseModels([]byte("name: \"one\"\nmodel_name: \"m\"\nthis line has no colon\nname: \"two\"\n"))
	if len(models) != 1 || models[0].Name != "one" {
		t.Fatalf("models = %+v, want the first name kept", models)
	}
	joined := strings.Join(problems, " | ")
	if !strings.Contains(joined, "not a `key: value` line") {
		t.Errorf("problems = %q, want the line named", problems)
	}
	if !strings.Contains(joined, "duplicate key \"name\"") {
		t.Errorf("problems = %q, want the duplicate named", problems)
	}
	for _, problem := range problems {
		if !strings.HasPrefix(problem, `model 1 ("one"): `) {
			t.Errorf("a problem does not name the model it is in: %q", problem)
		}
	}
}

// A block with neither name nor model name is not a model: AlayaCore drops it on load, so it is not shown as
// an empty row that a user could save into something broken.
func TestABlockWithNoNameIsNotAModel(t *testing.T) {
	models, problems := ParseModels([]byte("name: \"one\"\nmodel_name: \"m\"\n---\n# just a note\n---\nmodel_name: \"two\"\n"))
	if len(problems) != 0 {
		t.Fatalf("problems = %v", problems)
	}
	if len(models) != 2 || models[0].Name != "one" || models[1].ModelName != "two" {
		t.Fatalf("models = %+v, want the two that name something", models)
	}
}

// A file a Windows editor saved is one file, not one block: CRLF is normalized before anything is split.
func TestCRLFIsOneFileWithBlocks(t *testing.T) {
	content := "name: \"one\"\r\nmodel_name: \"m\"\r\n---\r\nname: \"two\"\r\nmodel_name: \"n\"\r\n"
	models, problems := ParseModels([]byte(content))
	if len(problems) != 0 {
		t.Fatalf("problems = %v", problems)
	}
	if len(models) != 2 {
		t.Fatalf("parsed %d model(s), want 2", len(models))
	}
	if models[0].Name != "one" || models[1].Name != "two" {
		t.Errorf("models = %+v", models)
	}
}

// Validation is AlayaCore's own list of reasons to skip a block, because a file this server writes has to be
// a file that loads — a rejected block is a model that disappears from the picker with nothing on screen to
// say why.
func TestValidateSaysWhatAlayaCoreWouldReject(t *testing.T) {
	valid := Model{Name: "one", ProtocolType: "openai", BaseURL: "http://127.0.0.1:9999/v1", ModelName: "m"}
	if problems := valid.Validate(); len(problems) != 0 {
		t.Fatalf("a valid model was refused: %v", problems)
	}
	if problems := (Model{Name: "one", ProtocolType: "Anthropic", BaseURL: "https://api.anthropic.com", ModelName: "m"}).Validate(); len(problems) != 0 {
		t.Errorf("protocol_type is matched case-insensitively by AlayaCore: %v", problems)
	}

	for name, model := range map[string]Model{
		"no name and no model name": {ProtocolType: "openai", BaseURL: "http://h/v1"},
		"no protocol":               {Name: "one", BaseURL: "http://h/v1", ModelName: "m"},
		"unknown protocol":          {Name: "one", ProtocolType: "ollama", BaseURL: "http://h/v1", ModelName: "m"},
		"no address":                {Name: "one", ProtocolType: "openai", ModelName: "m"},
		"address without one":       {Name: "one", ProtocolType: "openai", BaseURL: "localhost:11434", ModelName: "m"},
		"no model name":             {Name: "one", ProtocolType: "openai", BaseURL: "http://h/v1"},
		"unknown media":             {Name: "one", ProtocolType: "openai", BaseURL: "http://h/v1", ModelName: "m", InputModalities: []string{"vision"}},
		"reasoning not object":      {Name: "one", ProtocolType: "openai", BaseURL: "http://h/v1", ModelName: "m", Reasoning1: json.RawMessage(`"plain"`)},
	} {
		if problems := model.Validate(); len(problems) == 0 {
			t.Errorf("%s was accepted", name)
		}
	}
}
