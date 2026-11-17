import { getNodeSpec } from "@/constant/canvas";
import { nodeSizeForRun, type RunShapeSettings } from "@/lib/canvas/canvas-node-size";
import { isInheritableNodeField, recallNodeSettings, rememberNodeSettings } from "@/lib/canvas/node-settings-memory";
import { activeFileUrl } from "@/services/canvas-files";
import { modelForWorkflow, modelIsStep, acceptedInputs, type AiConfig } from "@/stores/use-config-store";
import type { UploadedImage } from "@/services/image-storage";
import type { UploadedFile } from "@/services/file-storage";
import type { RunFacts } from "@/services/api/runs";
import type { ReferenceImage } from "@/types/image";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasNodeTypeId, Position } from "@/types/canvas";

/**
 * Make one node: the card it starts with, and the settings it is born with.
 *
 * A card that will hold a run's picture is drawn at the shape that run is being asked for — its own `size`
 * setting if it states one, else the canvas's, the same precedence `buildGenerationConfig` uses for those two
 * keys. That is what makes a card the same size empty and full: the box comes from the ask, and the result is
 * only ever put inside it. A step (an upscaler, an angle re-render) is told no size at all, so the callers that
 * create one write its box themselves, from the picture in front of it (#354).
 */
export function createCanvasNode(type: CanvasNodeTypeId, position: Position, metadata?: CanvasNodeMetadata, settings?: RunShapeSettings): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const finalMetadata = { ...spec.metadata, ...(recallNodeSettings(type) || {}), ...metadata };
    rememberNodeSettings(type, finalMetadata);
    const size = nodeSizeForRun({ type, metadata: finalMetadata }, settings);

    return {
        id,
        type,
        position: {
            x: position.x - size.width / 2,
            y: position.y - size.height / 2,
        },
        width: size.width,
        height: size.height,
        metadata: finalMetadata,
    };
}

/**
 * Put a run's picture into the card it was asked for: the metadata changes, the box does not.
 *
 * The card was drawn at the shape that run was told to draw, so the picture fills it. When the graph answered
 * with something else — a model that ignored the size it was given — the card keeps the shape that was asked
 * for and the picture is drawn inside it: the run's disagreement shown, rather than hidden by the card quietly
 * resizing itself (#354).
 */
export function applyGeneratedImage(node: CanvasNodeData, image: UploadedImage): CanvasNodeData {
    return { ...node, metadata: { ...node.metadata, ...imageMetadata(image) } };
}

/**
 * A node's `content` is the URL its media is *shown* from, and `storageKey` is the reference
 * (`files/<name>`) the document keeps.
 *
 * The two are not interchangeable, which is what these functions got wrong: `content` was set to the
 * reference, so a node built in this session held a `files/<name>` where every reader — a lightbox, the
 * mask and crop editors, a magnified node — expects something an `<img>` can load. It looked fine until
 * the page was reloaded, because loading a canvas is what resolves `content` to a URL
 * (`hydrateCanvasImages`). `documentOf` puts the reference back before anything is written (#152, #156).
 *
 * The URL is derived from the reference through the canvas the node belongs to, not taken from whatever
 * address the run reported: a run's absolute URL is built from the server's `PUBLIC_BASE_URL`, which is
 * wrong for a page opened through a name or a proxy that address does not mention. `activeFileUrl` asks the
 * same question every other renderer asks ("where is this canvas's file served from"), so the thumbnail and
 * the lightbox cannot disagree.
 */
export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: servedUrlOf(image), storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, ...madeBy(image) };
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return {
        content: servedUrlOf(video),
        storageKey: video.storageKey,
        status: "success",
        naturalWidth: video.width,
        naturalHeight: video.height,
        bytes: video.bytes,
        mimeType: video.mimeType || "video/mp4",
        durationMs: video.durationMs,
        ...madeBy(video),
    };
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: servedUrlOf(audio), storageKey: audio.storageKey, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs, ...madeBy(audio) };
}

