import { create } from "zustand";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { serverModelLabel } from "@/lib/server-labels";
import { LOCAL_SERVER_BASE_URL, LOCAL_SERVER_CHANNEL_ID } from "@/constant/app-mode";
import { mirrorToSettings, readSetting } from "@/stores/use-settings-store";

export type ModelCapability = "image" | "video" | "text" | "audio";

/** How much of one media kind a workflow takes; `max: 0` means it takes none. */
export type ModelAccepts = {
    images?: { min: number; max: number };
    videos?: { min: number; max: number };
    audios?: { min: number; max: number };
    minTotal: number;
};

/** One knob a workflow declares, as far as a node panel renders it. */
export type ModelParameter = {
    key: string;
    label?: string;
    type?: string;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
};

/** One mode's media contract. */
type ModelContract = {
    accepts?: ModelAccepts;
    mode?: string;
    /** The keys a run of this mode may carry. */
    inputs?: string[];
};

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    label?: string;
    workflowId?: string;
    baseModel?: string;
    baseModelLabel?: string;
    variantModes?: string[];
    /** Modes the server reports as blocked: they would fail inside ComfyUI, so they are not offered. */
    blockedModes?: string[];
    variantLabels?: Record<string, string>;
    imageInputs?: number;
    /**
     * The range the workflow declares for its output length, if it declares one (a music workflow does;
     * a text-to-image one has nothing to say). Absent means the node offers no duration control — and the
     * request sends none, so the workflow's own binding default answers.
     */
    duration?: { min: number; max: number };
    /**
     * The workflow is an action the canvas also has a button for (interpolate, upscale, angle). It is
     * offered in a node's model list — that is how a node can *be* an interpolation — but never as the
     * default model for new nodes: a default has to run from a prompt, and a tool takes a clip.
     */
    tool?: boolean;
    /**
     * Whether the workflow has a `prompt` binding. An interpolation has nothing to be told, so its node
     * shows no prompt box and the request carries no prompt.
     */
    hasPrompt?: boolean;
    /**
     * Whether the user's seconds reach the graph: true when a binding reads `seconds`, false when none
     * does (the length then comes from the clip being edited, or from the binding's own default), and
     * absent when the model is not one the server listed — in which case the canvas knows nothing about
     * its bindings and must not claim either answer.
     */
    bindsSeconds?: boolean;
    /**
     * Whether the workflow declares the `transition_step` knob — the input the SelfLift fast/quality
     * toggle writes. A workflow without it is offered no toggle, because the value would be ignored.
     */
    selfLift?: boolean;
    /** The mode the workflow runs in, as it declares it (`text` / `frames` / `reference`). */
    mode?: string;
    /** What it accepts in that mode. */
    accepts?: ModelAccepts;
    /**
     * The keys a run may carry: the request's own semantic keys, the parameters the workflow declares, and
     * the bindings it addresses by their own name. A stored knob that is not here belongs to another model,
     * and sending it fails the run (docs/decisions.md #274).
     */
    inputs?: string[];
    /** Per-mode contracts, for a workflow that offers several (`t2i`, `edit`, `inpaint`, `outpaint`). */
    contracts?: Record<string, ModelContract>;
    /**
     * The knobs the workflow declares (`multiplier`, `upscale_model`), for a node whose panel renders them
     * from data rather than from a list of names. Bounds and option lists come from the same declaration
     * the server validates against, so a control cannot offer a value a run would refuse.
     */
    parameters?: ModelParameter[];
};

type ModelChannel = {
    id: string;
    /** The stored name: a user-typed one, or a snapshot of the translated default. */
    name: string;
    /**
     * The translation key a generated name came from. Present only until the user renames the channel; while
     * it is, the name is rendered in the reader's language — a channel saved on a Chinese machine reads
     * "Local ComfyUI" on an English one. A stored name is data, so the key drives the display and the snapshot
     * stays for whatever needs a string now.
     */
    nameKey?: string;
    baseUrl: string;
    models: ChannelModel[];
};

export type AiConfig = {
    baseUrl: string;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioFormat: string;
    /** How many seconds of audio the run may produce, for a workflow that declares a range. */
    audioSeconds: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    videoSelfLiftMode?: string;
    frameMode?: "first" | "last" | "both";
    imageMode?: string;
    outpaint?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    layout?: { summary: string; regions: Array<{ id: string; label: "object" | "character" | "text"; caption: string; text?: string; x: number; y: number; width: number; height: number }>; width?: number; height?: number };
    systemPrompt: string;
    models: string[];
    quality: string;
    size: string;
    background: string;
    autoFocusOnSelect: boolean;
    seed?: string;
    seedFixed?: string;
    params?: Record<string, unknown>;
};

