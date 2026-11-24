import { describe, expect, it } from "vitest";

/**
 * The list a canvas writes back into `model.conf`.
 *
 * The whole list is the file: a model it leaves out is deleted, and a field it does not say is a field the
 * server keeps from the file. These tests pin the bargain in both directions — what travels for a model that
 * exists (the fields on this screen, and a key only when this page has one to give), and what travels for one
 * that is being created (everything, and nothing invented).
 */
const { emptyModelDraft, modelDraftComplete, modelDraftOf, modelSyncPayload, reasoningError, withModality } = await import("@/lib/agent-models");

const model = (overrides: Partial<Parameters<typeof modelSyncPayload>[0][number]> = {}): Parameters<typeof modelSyncPayload>[0][number] => ({
    id: 1,
    name: "DeepSeek / Flash",
    protocolType: "openai",
    baseUrl: "https://api.deepseek.com",
    modelName: "deepseek-flash",
    contextLimit: 1000000,
    maxTokens: 65536,
    reasoning0: { thinking: { type: "disabled" } },
    reasoning1: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    reasoning2: { thinking: { type: "enabled" }, reasoning_effort: "xhigh" },
    reasoningField: "reasoning_content",
    serialToolCalls: true,
    inputModalities: ["image"],
    hasKey: true,
    ...overrides,
});

/** The draft of one model, which is what an edit starts from. */
const draftOf = (overrides: Partial<typeof model> = {}) => modelDraftOf(model(overrides));

describe("modelSyncPayload", () => {
    it("sends every model on screen, by id, and never a key", () => {
        const payload = modelSyncPayload([model(), model({ id: 2, name: "Qwen", modelName: "qwen3.8-27b", protocolType: "anthropic" })]);

        expect(payload).toEqual([
            { id: 1, name: "DeepSeek / Flash", protocol_type: "openai", base_url: "https://api.deepseek.com", model_name: "deepseek-flash" },
            { id: 2, name: "Qwen", protocol_type: "anthropic", base_url: "https://api.deepseek.com", model_name: "qwen3.8-27b" },
        ]);
        // The one thing a canvas has never been shown: `hasKey` is on screen, the key is not.
        expect(JSON.stringify(payload)).not.toContain("api_key");
    });

    it("leaves out a model that was deleted, which is the whole of a delete", () => {
        const payload = modelSyncPayload([model(), model({ id: 2 })], { kind: "delete", id: 2 });

        expect(payload.map((entry) => entry.id)).toEqual([1]);
    });

    it("adds the draft after the models that are already there, key and all", () => {
        const change = { kind: "add" as const, draft: { ...emptyModelDraft, name: "  New / Claude ", modelId: " claude-haiku-4 ", baseUrl: " https://api.anthropic.com ", protocol: "anthropic" as const, apiKey: " sk-new " } };
        const payload = modelSyncPayload([model()], change);

        expect(payload).toHaveLength(2);
        expect(payload[1]).toMatchObject({ name: "New / Claude", protocol_type: "anthropic", base_url: "https://api.anthropic.com", model_name: "claude-haiku-4", api_key: "sk-new" });
        // A new model has no id: the agent assigns ids when it writes the list.
        expect(payload[1]).not.toHaveProperty("id");
    });

    it("leaves the key out of a new model that has none, rather than sending an empty one", () => {
        const payload = modelSyncPayload([], { kind: "add", draft: { ...emptyModelDraft, name: "Local", modelId: "qwen", baseUrl: "http://127.0.0.1:9999/v1" } });

        expect(payload[0]).not.toHaveProperty("api_key");
    });

    it("changes a model in the place it stands, and keeps its id", () => {
        const payload = modelSyncPayload([model(), model({ id: 2 })], { kind: "edit", id: 2, draft: { ...modelDraftOf(model()), name: "Renamed", apiKey: "" } });

        expect(payload).toHaveLength(2);
        expect(payload[1]).toMatchObject({ id: 2, name: "Renamed" });
        // An empty key field is how a stored key is kept: nothing is said about it.
        expect(payload[1]).not.toHaveProperty("api_key");
    });

    it("sends a key that was retyped, which is how one is rotated", () => {
        const payload = modelSyncPayload([model()], { kind: "edit", id: 1, draft: { ...modelDraftOf(model()), apiKey: "sk-rotated" } });

        expect(payload[0]).toMatchObject({ id: 1, name: "DeepSeek / Flash", api_key: "sk-rotated" });
    });

    it("reads an unknown protocol as the one every provider speaks", () => {
        const payload = modelSyncPayload([model({ protocolType: undefined })]);

        expect(payload[0].protocol_type).toBe("openai");
    });
});

