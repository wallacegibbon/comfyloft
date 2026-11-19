import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getNodeSpec } from "../src/constant/canvas";
import { cardBoxForRun, fitBox, IMAGE_CARD_MAX_SIZE, NODE_MIN_SIZE, nodeShape, nodeSizeForRun } from "../src/lib/canvas/canvas-node-size";
import { applyGeneratedImage, applyNodeConfigPatch, createCanvasNode } from "../src/lib/canvas/canvas-node-factory";
import { applyGeneratedVideo } from "../src/lib/canvas/canvas-generated-video";
import { planRunShape, type MediaShape } from "../src/lib/canvas/run-shape";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { AiConfig, ChannelModel } from "../src/stores/use-config-store";

/**
 * A card's box is the shape the run will draw, never the shape of the answer that lands in it.
 *
 * Two bugs are the counter to here. First, a card was resized when its picture landed, so the card the user was
 * looking at changed size the moment it had something in it (#354). Second — the one #359 is about — the shape
 * itself was computed twice: once for the card and once for the request, with different rules, so a card could be
 * drawn square next to a run that was asked for 16:9. These tests hold both halves: the box comes from the graph
 * the run will submit, through `planRunShape`, and filling a card changes only what is inside it.
 */

const IMAGE_SPEC = getNodeSpec(CanvasNodeType.Image);

/**
 * A config whose models answer the shape question the way the server does.
 *
 * `output` is what `/api/workflows` publishes, derived from the graph (#359); a model listed without one is the
 * three-state "the graph was read and nothing can be claimed", which is a case these tests hold too.
 */
function configFor(models: Array<Partial<ChannelModel> & { name: string }>, size = "auto"): AiConfig {
    return {
        baseUrl: "http://127.0.0.1:8190/v1",
        channels: [{ id: "local", name: "Local", baseUrl: "http://127.0.0.1:8190/v1", models: models.map((model) => ({ capability: "image", ...model })) }],
        model: models[0]?.name || "",
        imageModel: models[0]?.name || "",
        size,
    } as unknown as AiConfig;
}

const graphSizesByAsk = { name: "image-zit", output: { sizedBy: "ask", pixels: "832x1216" } };
const graphDrawsItsOwnSquare = { name: "image-qwen", output: { sizedBy: "squareOf", key: "resolution", pixels: "1024x1024" } };
const graphKeepsItsSource = { name: "image-upscale", output: { sizedBy: "source" } };
const graphStatesItsOwnCanvas = { name: "image-outpaint", output: { sizedBy: "ask" } };
const graphSaysNothing = { name: "image-unknown" };

/**
 * The band a picture is left with inside a card: zero is the only answer that means "it fills the card".
 *
 * A card's box *is* the rectangle its picture is painted in — the frame is drawn outside it (#360) — so this is
 * the arithmetic of what the user sees, and asserting the box's ratio was not the same thing: a 4.9px band on each
 * side of a 640×186.6 card passed every ratio assertion written against that box.
 */
function bandsOf(box: MediaShape, shape: MediaShape) {
    const scale = Math.min(box.width / shape.width, box.height / shape.height);
    return { left: (box.width - shape.width * scale) / 2, top: (box.height - shape.height * scale) / 2 };
}

/** A box a run actually settled the card at. Every case using this states a shape, so `{}` — "nothing to change" —
 *  is a failure worth naming before the numbers are taken apart. */
function settledBox(box: Partial<MediaShape>): MediaShape {
    expect(box.width).toEqual(expect.any(Number));
    expect(box.height).toEqual(expect.any(Number));
    return { width: box.width as number, height: box.height as number };
}

function emptyCard(type: CanvasNodeType, box = { width: 300, height: 200 }, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id: `card-${type}`, type, position: { x: 40, y: 60 }, ...box, metadata: { content: "", status: "idle", ...metadata } };
}

function picture(width: number, height: number) {
    return { url: "http://127.0.0.1:8190/api/canvases/abc/files/task_1.png", storageKey: "files/task_1.png", width, height, bytes: 100, mimeType: "image/png" };
}

