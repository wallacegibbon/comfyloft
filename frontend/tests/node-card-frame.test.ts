import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { canvasThemes } from "../src/lib/canvas-theme";
import { cardFrameOf, CONTENT_RADIUS, NODE_CARD_FRAME, NODE_CARD_FRAME_SELECTED, SELECTION_BLUE, type CardFrameState } from "../src/lib/canvas/canvas-card-frame";

/**
 * What a card's frame says about the card.
 *
 * Four states — the user's pick, the card a run is working on, the cards around a pick, and a wire's target — were
 * drawn as one 2px blue line, so "did I select this one?" had no answer on the screen (#361). These tests hold the
 * two things that make the answer readable: the states are told apart, and none of them moves the card. The frame
 * is outside the rectangle a card records (#360), which is exactly what lets a frame be loud.
 */

const none: CardFrameState = { group: false, picture: false, selected: false, target: false, focus: false, related: false, dropTarget: false };
const at = (state: Partial<CardFrameState>): CardFrameState => ({ ...none, ...state });

/** Every state a card can be in, in the order `cardFrameOf` answers them. */
const states: Array<[string, CardFrameState]> = [
    ["rest", at({})],
    ["related", at({ related: true })],
    ["focus", at({ focus: true })],
    ["target", at({ target: true })],
    ["drop", at({ group: true, dropTarget: true })],
    ["picked", at({ selected: true })],
];

/** The states whose frame stays at the resting thickness: nothing here is a "this one" signal. */
const quiet = ["rest", "related", "focus", "drop"];

const look = (state: CardFrameState) => {
    const frame = cardFrameOf(state, canvasThemes.dark);
    return `${frame.width}|${frame.color}|${frame.style}|${frame.shadow || ""}`;
};

describe("a card's frame tells the user which card it is", () => {
    test("no two states draw the same frame (#361)", () => {
        const seen = new Map<string, string>();
        for (const [name, state] of states) {
            const drawn = look(state);
            expect(seen.has(drawn), `${name} looks identical to ${seen.get(drawn)}`).toBe(false);
            seen.set(drawn, name);
        }
    });

    test("only a pick, and a wire about to land on it, are loud", () => {
        for (const theme of [canvasThemes.dark, canvasThemes.light]) {
            for (const [name, state] of states) {
                const frame = cardFrameOf(state, theme);
                if (quiet.includes(name)) expect(frame.width, name).toBe(NODE_CARD_FRAME);
                else expect(frame.width, name).toBe(NODE_CARD_FRAME_SELECTED);
            }
            // Thicker than every quiet state — which #360 makes free, because the frame grows outwards.
            expect(NODE_CARD_FRAME_SELECTED).toBeGreaterThan(NODE_CARD_FRAME);
        }
    });

    test("the card the user picked reads on a white picture, on a dark canvas, and beside another card", () => {
        for (const theme of [canvasThemes.dark, canvasThemes.light]) {
            const picked = cardFrameOf(at({ selected: true }), theme);
            // A ring and a glow on top of the border: a 2px line alone is what the report could not see.
            expect(picked.color).toBe(SELECTION_BLUE);
            expect(picked.shadow?.split(",").length).toBeGreaterThanOrEqual(3);
            expect(cardFrameOf(at({}), theme).shadow).toBeUndefined();
            // The card a run is working on is a "this one" signal too, and must not be mistaken for the user's pick.
            const focus = cardFrameOf(at({ focus: true }), theme);
            expect(focus.color).toBe(SELECTION_BLUE);
            expect(focus.width).toBe(NODE_CARD_FRAME);
            expect(focus.shadow).not.toBe(picked.shadow);
            // Context stays in the palette's grey: nearby, never chosen.
            expect(cardFrameOf(at({ related: true }), theme).color).toBe(theme.node.muted);
            // A wire that has not landed yet says so in the same loud blue with a broken line.
            const target = cardFrameOf(at({ target: true }), theme);
            expect(target.color).toBe(SELECTION_BLUE);
            expect(target.style).toBe("dashed");
            expect(cardFrameOf(at({ selected: true, picture: true }), theme).color).toBe(SELECTION_BLUE);
        }
    });

    test("a picture at rest needs no edge, and a card of words keeps its own", () => {
        const theme = canvasThemes.dark;
        expect(cardFrameOf(at({ picture: true }), theme).color).toBe("transparent");
        expect(cardFrameOf(at({}), theme).color).toBe(theme.node.stroke);
    });

    test("a group is a group in every state, and a broken line means a group or an unfinished wire", () => {
        for (const [name, state] of states) {
            expect(cardFrameOf(at({ ...state, group: true }), canvasThemes.dark).style, name).toBe("dashed");
            const solid = name !== "target" && !state.group;
            expect(cardFrameOf(state, canvasThemes.dark).style, name).toBe(solid ? "solid" : "dashed");
        }
    });
});

describe("and none of it moves the card", () => {
    test("every frame grows outwards, so content keeps the same curve (#360)", () => {
        for (const [name, state] of states) {
            for (const theme of [canvasThemes.dark, canvasThemes.light]) {
                const frame = cardFrameOf(state, theme);
                // The corner is the content's curve plus the frame: the inner edge never moves, at any thickness.
                expect(frame.radius - frame.width, name).toBe(CONTENT_RADIUS);
            }
        }
    });

    test("the renderer draws that answer and adds nothing of its own (#360, #361)", async () => {
        const raw = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/components/canvas/canvas-node.tsx"), "utf8");
        // The frame's element, pinned to the card's rect and pulled out by its own thickness: with
        // `box-sizing: border-box` that leaves its content box — the area a picture is painted in — exactly the
        // rect. Filling the rect with the frame, as `h-full w-full` did, is what took 4px off the picture.
        expect(raw).toMatch(/<div\s+className="absolute overflow-visible"/);
        expect(raw).toContain("inset: -frame.width");
        expect(raw).toContain("borderWidth: frame.width");
        expect(raw).toContain("borderRadius: frame.radius");
        // The frame is the module's answer, not a chain of ternaries here, and its numbers are not utility classes.
        expect(raw).toContain("borderColor: frame.color");
        expect(raw).toContain("boxShadow: frame.shadow");
        expect(raw).toContain("const state: CardFrameState = {");
        expect(raw).toContain("cardFrameOf(state, theme)");
        expect(raw).not.toContain("rounded-3xl");
        // Content is clipped to the inner curve. Clipped to the outer one, the canvas shows at four corners.
        expect(raw).toContain('import { cardFrameOf, CONTENT_RADIUS, SELECTION_BLUE, type CardFrameState } from "@/lib/canvas/canvas-card-frame";');
        expect(raw).toContain("borderRadius: CONTENT_RADIUS");
    });
});
