import { useCallback, useRef } from "react";
import type { ChangeEvent, Dispatch, DragEvent, RefObject, SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/kit/toast";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { isAudioFile } from "@/lib/canvas/canvas-generation-helpers";
import { VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH } from "@/lib/canvas/canvas-generated-video";
import { audioMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitBox, IMAGE_CARD_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { NODE_STATUS_SUCCESS } from "@/lib/canvas/canvas-node-status";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type ContextMenuState, type Position } from "@/types/canvas";

/**
 * How content gets onto the canvas: files chosen from a picker, files dropped on it, an image or a
 * block of text read out of the system clipboard.
 *
 * Everything here answers one question — "the user handed me a File or a string, make it a node" —
 * and none of it reads the graph. That is what makes it a module: the only state it needs from the
 * page is where the viewport is looking, and the only thing it needs to give back is the hidden
 * file input the picker clicks through.
 */
export type ContentIngressDeps = {
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    containerRef: RefObject<HTMLDivElement | null>;
    size: { width: number; height: number };
    screenToCanvas: (clientX: number, clientY: number) => Position;
    getCanvasCenter: () => Position;
};

/** The files a drop, a paste or the picker may carry: what this canvas knows how to hold. */
function acceptedFiles(list: FileList | null): File[] {
    return Array.from(list || []).filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/") || isAudioFile(file));
}

export function useContentIngress(deps: ContentIngressDeps) {
    const { setNodes, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId, setContextMenu, containerRef, size, screenToCanvas, getCanvasCenter } = deps;
    const { t } = useTranslation();
    // A card that will hold a run's picture is drawn at that run's shape, so even the node this hook makes out of
    // a clipboard is sized through the same question (#359).
    const effectiveConfig = useEffectiveConfig();

    // The hidden <input type="file"> in the page's JSX. Not a dependency the page passes in: the
    // module owns the picker, so it owns the element the picker clicks.
    const imageInputRef = useRef<HTMLInputElement>(null);

    /**
     * Report a file that could not be added.
     *
     * Uploading is a network write, so it can fail (the server is down, the file is past the size limit),
     * and a drop or a paste has no form to show it in: without this the rejection ended in the console and
     * the person was left wondering why nothing appeared.
     */
    const failAdd = useCallback(
        (error: unknown) => {
            console.warn("adding a file to the canvas failed", error);
            toast.error(t("canvas.runtime.addFileFailed"));
        },
        [t],
    );

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = fitBox({ width: image.width, height: image.height }, IMAGE_CARD_MAX_SIZE);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitBox({ width: video.width || 1280, height: video.height || 720 }, { width: VIDEO_NODE_MAX_WIDTH, height: VIDEO_NODE_MAX_HEIGHT });
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(effectiveConfig, CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.runtime.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [effectiveConfig, getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            await createImageFileNode(file, getCanvasCenter()).catch(failAdd);
            toast.success(t("canvas.runtime.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) toast.success(t("canvas.runtime.clipboardTextAdded"));
    }, [createImageFileNode, createTextNodeFromClipboard, failAdd, getCanvasCenter, t]);

    /**
     * Open the picker. Every file it returns becomes a node of its own, exactly as a dropped or pasted one
     * does: a node's media is made with the node — a run's output, or the user's own file
     * (docs/decisions.md #228). There is no "put this file into that node": to keep a node's place in the
     * graph and change what is in it, the agent makes a node and rewires it, which is the same thing with
     * every step visible.
     */
    const handleUploadRequest = useCallback(() => {
        imageInputRef.current?.click();
    }, []);

    /**
     * Put files on the canvas: one node each, staggered from where they arrived.
     *
     * The body of a drop and of the picker (a paste is one image, at the centre, and already its own line).
     * Everything the user brings in becomes a node here or beside here: nothing in this module hands a file
     * to a node that already exists, because a node's media is made with the node (docs/decisions.md #228).
     */
    const addFiles = useCallback(
        (files: File[], base: Position) => {
            const STAGGER = 40; // Offset between multiple incoming files.
            for (let i = 0; i < files.length; i++) {
                const position = { x: base.x + i * STAGGER, y: base.y + i * STAGGER };
                const file = files[i];
                if (isAudioFile(file)) {
                    void createAudioFileNode(file, position).catch(failAdd);
                } else if (file.type.startsWith("video/")) {
                    void createVideoFileNode(file, position).catch(failAdd);
                } else {
                    void createImageFileNode(file, position).catch(failAdd);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, failAdd],
    );

    const handleImageInputChange = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => {
            const files = acceptedFiles(event.target.files);
            // Cleared before the uploads start, so picking the same file twice fires a change both times.
            event.target.value = "";
            if (!files.length) return;
            const box = containerRef.current?.getBoundingClientRect();
            addFiles(files, screenToCanvas((box?.left || 0) + size.width / 2, (box?.top || 0) + size.height / 2));
        },
        [addFiles, containerRef, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            addFiles(acceptedFiles(event.dataTransfer.files), screenToCanvas(event.clientX, event.clientY));
        },
        [addFiles, screenToCanvas],
    );

    return { imageInputRef, handleUploadRequest, handleImageInputChange, handleDrop, pasteSystemClipboard };
}
