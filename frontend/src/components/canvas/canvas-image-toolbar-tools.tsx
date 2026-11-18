import type { ReactNode } from "react";
import { Brush, Expand, Grid2x2, Maximize2, Rotate3d, Scissors, ZoomIn } from "lucide-react";

import type { CanvasNodeData } from "@/types/canvas";
import i18n from "@/i18n";

type ImageNodeActionToolId = "crop" | "split" | "upscale" | "inpaint" | "outpaint" | "angle" | "view";

type ImageToolHandlers = {
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onInpaint: (node: CanvasNodeData) => void;
    onOutpaint: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
};

type ImageToolDefinition = {
    id: ImageNodeActionToolId;
    /** Both are read when the bar is drawn, so the dictionary is asked at the moment the words are shown. */
    label: () => string;
    title: () => string;
    icon: () => ReactNode;
    run: (node: CanvasNodeData, handlers: ImageToolHandlers) => void;
};

// Everything here is a thing only a picture has (docs/decisions.md #332): crop, split, enlarge, repaint part of
// it, extend it, re-shoot from another angle, look at it bigger. What every node has — info, download, delete —
// lives in the right-click menu.
//
// The two mode verbs sit here beside the cuts, and they are not what #330 removed. What it removed was a mask
// button that ran *the card's own* model, which for every workflow but one is a graph that never reads the
// picture: the answer came back a fresh text-to-image of the sentence. A verb on this bar picks the graph the
// verb names instead (`modelForImageMode`), and it makes a new node rather than touching this one (#297) — so
// the picture a card holds is never rewritten by a press. The settings popover still offers the same two windows
// from the mode pills, and keeps doing it on the card's own model: that is the path for someone working inside
// one family.
const imageToolDefinitions: ImageToolDefinition[] = [
    {
        id: "crop",
        label: () => i18n.t("canvas.imageTools.crop"),
        title: () => i18n.t("canvas.imageTools.cropTitle"),
        icon: () => <Scissors className="size-4" />,
        run: (node, handlers) => handlers.onCrop(node),
    },
    {
        id: "split",
        label: () => i18n.t("canvas.imageTools.split"),
        title: () => i18n.t("canvas.imageTools.splitTitle"),
        icon: () => <Grid2x2 className="size-4" />,
        run: (node, handlers) => handlers.onSplit(node),
    },
    {
        id: "upscale",
        label: () => i18n.t("canvas.imageTools.upscale"),
        title: () => i18n.t("canvas.imageTools.upscaleTitle"),
        icon: () => <ZoomIn className="size-4" />,
        run: (node, handlers) => handlers.onUpscale(node),
    },
    {
        // A brush is the act: paint over the part to change. The mask is drawn on this picture and is what that
        // run reads; which graph runs it is chosen by the verb, never by this card (#357).
        id: "inpaint",
        label: () => i18n.t("canvas.imageTools.inpaint"),
        title: () => i18n.t("canvas.imageTools.inpaintTitle"),
        icon: () => <Brush className="size-4" />,
        run: (node, handlers) => handlers.onInpaint(node),
    },
    {
        // Arrows outward from the middle: the canvas grows past what the picture covers.
        id: "outpaint",
        label: () => i18n.t("canvas.imageTools.outpaint"),
        title: () => i18n.t("canvas.imageTools.outpaintTitle"),
        icon: () => <Expand className="size-4" />,
        run: (node, handlers) => handlers.onOutpaint(node),
    },
    {
        id: "angle",
        label: () => i18n.t("canvas.imageTools.angle"),
        title: () => i18n.t("canvas.imageTools.angleTitle"),
        // A camera says "take a picture", which is every other button here. The control behind this one is
        // the viewpoint — azimuth, pitch, distance — so the glyph is a rotation in space.
        icon: () => <Rotate3d className="size-4" />,
        run: (node, handlers) => handlers.onAngle(node),
    },
    {
        id: "view",
        label: () => i18n.t("canvas.imageTools.view"),
        title: () => i18n.t("canvas.imageTools.viewTitle"),
        icon: () => <Maximize2 className="size-4" />,
        run: (node, handlers) => handlers.onViewImage(node),
    },
];

/** The picture's verbs, in the order the bar draws them. Every one of them is the card's own; the shared ones are in the menu (#332). */
export function buildImageToolbarTools(node: CanvasNodeData, handlers: ImageToolHandlers) {
    return imageToolDefinitions.map((tool) => ({
        id: tool.id,
        label: tool.label(),
        title: tool.title(),
        icon: tool.icon(),
        onClick: () => tool.run(node, handlers),
    }));
}