function clip(width: number, height: number) {
    return { url: "http://127.0.0.1:8190/api/canvases/abc/files/task_1.mp4", storageKey: "files/task_1.mp4", bytes: 100, mimeType: "video/mp4", width, height };
}

describe("the shape a run will draw", () => {
    test("a graph sized by the ask draws the card at the size the ask states", () => {
        const config = configFor([graphSizesByAsk]);
        const wide = planRunShape(config, CanvasNodeType.Image, { model: "image-zit", size: "1536x864" });
        expect(wide.size).toBe("1536x864");
        expect(wide.shape!.width / wide.shape!.height).toBeCloseTo(16 / 9, 4);
    });

    test("`auto` sends no size, and the card is the shape the graph draws unasked", () => {
        const config = configFor([graphSizesByAsk]);
        const asked = planRunShape(config, CanvasNodeType.Image, { model: "image-zit", size: "auto" });
        // The graph's own answer is 832x1216 — a portrait. A square invented here is what letterboxed every
        // Z-Image card while the graph drew 832x1216.
        expect(asked.size).toBeUndefined();
        expect(asked.shape).toEqual({ width: 832, height: 1216 });
    });

    test("a graph that sizes itself by its own knob draws a square, of that knob", () => {
        const config = configFor([graphDrawsItsOwnSquare]);
        const stated = planRunShape(config, CanvasNodeType.Image, { model: "image-qwen", size: "1536x864", params: { resolution: 1536 } });
        expect(stated.shape).toEqual({ width: 1536, height: 1536 });
        // No size belongs in the request: nothing in that graph reads one.
        expect(stated.size).toBeUndefined();
        // Without the knob, the number the graph itself carries answers.
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-qwen" }).shape).toEqual({ width: 1024, height: 1024 });
    });

    test("a graph that keeps the picture it was handed draws that picture's shape", () => {
        const config = configFor([graphKeepsItsSource]);
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-upscale", size: "1024x1024" }, { width: 2048, height: 864 }).shape).toEqual({ width: 2048, height: 864 });
        // Handed no picture, nothing is claimed: the card keeps the box it has.
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-upscale" }).shape).toBeUndefined();
    });

    test("a graph that says nothing claims nothing — `auto` does not become a square", () => {
        const config = configFor([graphSaysNothing]);
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-unknown", size: "auto" })).toEqual({});
        // A stated size is still the ask, because that is all that is known about it.
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-unknown", size: "1536x864" }).shape).toEqual({ width: 1536, height: 864 });
    });

    test("a graph sized by a canvas the request states claims no shape for the run that states none", () => {
        const config = configFor([graphStatesItsOwnCanvas]);
        // An outpaint graph's canvas arrives through its own parameters, so the graph says the ask owns the
        // shape and says nothing about the numbers left in its nodes. Nothing here invents the difference:
        // a default read off the graph would square a card the outpaint dialog drew at the canvas it asked for.
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-outpaint", size: "auto", imageMode: "outpaint" })).toEqual({});
        // A stated size is still the ask, because that is all that is known about it.
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-outpaint", size: "1280x2272" }).shape).toEqual({ width: 1280, height: 2272 });
    });

    test("a bare ratio is refused as a size, by the card and by the request alike", () => {
        const config = configFor([graphSizesByAsk]);
        // `2:1` was where the two readers came apart: a 1536x864 card next to a run asked for 2048x1024.
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-zit", size: "2:1" })).toEqual({ problem: "shapeOnly" });
    });

    test("a mode's own graph is asked, not the workflow's", () => {
        const config = configFor([{ ...graphSizesByAsk, contracts: { inpaint: { output: { sizedBy: "source" } } } }]);
        expect(planRunShape(config, CanvasNodeType.Image, { model: "image-zit", imageMode: "inpaint", size: "1024x1024" }, { width: 900, height: 1600 }).shape).toEqual({ width: 900, height: 1600 });
    });

    test("the card and the request are the same number, for every shape either could state", () => {
        const config = configFor([graphSizesByAsk]);
        for (const size of ["1024x1024", "1536x864", "864x1536", "2048x1152", "1024x768"]) {
            const plan = planRunShape(config, CanvasNodeType.Image, { model: "image-zit", size });
            const box = nodeSizeForRun(config, emptyCard(CanvasNodeType.Image), { model: "image-zit", size });
            expect(box.width / box.height).toBeCloseTo(plan.shape!.width / plan.shape!.height, 6);
            expect(bandsOf(box, plan.shape!)).toEqual({ left: expect.closeTo(0, 6), top: expect.closeTo(0, 6) });
            expect(plan.size).toBe(size);
        }
    });
});