const CHANNEL_MODEL_SEPARATOR = "::";
const localDefaultChannel: ModelChannel = {
    id: LOCAL_SERVER_CHANNEL_ID,
    name: i18n.t("config.channels.localName"),
    nameKey: "config.channels.localName",
    baseUrl: LOCAL_SERVER_BASE_URL,
    models: [],
};

// One literal, no shared base to override: this build only ever talks to the
// local server, so a second default config would be dead weight that has to be kept
// in sync field by field.
export const defaultConfig: AiConfig = {
    baseUrl: LOCAL_SERVER_BASE_URL,
    channels: [localDefaultChannel],
    // No workflow id is baked in as the default: the first image/video workflow the server reports
    // becomes the selection (see `pickModel` below), so adding or renaming a workflow in the registry
    // never leaves the canvas pointing at a model that is gone.
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    audioFormat: "mp3",
    // A music workflow's own default (60 s, the value its binding writes when the request says nothing),
    // so the control opens showing the length the first run will actually ask for.
    audioSeconds: "60",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    // Local workflows are driven by a start frame, not by free text.
    videoMode: "text",
    videoSelfLiftMode: "fast",
    systemPrompt: "",
    models: [],
    quality: "auto",
    size: "1:1",
    background: "",
    autoFocusOnSelect: false,
};

type ConfigStore = {
    config: AiConfig;
    /**
     * The two floating windows over the canvas that read this config each keep their own flag: they are
     * separate windows (`preferences-dialog.tsx`, `workflows-dialog.tsx`), opened from separate buttons.
     */
    preferencesOpen: boolean;
    workflowsOpen: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openPreferences: () => void;
    openWorkflows: () => void;
    setPreferencesOpen: (open: boolean) => void;
    setWorkflowsOpen: (open: boolean) => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo"];

const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/**
 * Best-effort capability for a bare model name.
 *
 * Only a stored config that predates `ChannelModel` can contain one: everything the canvas writes
 * today is an object with a capability, and the server reports the kind itself (`type`). It stays as
 * the fallback for that legacy shape rather than dropping the model.
 */
function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        // In local mode a model that has disappeared from the registry falls back to the default for its capability.
        if (!configuredCapability) continue;
        // Keep unavailable selections visible so the readiness check blocks the
        // request. Only a known capability switch may choose another model.
        if (!configuredCapability || configuredCapability === capability) return model;
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

function channelModelEntries(config: AiConfig) {
    return config.channels.flatMap((channel) => channel.models.map((model) => ({ channel, model, value: encodeChannelModel(channel.id, model.name) })));
}

export function channelModelOf(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    for (const channel of config.channels) {
        if (decoded && channel.id !== decoded.channelId) continue;
        const model = channel.models.find((item) => item.name === name);
        if (model) return { channel, model };
    }
    return null;
}

/** Top-level dropdown: grouped by workflow, base-model entries only; falls back to a flat list without grouping metadata. */
export function workflowModelOptions(config: AiConfig, capability?: ModelCapability) {
    const entries = channelModelEntries(config);
    if (!entries.some((entry) => entry.model.workflowId)) return selectableModelsByCapability(config, capability);
    return entries.filter((entry) => entry.model.workflowId && !entry.model.baseModel && (!capability || entry.model.capability === capability)).map((entry) => entry.value);
}

/**
 * The models a *default* may be picked from.
 *
 * A tool (an interpolation, an upscaler, an angle re-render) is offered in a node's model list, because
 * that is how a node can be one — but it cannot be what a fresh node starts on: it takes a clip or a
 * picture and has nothing to be asked, so a default pointing at it would break every new node.
 */
export function defaultModelOptions(config: AiConfig, capability?: ModelCapability) {
    return workflowModelOptions(config, capability).filter((value) => !channelModelOf(config, value)?.model.tool);
}

/**
 * What a workflow accepts, in the mode it is about to run in.
 *
 * A workflow with variants runs one of them (inpaint wants a source and a mask; t2i wants none), so the
 * mode's own contract answers first and the workflow's is the fallback — the same precedence
 * `ResolveForMode` applies before a run is validated, so the panel cannot promise something the server
 * refuses.
 */
export function modelContractOf(config: AiConfig, value: string, mode?: string): ModelContract | undefined {
    const model = channelModelOf(config, value)?.model;
    if (!model) return undefined;
    const declared = mode ? model.contracts?.[mode] : undefined;
    const accepts = declared?.accepts ?? model.accepts;
    const resolvedMode = declared?.mode ?? model.mode;
    const inputs = declared?.inputs ?? model.inputs;
    if (!accepts && !resolvedMode && !inputs) return undefined;
    return { accepts, mode: resolvedMode, inputs };
}

/**
 * Whether a run of this model may carry `key` — the three-state answer a control needs.
 *
 * `undefined` means the workflow listed no inputs at all (a model the server did not describe, or an older
 * stored config), and nothing is claimed: the control stays where it was. `false` means the contract does not
 * list the key, so a control that writes it would set a value the run never reads — the "点了没反应" failure,
 * seen from the other end. This is `acceptedInputs` asked one step earlier, of one key, so a control and the
 * request cannot disagree (#304).
 */
export function acceptsInput(config: AiConfig, value: string, key: string, mode?: string) {
    const inputs = modelContractOf(config, value, mode)?.inputs;
    if (!inputs) return undefined;
    return inputs.includes(key);
}

/**
 * A request's keys, minus the ones the workflow that will run it does not read.
 *
 * This covers every key a run carries, not only `params`: `size`, `quality`, `seconds`, `mode` and the rest are
 * the engine's, and each is accepted only where the workflow declares what reads it (#302). The answer comes from
 * the same list the server validates against, so what the canvas sends and what a run accepts cannot disagree.
 *
 * A node keeps its `params` when the model under it changes — a knob belongs to the model that declared it,
 * not to the node — so a value from a previous model travelled with the request and was refused as
 * `unknown_input`, failing a run for a field nobody typed (docs/decisions.md #274). The answer comes from the
 * same list the server validates against, so what the canvas sends and what a run accepts cannot disagree.
 *
 * A model that declares nothing is left alone: nothing is claimed about it, which is the three-state reading
 * every other acceptance gets. `mode` is the mode the run will resolve to, since a variant takes its own keys.
 */
export function acceptedInputs(config: AiConfig, value: string, params: Record<string, unknown> | undefined, mode?: string) {
    if (!params) return undefined;
    const accepted = modelContractOf(config, value, mode)?.inputs;
    if (!accepted) return params;
    const kept: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(params)) {
        if (accepted.includes(key)) kept[key] = item;
    }
    return Object.keys(kept).length ? kept : undefined;
}

