import i18n from "@/i18n";
import { apiErrorMessage, isCancelled, throwIfCanceled } from "@/services/api/http";
import { dataUrlToFile } from "@/lib/image-utils";
import { clampVideoSeconds } from "@/lib/media-size";
import { planRunShape } from "@/lib/canvas/run-shape";
import { CanvasNodeType } from "@/types/canvas";
import { mediaIdOf } from "@/services/canvas-files";
import { getMediaBlob, resolveMediaUrl, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { cancelRun, createRun, uploadMedia, waitForRun, RunFailedError, type Run, type RunRequest } from "@/services/api/runs";
import { generatedVideo } from "@/lib/canvas/generated-media";
import { modelIsStep, modelTakesPrompt, acceptedInputs, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type RequestOptions = { signal?: AbortSignal; params?: Record<string, unknown>; askedBy?: RunRequest["askedBy"] };
type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/** A video task is a run: the id is the run id, and the file is read off the run. */
type VideoGenerationTask = { id: string; model: string };
export type VideoPreview = { url: string; mime?: string; step?: number; total?: number };
type WaitOptions = RequestOptions & {
    onPreview?: (preview: VideoPreview | null) => void;
    onSteps?: (steps: { step: number; total: number }) => void;
    /** Every read of the run, for what a poll says beyond steps and previews — "this one was resumed". */
    onPoll?: (run: Run) => void;
};
/**
 * A video run renders for minutes, so it is polled slower than an image: the step count and the
 * preview frame are the only things a poll adds, and both change slowly.
 */
const VIDEO_RUN_INTERVAL_MS = 1500;

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: WaitOptions): Promise<UploadedFile> {
    return waitForVideoRun(config, task, options);
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    assertVideoConfig(requestConfig, requestConfig.model);
    // A step, not a prompt: an interpolation is told a multiplier and given a clip, and nothing else.
    // Sending the composer's prompt and size would be accepted by the server and quietly ignored, which
    // is the one failure mode this build refuses to have (docs/protocol.md).
    if (modelIsStep(requestConfig, requestConfig.model)) return createVideoStepTask(requestConfig, prompt, references, options);
    return createServerVideoTask(requestConfig, prompt, references, options);
}

/**
 * Submit a video *step*: the workflow's own parameters, and its media by kind.
 *
 * The media role is the binding's kind (`video`, `audio`, `image`), which is how the server's planner
 * reads it — a step has no first-frame/last-frame/reference distinction to make, because it has no modes.
 */
async function createVideoStepTask(config: AiConfig, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const media: Record<string, string | string[]> = {};
    try {
        const images = await Promise.all(references.map((image, index) => uploadReferenceImage(config, image, index, options)));
        if (images.length) media.image = images;
        const videos = await Promise.all((options?.videos || []).map((video, index) => uploadReferenceClip(config, video, `source-${index + 1}.mp4`, "invalidReferenceVideo", options)));
        if (videos.length) media.video = videos;
        const audios = await Promise.all((options?.audios || []).map((audio, index) => uploadReferenceClip(config, audio, `source-${index + 1}.mp3`, "invalidReferenceAudio", options)));
        if (audios.length) media.audio = audios;
        const params = acceptedInputs(config, config.model, { ...(config.params || {}), ...(options?.params || {}) });
        const run = await createRun(config, {
            workflow: config.model,
            inputs: { ...(modelTakesPrompt(config, config.model) ? { prompt } : {}), ...(params || {}) },
            ...(Object.keys(media).length ? { media } : {}),
            askedBy: options?.askedBy,
        });
        return { id: run.id, model: config.model };
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText("videoTaskCreateFailed")));
    }
}

type ServerVideoPlan = {
    mode: string;
    frameMode: string;
    images: ReferenceImage[];
    videos: ReferenceVideo[];
    audios: ReferenceAudio[];
};

