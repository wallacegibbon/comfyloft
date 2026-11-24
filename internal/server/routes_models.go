package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"comfyloft/internal/agent"
	"comfyloft/internal/agentconf"
	"comfyloft/internal/httpx"
	"comfyloft/internal/util"
)

/**
 * The agent's models, as the one file they live in.
 *
 * `model.conf` is AlayaCore's list of providers: a name, an address, a protocol, a key, the token caps, the
 * reasoning blocks a level merges into a request, and the media a model declares. The preferences window
 * reads and writes it here.
 *
 * **Why this is the server's file, and not the agent's.** It always was AlayaCore's, and the canvas used to
 * edit it through the agent: `:model_sync` sent the whole list over the wire and AlayaCore rewrote the file
 * (#201). Wire version 19 removed that command — the list is written in exactly one place, `model.conf`, and
 * `:model_load` is what makes a running process read it again (its `docs/commands.md`). So the editor writes
 * the file, and `:model_load` is the one thing it still asks the agent for.
 *
 * **What that buys.** The editor works when no agent does, which is the case it exists for: a `model.conf`
 * with no usable model stops AlayaCore before it is ready (`internal/app/session.go` there), so an editor
 * that had to connect could not repair the file that stops it. It also ends the arrangement where an edit
 * deleted every key on the machine unless the server first put them back: the page is never shown a key, so
 * the file — which has them — is the thing that is edited, and `hasKey` is all the page needs.
 *
 * **What is not here.** No HTTP call to a provider, no probing, no defaults invented: whether a model works
 * is the agent's answer, given by `model_load` and by the first turn. The one judgement this route makes is
 * `agentconf.Model.Validate` — a file this server writes has to be a file that loads.
 */

// routesModels registers the model list the editor reads and writes.
func (s *Server) routesModels(mux *http.ServeMux) {
	s.route(mux, "GET /api/agent/models", s.handleAgentModels)
	s.route(mux, "PUT /api/agent/models", s.handleAgentModelsSave)
}

// handleAgentModels implements GET /api/agent/models: the list, and what the file says that this build could
// not read.
//
// No key is in the answer. `hasKey` says one is stored, which is all a page needs to offer to replace or
// clear it; the key itself never leaves the server, and the requests that use it are the agent's.
//
// `problems` is the file's own account of itself — a line that is not a field, a key stated twice, a value
// this build could not parse. They are reported rather than repaired: the entry is still shown, the line is
// still in the file, and editing the field replaces it.
func (s *Server) handleAgentModels(ctx *httpx.Ctx) error {
	models, problems, err := s.readAgentModels()
	if err != nil {
		return err
	}
	okJSON(ctx.W, modelsAnswer(models, problems))
	return nil
}

// handleAgentModelsSave implements PUT /api/agent/models with `{models: [...]}`.
//
// The list is the file: every model in it, in its order, with one added, changed or removed, and a model that
// is missing is a model that is deleted. An entry without an `id` is new; one whose id is not in the file is
// a page working from a list that has moved, and is refused rather than allowed to duplicate a model.
func (s *Server) handleAgentModelsSave(ctx *httpx.Ctx) error {
	path, err := s.modelConfPath()
	if err != nil {
		return err
	}
	body, err := bodyOrEmpty(ctx)
	if err != nil {
		return err
	}
	raw, present := body["models"]
	if !present || raw == nil {
		return httpx.BadRequest("agent_models_missing", "the request has no models")
	}
	edits, err := decodeModelEdits(raw)
	if err != nil {
		return err
	}
	stored, _, err := s.readAgentModels()
	if err != nil {
		return err
	}
	merged, err := mergeModels(stored, edits)
	if err != nil {
		return err
	}
	if problems := validateModels(merged); len(problems) > 0 {
		// Refused whole rather than written in part: a file with one rejected block loses that model from
		// every later process, and the user would be looking at a list that only looks saved.
		return httpx.BadRequest("agent_models_invalid", strings.Join(problems, "; "))
	}

	// A key is in this file, so it is written readable by its owner alone — the mode AlayaCore's own writer
	// uses (`internal/agent/persistence.go` there). The rename inside `WriteFileAtomicMode` keeps it.
	if err := util.WriteFileAtomicMode(path, agentconf.FormatModels(merged), 0o600); err != nil {
		return httpx.Errorf(http.StatusInternalServerError, "agent_models_unwritable", "cannot write model.conf: %v", err)
	}
	if s.logger != nil {
		s.logger.Info("agent: wrote %s (%d model(s))", path, len(merged))
	}
	s.reloadAgentModels()
	// The answer is the file read back rather than the list in memory: what a save reports has to be what a
	// reader will find, and a line this build does not understand is still there, still reported.
	written, problems, err := s.readAgentModels()
	if err != nil {
		return err
	}
	okJSON(ctx.W, modelsAnswer(written, problems))
	return nil
}

