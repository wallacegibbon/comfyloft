/**
 * The resolution tiers a run can be asked for.
 *
 * There is no "auto" tier: a tier is how big a picture is, and the only way to say "the graph decides" is to
 * state no size at all — the `auto` entry of `mediaRatioOptions`. Keeping a tier-shaped "auto" was what let a
 * size be written as a bare ratio, which two readers then resolved differently (#359).
 */
export const mediaScaleOptions = ["1k", "2k", "4k"] as const;
export const mediaRatioOptions = [
    { value: "1:1", width: 1, height: 1 },
    { value: "2:3", width: 2, height: 3 },
    { value: "3:2", width: 3, height: 2 },
    { value: "4:3", width: 4, height: 3 },
    { value: "3:4", width: 3, height: 4 },
    { value: "16:9", width: 16, height: 9 },
    { value: "9:16", width: 9, height: 16 },
    { value: "21:9", width: 21, height: 9 },
    { value: "9:21", width: 9, height: 21 },
    { value: "auto", width: 0, height: 0 },
] as const;

const imageSizePresets: Record<string, Record<string, string>> = {
    "1k": { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024", "4:3": "1024x768", "3:4": "768x1024", "16:9": "1536x864", "9:16": "864x1536", "21:9": "2016x864", "9:21": "864x2016" },
    "2k": { "1:1": "2048x2048", "2:3": "1360x2048", "3:2": "2048x1360", "4:3": "2048x1536", "3:4": "1536x2048", "16:9": "2048x1152", "9:16": "1152x2048", "21:9": "2688x1152", "9:21": "1152x2688" },
    "4k": { "1:1": "2880x2880", "2:3": "2336x3520", "3:2": "3520x2336", "4:3": "3312x2480", "3:4": "2480x3312", "16:9": "3840x2160", "9:16": "2160x3840", "21:9": "3840x1648", "9:21": "1648x3840" },
};

function parsePixelSize(value: string) {
    const match = String(value || "").match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

/** Read a size's pixels. Exported because the shape a card is drawn at and the shape a run is asked for are the same number and must be read the same way. */
export function pixelDimensions(value: unknown) {
    return parsePixelSize(typeof value === "string" ? value : "");
}

function parseAspectRatio(value: string) {
    const match = String(value || "").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return null;
    return { width, height };
}

/** The resolution a tier stands for: the short side of everything it writes. */
const TIER_SHORT_SIDE: Record<string, number> = { "1k": 1024, "2k": 2048, "4k": 2880 };

/**
 * The limits a picture's pixels have to stay inside.
 *
 * One set of numbers for three readers: the request refuses a size outside them, the agent's `set_node` refuses
 * it, and the box a card is drawn at is the shape the run would take. Separate copies is how "the request aligns
 * it, so it is fine" and "that size is refused" were both true in one build.
 */
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
/** The most lopsided shape a picture may be — also the bound a *card* keeps its floor inside, since a shape the
 * canvas will not draw a picture at is material, not an ask. */
export const IMAGE_MAX_RATIO = 3;

/** Why a stated size was refused, so every caller can say which rule it broke. */
export type ImageSizeProblem = "positive" | "step" | "edge" | "ratio" | "pixels";

/** What is wrong with these pixel dimensions, or "" when a run would take them. */
function imageSizeProblem(width: number, height: number): ImageSizeProblem | "" {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return "positive";
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) return "step";
    if (Math.max(width, height) > IMAGE_MAX_EDGE) return "edge";
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) return "ratio";
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) return "pixels";
    return "";
}

/**
 * What a stated size is — the one reading every size value goes through.
 *
 * `pixels` is the size a run would get, aligned to the step the graph is built on. `auto` is the honest "the
 * graph decides", and it is a value the canvas may hold: what the graph will draw is then the shape the server
 * published for it, not a square invented here (#359). `ratio` is a spelling a caller may type but never a value
 * this canvas stores — a shape without a size is not a size, and storing one meant two readers picked different
 * pictures from it. Anything else is `invalid`, with the reason, in words the caller can be told.
 */
type StatedSize = { kind: "auto" } | { kind: "pixels"; size: string; width: number; height: number } | { kind: "ratio"; ratio: string } | { kind: "invalid"; problem: "format" | ImageSizeProblem };

