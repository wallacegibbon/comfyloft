import { planStatedSize, pixelDimensions, videoPixelsForAsk, type ImageSizeProblem } from "@/lib/media-size";
import { modelContractOf, type AiConfig, type ModelOutputShape } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";

/**
 * The one place that answers "what shape will this run draw?".
 *
 * Two readers need that answer and used to compute it separately: the card, which is drawn at a shape before a
 * run starts so it can frame its picture instead of banding it, and the request, which states the ask. They
 * disagreed in plain sight — a stored size of `2:1` drew a 1536x864 card while the run asked for 2048x1024 —
 * and no amount of care at either end fixes a question asked twice. Everything that decides a shape now goes
 * through `planRunShape`, and it decides it once, from the answer the server published for the graph that will
 * run (#359).
 *
 * The graph, not this file, is the one who knows what sizes its own output. `sizedBy` names that owner: a run
 * may be told its shape (`ask`), the graph may take it from one of its own knobs (`squareOf`) or from the
 * picture it was handed (`source`), or it may say nothing — in which case nothing is claimed here either, and a
 * card keeps the shape it already has instead of guessing one.
 */

/** A picture's shape, in pixels. */
export type MediaShape = { width: number; height: number };

/** Where an ask came from: a node's own settings, or the canvas's. */
export type RunAsk = {
    size?: unknown;
    vquality?: unknown;
    /** The model the run will submit, which is whose graph is asked. */
    model?: unknown;
    /** The variant mode it will run in, since a variant is a different graph. */
    imageMode?: unknown;
    /** The workflow's own knobs — one of them can be what sizes the picture. */
    params?: unknown;
};

/**
 * What a run will draw, in one answer for both readers.
 *
 * `shape` is what a card is drawn at; `size` is what the request states. They are returned together because they
 * are the same fact, and a caller that sends one must be drawing the other. `problem` says why there is no answer
 * when the stated size is one a run would refuse, so the request can say which rule it broke rather than send
 * something the server will throw away.
 */
type RunShape = { shape?: MediaShape; size?: string; problem?: "format" | "shapeOnly" | ImageSizeProblem };

/**
 * The ask a node's next run carries: its own record first, the canvas's defaults otherwise — the same precedence
 * `buildGenerationConfig` uses for these keys, which is what lets a card be drawn at the shape of the run it is
 * pointed at before that run exists.
 */
export function runAskOf(metadata: CanvasNodeMetadata | undefined, config: AiConfig): RunAsk {
    return {
        size: metadata?.size ?? config.size,
        vquality: metadata?.vquality ?? config.vquality,
        model: metadata?.model ?? config.model,
        imageMode: metadata?.imageMode ?? config.imageMode,
        params: metadata?.params ?? config.params,
    };
}

/**
 * What the graph published about its own output, for the model and mode this run will resolve to.
 *
 * Undefined is a real answer and not a failure: it means the graph was read and nothing can be claimed about it,
 * or the model is one the server never described. Either way the caller must not invent a shape.
 */
function publishedShape(config: AiConfig, ask: RunAsk): ModelOutputShape | undefined {
    if (typeof ask.model !== "string" || !ask.model) return undefined;
    const mode = typeof ask.imageMode === "string" ? ask.imageMode : undefined;
    return modelContractOf(config, ask.model, mode)?.output;
}

/**
 * The shape a run will draw, and the ask that says so.
 *
 * `source` is the picture this run was handed, for the graphs that keep its shape (an upscaler, an interpolator,
 * an inpaint). A graph that publishes nothing *and* was handed a picture is answered by that picture too: the
 * caller knows what the run was given, and a default shape read off a quality tier is not an answer to it.
 */
export function planRunShape(config: AiConfig, kind: string, ask: RunAsk, source?: MediaShape): RunShape {
    if (kind !== CanvasNodeType.Image && kind !== CanvasNodeType.Video) return {};
    const declared = publishedShape(config, ask);

    if (declared?.sizedBy === "source" || (!declared && source)) return source ? { shape: source } : {};
    if (declared?.sizedBy === "squareOf") {
        const side = squareSide(ask.params, declared);
        return side ? { shape: { width: side, height: side } } : {};
    }
    // `ask`, or nothing published: the ask's own value space is the answer. A film's is never silent — its pixels
    // are always made from the quality tier — while a picture's may state nothing, and then the shape the graph
    // draws unasked is the one to draw the card at.
    if (kind === CanvasNodeType.Video) {
        const size = videoPixelsForAsk(ask.size, ask.vquality);
        const shape = pixelDimensions(size);
        return shape ? { size, shape } : {};
    }
    return pictureAsk(ask.size, declared?.pixels);
}

/** What a stated picture size means: the pixels it states, the graph's own shape, or the reason it was refused. */
function pictureAsk(size: unknown, fallback: string | undefined): RunShape {
    const planned = planStatedSize(size);
    if (planned.kind === "pixels") return { size: planned.size, shape: { width: planned.width, height: planned.height } };
    if (planned.kind === "ratio") return { problem: "shapeOnly" };
    if (planned.kind === "invalid") return { problem: planned.problem };
    // `auto` states no size, so the request states none either: the graph draws what it was built to draw, and the
    // shape it published for that is what the card frames. A square invented here would letterbox the answer.
    const pixels = pixelDimensions(fallback);
    return pixels ? { shape: pixels } : {};
}

/**
 * The side of a square a graph draws itself: the knob the user set, else the number the graph carries.
 *
 * The knob is read as a knob, not as a size — the graph's own input name is what `key` names, and a workflow
 * without a control for it still has the number baked in, which `pixels` carries.
 */
function squareSide(params: unknown, declared: ModelOutputShape) {
    if (params && typeof params === "object" && declared.key) {
        const stated = Number((params as Record<string, unknown>)[declared.key]);
        if (Number.isFinite(stated) && stated > 0) return Math.round(stated);
    }
    return pixelDimensions(declared.pixels)?.width || 0;
}
