import { getNodeSpec } from "@/constant/canvas";
import { IMAGE_MAX_RATIO } from "@/lib/media-size";
import { planRunShape, runAskOf, type MediaShape, type RunAsk } from "@/lib/canvas/run-shape";
import type { CanvasNodeData } from "@/types/canvas";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * The card's box.
 *
 * A card frames a picture, so its box is that picture's shape: drawn at the shape the next run is asked for, and
 * a result is only ever put *inside* it. Nothing here decides what that shape is — `run-shape.ts` answers that,
 * from the graph the run will submit — and nothing here is allowed to make a card a different shape than the
 * picture it holds.
 */

/**
 * The smallest a card may be: one number for the user's drag, for anything else that resizes a card, and for the
 * agent's `resize_node`.
 *
 * The drag clamped to these and nothing else did, so an agent asking for a 100-pixel card had no floor to be told
 * about, and a card drawn below one could not be dragged back. They are the same two numbers, in the one place
 * every reader looks.
 */
export const NODE_MIN_SIZE = { width: 220, height: 160 };

/**
 * The shape of the picture a card holds: its own pixels when they are known, else the box the card has.
 *
 * `naturalWidth`/`naturalHeight` are written when a picture lands, so a card that has one answers from the picture
 * rather than from itself. A card with neither (an empty one) keeps the box it happens to have, which is why the
 * fallback is the box and not a constant.
 */
export function nodeShape(node: Pick<CanvasNodeData, "width" | "height" | "metadata">): MediaShape {
    return { width: node.metadata?.naturalWidth || node.width, height: node.metadata?.naturalHeight || node.height || 1 };
}

/** A card's shape as a ratio, for the readers that resize one side and must keep the other. */
export function nodeRatio(node: Pick<CanvasNodeData, "width" | "height" | "metadata">) {
    const shape = nodeShape(node);
    return shape.width / Math.max(1, shape.height);
}

/**
 * The box that holds a shape inside a box: the shape itself, inside the limits, never under the floor.
 *
 * This is the only code in the canvas that turns a shape into a size, and every writer of a card's box goes
 * through it — a run's ask, a pasted picture, a crop, a frame out of a film. The floor matters more than it looks:
 * a 9:16 card fitted into a 340×240 one is 135 wide, which no drag and no `resize_node` call would accept (#270).
 * Growing the pair keeps the shape and lands on the narrowest card the canvas will hold.
 *
 * The floor is what the drag and `resize_node` refuse to go under, so it is honoured: the pair grows. A shape
 * outside the aspect the canvas accepts for a picture is material rather than an ask, and no pair both keeps it
 * and stays inside a card — those are kept inside the limits, so a panorama stays a panorama instead of becoming
 * a card 3200 wide. Something that is not a card — a preview drawn inside one — passes no floor, because it has
 * to stay inside the card that holds it.
 */
export function fitBox(shape: MediaShape, limits: MediaShape, floor: MediaShape = NODE_MIN_SIZE): MediaShape {
    const ratio = shape.width / Math.max(1, shape.height);
    if (!Number.isFinite(ratio) || ratio <= 0) return { width: limits.width, height: limits.height };
    const box = ratio >= limits.width / Math.max(1, limits.height) ? { width: limits.width, height: limits.width / ratio } : { width: limits.height * ratio, height: limits.height };
    const grow = Math.max(floor.width / box.width, floor.height / box.height);
    if (grow <= 1 || ratio > IMAGE_MAX_RATIO || ratio < 1 / IMAGE_MAX_RATIO) return box;
    return { width: box.width * grow, height: box.height * grow };
}

/** The ceiling a picture card is drawn under. A film's own ceiling is smaller, and lives with the film's writer. */
export const IMAGE_CARD_MAX_SIZE = { width: 640, height: 640 };

/**
 * The box a card is drawn at for the run it is about to make.
 *
 * This is the whole reason a card's size does not change when its picture lands: the box is decided by the ask —
 * the node's own settings first, the canvas's otherwise, the same precedence `buildGenerationConfig` uses — and
 * the ask's shape is what the graph the run will submit says it is, not what this file would guess (#359). A card
 * of a kind with no shape (words, a sound, a group) keeps the box its type starts with.
 */
export function nodeSizeForRun(config: AiConfig, node: Pick<CanvasNodeData, "type" | "metadata">, ask?: RunAsk) {
    const spec = getNodeSpec(node.type);
    const shape = planRunShape(config, node.type, ask || runAskOf(node.metadata, config)).shape;
    return shape ? fitBox(shape, { width: spec.width, height: spec.height }) : { width: spec.width, height: spec.height };
}

/**
 * The box a card takes for the run it is about to start — and nothing when that run states no shape.
 *
 * This is the moment the ask is known, and the only moment it should be acted on: the card takes the shape before
 * the run, and the result goes inside it (#354). A card already drawn at that shape answers with `{}` and does not
 * move; one written by an older build settles once, at the press, instead of mid-run.
 *
 * `ask` is the record of the run about to happen (`buildImageGenerationMetadata`'s output), because a run may be
 * asked something the node's stored settings do not say — an inpaint asked for the source's shape, an upscale
 * asked for nothing at all. Both are read from the graph's answer, so a step card is drawn at the shape of the
 * picture it was handed rather than at its parent's box (#293).
 */
export function cardBoxForRun(config: AiConfig, node: Pick<CanvasNodeData, "type" | "width" | "height" | "metadata">, ask?: RunAsk, source?: MediaShape): Partial<MediaShape> {
    const shape = planRunShape(config, node.type, ask || runAskOf(node.metadata, config), source).shape;
    if (!shape) return {};
    const size = fitBox(shape, { width: node.width, height: node.height });
    return Math.abs(size.width - node.width) < 0.5 && Math.abs(size.height - node.height) < 0.5 ? {} : size;
}