// modelConfPath is the file, or an error when this server has no configuration directory to name — writing
// `model.conf` into the process's working directory would be inventing a location no agent reads.
func (s *Server) modelConfPath() (string, error) {
	if s.cfg == nil || s.cfg.AgentConfigPath == "" {
		return "", httpx.NewError(http.StatusServiceUnavailable, "agent_config_missing", "the agent's configuration directory is not known: set AGENT_CONFIG_PATH")
	}
	return filepath.Join(s.cfg.AgentConfigPath, "model.conf"), nil
}

// readAgentModels is the file as the editor sees it.
//
// A file that is not there is an empty list rather than a failure: the config directory and its first
// `model.conf` are AlayaCore's to create, so "no file yet" is "no models yet", and a page that shows that is
// telling the truth.
func (s *Server) readAgentModels() ([]agentconf.Model, []string, error) {
	path, err := s.modelConfPath()
	if err != nil {
		return nil, nil, err
	}
	content, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, httpx.Errorf(http.StatusInternalServerError, "agent_models_unreadable", "cannot read model.conf: %v", err)
	}
	models, problems := agentconf.ParseModels(content)
	return models, problems, nil
}

// modelsAnswer is what both routes say: the list, and the file's problems when it has any.
//
// The entries are `agent.Model` — the shape a canvas already reads off `model_list` — so an editor and a
// picker describe a model the same way. The id is the model's position, which is what AlayaCore assigns on
// load and what its `:model_set` takes.
func modelsAnswer(models []agentconf.Model, problems []string) map[string]any {
	entries := make([]agent.Model, 0, len(models))
	for index, model := range models {
		entries = append(entries, agent.Model{
			ID:              index + 1,
			Name:            model.Name,
			ProtocolType:    model.ProtocolType,
			BaseURL:         model.BaseURL,
			ModelName:       model.ModelName,
			ContextLimit:    model.ContextLimit,
			HasKey:          model.APIKey != "",
			MaxTokens:       model.MaxTokens,
			Reasoning0:      model.Reasoning0,
			Reasoning1:      model.Reasoning1,
			Reasoning2:      model.Reasoning2,
			ReasoningField:  model.ReasoningField,
			SerialToolCalls: model.SerialToolCalls,
			InputModalities: model.InputModalities,
		})
	}
	answer := map[string]any{"models": entries}
	if len(problems) > 0 {
		answer["problems"] = problems
	}
	return answer
}

// modelEdit is one entry of a PUT: a model as the editor describes it, in the file's own field names.
//
// The reasoning blocks and the input modalities are `json.RawMessage` because there are three answers there
// and they mean three things: absent is "this page has never heard of the field" (a bundle older than it),
// `null` is "remove it" (a cleared box, a switch turned off), and a value is the value. A `*string` could not
// tell the first two apart, and reading either as the other would silently widen a model or delete a block.
type modelEdit struct {
	ID              *int            `json:"id"`
	Name            *string         `json:"name"`
	ProtocolType    *string         `json:"protocol_type"`
	BaseURL         *string         `json:"base_url"`
	ModelName       *string         `json:"model_name"`
	APIKey          *string         `json:"api_key"`
	ContextLimit    *int            `json:"context_limit"`
	MaxTokens       *int            `json:"max_tokens"`
	Reasoning0      json.RawMessage `json:"reasoning_0"`
	Reasoning1      json.RawMessage `json:"reasoning_1"`
	Reasoning2      json.RawMessage `json:"reasoning_2"`
	ReasoningField  *string         `json:"reasoning_field"`
	SerialToolCalls *bool           `json:"serial_tool_calls"`
	InputModalities json.RawMessage `json:"input_modalities"`
}

func decodeModelEdits(raw any) ([]modelEdit, error) {
	payload, err := json.Marshal(raw)
	if err != nil {
		return nil, httpx.BadRequest("agent_models_invalid", "the model list is not JSON: "+err.Error())
	}
	var edits []modelEdit
	if err := json.Unmarshal(payload, &edits); err != nil {
		return nil, httpx.BadRequest("agent_models_invalid", "every model must be an object of the fields model.conf holds: "+err.Error())
	}
	return edits, nil
}

