import { NODE_STATUS_ERROR, NODE_STATUS_LOADING } from "@/lib/canvas/canvas-node-status";
import type { ModelAccepts } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";

/**
 * What a node's run is doing right now, or what its last one ended in: the answer to "is anything happening
 * here?", which nothing on the canvas used to say.
 *
 * An agent told to check a node it just pressed (#285) can only do that if the node says so. A run in flight,
 * a failure with the reason it gave, or nothing — an idle node is not news, and a line of "idle" on every node
 * of a big canvas is noise.
 */
export function runClause(metadata: CanvasNodeMetadata | undefined): string {
    if (metadata?.status === NODE_STATUS_LOADING) return "generating now";
    if (metadata?.status === NODE_STATUS_ERROR) {
        const reason = (metadata?.errorDetails || "").trim() || "no reason given";
        return `last run failed: ${reason}`;
    }
    return "";
}

/**
 * What a node of this kind holds, for the sentences that refuse to read or write the wrong thing in it.
 *
 * It is here rather than in the tools because two modules now need the same three words: the word tools
 * ("it holds a picture, not words") and the refusal a node that is *material* gets (`materialClause`). A
 * second copy is how "a film" becomes "a video" in one refusal and not the other.
 */
export function heldNoun(type: string): string {
    if (type === CanvasNodeType.Image) return "a picture";
    if (type === CanvasNodeType.Video) return "a film";
    if (type === CanvasNodeType.Audio) return "a sound";
    return "nodes";
}

/**
 * How a node's content came to be, in one clause, for the two tools that answer questions about a node.
 *
 * `list_nodes` said every fact about a node except what made its content, and `read_node` handed over the
 * bytes and nothing about them, so an agent asked "which model drew this picture, and when" could only
 * guess from the prompt. The facts are on the node itself (docs/decisions.md #227, `workflow` and
 * `generatedAt`); this is the one place they are put into words, so the two tools cannot word them
 * differently and a third caller gets the same sentence.
 *
 * The stamp is the server's own: an ISO 8601 instant in UTC, printed as it was recorded rather than
 * formatted for a locale. The same sentence is read by a model and by the user, and the user's machine is
 * not necessarily where the server runs — a `toLocaleString` here would be a different string for every
 * reader of the same fact.
 */
export function generationClause(metadata: CanvasNodeMetadata | undefined): string {
    const workflow = (metadata?.workflow || "").trim();
    const generatedAt = (metadata?.generatedAt || "").trim();
    if (workflow && generatedAt) return `made ${generatedAt} with ${workflow}`;
    if (workflow) return `made with ${workflow}`;
    if (generatedAt) return `made ${generatedAt}`;
    return "";
}

/**
 * What a node is set to run, in one clause — the other half of `generationClause`.
 *
 * One answers what *made* the content in the node, this one what the next run will be. They are different
 * facts and they disagree the moment the user changes the picker: an image node made by
 * `image-z-image-turbo` can be set to run `image-qwen21`. An agent asked to rewrite a prompt needs this
 * one, because the wording it must write is chosen by the workflow (`h3-prompt-writing` has a different
 * section order for each H3 input mode) and nothing else on the canvas says which will run.
 *
 * It is read from the picker's own value, so it says nothing about a node that has never been given one —
 * a text node's model belongs to the agent, not to a workflow. The seconds are the node's, when it has
 * kept a duration of its own; the global default is not a fact about this node.
 *
 * The settings follow — the same fields `set_node` writes (#309). They are facts about the node
 * whether or not a model has been picked for it, which is why a node with a size and no picker still says so:
 * an agent about to write a size has to be able to read the one that is there. `auto` is left out, because it
 * is the absence of a choice rather than one.
 */
export function configuredClause(metadata: CanvasNodeMetadata | undefined): string {
    const settings = settingsClause(metadata);
    const model = (metadata?.model || "").trim();
    if (!model) return settings;
    // A picker value is `channel::model` or a bare model name; either way the tail is what the server is
    // asked for, and the channel is a local naming detail the reader cannot act on.
    const at = model.lastIndexOf("::");
    const name = (at >= 0 ? model.slice(at + 2) : model).trim();
    // The mode is part of which run this is, so a rewrite needs it: `image-qwen21 as edit` takes a picture and
    // the words for changing it, `as t2i` takes words alone. It is not a setting (#309) — it comes with the
    // model — but it is a fact about the next run, which is what this clause is (#311).
    const mode = (metadata?.imageMode || "").trim();
    return [`set to run ${name}${mode ? ` as ${mode}` : ""}`, ...(settings ? [settings] : [])].join(", ");
}

/** The params a settings clause leaves out: two the run fills in, and one it has already stated. */
const UNSTATED_PARAMS: string[] = ["loras", "layout", "layoutEnabled", "seed"];