/** Whether a workflow can be asked something in words. Unknown (an older stored config) means yes. */
export function modelTakesPrompt(config: AiConfig, value: string) {
    return channelModelOf(config, value)?.model.hasPrompt !== false;
}

/**
 * Whether the canvas runs this model as a step: a workflow a button drives (an interpolation, an upscaler,
 * an angle re-render) or one with nothing to be told in words.
 *
 * A step gets the step panel and submits the step request — words or knobs, never a prompt-shaped run. The
 * two halves are one predicate because they must agree: a model that the panel treats as a step but the
 * request sends as a from-prompt run is a node whose knobs are never sent, which is what happened to the
 * angle workflow while its `prompt` binding made it look like a composer model (#267).
 *
 * `modelTakesPrompt` answers a different question and stays: whether that step has a text box at all.
 */
export function modelIsStep(config: AiConfig, value: string) {
    const model = channelModelOf(config, value)?.model;
    return Boolean(model?.tool) || model?.hasPrompt === false;
}

/** The base-model entry of the workflow the current model belongs to, used to echo the top-level dropdown. */
export function workflowModelValue(config: AiConfig, value: string) {
    const found = channelModelOf(config, value);
    if (!found?.model.workflowId) return value;
    const base = found.channel.models.find((model) => model.workflowId === found.model.workflowId && !model.baseModel);
    return base ? encodeChannelModel(found.channel.id, base.name) : value;
}

/**
 * The model entry a workflow answers to, spelled the way the picker spells it — or `""` when the list has
 * none.
 *
 * The canvas names a workflow when it drives one from a button (`tool-workflows.ts`), but a node records a
 * *model*: that is the field the panel, the request builder and the agent read. This is the only place an id
 * becomes that value, so a node a button created and a node whose model was picked cannot disagree about what
 * they are. A workflow the list does not offer answers nothing, because the bare id is not a model — writing
 * it would leave the node naming something no other code can resolve, which is the fallback that made an
 * interpolation node show itself as text-to-video (#263).
 *
 * The first channel that offers it wins, which is the order a run resolves an id in.
 */