describe("the box an empty card is drawn at", () => {
    test("a square ask makes a square card, not the type table's wide one", () => {
        const config = configFor([graphSizesByAsk]);
        const box = nodeSizeForRun(config, emptyCard(CanvasNodeType.Image), { model: "image-zit", size: "1024x1024" });
        expect(box).toEqual({ width: IMAGE_SPEC.height, height: IMAGE_SPEC.height });
        expect(box.width).toBeLessThan(IMAGE_SPEC.width);
    });

    test("a ratio the panel offers is kept, not bent to the card", () => {
        const config = configFor([graphSizesByAsk]);
        const wide = nodeSizeForRun(config, emptyCard(CanvasNodeType.Image), { model: "image-zit", size: "1536x864" });
        expect(wide.width / wide.height).toBeCloseTo(16 / 9, 6);
        expect(wide.width).toBe(IMAGE_SPEC.width);

        const tall = nodeSizeForRun(config, emptyCard(CanvasNodeType.Image), { model: "image-zit", size: "864x1536" });
        expect(tall.width / tall.height).toBeCloseTo(9 / 16, 6);
        // A tall shape fitted into a wide card would come out narrower than any card the canvas will hold
        // (#270 states that floor to the agent), so the pair grows instead.
        expect(tall.width).toBeGreaterThanOrEqual(NODE_MIN_SIZE.width);
        expect(tall.height).toBeGreaterThanOrEqual(NODE_MIN_SIZE.height);
    });

    test("the node's own setting is asked first, the canvas's next", () => {
        const config = configFor([graphSizesByAsk], "1024x1024");
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 }, { size: "1536x864" });
        const asked = nodeSizeForRun(config, card);
        expect(asked.width / asked.height).toBeCloseTo(16 / 9, 6);
        // With nothing on the node, the canvas's setting is the ask.
        expect(nodeSizeForRun(config, emptyCard(CanvasNodeType.Image, { width: 300, height: 200 }, { model: "image-zit" }))).toEqual({ width: IMAGE_SPEC.height, height: IMAGE_SPEC.height });
    });

    test("a film's card holds the shape its run will be told, and the tier does not move it", () => {
        const config = configFor([{ name: "video-h3", capability: "video", output: { sizedBy: "ask", pixels: "1344x768" } }]);
        const automatic = nodeSizeForRun(config, emptyCard(CanvasNodeType.Video), { model: "video-h3", size: "auto", vquality: "720" });
        expect(automatic.width / automatic.height).toBeCloseTo(16 / 9, 6);
        const square = nodeSizeForRun(config, emptyCard(CanvasNodeType.Video), { model: "video-h3", size: "1024x1024", vquality: "720" });
        expect(square.width).toBeCloseTo(square.height, 6);
        // A tier changes how many pixels the clip is rendered at, not what shape it is.
        expect(nodeSizeForRun(config, emptyCard(CanvasNodeType.Video), { model: "video-h3", size: "1280x720", vquality: "720" })).toEqual(nodeSizeForRun(config, emptyCard(CanvasNodeType.Video), { model: "video-h3", size: "1920x1080", vquality: "1080" }));
    });

    test("a card with no shape to hold keeps the card its type starts with", () => {
        const config = configFor([graphSizesByAsk]);
        for (const type of [CanvasNodeType.Audio, CanvasNodeType.Text, CanvasNodeType.Group, CanvasNodeType.Lora]) {
            const spec = getNodeSpec(type);
            expect(nodeSizeForRun(config, emptyCard(type), { model: "image-zit", size: "864x1536" })).toEqual({ width: spec.width, height: spec.height });
        }
    });
});

