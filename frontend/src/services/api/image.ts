import i18n from "@/i18n";
import { LOCAL_SERVER_BASE_URL, isLocalServerUrl } from "@/constant/app-mode";
import { modelImageInputs, modelIsStep, modelTakesPrompt, acceptedInputs, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { imageModeFor } from "@/lib/canvas/image-mode";
import { dataUrlToFile } from "@/lib/image-utils";
import { mediaIdOf } from "@/services/canvas-files";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { IMAGE_ANGLE_WORKFLOW } from "@/lib/canvas/tool-workflows";
import { planRunShape, type RunAsk } from "@/lib/canvas/run-shape";
import { imageToDataUrl, type UploadedImage } from "@/services/image-storage";
import type { ImageSizeProblem } from "@/lib/media-size";
import { CanvasNodeType } from "@/types/canvas";
import { apiErrorMessage, throwIfCanceled } from "@/services/api/http";
import { createRun, uploadMedia, waitForRun, type Run, type RunRequest } from "@/services/api/runs";
import { generatedImage } from "@/lib/canvas/generated-media";
import type { ReferenceImage } from "@/types/image";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

type RequestOptions = {
    signal?: AbortSignal;
    /** The exact prompt that was sent, once it is composed: the panel shows it back to the user. */
    onPrompt?: (prompt: string) => void;
    params?: Record<string, unknown>;
    /** Reported as soon as the server accepts a run, so the node can resume it after a reload. */
    onRun?: (runId: string) => void;
    onProgress?: (run: Run) => void;
    /** The agent that asked for this generation, if one did: the server tells it when the run ends. */
    askedBy?: RunRequest["askedBy"];
};

export function localServerRoot(baseUrl: string) {
    const url = String(baseUrl || "")
        .trim()
        .replace(/\/+$/, "");
    if (!isLocalServerUrl(url)) return "";
    try {
        return new URL(url).origin;
    } catch {
        return "";
    }
}

// Explicit cancellation against the local server: it does not rely on when the browser tears down the XHR.
/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/**
 * What a stated size that a run would refuse is called in the answer.
 *
 * The rule is `planStatedSize`'s — one place decides what a size means and which rule a bad one breaks — and only
 * the wording is here, so the request, the agent's `set_node` and the panel cannot describe three different rules.
 * `shapeOnly` is a spelling like "16:9": a shape is not a size, and a value this canvas stores is always a size,
 * because two readers given only a shape resolve it differently (#359).
 */
const SIZE_PROBLEM_KEYS: Record<"format" | "shapeOnly" | ImageSizeProblem, string> = {
    format: "invalidImageSizeFormat",
    shapeOnly: "invalidImageSizeFormat",
    positive: "positiveImageDimensions",
    step: "imageDimensionStep",
    edge: "imageEdgeLimit",
    ratio: "imageRatioLimit",
    pixels: "imagePixelLimit",
};

/**
 * The size to send, from the same plan the card was drawn at.
 *
 * A run is told a size only when the graph it submits takes one: `planRunShape` reads that from the published
 * contract, so a Qwen edit is not sent a `size` its graph never reads and a card is never drawn at a shape the
 * request did not ask for. A size a run would refuse is an error here, in the words of the rule it broke.
 */
function requestSize(config: AiConfig, ask: RunAsk) {
    const plan = planRunShape(config, CanvasNodeType.Image, ask);
    if (plan.problem) throw new Error(apiText(SIZE_PROBLEM_KEYS[plan.problem]));
    return plan.size;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

async function requestServerImages(input: { config: AiConfig; prompt: string; references: ReferenceImage[]; size?: string; background?: string; imageMode?: string; params: Record<string, unknown>; options?: RequestOptions }): Promise<UploadedImage> {
    const { config, prompt, references, size, background, imageMode, params, options } = input;
    // A step rather than a prompt: an upscaler is told which model and given a picture. Its inputs are the
    // ones it declares, and its media is the picture by kind — nothing here is renamed into a prompt field,
    // because sending an undeclared key is accepted and ignored, which reads as a knob that did nothing.
    if (modelIsStep(config, config.model)) return requestServerStep({ config, prompt, references, params, options });
    const inputs: Record<string, unknown> = { prompt };
    if (size) inputs.size = size;
    if (background) inputs.background = background;
    // "layout" is a MOSS mode expressed entirely by params.layout, not a workflow variant.
    if (imageMode && imageMode !== "layout") inputs.mode = imageMode;
    if (config.quality?.trim()) inputs.quality = config.quality.trim();
    Object.assign(inputs, params);
    // ...and only what this workflow reads: a key the run would ignore is not sent, so the contract, the panel and
    // the request answer with one list (#302).
    const accepted = acceptedInputs(config, config.model, inputs, imageMode) || {};

    const capacity = modelImageInputs(config, config.model);
    const usable = typeof capacity === "number" ? references.slice(0, Math.max(0, capacity)) : references;
    const media: Record<string, string[]> = {};
    for (const [index, reference] of usable.entries()) {
        const role = imageMode === "inpaint" ? (index === 0 ? "source" : "mask") : imageMode === "outpaint" ? "source" : "reference";
        media[role] = [...(media[role] || []), await mediaId(config, reference, `reference-${index + 1}.png`, options?.signal)];
    }

    try {
        const run = await createRun(config, { workflow: config.model, inputs: accepted, ...(Object.keys(media).length ? { media } : {}), askedBy: options?.askedBy });
        options?.onRun?.(run.id);
        const finished = await waitForRun(config, run.id, { signal: options?.signal, onProgress: options?.onProgress, cancelOnAbort: true });
        // The run wrote these files into the canvas; the node references them where they are (#173).
        return await generatedImage(config, finished, { signal: options?.signal });
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText("requestFailed"), "imageTimeout"));
    }
}