export function modelForWorkflow(config: AiConfig, workflowId: string) {
    const id = workflowId.trim();
    if (!id) return "";
    for (const channel of config.channels) {
        const model = channel.models.find((item) => item.workflowId === id && !item.baseModel);
        if (model) return encodeChannelModel(channel.id, model.name);
    }
    return "";
}

/** Second-level dropdown: the workflow's default base model plus every variant. */
export function baseModelOptions(config: AiConfig, value: string) {
    const found = channelModelOf(config, value);
    const workflowId = found?.model.workflowId;
    if (!found || !workflowId) return [];
    return found.channel.models
        .filter((model) => model.workflowId === workflowId)
        .map((model) => ({
            value: encodeChannelModel(found.channel.id, model.name),
            label: serverModelLabel(model.name, model.baseModelLabel || model.label || model.name),
            isDefault: !model.baseModel,
            name: model.name,
        }));
}

export function modelImageInputs(config: AiConfig, value: string) {
    const found = channelModelOf(config, value);
    return typeof found?.model.imageInputs === "number" ? found.model.imageInputs : undefined;
}

function isAiConfigReady(config: AiConfig, model: string) {
    const match = findChannelModel(config, model);
    return Boolean(match && match.channel.baseUrl.trim());
}

/**
 * Bring a stored config up to the shape this build expects.
 *
 * The stored document is whatever the last build wrote, so every field is re-derived rather than
 * trusted: channels are rebuilt from their ids and models, the model selections are re-picked from
 * what those channels actually offer, and the enums fall back to their defaults. The alternative is a
 * canvas pointing at a model that the server stopped reporting, which looks like a broken button.
 */
function hydrateConfig(stored: Partial<AiConfig>): AiConfig {
    // The server's address is never taken from the document, only from the page (#241). A stored address is
    // a memory of where the server used to be: the canvas is served by the server it talks to (#219), so a
    // page that moved — a different port, a different host, a phone on the LAN — was otherwise left pointing
    // every request, and the agent's socket, at the address it itself had just stopped living at.
    const config = { ...defaultConfig, ...stored, baseUrl: defaultBaseUrl() };
    // Two fields this document used to carry: where the speech server listened and what it called its model. The
    // list is the server's now, one profile per server (#252), so a stored copy is a second and already dead
    // answer to where audio goes — and the mirror would keep writing it back to every browser.
    delete (config as { asrUrl?: unknown }).asrUrl;
    delete (config as { asrModel?: unknown }).asrModel;
    if (!Array.isArray(stored.channels)) config.channels = [];
    const channels = normalizeChannels(config);
    const models = modelOptionsFromChannels(channels);
    // A *default* is picked from the entries a fresh node can start on: a tool (an upscaler, an
    // interpolation) takes a picture or a clip and has nothing to be asked, so it is never the answer to
    // "which model does a new image node use" — it is only ever set on a node deliberately.
    const defaultsFor = (capability: ModelCapability) => channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability && !model.tool).map((model) => encodeChannelModel(channel.id, model.name)));
    const imageOptions = defaultsFor("image");
    const videoOptions = defaultsFor("video");
    const audioOptions = defaultsFor("audio");
    const pickModel = (current: string, options: string[]) => (options.includes(current) ? current : options[0] || "");
    return {
        ...config,
        model: pickModel(config.model || config.imageModel, imageOptions),
        channels,
        models,
        imageModel: pickModel(config.imageModel || config.model, imageOptions),
        videoModel: pickModel(config.videoModel, videoOptions),
        textModel: "",
        audioModel: pickModel(config.audioModel, audioOptions),
        audioFormat: config.audioFormat || defaultConfig.audioFormat,
        audioSeconds: config.audioSeconds || defaultConfig.audioSeconds,
        audioInstructions: config.audioInstructions || "",
        videoSeconds: config.videoSeconds || "6",
        vquality: config.vquality || "720",
        videoGenerateAudio: config.videoGenerateAudio || "true",
        videoWatermark: config.videoWatermark || "false",
        videoMode: config.videoMode === "reference" || config.videoMode === "text" ? config.videoMode : "frames",
        videoSelfLiftMode: config.videoSelfLiftMode === "quality" ? "quality" : "fast",
        autoFocusOnSelect: Boolean(config.autoFocusOnSelect),
    };
}