// mergeModels is the list to write.
//
// Every entry starts from what the file already holds for it, so deleting a model does not take another's
// key, reasoning blocks or the lines this build does not understand with it (the old `mergeModelSync`'s
// bargain, now kept by the file itself):
//
//   - an id names a stored entry, and the fields the page states replace the stored ones;
//   - no id is a new model, which travels as it was sent;
//   - `api_key` travels only when the page has one to give — a new model, or one whose key was just retyped.
//     An absent or empty one says nothing, because the page has never been shown the stored key and is in no
//     position to mean it away.
//   - a reasoning block or `input_modalities` is replaced only when the entry mentions it, and `null` is an
//     answer: it removes what is stored, which is how a cleared box or a switch turned off is said.
func mergeModels(stored []agentconf.Model, edits []modelEdit) ([]agentconf.Model, error) {
	merged := make([]agentconf.Model, 0, len(edits))
	for _, edit := range edits {
		model := agentconf.Model{}
		if edit.ID != nil {
			if *edit.ID < 1 || *edit.ID > len(stored) {
				return nil, httpx.NewError(http.StatusConflict, "agent_models_stale",
					fmt.Sprintf("model %d is not in model.conf: reload the list and try again", *edit.ID))
			}
			// A copy, which carries the lines this build does not own (`extra`) with it.
			model = stored[*edit.ID-1]
		}
		if edit.Name != nil {
			model.Name = *edit.Name
		}
		if edit.ProtocolType != nil {
			model.ProtocolType = *edit.ProtocolType
		}
		if edit.BaseURL != nil {
			model.BaseURL = *edit.BaseURL
		}
		if edit.ModelName != nil {
			model.ModelName = *edit.ModelName
		}
		if edit.ContextLimit != nil {
			model.ContextLimit = *edit.ContextLimit
		}
		if edit.MaxTokens != nil {
			model.MaxTokens = *edit.MaxTokens
		}
		if edit.ReasoningField != nil {
			model.ReasoningField = *edit.ReasoningField
		}
		if edit.SerialToolCalls != nil {
			model.SerialToolCalls = *edit.SerialToolCalls
		}
		if edit.APIKey != nil && *edit.APIKey != "" {
			model.APIKey = *edit.APIKey
		}
		for level, block := range [3]json.RawMessage{edit.Reasoning0, edit.Reasoning1, edit.Reasoning2} {
			if block == nil {
				continue
			}
			// `null` is the removal — a nil RawMessage is what writes no line — and anything else has to be the
			// object a request body can merge, because a string or an array would be a request AlayaCore sends
			// malformed (the same rule the form keeps Save off for, #249).
			if isJSONNull(block) {
				block = nil
			} else {
				var object map[string]any
				if json.Unmarshal(block, &object) != nil || object == nil {
					return nil, httpx.BadRequest("agent_model_reasoning_invalid",
						fmt.Sprintf("reasoning_%d must be a JSON object, or null to remove it", level))
				}
			}
			switch level {
			case 0:
				model.Reasoning0 = block
			case 1:
				model.Reasoning1 = block
			default:
				model.Reasoning2 = block
			}
		}
		if edit.InputModalities != nil {
			if isJSONNull(edit.InputModalities) {
				model.InputModalities = nil
			} else {
				var list []string
				if err := json.Unmarshal(edit.InputModalities, &list); err != nil {
					return nil, httpx.BadRequest("agent_model_modalities_invalid", "input_modalities must be a JSON array of input types, or null to remove it")
				}
				model.InputModalities = list
			}
		}
		merged = append(merged, model)
	}
	return merged, nil
}

// isJSONNull reports the one value that means "remove this", as opposed to a value that is not there.
func isJSONNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

// validateModels is every reason AlayaCore would skip a block, plus the one that is only visible across the
// list: a duplicate name, which it resolves by keeping the first and dropping the rest (`model_manager.go`
// there). Refusing here is the difference between a save that is shown on screen and a model that quietly is
// not there at the next start.
func validateModels(models []agentconf.Model) []string {
	var problems []string
	seen := make(map[string]bool, len(models))
	for index, model := range models {
		who := fmt.Sprintf("model %d", index+1)
		if model.Name != "" {
			who = fmt.Sprintf("model %d (%q)", index+1, model.Name)
		}
		for _, problem := range model.Validate() {
			problems = append(problems, who+": "+problem)
		}
		if model.Name == "" {
			continue
		}
		if seen[model.Name] {
			problems = append(problems, who+": duplicate name "+fmt.Sprintf("%q", model.Name)+" — AlayaCore would keep the first and skip this one")
		}
		seen[model.Name] = true
	}
	return problems
}

// reloadAgentModels asks every live agent to read `model.conf` again — `:model_load`, the only way a model
// list enters a process that is already running.
//
// A session in the middle of a turn is not asked now: the command is idle-only, so AlayaCore would refuse it.
// `Session.ReloadModels` remembers instead, and the pump sends it the moment that turn ends.
func (s *Server) reloadAgentModels() {
	now, deferred := 0, 0
	for _, session := range s.agentSessions.List() {
		if session.ReloadModels() {
			now++
		} else {
			deferred++
		}
	}
	if s.logger != nil && now+deferred > 0 {
		s.logger.Info("agent: model.conf written; model_load sent to %d idle session(s), deferred for %d mid-turn", now, deferred)
	}
}
