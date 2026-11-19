import { afterAll, describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

// The module under test imports the config store, which reads browser storage during initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        setItem: (key: string, value: string) => values.set(key, value),
        getItem: (key: string) => values.get(key) ?? null,
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as Record<string, unknown>).localStorage;
});

const { modeRefusalKey, pressInMode } = await import("@/lib/canvas/image-mode");

/**
 * What a press on a card in one of the paint modes means.
 *
 * A card made by an outpaint (or inpaint) run records its own ask — the canvas it stated, or the mask node
 * wired into it — so asking it again is the same ask and it is answered in place, the way every image card
 * answers (#228, #297). The window is for stating a *new* ask, which is a new shape and so a new card (#354,
 * #357). What the card cannot do either way is told to the person instead of opening a window on nothing.
 */
function card(metadata: Partial<CanvasNodeData["metadata"]>): CanvasNodeData {
    return { id: "image-1", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 1024, height: 768, metadata: metadata as CanvasNodeData["metadata"] };
}

const picture = { content: "files/source.png", storageKey: "files/source.png" };
const outpaintRun = { ...picture, model: "default::image-qwen21", imageMode: "outpaint" as const, outpaint: { left: 0, top: 0, right: 256, bottom: 0, width: 1280, height: 768 } };
const inpaintRun = { ...picture, model: "default::image-qwen21", imageMode: "inpaint" as const };

describe("a press on an outpaint card", () => {
    it("asks the card's own canvas again when the picture it extends is wired in", () => {
        expect(pressInMode(card(outpaintRun), "outpaint", { picture: true, mask: false })).toBe("run");
    });

    it("states the canvas instead when the card has none of its own", () => {
        // A card pointed at the outpaint mode but never run through it: the numbers are the ask, and the
        // window is where they are stated.
        expect(pressInMode(card(picture), "outpaint", { picture: true, mask: false })).toBe("window");
    });

    it("states the canvas again when the wire it extends is gone", () => {
        // The numbers are recorded, but a run reads only what is connected (#297) — so there is no source to
        // ask with, and the window makes a card that has one.
        expect(pressInMode(card(outpaintRun), "outpaint", { picture: false, mask: false })).toBe("window");
    });

    it("refuses a card with nothing to extend", () => {
        // Empty cards reach this branch too: the window draws on the card it was opened from, so opening it
        // here would be a button that does nothing.
        expect(pressInMode(card({ model: "default::image-qwen21", imageMode: "outpaint" }), "outpaint", { picture: false, mask: false })).toBe("refuse");
    });
});

describe("a press on an inpaint card", () => {
    it("asks again when a card carrying a mask is wired in", () => {
        expect(pressInMode(card(inpaintRun), "inpaint", { picture: true, mask: true })).toBe("run");
    });

    it("opens the mask editor for a picture that has no mask yet", () => {
        expect(pressInMode(card(picture), "inpaint", { picture: false, mask: false })).toBe("window");
    });

    it("refuses a card with nothing to paint a mask on", () => {
        expect(pressInMode(card({ model: "default::image-qwen21", imageMode: "inpaint" }), "inpaint", { picture: true, mask: false })).toBe("refuse");
    });
});

describe("the sentence for a refused press", () => {
    it("names what that mode is missing", () => {
        expect(modeRefusalKey("inpaint")).toBe("canvas.runtime.maskNodeNeeded");
        expect(modeRefusalKey("outpaint")).toBe("canvas.runtime.outpaintSourceNeeded");
    });
});
