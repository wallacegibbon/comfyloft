import type { CanvasTheme } from "@/lib/canvas-theme";

/**
 * How a card is framed.
 *
 * A card's frame is the only thing on the canvas that says what a card is *to the user right now*: which one they
 * picked, which one is connected to it, which one the agent is working on, which one a wire is about to land on.
 * Those answers were four ternaries in the renderer and came out as one 2-pixel blue line for all of them, which
 * is how "did I select this one?" became a question at all (#361). They are stated here, once, as one rule per
 * state.
 *
 * One fact governs every number in this file: a frame is drawn **outside** the rectangle a card records, so
 * nothing here can change what a card is or where its picture sits (#360). A thicker frame is a louder card, not
 * a bigger picture, and that is precisely why a frame is allowed to be loud.
 */

/** The colour every "this one" signal on the canvas uses: a picked card, a wire's target, a run's own card. */
export const SELECTION_BLUE = "#2f80ff";

/** A card's resting frame. A card holding a picture has no resting frame at all — the picture is the card. */
export const NODE_CARD_FRAME = 2;

/** A card's corner: the outer curve of a resting frame. */
const NODE_CARD_RADIUS = 24;

/**
 * The frame of a card the user has picked, or of a wire's target.
 *
 * Thicker than the resting one, because the complaint it answers is "I cannot see which one is selected"
 * (#361). It costs nothing that #360 cares about: the frame grows outwards, so the picture keeps every pixel of
 * the card's rect.
 */
export const NODE_CARD_FRAME_SELECTED = 3;

/**
 * The curve a card's content is clipped to: the inner edge of the frame.
 *
 * Every state draws with `CONTENT_RADIUS + its own thickness`, so this one curve is the inner edge of every frame
 * and content is never re-clipped by a state change — a card that is picked has the same picture, to the pixel,
 * as the same card at rest.
 */
export const CONTENT_RADIUS = NODE_CARD_RADIUS - NODE_CARD_FRAME;

/** What the renderer knows about a card. It says nothing about how the card looks — that is what this answers. */
export type CardFrameState = {
    group: boolean;
    /** A card whose content is a picture has no frame of its own: the picture's rectangle is the card. A clip
     *  keeps the edge a card has at rest, as it always did — deciding otherwise is not this file's call. */
    picture: boolean;
    /** The user's selection. */
    selected: boolean;
    /** A wire the user is dragging is about to land here. */
    target: boolean;
    /** The card a run, or the agent, is working on — which is not the user's pick, and must not look like it. */
    focus: boolean;
    /** The cards around a selection: context, not candidates. */
    related: boolean;
    /** A group this drag would drop the dragged cards into. */
    dropTarget: boolean;
};

/** A card's frame as the renderer draws it. `radius` is the frame's outer curve; content keeps the inner one. */
type CardFrame = { width: number; color: string; style: "solid" | "dashed"; radius: number; shadow?: string };

/**
 * The frame that state asks for: its thickness, its colour, its corner, and the ring or glow that carries it.
 *
 * Three rules hold for every branch, and `frontend/tests/node-card-frame.test.ts` holds them. The corner is
 * always `CONTENT_RADIUS + thickness`, so a frame only ever grows outwards (#360). Only one state is answered per
 * card, in the order a user reads the canvas: the thing they are doing to it (a drop, a wire landing), what they
 * picked, what the canvas is doing, what is merely around it. And no two of those may look the same, because four
 * states sharing one line is the bug — the picked card in particular carries a ring *and* a glow, so it survives
 * sitting on top of a white picture, a dark canvas, or another card.
 */
export function cardFrameOf(state: CardFrameState, theme: CanvasTheme): CardFrame {
    const frame = (width: number, color: string, shadow?: string): CardFrame => ({ width, color, style: state.group ? "dashed" : "solid", radius: CONTENT_RADIUS + width, shadow });
    // A border alone vanished into a bright picture; the ring separates it from the card's own edge and the glow
    // from the canvas, which is what a 2px line on white could not do.
    const loud = `0 0 0 2px ${SELECTION_BLUE}59, 0 0 22px 3px ${SELECTION_BLUE}3D, 0 18px 48px rgba(0,0,0,.14)`;

    if (state.dropTarget) return frame(NODE_CARD_FRAME, SELECTION_BLUE, `0 0 0 2px ${SELECTION_BLUE}66, inset 0 0 0 999px ${SELECTION_BLUE}10`);
    if (state.selected) return frame(NODE_CARD_FRAME_SELECTED, SELECTION_BLUE, loud);
    // A wire the user is dragging is a choice not made yet, so it says so in the same loud blue with a broken line.
    if (state.target) return { ...frame(NODE_CARD_FRAME_SELECTED, SELECTION_BLUE, loud), style: "dashed" };
    if (state.focus) return frame(NODE_CARD_FRAME, SELECTION_BLUE, `0 0 0 1px ${SELECTION_BLUE}55`);
    if (state.related) return frame(NODE_CARD_FRAME, theme.node.muted, `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)`);
    // A card at rest: its own edge, and for a picture no edge at all — the picture's own rectangle is the card.
    return frame(NODE_CARD_FRAME, state.picture ? "transparent" : theme.node.stroke);
}