describe("modelDraftOf", () => {
    it("fills the form from the model, with the key it cannot know left empty", () => {
        expect(modelDraftOf(model({ protocolType: "anthropic" }))).toMatchObject({ name: "DeepSeek / Flash", modelId: "deepseek-flash", baseUrl: "https://api.deepseek.com", protocol: "anthropic", apiKey: "" });
    });

    // Every field of the entry is on the form (#249): what a form does not show is a value the user cannot set.
    it("fills the rest of the entry too, and shows each reasoning block as the JSON it is", () => {
        const draft = modelDraftOf(model());

        expect(draft).toMatchObject({ contextLimit: "1000000", maxTokens: "65536", reasoningField: "reasoning_content", serialToolCalls: true });
        expect(JSON.parse(draft.reasoning1)).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
        // Indented, because a person has to be able to read it in a textarea.
        expect(draft.reasoning1).toContain("\n");
    });

    it("shows nothing for a block the entry does not have", () => {
        expect(modelDraftOf(model({ reasoning0: undefined })).reasoning0).toBe("");
        expect(modelDraftOf(model({ reasoning0: null })).reasoning0).toBe("");
    });
});

describe("the rest of a model's entry, as the form edits it", () => {
    it("sends the token caps, the blocks, the reasoning field and the tool-call mode", () => {
        const payload = modelSyncPayload([model()], {
            kind: "edit",
            id: 1,
            draft: { ...draftOf(), contextLimit: "200000", maxTokens: "8192", reasoningField: "reasoning_text", serialToolCalls: false, reasoning0: `{"thinking":{"type":"disabled"}}` },
        });

        expect(payload[0]).toMatchObject({
            context_limit: 200000,
            max_tokens: 8192,
            reasoning_field: "reasoning_text",
            serial_tool_calls: false,
            reasoning_0: { thinking: { type: "disabled" } },
        });
        // An untouched block travels as itself: it was shown, so it is sent back.
        expect(payload[0].reasoning_2).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "xhigh" });
    });

    // A cleared box is an answer, where an empty key field is a silence: the form showed the block, so
    // emptying it removes it, and `null` is how that is said.
    it("sends null for a block the user cleared", () => {
        const payload = modelSyncPayload([model()], { kind: "edit", id: 1, draft: { ...draftOf(), reasoning2: "   " } });

        expect(payload[0].reasoning_2).toBeNull();
    });

    it("sends an empty reasoning field as nothing, so the provider's default stands", () => {
        const payload = modelSyncPayload([model()], { kind: "edit", id: 1, draft: { ...draftOf(), reasoningField: "  " } });

        expect(payload[0]).not.toHaveProperty("reasoning_field");
    });

    it('counts a cleared token cap as the zero model.conf writes for "not set"', () => {
        const payload = modelSyncPayload([model()], { kind: "edit", id: 1, draft: { ...draftOf(), contextLimit: "", maxTokens: "abc" } });

        expect(payload[0]).toMatchObject({ context_limit: 0, max_tokens: 0 });
    });
});

