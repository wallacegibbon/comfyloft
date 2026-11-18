import { Clapperboard, GalleryHorizontal, GalleryHorizontalEnd, Maximize2, Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasBar, CanvasBarButton, type CanvasBarItem } from "@/components/canvas/canvas-bar";
import { buildImageToolbarTools } from "@/components/canvas/canvas-image-toolbar-tools";
import type { VideoFramePosition } from "@/lib/canvas/canvas-video-frame";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

type CanvasNodeToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onInterpolateVideo: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onInpaint: (node: CanvasNodeData) => void;
    onOutpaint: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    /** Opens the node's media at its own size — the clip's button, and the picture's `view` tool both. */
    onView: (node: CanvasNodeData) => void;
    onCaptureVideoFrame: (node: CanvasNodeData, position: VideoFramePosition) => void;
};

/**
 * The bar over a **selected** node, and only what that *kind* of node can do (docs/decisions.md #332): a clip
 * gets interpolate, a frame grab and view, a picture gets crop, split, upscale, the two paint verbs, an angle
 * re-render and view, a text card gets its font size. What every node has — information, download, delete,
 * duplicate, grouping — is in the right-click menu, and a node with no verbs of its own (a group, an empty
 * audio card) gets no bar at all.
 *
 * Selection, not hover: it was called the hover toolbar and appeared under the pointer (#192), and since the
 * verbs became the card's own it is drawn for the one selected card, which is also the only card whose panel can
 * be open. Hovering still means something — the card under the pointer is the one the related cards light up
 * with — but that is the board's job, not this bar's.
 */
export function CanvasNodeToolbar({ node, viewport, onDecreaseFont, onIncreaseFont, onInterpolateVideo, onCrop, onSplit, onUpscale, onInpaint, onOutpaint, onAngle, onView, onCaptureVideoFrame }: CanvasNodeToolbarProps) {
    const { t } = useTranslation();
    if (!node) return null;

    const left = viewport.x + (node.position.x + node.width / 2) * viewport.k;
    const top = viewport.y + node.position.y * viewport.k - 14;
    const isImage = node.type === CanvasNodeType.Image;
    const isVideo = node.type === CanvasNodeType.Video;
    const isText = node.type === CanvasNodeType.Text;
    const hasImage = isImage && Boolean(node.metadata?.content);
    const hasVideo = isVideo && Boolean(node.metadata?.content);

    const tools: CanvasBarItem[] = [
        ...(hasVideo
            ? [
                  { id: "videoInterpolate", title: t("canvas.nodeToolbar.interpolateTitle"), label: t("canvas.nodeToolbar.interpolate"), icon: <Clapperboard className="size-4" />, onClick: () => onInterpolateVideo(node) },
                  // A frame grab is three answers to one question, so it is one button with a menu: the three of them
                  // in the bar would be wider than the card they sit over (#333).
                  {
                      id: "captureFrame",
                      title: t("canvas.nodeToolbar.captureFrameTitle"),
                      label: t("canvas.nodeToolbar.captureFrame"),
                      icon: <GalleryHorizontal className="size-4" />,
                      menu: [
                          // Lucide has `gallery-horizontal-end` and no start, so the first frame is that glyph
                          // mirrored: the pair reads as one strip with the marker at either end.
                          { id: "firstFrame", label: t("canvas.videoFrames.first"), icon: <GalleryHorizontalEnd className="size-4 -scale-x-100" />, onClick: () => onCaptureVideoFrame(node, "first") },
                          { id: "lastFrame", label: t("canvas.videoFrames.last"), icon: <GalleryHorizontalEnd className="size-4" />, onClick: () => onCaptureVideoFrame(node, "last") },
                          { id: "currentFrame", label: t("canvas.videoFrames.current"), icon: <GalleryHorizontal className="size-4" />, onClick: () => onCaptureVideoFrame(node, "current") },
                      ],
                  },
                  // The card's double click opens a clip at its own size, and a gesture nobody can see is not a tool
                  // (#331). Same act as the picture's `view`, so the same glyph.
                  { id: "viewVideo", title: t("canvas.nodeToolbar.viewVideoTitle"), label: t("canvas.nodeToolbar.viewVideo"), icon: <Maximize2 className="size-4" />, onClick: () => onView(node) },
              ]
            : []),
        ...(isText
            ? [
                  // The label, not just the tooltip, has to say *what* gets smaller: with the words always on
                  // (#332), "缩小" over a text card reads as zooming the canvas, which it does not do.
                  { id: "decreaseFont", title: t("canvas.nodeToolbar.decreaseFont"), label: t("canvas.nodeToolbar.decreaseFont"), icon: <Minus className="size-4" />, onClick: () => onDecreaseFont(node) },
                  { id: "increaseFont", title: t("canvas.nodeToolbar.increaseFont"), label: t("canvas.nodeToolbar.increaseFont"), icon: <Plus className="size-4" />, onClick: () => onIncreaseFont(node) },
              ]
            : []),
        ...(hasImage ? buildImageToolbarTools(node, { onCrop, onSplit, onUpscale, onInpaint, onOutpaint, onAngle, onViewImage: onView }) : []),
    ];

    if (!tools.length) return null;

    // Under the canvas chrome, with the node it belongs to: the bars, the dock and the side panel are the
    // board's frame, and a node that slides under them takes its toolbar along (#192). At 70 it was drawn
    // *over* the panel while the node itself was under it, which reads as a floating tool attached to nothing.
    return (
        <CanvasBar left={left} top={top} nodeId={node.id}>
            {tools.map((tool) => (
                <CanvasBarButton key={tool.id} {...tool} />
            ))}
        </CanvasBar>
    );
}