/**
 * Submit an image *step*: the workflow's declared parameters, and its source picture by kind.
 *
 * The count is the capacity the workflow reports (`imageInputs`), which is the same number the server
 * derives from its bindings — an upscaler takes one picture, so an extra one is not uploaded at all rather
 * than silently dropped later.
 */
async function requestServerStep(input: { config: AiConfig; prompt: string; references: ReferenceImage[]; params: Record<string, unknown>; options?: RequestOptions }): Promise<UploadedImage> {
    const { config, prompt, references, params, options } = input;
    const capacity = modelImageInputs(config, config.model);
    const usable = typeof capacity === "number" ? references.slice(0, Math.max(0, capacity)) : references;
    const media: Record<string, string[]> = {};
    for (const [index, reference] of usable.entries()) {
        media.image = [...(media.image || []), await mediaId(config, reference, `source-${index + 1}.png`, options?.signal)];
    }
    try {
        // A step is a workflow whose knobs are its own, but one of them can be words: the angle re-render is
        // told what to keep and what to change. It is sent only where the workflow binds a prompt, so a step
        // that has no such binding is not handed a field the server would refuse.
        const words = modelTakesPrompt(config, config.model) ? { prompt } : {};
        const run = await createRun(config, { workflow: config.model, inputs: { ...words, ...params }, ...(Object.keys(media).length ? { media } : {}), askedBy: options?.askedBy });
        options?.onRun?.(run.id);
        const finished = await waitForRun(config, run.id, { signal: options?.signal, onProgress: options?.onProgress, cancelOnAbort: true });
        return await generatedImage(config, finished, { signal: options?.signal });
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText("requestFailed"), "imageTimeout"));
    }
}

/**
 * The id a run's media map takes for this reference.
 *
 * A reference that is already a canvas file (a node's picture, a mask, an upscale source) is named where it
 * is: a run looks media up by name inside its own canvas, so copying it first would store the same bytes again
 * for nothing (#174). Only a reference with no file yet — a paste, a crop, a data URL — is uploaded.
 */