describe("the input types a model declares", () => {
    it('keeps "no media" apart from "not declared" in both directions', () => {
        // `[]` is a declaration; reading it as "nothing was declared" is a model that silently widens back to
        // every modality its protocol carries.
        expect(modelDraftOf(model({ inputModalities: [] })).inputModalities).toEqual([]);
        expect(modelDraftOf(model({ inputModalities: ["text", "image"] })).inputModalities).toEqual(["text", "image"]);
        expect(modelDraftOf(model({ inputModalities: null })).inputModalities).toBeNull();
        expect(modelDraftOf(model({ inputModalities: undefined })).inputModalities).toBeNull();
    });

    it("sends the switch, off, as null — the one thing that removes the line", () => {
        const payload = modelSyncPayload([model()], { kind: "edit", id: 1, draft: { ...draftOf(), inputModalities: null } });

        expect(payload[0]).toHaveProperty("input_modalities", null);
    });

    it("sends a list and an empty declaration as themselves", () => {
        const list = modelSyncPayload([model()], { kind: "edit", id: 1, draft: { ...draftOf(), inputModalities: ["image", "document"] } });
        expect(list[0].input_modalities).toEqual(["image", "document"]);

        const none = modelSyncPayload([model()], { kind: "edit", id: 1, draft: { ...draftOf(), inputModalities: [] } });
        expect(none[0].input_modalities).toEqual([]);
    });

    // Only the edited model's list travels: the others the page never opened keep what the server holds, which
    // is where an `api_key` and a declaration it was not shown come from.
    it("says nothing about a model the form did not open", () => {
        const payload = modelSyncPayload([model(), model({ id: 2 })], { kind: "delete", id: 2 });

        expect(payload[0]).not.toHaveProperty("input_modalities");
    });

    it("keeps the words this build does not know when a box is ticked", () => {
        // A newer AlayaCore may accept a sixth word; the form edits only the boxes it has, so the rest travel.
        expect(withModality(["text", "hologram"], "image", true)).toEqual(["text", "hologram", "image"]);
        expect(withModality(["text", "hologram"], "image", false)).toEqual(["text", "hologram"]);
    });

    it("toggles without duplicating, in either order", () => {
        expect(withModality([], "audio", true)).toEqual(["audio"]);
        expect(withModality(["audio"], "audio", true)).toEqual(["audio"]);
        expect(withModality(["image", "audio"], "image", false)).toEqual(["audio"]);
        expect(withModality(["image"], "video", true)).toEqual(["image", "video"]);
    });
});

describe("reasoningError", () => {
    it("accepts a blank block and a JSON object", () => {
        expect(reasoningError("")).toBe("");
        expect(reasoningError("   ")).toBe("");
        expect(reasoningError(`{"thinking":{"type":"enabled"}}`)).toBe("");
        expect(reasoningError("{}")).toBe("");
    });

    // The blocks are merged into a request body, so anything else is a request the provider rejects.
    it("refuses what is not a JSON object, and says which of the two things is wrong", () => {
        expect(reasoningError("{oops")).toBe("config.preferences.modelReasoningNotJson");
        expect(reasoningError(`{"thinking":}`)).toBe("config.preferences.modelReasoningNotJson");
        expect(reasoningError(`"enabled"`)).toBe("config.preferences.modelReasoningNotObject");
        expect(reasoningError("5")).toBe("config.preferences.modelReasoningNotObject");
        expect(reasoningError("[1,2]")).toBe("config.preferences.modelReasoningNotObject");
        expect(reasoningError("null")).toBe("config.preferences.modelReasoningNotObject");
    });
});

describe("modelDraftComplete", () => {
    it("wants a name to show and the two things a request needs", () => {
        expect(modelDraftComplete({ ...emptyModelDraft, name: "Local", modelId: "qwen", baseUrl: "http://127.0.0.1:9999/v1" })).toBe(true);
        // The key is optional: a local endpoint answers without one.
        expect(modelDraftComplete({ ...emptyModelDraft, name: "Local", modelId: "qwen" })).toBe(false);
        expect(modelDraftComplete({ ...emptyModelDraft, name: "   ", modelId: "qwen", baseUrl: "http://127.0.0.1:9999/v1" })).toBe(false);
    });

    // A form that would send JSON it could not parse is a form that must not save: Save stays off, and the
    // field says why.
    it("wants the reasoning blocks to be JSON objects", () => {
        const complete = { ...emptyModelDraft, name: "Local", modelId: "qwen", baseUrl: "http://127.0.0.1:9999/v1" };
        expect(modelDraftComplete({ ...complete, reasoning1: `{"thinking":{"type":"enabled"}}` })).toBe(true);
        expect(modelDraftComplete({ ...complete, reasoning1: "{oops" })).toBe(false);
        expect(modelDraftComplete({ ...complete, reasoning2: "nope" })).toBe(false);
    });
});