export const useConfigStore = create<ConfigStore>()((set) => ({
    config: hydrateConfig(readSetting<Partial<AiConfig>>("config", {})),
    preferencesOpen: false,
    workflowsOpen: false,
    updateConfig: (key, value) =>
        set((state) => ({
            config: {
                ...state.config,
                [key]: value,
            },
        })),
    isAiConfigReady: (config, model) => isAiConfigReady(config, model),
    openPreferences: () => set({ preferencesOpen: true }),
    openWorkflows: () => set({ workflowsOpen: true }),
    setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
    setWorkflowsOpen: (workflowsOpen) => set({ workflowsOpen }),
}));

// The channel name and the model selections are a preference: they are the same on the phone in the next
// room, and they survive a cleared browser.
mirrorToSettings(useConfigStore, "config", (state) => state.config);

/**
 * The config every caller should read.
 *
 * It used to be a copy with `channelMode` forced to "local", because a cloud mode
 * still existed and could have set it. With cloud mode deleted the field was always
 * "local", so there is nothing left to force and this is the stored config itself.
 */
export function useEffectiveConfig() {
    return useConfigStore((state) => state.config);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const label = typeof item === "string" ? undefined : item.label?.trim() || undefined;
        const workflowId = typeof item === "string" ? undefined : item.workflowId?.trim() || undefined;
        const baseModel = typeof item === "string" ? undefined : item.baseModel?.trim() || undefined;
        const baseModelLabel = typeof item === "string" ? undefined : item.baseModelLabel?.trim() || undefined;
        const variantModes = typeof item === "string" ? undefined : Array.isArray(item.variantModes) ? item.variantModes.map((mode) => String(mode).trim()).filter(Boolean) : undefined;
        const blockedModes = typeof item === "string" ? undefined : Array.isArray(item.blockedModes) ? item.blockedModes.map((mode) => String(mode).trim()).filter(Boolean) : undefined;
        const variantLabels = typeof item === "string" ? undefined : item.variantLabels && typeof item.variantLabels === "object" ? item.variantLabels : undefined;
        const imageInputs = typeof item === "string" ? undefined : typeof item.imageInputs === "number" ? item.imageInputs : undefined;
        const duration = typeof item !== "string" && item.duration && Number.isFinite(item.duration.min) && Number.isFinite(item.duration.max) && item.duration.max > item.duration.min ? { min: item.duration.min, max: item.duration.max } : undefined;
        // The contract is the server's declaration, echoed: rebuilt rather than trusted so a stored
        // document from an older build cannot smuggle a shape the panel would misread.
        const tool = typeof item === "string" ? undefined : item.tool === true ? true : undefined;
        const hasPrompt = typeof item === "string" ? undefined : typeof item.hasPrompt === "boolean" ? item.hasPrompt : undefined;
        const bindsSeconds = typeof item === "string" ? undefined : typeof item.bindsSeconds === "boolean" ? item.bindsSeconds : undefined;
        const selfLift = typeof item === "string" ? undefined : item.selfLift === true ? true : undefined;
        const mode = typeof item === "string" ? undefined : item.mode?.trim() || undefined;
        const accepts = typeof item === "string" ? undefined : normalizeAccepts(item.accepts);
        const inputs = typeof item === "string" ? undefined : normalizeInputs(item.inputs);
        const contracts = typeof item === "string" ? undefined : normalizeContracts(item.contracts);
        const parameters = typeof item === "string" ? undefined : normalizeParameters(item.parameters);
        result.push({ name, capability, label, workflowId, baseModel, baseModelLabel, variantModes, variantLabels, blockedModes, imageInputs, duration, tool, hasPrompt, bindsSeconds, selfLift, mode, accepts, inputs, contracts, parameters });
    }
    return result;
}

function normalizeParameters(value: Array<{ key?: string; label?: string; type?: string; default?: unknown; min?: number; max?: number; step?: number; options?: unknown }> | undefined) {
    if (!Array.isArray(value)) return undefined;
    const parameters = value
        .filter((item) => item && typeof item.key === "string" && item.key.trim())
        .map((item) => ({
            key: String(item.key).trim(),
            label: item.label?.trim() || undefined,
            type: item.type?.trim() || undefined,
            default: item.default,
            min: Number.isFinite(item.min) ? Number(item.min) : undefined,
            max: Number.isFinite(item.max) ? Number(item.max) : undefined,
            step: Number.isFinite(item.step) ? Number(item.step) : undefined,
            options: Array.isArray(item.options) ? item.options.map((option) => (typeof option === "string" ? option : String((option as { value?: unknown })?.value ?? ""))).filter(Boolean) : undefined,
        }));
    return parameters.length ? parameters : undefined;
}