function planServerVideo(config: AiConfig, references: ReferenceImage[], options?: VideoMediaOptions): ServerVideoPlan {
    const mode = resolveVideoMode(config.videoMode, references.length);
    return {
        mode,
        frameMode: config.frameMode || (references.length >= 2 ? "both" : "first"),
        images: mode === "text" ? [] : references,
        videos: mode === "reference" ? options?.videos || [] : [],
        audios: mode === "reference" ? options?.audios || [] : [],
    };
}

/**
 * Submit one video run.
 *
 * Media goes in by role — `first_frame`/`last_frame` for a frame workflow, `reference` plus `video`
 * and `audio` for multi-reference — and the knobs are the workflow's own declared inputs. Nothing
 * here renames a field to a legacy multipart name, so a request that the server would reject is
 * rejected at submission rather than minutes into the render.
 */
async function createServerVideoTask(config: AiConfig, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const plan = planServerVideo(config, references, options);
    const inputs: Record<string, unknown> = { prompt, mode: plan.mode };
    const seconds = normalizeVideoSeconds(config.videoSeconds);
    if (Number(seconds) > 0) inputs.seconds = Number(seconds);
    // The shape is the graph's answer, not a tier's default: a film's pixels are derived from the tier it is made
    // at — which is the same plan the card was drawn at — and a workflow that keeps the clip it was handed, an
    // interpolation, is not told a size at all (#359).
    const size = planRunShape(config, CanvasNodeType.Video, { size: config.size, vquality: config.vquality, model: config.model, imageMode: plan.mode, params: config.params }).size;
    if (size) inputs.size = size;
    if (plan.mode === "frames") inputs.frameMode = plan.frameMode;
    // The SelfLift choice is a knob like any other — the workflow has to declare `transition_step` for it to
    // mean anything — and only the knobs this model takes are sent (#274).
    const params = acceptedInputs(config, config.model, { transition_step: config.videoSelfLiftMode === "quality" ? 5 : 6, ...(options?.params || config.params || {}) }, plan.mode);
    if (params) Object.assign(inputs, params);
    // ...and only the keys this workflow reads: `mode` is a variant selector, so a workflow without variants
    // takes none, and a key the run would ignore is not sent at all (#302).
    const accepted = acceptedInputs(config, config.model, inputs, plan.mode) || {};

    try {
        const media = await serverVideoMedia(config, plan, options);
        const run = await createRun(config, {
            workflow: config.model,
            inputs: accepted,
            ...(Object.keys(media).length ? { media } : {}),
            askedBy: options?.askedBy,
        });
        return { id: run.id, model: config.model };
    } catch (error) {
        throw new Error(apiErrorMessage(error, apiText("videoTaskCreateFailed")));
    }
}

/** Upload the planned media and return the role → upload id map a run request takes. */
async function serverVideoMedia(config: AiConfig, plan: ServerVideoPlan, options?: VideoMediaOptions): Promise<Record<string, string | string[]>> {
    const media: Record<string, string | string[]> = {};
    if (plan.mode === "frames") {
        const first = plan.frameMode === "first" || plan.frameMode === "both" ? plan.images[0] : undefined;
        const last = plan.frameMode === "last" ? plan.images[0] : plan.frameMode === "both" ? plan.images[1] : undefined;
        if (first) media.first_frame = await uploadReferenceImage(config, first, 0, options);
        if (last) media.last_frame = await uploadReferenceImage(config, last, first ? 1 : 0, options);
        return media;
    }
    if (plan.mode !== "reference") return media;

    if (plan.images.length) media.reference = await Promise.all(plan.images.map((image, index) => uploadReferenceImage(config, image, index, options)));
    if (plan.videos.length) media.video = await Promise.all(plan.videos.map((video, index) => uploadReferenceClip(config, video, `reference-${index + 1}.mp4`, "invalidReferenceVideo", options)));
    if (plan.audios.length) media.audio = await Promise.all(plan.audios.map((audio, index) => uploadReferenceClip(config, audio, `reference-${index + 1}.mp3`, "invalidReferenceAudio", options)));
    return media;
}