export function planStatedSize(value: unknown): StatedSize {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || trimmed.toLowerCase() === "auto") return { kind: "auto" };
    const dimensions = parsePixelSize(trimmed);
    if (dimensions) {
        const aligned = {
            width: Math.ceil(dimensions.width / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP,
            height: Math.ceil(dimensions.height / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP,
        };
        const problem = imageSizeProblem(aligned.width, aligned.height);
        if (problem) return { kind: "invalid", problem };
        return { kind: "pixels", size: `${aligned.width}x${aligned.height}`, width: aligned.width, height: aligned.height };
    }
    if (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(trimmed)) return { kind: "ratio", ratio: trimmed };
    return { kind: "invalid", problem: "format" };
}

export const videoRatioOptions = [
    { value: "1:1", width: 1, height: 1 },
    { value: "3:4", width: 3, height: 4 },
    { value: "4:3", width: 4, height: 3 },
    { value: "16:9", width: 16, height: 9 },
    { value: "9:16", width: 9, height: 16 },
    { value: "21:9", width: 21, height: 9 },
    { value: "auto", width: 0, height: 0 },
] as const;

export const VIDEO_SECONDS_MIN = 4;
export const VIDEO_SECONDS_MAX = 30;

function normalizeMediaScale(value: string | undefined) {
    const scale = String(value || "")
        .trim()
        .toLowerCase();
    if (scale === "2k" || scale === "2048") return "2k";
    if (scale === "4k" || scale === "3840") return "4k";
    if (scale === "auto") return "auto";
    if (mediaScaleOptions.includes(scale as (typeof mediaScaleOptions)[number])) return scale;
    return "1k";
}

export function inferMediaScale(size: string, storedScale?: string) {
    if (storedScale) return normalizeMediaScale(storedScale);
    if (!size || size === "auto") return "auto";
    if (parseAspectRatio(size)) return "auto";
    const pixels = parsePixelSize(size);
    if (!pixels) return "auto";
    const presetScale = Object.keys(imageSizePresets).find((scale) => Object.values(imageSizePresets[scale]).includes(`${pixels.width}x${pixels.height}`));
    if (presetScale) return presetScale;
    const longSide = Math.max(pixels.width, pixels.height);
    if (longSide >= 3072) return "4k";
    if (longSide >= 1536) return "2k";
    return "1k";
}

export function inferMediaRatio(size: string, fallback = "1:1") {
    if (!size || size === "auto") return "auto";
    if (mediaRatioOptions.some((item) => item.value === size)) return size;
    const pixels = parsePixelSize(size) || parseAspectRatio(size);
    if (!pixels) return fallback;
    const target = pixels.width / pixels.height;
    return mediaRatioOptions
        .filter((item) => item.value !== "auto")
        .reduce((best, item) => {
            const current = item.width / item.height;
            const bestOption = mediaRatioOptions.find((option) => option.value === best);
            const bestRatio = (bestOption?.width || 1) / Math.max(1, bestOption?.height || 1);
            return Math.abs(current - target) < Math.abs(bestRatio - target) ? item.value : best;
        }, fallback);
}

export function computeMediaSize(scale: string, ratio: string) {
    if (ratio === "auto" || !ratio) return "auto";
    // A shape the pills do not offer is still a shape: it is made at the tier's own short side, on the same
    // numbers a typed size is checked against. Nothing here can write a bare ratio — a stored `size` is always
    // a size, never only a shape (#359).
    const tier = normalizeMediaScale(scale) === "auto" ? "1k" : normalizeMediaScale(scale);
    const preset = imageSizePresets[tier]?.[ratio];
    if (preset) return preset;
    const shape = pixelsForRatio(ratio, tier);
    return shape ? `${shape.width}x${shape.height}` : "auto";
}

/** A shape at a tier, in the pixels that mean it: the preset the pills offer, else that tier's short side. */
/**
 * What choosing a resolution tier means for the size as it stands.
 *
 * A tier is only ever half of a size — "how big" with no "what shape" — so it takes the shape the size already
 * states, in the words the shape controls use, and states a square when nothing does. The rule lives here because
 * two controls offer a tier, and the one that asked its own question was the preferences' default: from `auto` it
 * read back the shape `auto` states ("none"), wrote `auto`, and so did nothing at all.
 */
export function sizeForTier(scale: string, current: unknown) {
    const ratio = inferMediaRatio(String(current ?? ""));
    return computeMediaSize(scale, ratio === "auto" ? "1:1" : ratio);
}

function pixelsForRatio(ratio: string, tier: string) {
    const shape = parseAspectRatio(ratio);
    if (!shape) return null;
    const shortSide = TIER_SHORT_SIDE[tier] || TIER_SHORT_SIDE["1k"];
    const landscape = shape.width >= shape.height;
    const longSide = Math.ceil((shortSide * (landscape ? shape.width / shape.height : shape.height / shape.width)) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    const width = landscape ? longSide : shortSide;
    const height = landscape ? shortSide : longSide;
    return imageSizeProblem(width, height) ? null : { width, height };
}

/**
 * The pixels a stated size means, for the panel's own two number boxes.
 *
 * A display reader, not a decision: it answers "what do I show in the W and H boxes", and for a size that states
 * nothing it shows 0 and the boxes are disabled beside it. Whether a run will draw this shape is answered by
 * `planRunShape`, which asks the graph what sizes it.
 */
export function readMediaDimensions(size: string, scale: string, ratio: string) {
    const pixels = parsePixelSize(size);
    if (pixels) return pixels;
    const computed = computeMediaSize(scale === "auto" ? "1k" : scale, ratio === "auto" ? "1:1" : ratio);
    return parsePixelSize(computed) || { width: 0, height: 0 };
}

export function clampVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(VIDEO_SECONDS_MIN, Math.min(VIDEO_SECONDS_MAX, seconds)));
}