describe("the box a shape is drawn at, once", () => {
    test("one function, for every writer of a card's box: the shape, inside the box, never under the floor", () => {
        // A wide shape into a square card: the card lands on the limit and the shape is what fits *inside* it.
        const wide = fitBox({ width: 1920, height: 1080 }, { width: 640, height: 640 });
        expect(wide.width).toBe(640);
        expect(wide.width / wide.height).toBeCloseTo(16 / 9, 6);
        // The floor grows the pair rather than bending the shape (#270).
        const tall = fitBox({ width: 864, height: 1536 }, { width: 340, height: 240 });
        expect(tall.width / tall.height).toBeCloseTo(864 / 1536, 6);
        expect(tall.width).toBeGreaterThanOrEqual(NODE_MIN_SIZE.width);
        expect(tall.height).toBeGreaterThanOrEqual(NODE_MIN_SIZE.height);
        // An extreme shape keeps its shape instead of growing into an impossible card.
        const strip = fitBox({ width: 4000, height: 200 }, { width: 640, height: 640 });
        expect(strip.width).toBe(640);
        expect(strip.width / strip.height).toBeCloseTo(20, 6);
    });

    test("the frame is not a band: a card holding a picture leaves none (#360)", () => {
        // The real numbers from the report: a 487×142 picture in a card of that same ratio, and a 4.9px dark band
        // down each side. The card's box was the picture's rect and the picture was painted inside the border that
        // had been cut out of it, so the two rectangles were 4px apart — and nothing written against the box could
        // see it. A square hides the difference, which is why the square graphs never showed the seam.
        const source = { width: 487, height: 142 };
        const card = fitBox(source, IMAGE_CARD_MAX_SIZE);
        expect(card.width).toBeLessThanOrEqual(IMAGE_CARD_MAX_SIZE.width);
        expect(bandsOf(card, source)).toEqual({ left: expect.closeTo(0, 6), top: expect.closeTo(0, 6) });
        // A card the fit settled on the floor answers its shape the same way.
        expect(bandsOf(fitBox({ width: 3, height: 2 }, { width: 340, height: 240 }), { width: 3, height: 2 })).toEqual({ left: expect.closeTo(0, 6), top: expect.closeTo(0, 6) });
        // A square never had the problem, and still does not.
        expect(bandsOf(fitBox({ width: 1024, height: 1024 }, { width: 340, height: 240 }), { width: 1024, height: 1024 })).toEqual({ left: expect.closeTo(0, 6), top: expect.closeTo(0, 6) });
    });

    test("the shape a card holds is its picture's, not the box it happens to have", () => {
        const dragged = emptyCard(CanvasNodeType.Image, { width: 700, height: 300 }, { content: "http://example/x.png", naturalWidth: 1024, naturalHeight: 1024 });
        expect(nodeShape(dragged)).toEqual({ width: 1024, height: 1024 });
    });
});

describe("a card created for a run carries that box", () => {
    test("a new picture card is the shape the canvas is set to draw", () => {
        const config = configFor([graphSizesByAsk], "1024x1024");
        const centre = { x: 500, y: 400 };
        const node = createCanvasNode(config, CanvasNodeType.Image, centre, { model: "image-zit" });
        expect(node.width).toBeCloseTo(node.height, 4);
        expect(node.position).toEqual({ x: centre.x - node.width / 2, y: centre.y - node.height / 2 });
    });

    test("a new card with no size stated is the shape the graph draws unasked", () => {
        const config = configFor([graphSizesByAsk]);
        const node = createCanvasNode(config, CanvasNodeType.Image, { x: 500, y: 400 }, { model: "image-zit" });
        const painted = { width: node.width, height: node.height };
        expect(painted.width / painted.height).toBeCloseTo(832 / 1216, 6);
    });

    test("a new film card is the shape its run will render", () => {
        const config = configFor([{ name: "video-h3", capability: "video", output: { sizedBy: "ask", pixels: "1344x768" } }], "9:16");
        const node = createCanvasNode(config, CanvasNodeType.Video, { x: 500, y: 400 }, { model: "video-h3", vquality: "720" });
        const painted = { width: node.width, height: node.height };
        expect(painted.width / painted.height).toBeCloseTo(9 / 16, 6);
        expect(node.width).toBeGreaterThanOrEqual(NODE_MIN_SIZE.width);
    });

    test("a card the canvas has no settings for still gets a card it can be clicked on", () => {
        const config = configFor([graphSizesByAsk]);
        const node = createCanvasNode(config, CanvasNodeType.Audio, { x: 10, y: 10 }, { seconds: "6" });
        const spec = getNodeSpec(CanvasNodeType.Audio);
        expect({ width: node.width, height: node.height }).toEqual({ width: spec.width, height: spec.height });
    });
});

