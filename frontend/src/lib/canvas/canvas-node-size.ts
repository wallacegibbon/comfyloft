import { getNodeSpec } from "@/constant/canvas";
import { inferMediaRatio, inferMediaScale, inferVideoRatio, parseVideoResolution, readMediaDimensions, readVideoDimensions } from "@/lib/media-size";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

/**
 * The smallest a card may be: one number for the user's drag and for anything else that resizes a card.
 *
 * The drag clamped to these and nothing else did, so an agent asking for a 100-pixel card had no floor to be
 * told about. They are the same two numbers, in the one place both readers look.
 */
export const NODE_MIN_SIZE = { width: 220, height: 160 };

/**
 * The shape a card holds: the picture's own pixels when they are known, else the card's current box.
 *
 * A card that frames a picture keeps this ratio when it is resized, and its own metadata is what says so —
 * `naturalWidth`/`naturalHeight` are written when the picture arrives. A card with neither (an empty one, or
 * one written before they were recorded) keeps the shape it happens to have, which is why the fallback is the
 * box rather than a constant.
 */
export function nodeRatio(node: Pick<CanvasNodeData, "width" | "height" | "metadata">) {
    const width = node.metadata?.naturalWidth || node.width;
    const height = node.metadata?.naturalHeight || node.height || 1;
    return width / Math.max(1, height);
}

/** A shape in pixels, from whichever reader knows what the next run is asked to draw. */
type NodeOutputShape = { width: number; height: number };

/** The two settings that decide a run's shape. Read structurally, so an `AiConfig` or a node's own metadata answers. */
export type RunShapeSettings = { size?: unknown; vquality?: unknown };

/**
 * What the run a node is pointed at is being asked to draw, in pixels — the shape of the *ask*, not of an answer.
 *
 * These are the two functions the settings panels already use to write their own size pills (`readMediaDimensions`,
 * `readVideoDimensions`), so a card drawn from them is the shape the request will ask the graph for. A size that
 * says only a ratio ("16:9") is answered at the scale the panel's own scale pill implies, and `auto` is answered
 * the way the graphs read it: a square for a picture (#306), the model's own 16:9 tier for a film.
 *
 * A kind with no shape — words, a sound, a group, a LoRA — has no answer, and that is the honest one: nothing
 * about its card is decided by a size.
 */
function requestedOutputShape(kind: string, settings: RunShapeSettings): NodeOutputShape | undefined {
    const stated = typeof settings.size === "string" ? settings.size.trim() : "";
    const dimensions =
        kind === CanvasNodeType.Image
            ? readMediaDimensions(stated, inferMediaScale(stated), inferMediaRatio(stated))
            : kind === CanvasNodeType.Video
              ? readVideoDimensions(stated || "auto", parseVideoResolution(typeof settings.vquality === "string" ? settings.vquality : undefined), inferVideoRatio(stated || "auto"))
              : { width: 0, height: 0 };
    return dimensions.width > 0 && dimensions.height > 0 ? dimensions : undefined;
}

/**
 * The box a card takes to hold a picture of that shape: the shape itself, inside the card's own size, never under
 * the floor the drag refuses to go below.
 *
 * The floor matters more than it looks: a 9:16 card fitted into a 340×240 one is 135 wide, which no drag, and no
 * `resize_node` call, would accept (#270). Growing the pair keeps the shape and lands on the narrowest card the
 * canvas will hold — the same card the drag would have settled on.
 */
export function nodeSizeFromShape(shape: NodeOutputShape, baseWidth: number, baseHeight: number) {
    const ratio = Math.max(1, shape.width) / Math.max(1, shape.height);
    if (!Number.isFinite(ratio) || ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    const box = ratio >= baseWidth / Math.max(1, baseHeight) ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
    const grow = Math.max(NODE_MIN_SIZE.width / box.width, NODE_MIN_SIZE.height / box.height);
    return grow > 1 ? { width: box.width * grow, height: box.height * grow } : box;
}

/**
 * The box a card is drawn at for the run it is about to make.
 *
 * This is the whole reason a card's size does not change when its picture lands: the box is decided by the ask —
 * the node's own size setting, else the canvas's, the same precedence `buildGenerationConfig` uses for those two
 * keys — and a result is only ever put *inside* it. A card of a kind with no shape keeps the card its type
 * starts with.
 */
export function nodeSizeForRun(node: Pick<CanvasNodeData, "type" | "metadata">, settings: RunShapeSettings = {}) {
    const spec = getNodeSpec(node.type);
    const shape = requestedOutputShape(node.type, {
        size: node.metadata?.size ?? settings.size,
        vquality: node.metadata?.vquality ?? settings.vquality,
    });
    return shape ? nodeSizeFromShape(shape, spec.width, spec.height) : { width: spec.width, height: spec.height };
}

/**
 * The box a card takes for the run it is about to start — and nothing when the run was told no shape.
 *
 * This is the moment the ask is known, and the only moment it should be acted on: the card takes the shape
 * before the run, and the result is put inside it (#354). A card that was made with the right box answers with
 * `{}` and does not move; a card written by an older build settles once, at the press, instead of mid-run.
 *
 * The "no shape stated" case is a step — an upscaler, an interpolator, an angle re-render is handed a picture,
 * not a size, so its answer keeps the shape of the one in front of it, which is the box its card was made with
 * (#293). Both run builders leave `size` out of the record for exactly that reason, so the absence is the fact
 * and not a guess.
 */
export function cardBoxForRun(node: Pick<CanvasNodeData, "type" | "width" | "height" | "metadata">, ask: RunShapeSettings = {}) {
    if (typeof ask.size !== "string" || !ask.size) return {};
    const size = nodeSizeForRun(node, ask);
    return Math.abs(size.width - node.width) < 0.5 && Math.abs(size.height - node.height) < 0.5 ? {} : size;
}
