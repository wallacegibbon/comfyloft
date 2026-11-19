import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { toast } from "@/components/kit/toast";
import { requestEdit, requestGeneration, requestImageAngle } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { cropDataUrl, splitDataUrl } from "@/lib/canvas/canvas-image-data";
import { fitBox, nodeShape } from "@/lib/canvas/canvas-node-size";
import { planRunShape, runAskOf } from "@/lib/canvas/run-shape";
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
import { imageModeRefusalKey, modelForImageMode } from "@/lib/canvas/image-mode";
import { serverVariantLabel } from "@/lib/server-labels";
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
            // A crop is a picture of its own, so its card is drawn at its own shape — inside the box of the card it
            // came from, which is the rule every derived card follows (#359).
            const size = fitBox({ width: image.width, height: image.height }, { width: node.width, height: node.height });
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: size.width,
                height: size.height,
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
            const uploaded = await Promise.all(pieces.map((piece) => uploadImage(piece.dataUrl)));
            // An even split makes every piece the same shape, so one box is the grid's cell: that shape, inside the
            // cell the source card's grid implies. Deriving it from the pieces rather than from the source card's
            // box is what keeps a cell the shape of the picture inside it (#359).
            const cell = fitBox({ width: uploaded[0]!.width, height: uploaded[0]!.height }, { width: node.width / params.columns, height: node.height / params.rows });
            const gap = 16;
            const cellWidth = cell.width;
            const cellHeight = cell.height;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = uploaded.map((image, index) => {
                const piece = pieces[index]!;
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
            });
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
            // The verb names the graph, so the graph is chosen here rather than inherited: the card may be
            // material (#297) or a run of a workflow that takes no pictures at all, and sending "inpaint" to one
            // of those is #267's request for something the graph cannot do. The card's own model still wins when
            // it declares the mode — that is the settings-popover path — and the answer is recorded on the child
            // this run writes into, never back onto the picture (#357).
            const wanted = modelForImageMode(effectiveConfig, node.metadata?.model, "inpaint");
            if (!wanted.ok) {
                toast.warning(t(imageModeRefusalKey(wanted.reason), { label: serverVariantLabel("inpaint", "inpaint") }));
                openPreferences();
                return;
            }
            // The run is an inpaint run by definition, and the mask is the binary one the workflow takes — not a
            // picture of the marks.
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                model: wanted.model,
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
            // Both cards are the source picture's shape, and the graph says so: an inpaint is handed a picture and
            // keeps its shape, so neither is drawn at the box the source card happens to have — a drag may have
            // changed that (#359). The mask is the same canvas with marks on it, so it matches the result.
            const childBox = fitBox(planRunShape(generationConfig, CanvasNodeType.Image, runAskOf(generationMetadata, generationConfig), nodeShape(node)).shape || nodeShape(node), { width: node.width, height: node.height });
            const maskBox = fitBox(nodeShape(node), { width: node.width, height: node.height });
            setNodes((prev) => [
                ...prev,
                {
                    id: maskNodeId,
                    type: CanvasNodeType.Image,
                    position: { x: node.position.x, y: node.position.y + node.height + 96 },
                    ...maskBox,
                    metadata: { ...imageMetadata(drawnMask), ...maskBinding },
                },
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    ...childBox,
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
            // Same rule as the mask run: 扩图 is a graph, not a setting, so the workflow that has it is chosen by
            // the verb and recorded on the child (#357, #267).
            const wanted = modelForImageMode(effectiveConfig, node.metadata?.model, "outpaint");
            if (!wanted.ok) {
                toast.warning(t(imageModeRefusalKey(wanted.reason), { label: serverVariantLabel("outpaint", "outpaint") }));
                openPreferences();
                return;
            }
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                model: wanted.model,
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
            const askedBox = fitBox({ width: payload.width, height: payload.height }, { width: node.width, height: node.height });
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
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, openPreferences, startGenerationRequest, t],
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
            const askedBox = fitBox({ width: payload.width || 1024, height: payload.height || 1024 }, { width: node.width, height: node.height });
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
            // The workflow, not the canvas's model: an upscale is `image-esrgan-upscale` whatever the node being
            // upscaled was made with (#293). No params and no prompt — the model is the workflow's default until
            // someone chooses another, and an upscaler is asked nothing — and nothing runs until the node's own send
            // button is pressed (#301).
            const step = buildStepNodeMetadata(effectiveConfig, IMAGE_UPSCALE_WORKFLOW);
            // More pixels in the same picture. The graph says it keeps the shape of the picture it was handed, so the
            // card is drawn at *that* shape inside the source card's box — not at the box, which a drag may have
            // changed out of step with the picture (#359).
            const shape = planRunShape(effectiveConfig, CanvasNodeType.Image, { ...runAskOf(node.metadata, effectiveConfig), model: step.model }, nodeShape(node)).shape || nodeShape(node);
            const size = fitBox(shape, { width: node.width, height: node.height });
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    ...size,
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
            // This graph draws its own square: `image-qwen21-angle` sizes its output by the resolution its
            // text-encoder node carries, so the card is drawn at that square. Copying the source card's box made a
            // landscape source's re-render come back with bands down the sides (#359).
            const shape = planRunShape(generationConfig, CanvasNodeType.Image, runAskOf(generationMetadata, generationConfig), nodeShape(node)).shape || nodeShape(node);
            const size = fitBox(shape, { width: node.width, height: node.height });
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    ...size,
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