describe("filling a card does not move it", () => {
    test("a picture lands in the box that was made for it, and the card keeps its size", () => {
        const config = configFor([graphSizesByAsk], "1024x1024");
        const card = createCanvasNode(config, CanvasNodeType.Image, { x: 500, y: 400 }, { model: "image-zit" });
        const filled = applyGeneratedImage(card, picture(1024, 1024));
        // The sentence the bug report asked for: the same card, empty and full, the same size.
        expect({ width: filled.width, height: filled.height, position: filled.position }).toEqual({ width: card.width, height: card.height, position: card.position });
        expect(filled.metadata?.naturalWidth).toBe(1024);
        expect(filled.metadata?.naturalHeight).toBe(1024);
    });

    test("a run that answers with a different shape is drawn inside the card, not by resizing it", () => {
        const config = configFor([graphSizesByAsk], "1024x1024");
        const card = createCanvasNode(config, CanvasNodeType.Image, { x: 500, y: 400 }, { model: "image-zit" });
        const filled = applyGeneratedImage(card, picture(1920, 1080));
        expect({ width: filled.width, height: filled.height }).toEqual({ width: card.width, height: card.height });
    });

    test("the same for a film: the clip does not restyle the card", () => {
        const config = configFor([{ name: "video-h3", capability: "video", output: { sizedBy: "ask", pixels: "1344x768" } }], "1024x1024");
        const card = createCanvasNode(config, CanvasNodeType.Video, { x: 500, y: 400 }, { model: "video-h3", vquality: "720" });
        const filled = applyGeneratedVideo(card, clip(1920, 1080), { prompt: "panned left" });
        expect({ width: filled.width, height: filled.height, position: filled.position }).toEqual({ width: card.width, height: card.height, position: card.position });
        expect(filled.metadata?.prompt).toBe("panned left");
    });
});

describe("a settings change moves an empty card and never a filled one", () => {
    test("an empty card takes the shape the panel just picked", () => {
        const config = configFor([graphSizesByAsk]);
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 }, { model: "image-zit" });
        const next = applyNodeConfigPatch(config, card, { size: "1536x864" });
        const painted = { width: next.width, height: next.height };
        expect(painted.width / painted.height).toBeCloseTo(16 / 9, 6);
        expect(next.metadata?.size).toBe("1536x864");
    });

    test("a card that holds a picture keeps that picture's shape (#264)", () => {
        const config = configFor([graphSizesByAsk]);
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 }, { content: "http://example/x.png", naturalWidth: 300, naturalHeight: 200, model: "image-zit" });
        const next = applyNodeConfigPatch(config, card, { size: "1536x864" });
        expect({ width: next.width, height: next.height }).toEqual({ width: 300, height: 200 });
        expect(next.metadata?.size).toBe("1536x864");
    });

    test("a setting that decides no shape leaves a box alone", () => {
        const config = configFor([graphSizesByAsk], "1024x1024");
        const card = createCanvasNode(config, CanvasNodeType.Image, { x: 500, y: 400 }, { model: "image-zit" });
        const next = applyNodeConfigPatch(config, card, { seed: "424242", seedFixed: "true" });
        expect({ width: next.width, height: next.height, position: next.position }).toEqual({ width: card.width, height: card.height, position: card.position });
        expect(next.metadata?.seed).toBe("424242");
    });
});