export function parseVideoResolution(value: string | undefined) {
    const raw = String(value || "")
        .trim()
        .toLowerCase();
    if (raw === "low") return "480";
    if (raw === "auto" || raw === "high" || raw === "medium") return "720";
    const number = raw.replace(/p$/i, "");
    return /^\d+$/.test(number) && Number(number) > 0 ? number : "720";
}

export function inferVideoRatio(size: string) {
    if (!size || size === "auto") return "auto";
    if (videoRatioOptions.some((item) => item.value === size)) return size;
    const pixels = parsePixelSize(size) || parseAspectRatio(size);
    if (!pixels) return "16:9";
    const target = pixels.width / pixels.height;
    return videoRatioOptions
        .filter((item) => item.value !== "auto")
        .reduce((best, item) => {
            const current = item.width / item.height;
            const bestOption = videoRatioOptions.find((option) => option.value === best);
            const bestRatio = (bestOption?.width || 16) / (bestOption?.height || 9);
            return Math.abs(current - target) < Math.abs(bestRatio - target) ? item.value : best;
        }, "16:9");
}

export function computeVideoSize(resolution: string, ratio: string) {
    if (ratio === "auto" || !ratio) return "auto";
    const parsed = parseAspectRatio(ratio);
    if (!parsed) return "auto";
    const p = Math.max(1, Math.floor(Number(parseVideoResolution(resolution)) || 720));
    const landscape = parsed.width >= parsed.height;
    const width = evenRound(landscape ? (p * parsed.width) / parsed.height : p);
    const height = evenRound(landscape ? p : (p * parsed.height) / parsed.width);
    return `${width}x${height}`;
}

/**
 * The pixels a film run is asked for.
 *
 * A clip's shape always comes from the quality tier it is made at, so unlike a picture its ask is never silent:
 * this always answers with pixels. A stated size contributes its shape only — a stale pair of numbers must not
 * outrank the tier the user chose, and the tier re-makes it, which is what the panel's own pills write. The card
 * is drawn from this same function, which is why a film card frames its clip instead of banding it (#359).
 */
export function videoPixelsForAsk(size: unknown, tier: unknown) {
    const resolution = parseVideoResolution(typeof tier === "string" ? tier : undefined);
    const ratio = inferVideoRatio(typeof size === "string" && size.trim() ? size.trim() : "auto");
    return computeVideoSize(resolution, ratio === "auto" ? "16:9" : ratio);
}

/** The pixels to show for a film's settings — a display reader, as `readMediaDimensions` is for a picture. */
export function readVideoDimensions(size: string, resolution: string, ratio: string) {
    const pixels = parsePixelSize(size);
    if (pixels) return pixels;
    const computed = computeVideoSize(resolution, ratio === "auto" ? "16:9" : ratio);
    return parsePixelSize(computed) || { width: 0, height: 0 };
}

function evenRound(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}