async function mediaId(config: AiConfig, reference: ReferenceImage, filename: string, signal?: AbortSignal): Promise<string> {
    const existing = mediaIdOf(reference);
    if (existing) return existing;
    const dataUrl = await imageToDataUrl(reference, { signal });
    const uploaded = await uploadMedia(config, dataUrlToFile({ ...reference, dataUrl }), filename, { signal });
    return uploaded.id;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    // Resolved against the model that will run, not taken on trust: a stored mode can outlive the model it was
    // chosen for, and this is the line that decides the roles and the outpaint numbers (#267).
    const imageMode = imageModeFor(requestConfig, requestConfig.model);
    // The shape this run will draw, and whether the graph is told one at all — the same plan the card was drawn
    // at, so what a user sees on the canvas and what the graph is asked for cannot come apart (#359).
    const size = requestSize(requestConfig, { size: requestConfig.size, model: requestConfig.model, imageMode, params: requestConfig.params });
    const background = normalizeBackground(config.background);
    // Only the knobs this model takes travel: one left over from another model is a 400 for a field nobody
    // typed (#274). The layout below is added after, because it is this client's own word rather than a knob.
    const requestParams = acceptedInputs(requestConfig, requestConfig.model, options?.params ?? requestConfig.params, imageMode) || {};
    // `layout` is the node's own word, not a mode the server has: it means "a text-to-image run whose prompt
    // carries a MOSS layout", and the server renders it into the prompt (`internal/prompt/layout.go`). So it is
    // read from the node's choice, while the mode beside it is the one the model declares — reading the pseudo
    // mode from the resolved one dropped the layout on every workflow without variants (#271).
    if (config.imageMode === "layout" && config.layout) {
        requestParams.layout = config.layout;
        requestParams.layoutEnabled = true;
    }
    const finalPrompt = withSystemPrompt(requestConfig, prompt);
    options?.onPrompt?.(finalPrompt);
    return requestServerImages({
        config: requestConfig,
        prompt: finalPrompt,
        references: [],
        size,
        background,
        imageMode,
        params: requestParams,
        options,
    });
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const background = normalizeBackground(config.background);
    const imageMode = String(config.imageMode || requestConfig.imageMode || "").trim();
    // The same plan as the card: an edit that takes a picture is not told a size, because the graph keeps the
    // picture's shape and says so (#359).
    const size = requestSize(requestConfig, { size: requestConfig.size, model: requestConfig.model, imageMode, params: requestConfig.params });
    const requestParams = acceptedInputs(requestConfig, requestConfig.model, options?.params ?? requestConfig.params, imageMode) || {};
    if (config.imageMode === "outpaint" && config.outpaint) {
        const { left, top, right, bottom, width, height } = config.outpaint;
        // ComfyUI's ImageScaleToTotalPixels counts 1 MP as 1024², not 1e6.
        const megapixels = Math.min(16, Math.max(0.1, (width * height) / (1024 * 1024)));
        Object.assign(requestParams, { left, top, right, bottom, megapixels, outpaintWidth: width, outpaintHeight: height });
    }
    if (config.imageMode === "layout" && config.layout) {
        requestParams.layout = config.layout;
        requestParams.layoutEnabled = true;
    }
    const finalPrompt = withSystemPrompt(requestConfig, requestPrompt);
    options?.onPrompt?.(finalPrompt);
    return requestServerImages({
        config: requestConfig,
        prompt: finalPrompt,
        references,
        size,
        background,
        imageMode,
        params: requestParams,
        options,
    });
}

type ImageAngleParams = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

/**
 * Re-render one image from a new camera angle.
 *
 * The angle knobs are the workflow's own inputs (`horizontalAngle`, `pitchAngle`, `cameraDistance`),
 * so this is one run with the source image as its reference — the same path every other image edit
 * takes. `wideAngle` is a UI toggle the graph has no counterpart for, so it is not sent: the server
 * rejects inputs a workflow does not declare, and a binding that reaches nothing would be worse than
 * leaving the knob out until the model can honour it.
 */
export async function requestImageAngle(config: AiConfig, prompt: string, params: ImageAngleParams, references: ReferenceImage[], options?: RequestOptions): Promise<UploadedImage> {
    const requestConfig = { ...resolveModelRequestConfig(config, config.imageModel || config.model), baseUrl: LOCAL_SERVER_BASE_URL, model: IMAGE_ANGLE_WORKFLOW };
    return requestServerImages({
        config: requestConfig,
        prompt,
        references,
        params: {
            horizontalAngle: params.horizontalAngle,
            pitchAngle: params.pitchAngle,
            cameraDistance: params.cameraDistance,
        },
        options,
    });
}