describe("a step is handed a picture, not a size", () => {
    test("a run whose graph takes no shape leaves the card it was made with", () => {
        const config = configFor([graphKeepsItsSource]);
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 });
        expect(cardBoxForRun(config, card, { model: "image-upscale" })).toEqual({});
        expect(cardBoxForRun(config, card, { model: "image-upscale", size: "1024x1024" })).toEqual({});
    });

    test("a step card is drawn at the picture it was handed, not at its parent's box", () => {
        const config = configFor([graphKeepsItsSource]);
        // A card dragged out of step with its picture (#264 keeps the drag free, the shape fixed): the child
        // follows the picture, and the parent's box is not evidence of the child's shape.
        const parent = emptyCard(CanvasNodeType.Image, { width: 700, height: 300 }, { content: "http://example/x.png", naturalWidth: 1024, naturalHeight: 1024, model: "image-upscale" });
        const box = settledBox(cardBoxForRun(config, parent, { model: "image-upscale" }, nodeShape(parent)));
        expect(box.width).toBeCloseTo(box.height, 4);
    });

    test("a run asked for the shape the card already has answers with nothing to change", () => {
        const config = configFor([graphSizesByAsk]);
        const square = nodeSizeForRun(config, emptyCard(CanvasNodeType.Image), { model: "image-zit", size: "1024x1024" });
        const card = emptyCard(CanvasNodeType.Image, square, { model: "image-zit" });
        expect(cardBoxForRun(config, card, { model: "image-zit", size: "1024x1024" })).toEqual({});
    });

    test("a run asked for another shape settles the card once, before it starts — and leaves its corner alone", () => {
        const config = configFor([graphSizesByAsk]);
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 }, { model: "image-zit" });
        const box = settledBox(cardBoxForRun(config, card, { model: "image-zit", size: "1024x1024" }));
        // The shape the run was asked for, inside the card's box, and never under the floor the drag refuses.
        expect(box.width).toBeCloseTo(box.height, 4);
        expect(box.width).toBeGreaterThanOrEqual(NODE_MIN_SIZE.width);
        // Pressing it again changes nothing: the box already answers the ask.
        expect(cardBoxForRun(config, { ...card, ...box }, { model: "image-zit", size: "1024x1024" })).toEqual({});
        // Only the box: the top-left stays where it was, as `resize_node` keeps it (#270).
        expect(box).not.toHaveProperty("position");
    });
});

/**
 * Where the frame is drawn, read from the renderer.
 *
 * Every number above is already right, and that is the point: the band the user reported was not in the arithmetic
 * but in the drawing — a border taken out of the card's rect put the canvas between the picture and the frame
 * (#360). So this reads the renderer, the way `overlay-z-index.test.ts` reads the source for the numbers it cannot
 * reach any other way.
 */
describe("the frame around that box", () => {
    const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/components/canvas/canvas-node.tsx");

    test("the frame is drawn outside the card's rect, which is the picture's rect (#360)", async () => {
        const raw = await readFile(source, "utf8");
        // The frame's element, pinned to the rect and pulled out by its own thickness: with `box-sizing: border-box`
        // that leaves its content box — the area the picture is painted in — exactly the rect. Filling the rect
        // with the frame instead, as `h-full w-full` did, is what took 4px out of the picture on every side.
        expect(raw).toMatch(/<div\s+className="absolute overflow-visible"/);
        expect(raw).toContain("inset: -NODE_CARD_FRAME");
        expect(raw).toContain("borderWidth: NODE_CARD_FRAME");
        // One number for the frame and one for the corner, drawn from here rather than from utility classes
        // (`rounded-3xl border-2` was the old pair, and the renderer had no way to agree with it).
        expect(raw).not.toContain("rounded-3xl");
        // Content keeps the frame's inner curve: clipped to the outer one, the canvas shows at four corners too.
        expect(raw).toContain("const CONTENT_RADIUS = NODE_CARD_RADIUS - NODE_CARD_FRAME;");
        expect(raw).toContain("borderRadius: CONTENT_RADIUS");
    });
});
