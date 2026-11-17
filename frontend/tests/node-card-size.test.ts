import { describe, expect, test } from "vitest";

import { getNodeSpec } from "../src/constant/canvas";
import { cardBoxForRun, NODE_MIN_SIZE, nodeSizeForRun } from "../src/lib/canvas/canvas-node-size";
import { applyGeneratedImage, applyNodeConfigPatch, createCanvasNode } from "../src/lib/canvas/canvas-node-factory";
import { applyGeneratedVideo } from "../src/lib/canvas/canvas-generated-video";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

/**
 * A card's box is the shape of the ask, never the shape of the answer.
 *
 * The bug this is the counter to: an empty image card was the type table's 340×240, and when the picture
 * landed the card was resized around it — so the same card the user had been looking at was a different
 * size the moment it had something in it, and a portrait run made a smaller card than the placeholder it
 * replaced (#354). These tests hold the two halves of the rule: a card is drawn at the shape its run is
 * asked for, and filling it changes only what is inside it.
 */

const IMAGE_SPEC = getNodeSpec(CanvasNodeType.Image);

function emptyCard(type: CanvasNodeType, box = { width: 300, height: 200 }, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id: `card-${type}`, type, position: { x: 40, y: 60 }, ...box, metadata: { content: "", status: "idle", ...metadata } };
}

function picture(width: number, height: number) {
    return { url: "http://127.0.0.1:8190/api/canvases/abc/files/task_1.png", storageKey: "files/task_1.png", width, height, bytes: 100, mimeType: "image/png" };
}

function clip(width: number, height: number) {
    return { url: "http://127.0.0.1:8190/api/canvases/abc/files/task_1.mp4", storageKey: "files/task_1.mp4", bytes: 100, mimeType: "video/mp4", width, height };
}

describe("the box an empty card is drawn at", () => {
    test("a square ask makes a square card, not the type table's wide one", () => {
        const box = nodeSizeForRun(emptyCard(CanvasNodeType.Image), { size: "1024x1024" });
        expect(box).toEqual({ width: IMAGE_SPEC.height, height: IMAGE_SPEC.height });
        expect(box.width).toBeLessThan(IMAGE_SPEC.width);
    });

    test("a ratio the panel offers is kept, not bent to the card", () => {
        const wide = nodeSizeForRun(emptyCard(CanvasNodeType.Image), { size: "1536x864" });
        expect(wide.width / wide.height).toBeCloseTo(16 / 9, 4);
        expect(wide.width).toBe(IMAGE_SPEC.width);

        const tall = nodeSizeForRun(emptyCard(CanvasNodeType.Image), { size: "864x1536" });
        expect(tall.width / tall.height).toBeCloseTo(9 / 16, 4);
        // A tall shape fitted into a wide card would come out narrower than any card the canvas will hold
        // (#270 states that floor to the agent), so the pair grows instead.
        expect(tall.width).toBeGreaterThanOrEqual(NODE_MIN_SIZE.width);
        expect(tall.height).toBeGreaterThanOrEqual(NODE_MIN_SIZE.height);
    });

    test("`auto` and a bare ratio are answered the way the run answers them", () => {
        // A picture run with `auto` draws at the graph's own resolution, which is a square (#306); a bare
        // ratio is drawn at the scale the panel's own scale pill implies.
        for (const size of ["auto", "", "1:1"]) {
            const box = nodeSizeForRun(emptyCard(CanvasNodeType.Image), { size });
            expect(box.width).toBeCloseTo(box.height, 4);
        }
        const ratio = nodeSizeForRun(emptyCard(CanvasNodeType.Image), { size: "16:9" });
        expect(ratio.width / ratio.height).toBeCloseTo(16 / 9, 4);
    });

    test("the node's own setting is asked first, the canvas's next", () => {
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 }, { size: "1536x864" });
        const own = nodeSizeForRun(card, { size: "1024x1024" });
        expect(own.width / own.height).toBeCloseTo(16 / 9, 4);
        const inherited = nodeSizeForRun(emptyCard(CanvasNodeType.Image), { size: "1024x1024" });
        expect(inherited.width).toBeCloseTo(inherited.height, 4);
    });

    test("a film's card holds the shape its run will be told, and the tier does not move it", () => {
        const automatic = nodeSizeForRun(emptyCard(CanvasNodeType.Video), { size: "auto", vquality: "720" });
        expect(automatic.width / automatic.height).toBeCloseTo(16 / 9, 4);
        const square = nodeSizeForRun(emptyCard(CanvasNodeType.Video, { width: 300, height: 300 }, { size: "1024x1024" }), { size: "1024x1024" });
        expect(square.width).toBeCloseTo(square.height, 4);
        // A tier changes how many pixels the clip is rendered at, not what shape it is.
        expect(nodeSizeForRun(emptyCard(CanvasNodeType.Video), { size: "1280x720", vquality: "720" })).toEqual(nodeSizeForRun(emptyCard(CanvasNodeType.Video), { size: "1920x1080", vquality: "1080" }));
    });

    test("a card with no shape to hold keeps the card its type starts with", () => {
        for (const type of [CanvasNodeType.Audio, CanvasNodeType.Text, CanvasNodeType.Group, CanvasNodeType.Lora]) {
            const spec = getNodeSpec(type);
            expect(nodeSizeForRun(emptyCard(type), { size: "864x1536" })).toEqual({ width: spec.width, height: spec.height });
        }
    });
});

