import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { toast } from "@/components/kit/toast";
import { requestEdit, requestGeneration, requestImageAngle } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { cropDataUrl, splitDataUrl } from "@/lib/canvas/canvas-image-data";
import { nodeSizeFromShape } from "@/lib/canvas/canvas-node-size";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import type { CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import type { CanvasOutpaintPayload } from "@/components/canvas/canvas-node-outpaint-dialog";
import type { CanvasMossLayoutPayload } from "@/components/canvas/canvas-node-moss-layout-dialog";
import type { CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { buildImageGenerationMetadata, buildStepNodeMetadata, imageMetadata, referenceUrl } from "@/lib/canvas/canvas-node-factory";
import { IMAGE_ANGLE_WORKFLOW, IMAGE_UPSCALE_WORKFLOW } from "@/lib/canvas/tool-workflows";
import { buildAngleLabel, buildAnglePrompt, buildGenerationConfig, isGenerationCanceled } from "@/lib/canvas/canvas-generation-helpers";
import { NODE_STATUS_ERROR, NODE_STATUS_IDLE, NODE_STATUS_LOADING } from "@/lib/canvas/canvas-node-status";
import type { NodeEditorDeps } from "@/pages/canvas/hooks/node-editor-deps";

/**
 * The editors that make a new image node out of an existing one: crop, split, mask, outpaint,
 * MOSS layout, upscale and multi-angle. Each one appends children, wires connections, opens the
 * composer on the result and (where it generates) drives one generation request.
 */
export function useImageEditors(deps: NodeEditorDeps) {
    const { setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId, setRunningNodeId, closeNodeTool, startGenerationRequest, finishGenerationRequest } = deps;
    const { t } = useTranslation();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openPreferences = useConfigStore((state) => state.openPreferences);

    const cropImageNode = useCallback(
        async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
            if (!node.metadata?.content) return;
            // The source is re-drawn in the browser, so it can be refused (a file that is gone, a server
            // that answers no CORS for it). Reporting that is better than a child node appearing empty.
            const cropped = await cropDataUrl(node.metadata.content, crop).catch(() => "");
            if (!cropped) return toast.error(t("common.imageReadFailed"));
            const image = await uploadImage(cropped);
            const width = Math.min(node.width, Math.max(220, image.width));
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width,
                height: width * (image.height / image.width),
                // No prompt: a crop answered nothing. Copying the source's words here made the node look
                // like a run that could be asked again, which a browser-side crop can never be (#297).
                metadata: imageMetadata(image),
            };
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            closeNodeTool();
        },
        [t],
    );

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            closeNodeTool();
            const pieces = await splitDataUrl(node.metadata.content, params).catch(() => []);
            if (!pieces.length) return toast.error(t("common.imageReadFailed"));
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        // Likewise no prompt: a piece of a picture was not generated either (#297).
                        metadata: imageMetadata(image),
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            toast.success(t("canvas.runtime.splitSuccess", { count: childNodes.length }));
        },
        [t],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            // The only way in is a model's inpaint mode (docs/decisions.md #330), so the run is an inpaint run by
            // definition and the mask is the binary one the workflow takes — not a picture of the marks.
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                count: "1",
                size: node.metadata?.size || "auto",
                imageMode: "inpaint",
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openPreferences();
                return;
            }
            const prompt = payload.prompt.trim();
            closeNodeTool();
            // Two files, two jobs. The drawn mask is the source with the marks on it: it is what the mask node
            // shows, so reopening it looks like what was painted. The binary one is white-on-transparent, which
            // is what SetLatentNoiseMask reads, and it is the file the node binds as its mask.
            const drawnMask = await uploadImage(payload.maskDataUrl);
            const generationMask = await uploadImage(payload.binaryMaskDataUrl);
            const maskNodeId = nanoid();
            const childId = nanoid();
            const source = { id: node.id, name: `${node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const sentMask = { id: maskNodeId, name: "mask.png", type: generationMask.mimeType || "image/png", dataUrl: generationMask.url, storageKey: generationMask.storageKey };
            const references = [source, sentMask];
            const maskBinding = sentMask.storageKey ? { mask: { storageKey: sentMask.storageKey, mimeType: sentMask.type } } : {};
            const generationMetadata = buildImageGenerationMetadata(generationConfig, references);
            const childMetadata = { prompt, status: NODE_STATUS_LOADING, ...generationMetadata };
            setNodes((prev) => [
                ...prev,
                {
                    id: maskNodeId,
                    type: CanvasNodeType.Image,
                    position: { x: node.position.x, y: node.position.y + node.height + 96 },
                    width: node.width,
                    height: node.height,
                    metadata: { ...imageMetadata(drawnMask), ...maskBinding },
                },
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: childMetadata,
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }, { id: nanoid(), fromNodeId: maskNodeId, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, prompt, references, { signal: controller.signal });
                // The card it lands in is the one it was made for: the mask run is asked for the source's own
                // size, so the child was drawn at the source's box and nothing here moves it (#354).
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, ...imageMetadata(image), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.maskFailed");
                toast.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, openPreferences, startGenerationRequest, t],
    );

    const outpaintImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasOutpaintPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                count: "1",
                size: "auto",
                imageMode: "outpaint",
                outpaint: { left: payload.left, top: payload.top, right: payload.right, bottom: payload.bottom, width: payload.width, height: payload.height },
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openPreferences();
                return;
            }
            closeNodeTool();
            const childId = nanoid();
            const source = { id: node.id, name: `${node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const references = [source];
            const generationMetadata = buildImageGenerationMetadata(generationConfig, references);
            // The outpaint dialog states the canvas it asked for, so the card is drawn at that shape now —
            // inside the source card's box, as the result used to be fitted into it after the run. Waiting for
            // the run to say it would resize a card that was already showing itself at the right shape (#354).
            const askedBox = nodeSizeFromShape({ width: payload.width, height: payload.height }, node.width, node.height);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    ...askedBox,
                    metadata: { prompt: payload.prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, payload.prompt, references, { signal: controller.signal });
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, ...imageMetadata(image), prompt: payload.prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.outpaint.failed");
                toast.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, openPreferences, startGenerationRequest],
    );

    const mossLayoutImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasMossLayoutPayload) => {
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                count: "1",
                size: `${payload.width || 1024}x${payload.height || 1024}`,
                imageMode: "layout",
                layout: payload,
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openPreferences();
                return;
            }
            closeNodeTool();
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, imageMode: "layout", layout: payload } } : item)));
            const childId = nanoid();
            const generationMetadata = buildImageGenerationMetadata(generationConfig, []);
            // A layout carries the canvas it was drawn on, so the card is drawn at that shape before the run
            // rather than resized to it afterwards (#354).
            const askedBox = nodeSizeFromShape({ width: payload.width || 1024, height: payload.height || 1024 }, node.width, node.height);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    ...askedBox,
                    metadata: { prompt: payload.summary, status: NODE_STATUS_LOADING, layout: payload, ...generationMetadata },
                },
            ]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestGeneration(generationConfig, payload.summary, { signal: controller.signal });
                if (!image) throw new Error(t("canvas.mossLayout.noImage"));
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, ...imageMetadata(image), prompt: payload.summary, layout: payload, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.mossLayout.failed");
                toast.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, openPreferences, startGenerationRequest],
    );

    const upscaleImageNode = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            const childId = nanoid();
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    // An upscaler is handed a picture, not a size: its answer is the same picture with more
                    // pixels in it, so the card is drawn at the source card's shape and the run only fills it
                    // (#354, #293).
                    width: node.width,
                    height: node.height,
                    // The workflow, not the canvas's model: an upscale is `image-esrgan-upscale` whatever the
                    // node being upscaled was made with (#293). No params and no prompt — the model is the
                    // workflow's default until someone chooses another, and an upscaler is asked nothing —
                    // and nothing runs until the node's own send button is pressed (#301).
                    metadata: { ...buildStepNodeMetadata(effectiveConfig, IMAGE_UPSCALE_WORKFLOW), status: NODE_STATUS_IDLE },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
        },
        [effectiveConfig, t],
    );

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openPreferences();
                return;
            }
            const childId = nanoid();
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const sourceReference = {
                id: node.id,
                name: `${node.id}.png`,
                type: node.metadata.mimeType || "image/png",
                dataUrl: node.metadata.content,
                storageKey: node.metadata.storageKey,
            };
            // The angle workflow is what this run submits, so it is what the node is — not the model of the
            // picture it re-renders, which is what `buildImageGenerationMetadata` would echo. The knobs go
            // with it, so the panel shows the angle that was asked for instead of the workflow's defaults.
            const reference = referenceUrl(sourceReference);
            const generationMetadata = {
                ...buildStepNodeMetadata(effectiveConfig, IMAGE_ANGLE_WORKFLOW, { horizontalAngle: params.horizontalAngle, pitchAngle: params.pitchAngle, cameraDistance: params.cameraDistance }),
                ...(reference ? { references: [reference] } : {}),
            };
            closeNodeTool();
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    // The re-render is of this picture, at this picture's shape: a step is given one, not a
                    // size, so the card is drawn at the source card's box and the run only fills it (#354).
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestImageAngle(generationConfig, prompt, params, [sourceReference], { signal: controller.signal });
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, ...imageMetadata(image), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.generationFailed");
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, openPreferences, startGenerationRequest, t],
    );

    return { cropImageNode, splitImageNode, maskEditImageNode, outpaintImageNode, mossLayoutImageNode, upscaleImageNode, generateAngleNode };
}
