import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { useEffectiveConfig } from "@/stores/use-config-store";
import { fitBox, nodeShape } from "@/lib/canvas/canvas-node-size";
import { planRunShape, runAskOf } from "@/lib/canvas/run-shape";
import { VIDEO_INTERPOLATE_WORKFLOW } from "@/lib/canvas/tool-workflows";
import { VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH } from "@/lib/canvas/canvas-generated-video";
import { NODE_STATUS_IDLE } from "@/lib/canvas/canvas-node-status";
import { buildStepNodeMetadata } from "@/lib/canvas/canvas-node-factory";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { NodeEditorDeps } from "@/pages/canvas/hooks/node-editor-deps";

/**
 * The editor that produces a new *video* node: frame interpolation.
 *
 * It is split from the image editors because it shares almost nothing with them beyond the spawn-select-open
 * pattern — a node whose size comes from the clip rather than from a fixed default.
 *
 * It creates the node and stops there. The multiplier is a choice (2× or 3×) and the node's own card is where
 * such a choice is made, so pressing the toolbar button configures a node and pressing that node's send button
 * runs it — the same two steps every other node on the canvas takes. Running from the button meant the first run
 * always used the default multiplier, and the user paid for a 2× pass to discover they wanted 3× (#301).
 */
export function useVideoEditors(deps: NodeEditorDeps) {
    const { setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId } = deps;
    const { t } = useTranslation();
    const effectiveConfig = useEffectiveConfig();

    const interpolateVideoNode = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            const childId = nanoid();
            // The workflow, not the canvas's model — named from the moment the node exists, so its panel is its own
            // rather than whatever the canvas falls back to (#263). No params: the multiplier is the workflow's
            // declared default until someone picks another, and no prompt, because an interpolation is asked nothing.
            const step = buildStepNodeMetadata(effectiveConfig, VIDEO_INTERPOLATE_WORKFLOW);
            // The card is drawn at the shape this run will draw, and the graph answers that: an interpolation is
            // handed a clip and keeps its shape, so the card is the clip's shape — never a tier's default, and never
            // the source *card's* box, which a drag may have changed (#359).
            const shape = planRunShape(effectiveConfig, CanvasNodeType.Video, { ...runAskOf(node.metadata, effectiveConfig), model: step.model }, nodeShape(node)).shape || nodeShape(node);
            const size = fitBox(shape, { width: VIDEO_NODE_MAX_WIDTH, height: VIDEO_NODE_MAX_HEIGHT });
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Video,
                    title: t("canvas.nodeToolbar.interpolateTitle"),
                    titleKey: "canvas.nodeToolbar.interpolateTitle",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: size.width,
                    height: size.height,
                    metadata: { ...step, status: NODE_STATUS_IDLE },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
        },
        [effectiveConfig, t],
    );

    return { interpolateVideoNode };
}