function settingsClause(metadata: CanvasNodeMetadata | undefined) {
    const parts: string[] = [];
    const size = (metadata?.size || "").trim();
    if (size && size.toLowerCase() !== "auto") parts.push(`size ${size}`);
    const seconds = (metadata?.seconds || "").trim();
    if (seconds) parts.push(`${seconds} s`);
    // A seed is only a fact about the run when the node also says it is fixed — the pair `set_node`
    // writes together, and the one `buildGenerationConfig` reads before it puts a seed in the request.
    const seed = (metadata?.seed || "").trim();
    if (seed && metadata?.seedFixed === "true") parts.push(`seed ${seed}`);
    if ((metadata?.background || "").trim().toLowerCase() === "transparent") parts.push("transparent background");
    const quality = (metadata?.quality || metadata?.vquality || "").trim();
    if (quality) parts.push(`quality ${quality}`);
    // What the connected pictures are to a film that takes frames: `first`, `last`, or both. It is the request's
    // own word, and the fact that decides whether a clip continues from a frame or ends on it (#324).
    const frames = (metadata?.frameMode || "").trim();
    if (frames === "first") parts.push("frames first");
    else if (frames === "last") parts.push("frames last");
    else if (frames === "both") parts.push("frames first and last");
    const params = Object.entries(metadata?.params || {}).filter(([key, value]) => !UNSTATED_PARAMS.includes(key) && value !== "" && value != null);
    if (params.length) parts.push(`params ${params.map(([key, value]) => `${key} ${value && typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(", ")}`);
    return parts.join(", ");
}

/**
 * What a node forgets while its content is being replaced by a new run: the workflow and the time that
 * described the picture which is now gone.
 *
 * Spread into a patch to erase both fields (`undefined` overwrites, and the document drops the key when it
 * is serialized). A run that fails leaves the node with no content, and a node that claims a maker for
 * content it does not hold is worse than one that says nothing: the agent would report the old model with
 * the new picture's confidence (#227).
 */
export const NO_MAKER: Partial<CanvasNodeMetadata> = { workflow: undefined, generatedAt: undefined };

/** What a node's workflow takes, one count per kind, as the page sees what is wired into the node. */
export type MediaCounts = { image: number; video: number; audio: number };

/**
 * What a node's run needs, and what it has — the third clause `read_prompt` carries.
 *
 * The prompt is only half of a press. A workflow that re-renders a picture from a new angle, swaps a character
 * in a clip, or inpaints a mask takes media the prompt cannot replace, and a caller who does not know that
 * presses a node that can only be refused. The counts are the workflow's own declaration (#313) and the state
 * is the wiring in front of it, so the answer is the same one the server's refusal would give — said before the
 * call rather than after it.
 *
 * Nothing is claimed for a workflow that publishes no media contract: an older config, or a model the server did
 * not describe.
 */
export function requiresClause(accepts: ModelAccepts | undefined, counts: MediaCounts) {
    const need = describeNeed(accepts);
    if (!need) return "";
    const state = describeCounts(counts);
    // A press is refused for either side of a declared bound — the minimum a run needs, and the maximum it takes.
    return `it takes ${need}; ${state}${meetsMedia(accepts!, counts) ? "" : ", so a press would be refused"}`;
}

/**
 * The media a run *needs*, in the order a node's own panel names them.
 *
 * What is required comes first: a kind a run cannot do without (`min > 0`) is the answer to "may I press this
 * yet". Only where nothing is required does a maximum get said at all — as "up to 1 clip", which is a permission
 * rather than a demand, and the difference between the two is exactly the press.
 */
function describeNeed(accepts: ModelAccepts | undefined) {
    if (!accepts) return "";
    const kinds = [
        { limit: accepts.images, one: "image", many: "images" },
        { limit: accepts.videos, one: "clip", many: "clips" },
        { limit: accepts.audios, one: "sound", many: "sounds" },
    ];
    const required = kinds.flatMap(({ limit, one, many }) => (limit?.min ? [limit.min === limit.max ? `${limit.min} ${limit.min === 1 ? one : many}` : `${limit.min}-${limit.max} ${many}`] : []));
    const total = accepts.minTotal || 0;
    // A minimum across kinds is not the sum of the mins: a workflow can take an image *or* a clip and still need
    // one of them. Said only where it adds something the per-kind lines do not already require.
    const perKind = (accepts.images?.min || 0) + (accepts.videos?.min || 0) + (accepts.audios?.min || 0);
    if (total > perKind) required.push(`at least ${total} media item${total === 1 ? "" : "s"} in all`);
    if (required.length) return required.join(" and ");
    const allowed = kinds.flatMap(({ limit, one, many }) => (limit?.max ? [`up to ${limit.max} ${limit.max === 1 ? one : many}`] : []));
    return allowed.length ? allowed.join(" and ") : "words only";
}

/** What is wired into the node now, in the same words. */
function describeCounts(counts: MediaCounts) {
    const parts: string[] = [];
    if (counts.image) parts.push(`${counts.image} image${counts.image === 1 ? "" : "s"}`);
    if (counts.video) parts.push(`${counts.video} clip${counts.video === 1 ? "" : "s"}`);
    if (counts.audio) parts.push(`${counts.audio} sound${counts.audio === 1 ? "" : "s"}`);
    return parts.length ? `${parts.join(" and ")} connected` : "nothing connected";
}

/** Whether the wiring satisfies the declaration, both ways round. */
function meetsMedia(accepts: ModelAccepts, counts: MediaCounts) {
    const pairs: Array<[keyof MediaCounts, { min: number; max: number } | undefined]> = [
        ["image", accepts.images],
        ["video", accepts.videos],
        ["audio", accepts.audios],
    ];
    for (const [kind, limit] of pairs) {
        if (!limit) continue;
        if (counts[kind] < limit.min) return false;
        // A declared maximum is a maximum even when it is zero: `max: 0` is how a workflow says it takes none
        // (`media.go`), and reading it as "no limit" let a press through that the server then refused.
        if ((limit.max ?? Infinity) < counts[kind]) return false;
    }
    const total = counts.image + counts.video + counts.audio;
    return total >= (accepts.minTotal || 0);
}