/**
 * A reference as the id a run names it by.
 *
 * A reference that is already a canvas file is named, not copied: the run reads media by name inside its
 * own canvas (#174). Only a reference with no file yet is uploaded to give it one.
 */
async function uploadReferenceImage(config: AiConfig, image: ReferenceImage, index: number, options?: RequestOptions) {
    const signal = options?.signal;
    const existing = mediaIdOf(image);
    if (existing) return existing;
    const dataUrl = await imageToDataUrl(image, { signal });
    if (!dataUrl) throw new Error(apiText("referenceImageReadFailed"));
    return (await uploadMedia(config, dataUrlToFile({ ...image, dataUrl }), image.name || `reference-${index + 1}.png`, { signal })).id;
}

async function uploadReferenceClip(config: AiConfig, item: ReferenceVideo | ReferenceAudio, name: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    const existing = mediaIdOf(item);
    if (existing) return existing;
    const file = await referenceMediaToFile(item, name, errorKey, options);
    return (await uploadMedia(config, file, file.name, { signal: options?.signal })).id;
}

/**
 * Watch the run that is producing this video.
 *
 * The run belongs to the server, so its id survives a reload: nothing is submitted again here, and
 * the step count and preview frames come from the run itself. Starting the request and watching it
 * are separate calls for exactly this reason.
 */
async function waitForVideoRun(config: AiConfig, task: VideoGenerationTask, options?: WaitOptions): Promise<UploadedFile> {
    const requestConfig = resolveModelRequestConfig(config, task.model);
    try {
        const run: Run = await waitForRun(requestConfig, task.id, {
            signal: options?.signal,
            intervalMs: VIDEO_RUN_INTERVAL_MS,
            onProgress: (current) => {
                options?.onPoll?.(current);
                const preview = current.preview;
                if (preview?.url) {
                    options?.onPreview?.({
                        url: resolvePreviewUrl(requestConfig, preview.url),
                        mime: preview.mime,
                        step: current.progress?.step,
                        total: current.progress?.total,
                    });
                }
            },
            onSteps: options?.onSteps,
        });
        options?.onPreview?.(null);
        // The run wrote the clip into the canvas; the node references it where it is (#173).
        return await generatedVideo(requestConfig, run);
    } catch (error) {
        // Only an explicit stop cancels the run; a reload or a node switch leaves it rendering so
        // the node can reattach to it later.
        if (options?.signal?.aborted && options.signal.reason === "user-stop") {
            await cancelRun(requestConfig, task.id).catch(() => undefined);
        }
        options?.onPreview?.(null);
        if (isCancelled(error) || options?.signal?.aborted) throw error;
        // The canvas clears a failed task id from this error, which is what stops it polling a run
        // that will never answer differently.
        // A run that ended is passed on as it is: `RunFailedError` is the one way every mode says "the
        // server answered about the run", and it used to be rewrapped here under a video-only name.
        if (error instanceof RunFailedError) throw error;
        throw new Error(apiErrorMessage(error, apiText("videoTaskQueryFailed")));
    }
}

function resolvePreviewUrl(config: AiConfig, url: string) {
    try {
        return new URL(url, config.baseUrl).toString();
    } catch {
        return url;
    }
}
async function referenceMediaToFile(item: { name: string; type?: string; url?: string; storageKey?: string }, fallbackName: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(apiText(errorKey));
        try {
            blob = await (await fetch(url, { signal: options?.signal })).blob();
        } catch (error) {
            throwIfCanceled(error);
            throw new Error(apiText(errorKey));
        }
    }
    if (!blob.size) throw new Error(apiText(errorKey));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
}

function normalizeVideoSeconds(value: string) {
    return clampVideoSeconds(value);
}

function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "text" || mode === "reference" || mode === "frames") return mode;
    return imageCount > 2 ? "reference" : "frames";
}