/**
 * The run a file came from, as the two facts a node keeps about its own content — or nothing, for a file
 * nothing made (a picture the user picked, a crop, a mask drawn in the editor).
 *
 * It is written here, in the three builders every node's media passes through, rather than at each place a
 * node is filled: a run ends in a batch fill, an in-place regeneration, a resumed poll and a retry path, and
 * a fact that a path can forget is a fact the agent will be told it does not have (docs/decisions.md #227).
 */
function madeBy(file: { run?: RunFacts }): CanvasNodeMetadata {
    return file.run ? { workflow: file.run.workflow, generatedAt: file.run.finishedAt } : {};
}

/** The address one of these files is served at: this canvas's file URL, then the caller's, then the reference. */
function servedUrlOf(file: { url?: string; storageKey?: string }) {
    return activeFileUrl(file.storageKey) || file.url || file.storageKey || "";
}

export function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

/**
 * The record of a node a *button* created: the workflow it submitted, and the knobs it was given.
 *
 * Every editor that makes a node out of an action submits a workflow of its own — an upscale is
 * `image-esrgan-upscale` whatever the canvas is set to, an angle re-render is `image-qwen21-angle` — so
 * echoing the config's model describes a run that never happened. The node is what it is from the moment it
 * appears: a node that is already in the canvas and already spinning must say which workflow it is waiting
 * on, and a run that fails must not leave it claiming to be something else (#263).
 *
 * A workflow the model list does not offer leaves no model claim rather than the bare id
 * (`modelForWorkflow`). Its knobs are kept either way: they are what the run was told, and the field is the
 * panel's to read back.
 */
export function buildStepNodeMetadata(config: AiConfig, workflowId: string, params?: Record<string, unknown>): CanvasNodeMetadata {
    const model = modelForWorkflow(config, workflowId);
    const accepted = acceptedInputs(config, model, params);
    return { ...(model ? { model } : {}), ...(accepted ? { params: accepted } : {}) };
}

export function buildImageGenerationMetadata(config: AiConfig, references: ReferenceImage[]): CanvasNodeMetadata {
    const referencesOf = { references: references.map(referenceUrl).filter((url): url is string => Boolean(url)) };
    // A step — an upscaler — was given a picture and a model name, not a size, a quality or a mode. Writing
    // those would describe a run that never had them, and the node's own record is read back by the panel
    // and by the agent.
    if (modelIsStep(config, config.model)) return { model: config.model, ...(config.params ? { params: config.params } : {}), ...referencesOf };
    return {
        model: config.model,
        size: config.size,
        quality: config.quality,
        ...(config.background ? { background: config.background } : {}),
        ...(config.imageMode ? { imageMode: config.imageMode as CanvasNodeMetadata["imageMode"] } : {}),
        ...(config.imageMode === "layout" && config.layout ? { layout: config.layout } : {}),
        ...(config.outpaint ? { outpaint: config.outpaint } : {}),
        ...(config.params ? { params: config.params } : {}),
        ...referencesOf,
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        // The node's own length, in the field every duration lives in: the panel reads it back, and the
        // agent's `read_prompt` reports it as part of what this node is set to run (#259).
        seconds: config.audioSeconds,
        audioFormat: config.audioFormat,
        audioInstructions: config.audioInstructions,
    };
}

/**
 * Write a card's own run settings, and — while it is still empty — the box those settings describe.
 *
 * Only an empty card follows the shape of the run it is set to. A card that holds a picture is that picture's
 * shape (#264), and a setting cannot change it; only a run that replaces the picture can, and that one keeps the
 * box the card already has (#354). The two keys that decide a shape are `size` and, for a film, its tier: no
 * other setting moves a card, so changing a seed or a container leaves a box the user dragged alone.
 */
export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    if (Object.keys(safePatch).some(isInheritableNodeField)) rememberNodeSettings(next.type, next.metadata);
    if (node.metadata?.content || (typeof safePatch.size !== "string" && safePatch.vquality === undefined)) return next;
    const size = nodeSizeForRun(next);
    if (Math.abs(size.width - node.width) < 0.5 && Math.abs(size.height - node.height) < 0.5) return next;
    return { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } };
}
