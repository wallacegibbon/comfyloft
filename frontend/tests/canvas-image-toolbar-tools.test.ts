import { describe, expect, it, vi } from "vitest";

import { buildImageToolbarTools } from "@/components/canvas/canvas-image-toolbar-tools";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * What a picture's bar offers, and what each button does.
 *
 * The list is the rule from #332 — the bar holds what only that *kind* of node can do — so the ids and their
 * order are the assertion: crop, split, upscale, inpaint, outpaint, multi-angle, view. The two paint verbs are
 * on the bar because the graph they run is chosen by the verb, not inherited from the card (#357): a picture
 * dragged in from outside has no model to inherit at all. Downloading, reading the facts and deleting are every
 * node's, so they are in the right-click menu and not here.
 */
function picture(): CanvasNodeData {
    return {
        id: "image-1",
        type: CanvasNodeType.Image,
        position: { x: 0, y: 0 },
        width: 340,
        height: 240,
        metadata: { content: "files/a.png", storageKey: "files/a.png", status: "idle" },
    } as CanvasNodeData;
}

function handlers() {
    return { onCrop: vi.fn(), onSplit: vi.fn(), onUpscale: vi.fn(), onInpaint: vi.fn(), onOutpaint: vi.fn(), onAngle: vi.fn(), onViewImage: vi.fn() };
}

describe("a picture's bar", () => {
    it("offers the picture's own seven verbs, in the order the bar draws them", () => {
        expect(buildImageToolbarTools(picture(), handlers()).map((tool) => tool.id)).toEqual(["crop", "split", "upscale", "inpaint", "outpaint", "angle", "view"]);
    });

    it("gives each one a label to read and a longer question to hover", () => {
        for (const tool of buildImageToolbarTools(picture(), handlers())) {
            expect(tool.label.length).toBeGreaterThan(0);
            expect(tool.title.length).toBeGreaterThan(0);
        }
    });

    it("runs the handler it was built with, and only that one", () => {
        const actions = handlers();
        const tools = buildImageToolbarTools(picture(), actions);
        tools.forEach((tool) => tool.onClick?.());
        expect(actions.onCrop).toHaveBeenCalledTimes(1);
        expect(actions.onSplit).toHaveBeenCalledTimes(1);
        expect(actions.onUpscale).toHaveBeenCalledTimes(1);
        expect(actions.onInpaint).toHaveBeenCalledTimes(1);
        expect(actions.onOutpaint).toHaveBeenCalledTimes(1);
        expect(actions.onAngle).toHaveBeenCalledTimes(1);
        expect(actions.onViewImage).toHaveBeenCalledTimes(1);
        expect(actions.onCrop.mock.calls[0][0].id).toBe("image-1");
        // The two paint verbs are handed the card they were pressed on: the mask and outpaint windows draw the
        // picture that card holds, and the run writes its answer to a new one (#357, #297).
        expect(actions.onInpaint.mock.calls[0][0].id).toBe("image-1");
        expect(actions.onOutpaint.mock.calls[0][0].id).toBe("image-1");
    });
});