describe("a card created for a run carries that box", () => {
    test("a new picture card is the shape the canvas is set to draw", () => {
        const centre = { x: 500, y: 400 };
        const node = createCanvasNode(CanvasNodeType.Image, centre, { size: "1024x1024" });
        expect(node.width).toBeCloseTo(node.height, 4);
        expect(node.position).toEqual({ x: centre.x - node.width / 2, y: centre.y - node.height / 2 });
    });

    test("a new film card is the shape its run will render", () => {
        const node = createCanvasNode(CanvasNodeType.Video, { x: 500, y: 400 }, { size: "9:16", vquality: "720" });
        expect(node.width / node.height).toBeCloseTo(9 / 16, 4);
        expect(node.width).toBeGreaterThanOrEqual(NODE_MIN_SIZE.width);
    });

    test("a card the canvas has no settings for still gets a card it can be clicked on", () => {
        const node = createCanvasNode(CanvasNodeType.Audio, { x: 10, y: 10 }, { seconds: "6" });
        const spec = getNodeSpec(CanvasNodeType.Audio);
        expect({ width: node.width, height: node.height }).toEqual({ width: spec.width, height: spec.height });
    });
});

describe("filling a card does not move it", () => {
    test("a picture lands in the box that was made for it, and the card keeps its size", () => {
        const card = createCanvasNode(CanvasNodeType.Image, { x: 500, y: 400 }, { size: "1024x1024" });
        const filled = applyGeneratedImage(card, picture(1024, 1024));
        // The sentence the bug report asked for: the same card, empty and full, the same size.
        expect({ width: filled.width, height: filled.height, position: filled.position }).toEqual({ width: card.width, height: card.height, position: card.position });
        expect(filled.metadata?.naturalWidth).toBe(1024);
        expect(filled.metadata?.naturalHeight).toBe(1024);
    });

    test("a run that answers with a different shape is drawn inside the card, not by resizing it", () => {
        const card = createCanvasNode(CanvasNodeType.Image, { x: 500, y: 400 }, { size: "1024x1024" });
        const filled = applyGeneratedImage(card, picture(1920, 1080));
        expect({ width: filled.width, height: filled.height }).toEqual({ width: card.width, height: card.height });
    });

    test("the same for a film: the clip does not restyle the card", () => {
        const card = createCanvasNode(CanvasNodeType.Video, { x: 500, y: 400 }, { size: "1024x1024", vquality: "720" });
        const filled = applyGeneratedVideo(card, clip(1920, 1080), { prompt: "panned left" });
        expect({ width: filled.width, height: filled.height, position: filled.position }).toEqual({ width: card.width, height: card.height, position: card.position });
        expect(filled.metadata?.prompt).toBe("panned left");
    });
});

describe("a settings change moves an empty card and never a filled one", () => {
    test("an empty card takes the shape the panel just picked", () => {
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 });
        const next = applyNodeConfigPatch(card, { size: "1536x864" });
        expect(next.width / next.height).toBeCloseTo(16 / 9, 4);
        expect(next.metadata?.size).toBe("1536x864");
    });

    test("a card that holds a picture keeps that picture's shape (#264)", () => {
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 }, { content: "http://example/x.png", naturalWidth: 300, naturalHeight: 200 });
        const next = applyNodeConfigPatch(card, { size: "1536x864" });
        expect({ width: next.width, height: next.height }).toEqual({ width: 300, height: 200 });
        expect(next.metadata?.size).toBe("1536x864");
    });

    test("a setting that decides no shape leaves a box alone", () => {
        const card = createCanvasNode(CanvasNodeType.Image, { x: 500, y: 400 }, { size: "1024x1024" });
        const next = applyNodeConfigPatch(card, { seed: "424242", seedFixed: "true" });
        expect({ width: next.width, height: next.height, position: next.position }).toEqual({ width: card.width, height: card.height, position: card.position });
        expect(next.metadata?.seed).toBe("424242");
    });
});

describe("a step is handed a picture, not a size", () => {
    test("a run that states no size leaves the card it was made with", () => {
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 });
        expect(cardBoxForRun(card, {})).toEqual({});
        expect(cardBoxForRun(card, undefined)).toEqual({});
    });

    test("a run asked for the shape the card already has answers with nothing to change", () => {
        const square = nodeSizeForRun(emptyCard(CanvasNodeType.Image), { size: "1024x1024" });
        const card = emptyCard(CanvasNodeType.Image, square);
        expect(cardBoxForRun(card, { size: "1024x1024" })).toEqual({});
    });

    test("a run asked for another shape settles the card once, before it starts — and leaves its corner alone", () => {
        const card = emptyCard(CanvasNodeType.Image, { width: 300, height: 200 });
        const asked = nodeSizeForRun(card, { size: "1024x1024" });
        expect(asked.width).toBeCloseTo(asked.height, 4);
        const box = cardBoxForRun(card, { size: "1024x1024" });
        expect(box).toEqual(asked);
        // Only the box: the top-left stays where it was, as `resize_node` keeps it (#270).
        expect(box).not.toHaveProperty("position");
    });
});
