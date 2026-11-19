import { audioFormatOptions } from "@/lib/audio-generation";
import type { ModelAccepts } from "@/stores/use-config-store";
import { computeVideoSize, inferVideoRatio, parseVideoResolution, planStatedSize, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

/**
 * The settings that decide what a node's next run produces, and the one function that turns what a caller
 * said into the fields the node's own panel writes.
 *
 * The panel knows these as rows and switches: a size in two boxes, a transparent background, a fixed seed, a
 * slider for the length, a container for a sound, the workflow's own knobs. An agent had none of them — it
 * could write a prompt and press generate, but not say how big the picture should be or how long the clip —
 * so "a 16:9 hero shot, five seconds, seed 42" was a sentence it could not act on.
 *
 * This is not a second vocabulary. Every setting is the *request's* key (`size`, `seconds`, `background`,
 * `seed`, `format`, `lyrics`, and the knobs a workflow declares), the value is checked by the functions the
 * panel and the request already use (`planStatedSize`, the length bounds, the container list), and whether a
 * key means anything at all is asked of the published contract — the three-state answer #304 gave the panel's
 * rows. A setting the run would drop is refused here, with the list of what it does read, rather than written
 * into a node and silently ignored.
 *
 * What is deliberately not here: what *runs* (`model`, the Qwen `t2i`/`edit`/`inpaint`/`outpaint` mode), the
 * LoRA stack, the MOSS layout, and masks, crops and outpaints. Those decide which run this is rather than its
 * shape, and each has its own tool or its own editor (docs/decisions.md #309).
 *
 * `frameMode` is here for the opposite reason: it is the request's own key (`inputs.frameMode`), declared by
 * every workflow that takes frames, and it does not decide *which* run this is — a frames workflow is chosen
 * by its mode. It was reachable only as `params.frameMode`, which did reach the request but not the node, so
 * the panel's pill and `read_node` never saw it (#324).
 */

/** What a caller may state, under the request's names. */
export type NodeSettings = {
    size?: unknown;
    quality?: unknown;
    seconds?: unknown;
    background?: unknown;
    seed?: unknown;
    format?: unknown;
    instructions?: unknown;
    /** Which frames the connected pictures are, on a film that takes them: the first, the last, or both. */
    frameMode?: unknown;
    params?: unknown;
};

/**
 * What the node's model publishes about its next run — every fact the tools read off a node's workflow.
 *
 * One hand for all of them, because they come from one projection: the keys a run accepts (`set_node`
 * refuses a key outside it), the media it takes (`read_prompt` states what is connected against it), a sound's
 * declared length, and a film's quality tier.
 */
export type SettingsContract = {
    /** The contract's `inputs`: the keys a run may carry, or undefined when the model publishes none. */
    accepts?: string[];
    /** How much media a run of this node's mode takes. */
    media?: ModelAccepts;
    /** A sound's declared length, the bound `clampAudioSeconds` clamps to. */
    duration?: { min: number; max: number };
    /** The quality tier a film is made at: a film's pixels are *derived* from this and its shape. */
    tier?: string;
};

type SettingsPlan = { ok: true; patch: CanvasNodeMetadata; written: string[] } | { ok: false; reason: string };

/** The kinds of node that hold a run's settings. A text card is words, a group holds nodes, a LoRA a stack. */
const SETTING_KINDS: string[] = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

/** The kinds that keep the workflow's own knobs. A sound's request carries no knob bag at all. */
const KINDS_WITH_PARAMS: string[] = [CanvasNodeType.Image, CanvasNodeType.Video];

/** One setting: the field it writes, the request key that makes it mean anything, and how its value is read. */
type Field = {
    name: keyof NodeSettings;
    /** The metadata field the panel writes. */
    field: keyof CanvasNodeMetadata;
    /** The request key this setting reaches — what the contract has to list. */
    key: string;
    read: (value: unknown) => { value: string } | { reason: string };
};

/**
 * The knobs a call may not name, and why each has an owner elsewhere.
 *
 * `loras` is filled in at press time from the LoRA nodes wired into this one, so a value here is replaced
 * before the run. `layout` is the MOSS editor's region list and travels only when the node's own mode says so,
 * so a value written here would be a picture with no layout behind it.
 */
const RESERVED_PARAMS: Record<string, string> = {
    loras: "the LoRA stack comes from the LoRA nodes connected to this one, so a value here would be replaced before the run",
    layout: "a MOSS layout is drawn in its own editor, and only a node set to that mode sends one",
    layoutEnabled: "a MOSS layout is drawn in its own editor, and only a node set to that mode sends one",
};

const text = (value: unknown) => (typeof value === "string" ? { value } : { reason: "needs a string" });

/** A size in pixels, aligned the way the request aligns it, or the reason a run could not take it. */
const size: Field["read"] = (value) => {
    if (typeof value !== "string") return { reason: "needs a string like 1360x768, or auto" };
    const planned = planStatedSize(value);
    if (planned.kind === "pixels") return { value: planned.size };
    if (planned.kind === "auto") return { value: "auto" };
    if (planned.kind === "ratio") return { reason: `${planned.ratio} is a shape, not a size: state the pixels, like 1360x768 for a 16:9 picture` };
    if (planned.problem === "format") return { reason: `${value} is not a size: state WxH, like 1360x768, or auto` };
    if (planned.problem === "edge") return { reason: `${value} is too large: the longest side is 3840 px` };
    if (planned.problem === "ratio") return { reason: `${value} is too lopsided: the longest side may be at most three times the shortest` };
    if (planned.problem === "pixels") return { reason: `${value} is outside what a picture may be: 655360 to 8294400 pixels in total` };
    if (planned.problem === "step") return { reason: `${value} is not a size this canvas renders: both sides are multiples of 16` };
    return { reason: `${value} is not a size: state two positive sides, like 1024x1024` };
};

const background: Field["read"] = (value) => {
    if (typeof value !== "string") return { reason: 'needs "transparent", or "" for the picture\'s own background' };
    const normalized = value.trim().toLowerCase();
    if (!normalized) return { value: "" };
    if (normalized !== "transparent") return { reason: `${value} is not a background: "transparent" and "" are the two a run can be told` };
    return { value: "transparent" };
};

/**
 * A fixed seed, or "random" to leave it to the graph.
 *
 * A seed travels only when the node also says it is fixed — `buildGenerationConfig` drops it otherwise — so
 * this writes the pair, which is what the panel's switch and its box do between them.
 */
const seed: Field["read"] = (value) => {
    if (value === "" || value === null || (typeof value === "string" && value.trim().toLowerCase() === "random")) return { value: "" };
    const digits = String(value).trim();
    if (!/^\d+$/.test(digits)) return { reason: `${String(value)} is not a seed: state a whole number, or "random"` };
    const number = Number(digits);
    if (number < 1 || number > 2147483647) return { reason: `${digits} is outside the seeds a graph takes: 1 to 2147483647` };
    return { value: digits };
};

/**
 * A film's size, which is not the number a run is given: the pixels are derived from the quality tier and the
 * shape at submit (`planRunShape`), so pixels are a *shape* here and the tier is what says how big it is.
 *
 * A stated size that disagrees with what the tier would make is refused, with the number the tier does make —
 * the same refusal-not-clamp rule as a contradictory resize (#270), and the reason `quality` exists as a
 * setting of its own: a 720p node cannot be asked for 1080p pixels, it can be asked for 1080p.
 */
const videoSize =
    (tier: string): Field["read"] =>
    (value) => {
        if (typeof value !== "string") return { reason: "needs a string like 1280x720, or auto" };
        const trimmed = value.trim();
        if (!trimmed || trimmed.toLowerCase() === "auto") return { value: "auto" };
        const named = videoRatioOptions.some((option) => option.value === trimmed);
        if (!named && !/^\d+x\d+$/i.test(trimmed)) return { reason: `${value} is not a size: state WxH, like 1280x720, or auto` };
        const ratio = inferVideoRatio(trimmed);
        const made = computeVideoSize(tier, ratio === "auto" ? "16:9" : ratio);
        if (!named && made !== trimmed) {
            return { reason: `${trimmed} is a ${ratio} shape, and this node is set to ${tier}p, which makes ${made} of it: state ${made}, or set quality to the tier you mean` };
        }
        return { value: made };
    };

/** The quality tier a film is made at: whole pixels of short side, the number the panel's own pills write. */
const quality: Field["read"] = (value) => {
    const digits = String(value).trim().replace(/p$/i, "");
    if (!/^\d+$/.test(digits)) return { reason: `${String(value)} is not a quality: state a tier like 720 or 1080` };
    const tier = parseVideoResolution(digits);
    if (!Number(digits) || Number(digits) < 240 || Number(digits) > 4320) return { reason: `${digits}p is outside the tiers a clip may be made at: 240 to 4320` };
    return { value: tier };
};

/** A length, refused outside the bounds the panel's own control offers rather than clamped into them. */
const secondsBetween =
    (min: number, max: number): Field["read"] =>
    (value) => {
        const number = typeof value === "number" ? value : Number(String(value).trim());
        if (!Number.isFinite(number)) return { reason: `${String(value)} is not a length: state whole seconds` };
        const whole = Math.round(number);
        if (whole < min || whole > max) return { reason: `${whole} s is outside the lengths this workflow declares: ${min} to ${max} s` };
        return { value: String(whole) };
    };

/**
 * Which of the connected pictures is the first frame and which the last.
 *
 * A workflow declares how many pictures it takes; this says what they mean, and it is the difference between
 * "continue from this frame" and "end on it". The value is the request's own (`first`, `last`, `both`), and a
 * film that takes frames reads it — so a workflow that declares no frames refuses it, with the list of the
 * keys it does read.
 */
const frameMode: Field["read"] = (value) => {
    if (typeof value !== "string") return { reason: 'needs "first", "last" or "both"' };
    const normalized = value.trim().toLowerCase();
    if (normalized === "first" || normalized === "last" || normalized === "both") return { value: normalized };
    return { reason: `${value} is not a frame mode: a run takes its pictures as "first", "last", or "both"` };
};

const format: Field["read"] = (value) => {
    if (typeof value !== "string") return { reason: "needs a container, like mp3 or wav" };
    const found = audioFormatOptions.find((option) => option.value === value.trim().toLowerCase());
    if (!found) return { reason: `${value} is not a container this canvas writes: ${audioFormatOptions.map((option) => option.value).join(", ")}` };
    return { value: found.value };
};

/** The settings each kind keeps. A kind's list is the whole of what it may be told, and its refusals quote it. */
function fieldsFor(kind: string, contract: SettingsContract): Field[] {
    if (kind === CanvasNodeType.Image) {
        return [
            { name: "size", field: "size", key: "size", read: size },
            { name: "background", field: "background", key: "background", read: background },
            { name: "seed", field: "seed", key: "seed", read: seed },
        ];
    }
    if (kind === CanvasNodeType.Video) {
        return [
            { name: "size", field: "size", key: "size", read: videoSize(contract.tier ? parseVideoResolution(contract.tier) : "720") },
            { name: "quality", field: "vquality", key: "", read: quality },
            { name: "seconds", field: "seconds", key: "seconds", read: secondsBetween(VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX) },
            { name: "frameMode", field: "frameMode", key: "frameMode", read: frameMode },
        ];
    }
    const duration = contract.duration;
    return [
        { name: "seconds", field: "seconds", key: "seconds", read: secondsBetween(duration?.min ?? VIDEO_SECONDS_MIN, duration?.max ?? VIDEO_SECONDS_MAX) },
        { name: "format", field: "audioFormat", key: "format", read: format },
        { name: "instructions", field: "audioInstructions", key: "lyrics", read: text },
    ];
}

/**
 * The contract's three-state answer to "may a run of this model carry this key" (#304): only `false` refuses.
 *
 * A field with no request key is the client's own input rather than the request's — a film's quality tier is
 * only ever read through the size a run derives from it — so no list can refuse it, and it is checked by its own
 * bounds.
 */
function refusedBy(key: string, contract: SettingsContract) {
    if (!key) return false;
    return Boolean(contract.accepts) && !contract.accepts?.includes(key);
}

/** What a refusal says: the key, and the list a caller can choose from instead. */
function notAccepted(key: string, contract: SettingsContract) {
    const reads = contract.accepts?.length ? [...contract.accepts].sort().join(", ") : "nothing this tool can set";
    return `${key} means nothing to this workflow — a run of it reads ${reads}`;
}

/**
 * Turn what a caller stated into the node's own fields, or say why it cannot be written.
 *
 * One refusal, never a partial write: a call that names three settings and gets one wrong writes none of them
 * and says which. A half-applied request is a node nobody asked for, and the caller would have to read the
 * answer to find out which half landed.
 */
export function planNodeSettings(node: CanvasNodeData, settings: NodeSettings, contract: SettingsContract): SettingsPlan {
    const kind = node.type;
    if (!SETTING_KINDS.includes(kind)) {
        const what = kind === CanvasNodeType.Text ? "a text node is its words and has no run to configure" : kind === CanvasNodeType.Group ? "a group holds nodes and runs nothing" : "a LoRA node's only setting is the stack its own panel picks";
        return { ok: false, reason: `${node.id} is ${kind} and has no run to configure: ${what}` };
    }
    // Material — content with no model recorded — is the one node whose press cannot run anything (#297), so
    // there is no run to shape. The picker that would give it one belongs to the user.
    if (node.metadata?.content && !node.metadata?.model) {
        return { ok: false, reason: `${node.id} holds material and no model, so nothing would run it: material is used by connecting it to a node that runs (docs/decisions.md #297)` };
    }

    // A film's quality tier is settled first: its size is judged against the tier that will be used, so a call
    // that states both has to know the tier before it can say whether the size is the one it makes.
    const statedTier = kind === CanvasNodeType.Video && settings.quality !== undefined ? quality(settings.quality) : undefined;
    if (statedTier && "reason" in statedTier) return { ok: false, reason: `quality: ${statedTier.reason}` };
    const tier = statedTier && "value" in statedTier ? statedTier.value : undefined;

    const mine = fieldsFor(kind, { ...contract, tier: tier ?? contract.tier });
    const names = [...mine.map((field) => field.name), ...(KINDS_WITH_PARAMS.includes(kind) ? ["params"] : [])];
    const patch: CanvasNodeMetadata = {};
    const written: string[] = [];
    const params: Record<string, unknown> = {};
    if (tier) {
        patch.vquality = tier;
        written.push(`quality ${tier}`);
    }

    for (const [name, value] of Object.entries(settings)) {
        if (value === undefined) continue;
        // Already settled above, before any size was read.
        if (name === "quality") continue;
        if (name === "params") {
            const refusal = readParams(kind, value, contract, params);
            if (refusal) return { ok: false, reason: refusal };
            written.push(...Object.keys(params).map((key) => `params.${key} ${describeValue(params[key])}`));
            continue;
        }
        const field = mine.find((candidate) => candidate.name === name);
        if (!field) return { ok: false, reason: `${kind} nodes keep ${names.join(", ")} — not ${name}` };
        if (refusedBy(field.key, contract)) return { ok: false, reason: notAccepted(field.key, contract) };
        const read = field.read(value);
        if ("reason" in read) return { ok: false, reason: `${name}: ${read.reason}` };
        patch[field.field] = read.value as never;
        // A seed travels only when the node says it is fixed — the pair the panel's switch writes.
        if (name === "seed") patch.seedFixed = read.value ? "true" : "false";
        written.push(read.value ? `${name} ${read.value}` : `${name} cleared`);
    }

    if (!written.length) return { ok: false, reason: "no setting was stated: name a size, a length, a background, a seed, a container, instructions, or params" };
    if (Object.keys(params).length) patch.params = { ...(node.metadata?.params || {}), ...params };
    return { ok: true, patch, written };
}

/** The workflow's own knobs, each checked against the contract; false when one is refused. */
function readParams(kind: string, value: unknown, contract: SettingsContract, into: Record<string, unknown>) {
    if (!KINDS_WITH_PARAMS.includes(kind)) return `a ${kind} node keeps no knobs of its own: a sound's request carries none, and what it is made of is its prompt`;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "params needs an object of the workflow's own keys";
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (!entries.length) return "params was empty";
    for (const [key] of entries) {
        if (RESERVED_PARAMS[key]) return `${key} is not set here: ${RESERVED_PARAMS[key]}`;
        if (refusedBy(key, contract)) return notAccepted(key, contract);
    }
    for (const [key, item] of entries) into[key] = item;
    return "";
}

const describeValue = (value: unknown) => (value && typeof value === "object" ? JSON.stringify(value) : String(value));

/**
 * The request keys this node currently holds values for — what a model change might stop reading.
 *
 * The names are the request's, the same ones `fieldsFor` writes, and they are read off the metadata the panels
 * write: a node that kept a `size` for one workflow and is pointed at another is the case this exists for
 * (docs/decisions.md #311). `quality` is here though no control writes it: a node made by a button records it
 * from the config it was made with, so it can go stale like any other.
 */
export function heldKeys(node: CanvasNodeData): string[] {
    const metadata = node.metadata || {};
    const held: Array<[string, unknown]> = [
        ["size", metadata.size],
        ["seconds", metadata.seconds],
        // A seed is only a value a run reads when the node says it is fixed — the pair #309 writes.
        ["seed", metadata.seedFixed === "true" ? metadata.seed : ""],
        ["background", metadata.background],
        ["quality", metadata.quality ?? metadata.vquality],
        ["frameMode", metadata.frameMode],
        ["format", metadata.audioFormat],
        ["lyrics", metadata.audioInstructions],
        ...Object.entries(metadata.params || {}),
    ];
    return held.filter(([key, value]) => key && value !== "" && value != null).map(([key]) => key);
}