function normalizeLimit(value: { min?: number; max?: number } | undefined) {
    if (!value) return undefined;
    const min = Number(value.min) || 0;
    const max = Number(value.max) || 0;
    return { min, max };
}

function normalizeAccepts(value: { images?: { min?: number; max?: number }; videos?: { min?: number; max?: number }; audios?: { min?: number; max?: number }; minTotal?: number } | undefined) {
    if (!value) return undefined;
    const images = normalizeLimit(value.images);
    const videos = normalizeLimit(value.videos);
    const audios = normalizeLimit(value.audios);
    const minTotal = Number(value.minTotal) || 0;
    if (!images && !videos && !audios && !minTotal) return undefined;
    return { images, videos, audios, minTotal };
}

function normalizeContracts(
    value: Record<string, { accepts?: { images?: { min?: number; max?: number }; videos?: { min?: number; max?: number }; audios?: { min?: number; max?: number }; minTotal?: number }; mode?: string; inputs?: string[] }> | undefined,
) {
    if (!value || typeof value !== "object") return undefined;
    const contracts: Record<string, { accepts?: ReturnType<typeof normalizeAccepts>; mode?: string; inputs?: string[] }> = {};
    for (const [mode, contract] of Object.entries(value)) {
        const trimmed = String(mode).trim();
        if (!trimmed || !contract || typeof contract !== "object") continue;
        contracts[trimmed] = { accepts: normalizeAccepts(contract.accepts), mode: contract.mode?.trim() || undefined, inputs: normalizeInputs(contract.inputs) };
    }
    return Object.keys(contracts).length ? contracts : undefined;
}

/** The keys a run may carry, rebuilt rather than trusted, so a stored document cannot smuggle a shape. */
function normalizeInputs(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    const keys = value.filter((key): key is string => typeof key === "string" && Boolean(key.trim())).map((key) => key.trim());
    return keys.length ? keys : undefined;
}

/**
 * The channel name to render.
 *
 * Same rule as a node title: a key wins, so a channel created in the Chinese UI does not appear under its
 * Chinese name in the English one. A name the user typed has no key and is shown as typed.
 */
function channelName(channel: Pick<ModelChannel, "name" | "nameKey">) {
    return channel.nameKey ? i18n.t(channel.nameKey) : channel.name;
}

/**
 * The key a stored channel name was rendered from, when it was one of the app's own defaults.
 *
 * Read from both dictionaries: the stored snapshot came from whichever language was active when the
 * channel was created.
 */
function defaultChannelNameKey(name: string): string | undefined {
    const value = name.trim();
    if (!value) return undefined;
    for (const language of ["zh-CN", "en-US"] as const) {
        // The language is named on every call rather than taken from the active one: the stored snapshot could
        // have been written in either language, and this has to recognise both.
        if (i18n.t("config.channels.localName", { lng: language }) === value) return "config.channels.localName";
    }
    return undefined;
}

function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const name = channel?.name?.trim() || "";
    return {
        id: channel?.id?.trim() || nanoid(),
        name: name || i18n.t("config.channels.newName"),
        // Same rule as the document's own: the address is the page's, not the stored one (#241).
        baseUrl: defaultBaseUrl(),
        // An older config stored the translated default; adopt the key so the name follows the language.
        nameKey: channel?.nameKey || defaultChannelNameKey(name) || undefined,
        models: normalizeChannelModels(channel?.models),
    };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    const model = channel?.models.find((item) => item.name === decoded.model);
    // The label arrives in English from the server registry; the dictionary supplies the
    // Chinese one, keyed by the model id, and the server text is the fallback.
    const label = serverModelLabel(decoded.model, model?.label);
    if (label !== decoded.model) return label;
    return channel ? i18n.t("settingsPanels.model.withChannel", { model: decoded.model, channel: channelName(channel) }) : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return (
        matched ||
        config.channels[0] ||
        createModelChannel({
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: config.baseUrl,
            models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })),
        })
    );
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

/** Every channel in this build points at the local server; there is no cloud default. */
function defaultBaseUrl() {
    return LOCAL_SERVER_BASE_URL;
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}
