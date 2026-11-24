import type { AgentModel } from "@/services/api/agent";
import type { AgentModelEdit } from "@/services/api/agent-models";

/**
 * The editor's side of the agent's model list.
 *
 * The list is `model.conf`, and the server writes it (`internal/server/routes_models.go`). A page sends the
 * **whole** list — "these models, in this order" — so a model that is missing is a model that is deleted.
 *
 * What a page cannot send is the part it has never been shown: the `api_key`. So an existing model travels by
 * id and the fields on this screen, and a key travels only when this page has one to give: a model being
 * created, or one whose key the user has just retyped. An empty key field says nothing and changes nothing.
 *
 * Everything else in an entry is on the form (#249): the token caps, the three reasoning blocks as the JSON
 * they are, the response field that carries reasoning text, and whether a step's tool calls run one at a
 * time. The reasoning blocks are the one place where a blank field is an answer — a form showed the value,
 * so clearing the box removes the block, which is sent as `null`.
 */
export type ModelProtocol = "openai" | "anthropic";

/** The fields a model is added or changed with. Numbers stay text so a half-typed one is not a `NaN`. */
export type ModelDraft = {
    name: string;
    modelId: string;
    baseUrl: string;
    protocol: ModelProtocol;
    apiKey: string;
    /** Context window; "" is the same as 0, which `model.conf` reads as unlimited. */
    contextLimit: string;
    /** Output cap; "" is the provider's own default. */
    maxTokens: string;
    /** The three reasoning blocks as JSON text: "" is no block, and clearing one removes it. */
    reasoning0: string;
    reasoning1: string;
    reasoning2: string;
    /** The response key that carries reasoning text; "" leaves the provider's default. */
    reasoningField: string;
    serialToolCalls: boolean;
    /**
     * Which input modalities the model declares, or `null` for "not declared".
     *
     * Three states, and the form can express all three: `null` writes no `input_modalities` line at all, so
     * the protocol decides what the model is sent; `[]` declares that it takes no media; a list declares
     * exactly that list. `text` is never filtered by AlayaCore — a message is text — so `[]` and `["text"]`
     * are one model, which is why the form has no text box and keeps whatever spelling it was handed.
     */
    inputModalities: string[] | null;
};

/**
 * The media a model can declare, in the order the form offers them.
 *
 * AlayaCore's vocabulary also has `text`, which is deliberately not here: text is never filtered — a message
 * is text, so there is no way to send one without it — which makes `[]` and `["text"]` the same model. A box
 * that changes nothing would say the opposite. A stored `["text"]` is kept as it is, because the form edits
 * only these four words in a list it was handed.
 *
 * `document` is the catch-all: anything that is not image, video or audio, PDF and unrecognized extensions
 * included. See AlayaCore's `docs/configuration.md`, "Input modalities".
 */
export const INPUT_MEDIA = ["image", "video", "audio", "document"] as const;

/**
 * The declaration with one media type switched on or off, in the order the boxes were clicked.
 *
 * Order means nothing to AlayaCore (it is a set), and rebuilding the list instead of sorting it keeps every
 * word this build does not know exactly where it was: a list that arrived is a list a page may not shorten.
 */
export function withModality(list: readonly string[], modality: string, declared: boolean): string[] {
    const kept = list.filter((entry) => entry !== modality);
    return declared ? [...kept, modality] : kept;
}

export const emptyModelDraft: ModelDraft = {
    name: "",
    modelId: "",
    baseUrl: "",
    protocol: "openai",
    apiKey: "",
    contextLimit: "",
    maxTokens: "",
    reasoning0: "",
    reasoning1: "",
    reasoning2: "",
    reasoningField: "",
    serialToolCalls: false,
    inputModalities: null,
};

/** What one model on screen looks like in the form. The key is not known here, so it starts empty. */
export function modelDraftOf(model: AgentModel): ModelDraft {
    return {
        name: model.name,
        modelId: model.modelName ?? "",
        baseUrl: model.baseUrl ?? "",
        protocol: protocolOf(model.protocolType),
        apiKey: "",
        contextLimit: model.contextLimit ? String(model.contextLimit) : "",
        maxTokens: model.maxTokens ? String(model.maxTokens) : "",
        reasoning0: reasoningText(model.reasoning0),
        reasoning1: reasoningText(model.reasoning1),
        reasoning2: reasoningText(model.reasoning2),
        reasoningField: model.reasoningField ?? "",
        serialToolCalls: model.serialToolCalls === true,
        // `??` and not `||`: `[]` is a declaration ("no media") and has to stay one, while undefined and null
        // are the same thing here — a model the protocol decides for.
        inputModalities: model.inputModalities ?? null,
    };
}

