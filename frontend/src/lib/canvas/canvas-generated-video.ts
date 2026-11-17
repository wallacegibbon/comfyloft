import type { CanvasNodeData } from "@/types/canvas";
import type { UploadedFile } from "@/services/file-storage";
import { videoMetadata } from "@/lib/canvas/canvas-node-factory";

// A generated clip is capped on screen: a 4K result would otherwise cover the whole viewport the
// moment it lands, and the node is a thumbnail until you open it. These are the bounds a card is *drawn*
// at — a file the user handed in, a frame taken out of a clip, a join of several — and the bounds an
// empty card is drawn at before its run. The result never moves a card that already has a box (#354).
export const VIDEO_NODE_MAX_WIDTH = 420;
export const VIDEO_NODE_MAX_HEIGHT = 420;

/**
 * Swap a video node's body for a finished file. The box stays: a card's shape is the shape its run was
 * *asked* for, decided before the run, so filling it changes only what is inside it (#354).
 */
export function applyGeneratedVideo(item: CanvasNodeData, video: UploadedFile, extra: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { ...item, metadata: { ...item.metadata, ...videoMetadata(video), ...extra } };
}