/** The JSON a form shows for a block the agent holds, indented for reading; "" when there is none. */
function reasoningText(value: unknown): string {
    if (value === undefined || value === null) return "";
    return JSON.stringify(value, null, 2);
}

/**
 * "" when a block's text is blank or a JSON object, and the translation key of the reason when it is not.
 *
 * The blocks are merged into a request body as they stand, so a string, a number or an array would be a
 * request AlayaCore sends malformed. The server refuses them too (`internal/agent`); this is the same rule
 * where it can be said while the user is typing.
 */
export function reasoningError(text: string): string {
    if (!text.trim()) return "";
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return "config.preferences.modelReasoningNotJson";
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return "config.preferences.modelReasoningNotObject";
    }
    return "";
}

/** The three blocks of a draft, in the order they are shown, with the key each error is rendered under. */
const reasoningFieldsOf = (draft: ModelDraft): Array<{ label: string; text: string }> => [
    { label: "modelReasoning0", text: draft.reasoning0 },
    { label: "modelReasoning1", text: draft.reasoning1 },
    { label: "modelReasoning2", text: draft.reasoning2 },
];

/** The first thing wrong with one of the blocks, as a translation key, or "". */
function draftReasoningError(draft: ModelDraft): string {
    for (const field of reasoningFieldsOf(draft)) {
        const error = reasoningError(field.text);
        if (error) return error;
    }
    return "";
}

/** Whether a draft says enough to be a model: a name to show, the two things a request needs, and JSON that parses. */
export function modelDraftComplete(draft: ModelDraft): boolean {
    return Boolean(draft.name.trim() && draft.modelId.trim() && draft.baseUrl.trim()) && !draftReasoningError(draft);
}

/** What one edit does to the list: a model added after the others, or one changed or removed where it is. */
export type ModelChange = { kind: "add"; draft: ModelDraft } | { kind: "edit"; id: number; draft: ModelDraft } | { kind: "delete"; id: number };

/**
 * The list to send: every model on screen, with one added, changed or removed.
 *
 * No change at all is also a delete, of everything: the list is the file, so what is not in it is gone.
 */
export function modelSyncPayload(models: AgentModel[], change?: ModelChange): AgentModelEdit[] {
    const kept = models.map((model) => entryOf(model));
    if (!change) return kept;
    switch (change.kind) {
        case "add":
            return [...kept, editableOf(change.draft)];
        case "edit":
            return kept.map((entry) => (entry.id === change.id ? { ...entry, ...editableOf(change.draft) } : entry));
        case "delete":
            return kept.filter((entry) => entry.id !== change.id);
    }
}

/** One model the server holds, as this page may describe it back: only what a form would show unchanged. */
function entryOf(model: AgentModel): AgentModelEdit {
    return {
        id: model.id,
        name: model.name,
        protocol_type: protocolOf(model.protocolType),
        base_url: model.baseUrl ?? "",
        model_name: model.modelName ?? "",
    };
}

/** The fields the form owns. The key is one of them only when there is one to send. */
function editableOf(draft: ModelDraft): AgentModelEdit {
    const entry: AgentModelEdit = {
        name: draft.name.trim(),
        protocol_type: draft.protocol,
        base_url: draft.baseUrl.trim(),
        model_name: draft.modelId.trim(),
        context_limit: count(draft.contextLimit),
        max_tokens: count(draft.maxTokens),
        // `null` is an answer — the box was cleared — and absent is not (`entryOf` sends no blocks at all).
        reasoning_0: reasoningValue(draft.reasoning0),
        reasoning_1: reasoningValue(draft.reasoning1),
        reasoning_2: reasoningValue(draft.reasoning2),
        serial_tool_calls: draft.serialToolCalls,
        // Always sent, `null` included: a switch turned off is an answer ("no line in model.conf"), and a
        // field left out would keep the stored declaration instead — the opposite of what was chosen.
        input_modalities: draft.inputModalities,
    };
    // A field left empty says nothing rather than "no field": the provider's default is the absence.
    const reasoningField = draft.reasoningField.trim();
    if (reasoningField) entry.reasoning_field = reasoningField;
    // An empty key is no answer, not an empty key: the field is how a stored key is kept.
    const key = draft.apiKey.trim();
    if (key) entry.api_key = key;
    return entry;
}

/** A count as typed, or 0 — which is what `model.conf` writes for "not set". */
function count(text: string): number {
    const value = Number(text.trim());
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** A reasoning block as JSON, or `null` for a cleared one. `modelDraftComplete` has already checked it parses. */
function reasoningValue(text: string): unknown {
    return text.trim() ? JSON.parse(text) : null;
}

/** The protocol, by the two names AlayaCore knows. Anything else is the one every provider speaks. */
function protocolOf(protocol: string | undefined): ModelProtocol {
    return protocol === "anthropic" ? "anthropic" : "openai";
}
