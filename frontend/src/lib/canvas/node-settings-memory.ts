import type { CanvasNodeMetadata, CanvasNodeTypeId } from "@/types/canvas";

const INHERITABLE_FIELDS = new Set([
    "model",
    "size",
    "quality",
    "background",
    "count",
    "seconds",
    "vquality",
    "generateAudio",
    "watermark",
    "videoMode",
    "videoSelfLiftMode",
    "frameMode",
    "imageMode",
    "outpaint",
    "layout",
    "audioFormat",
    "audioInstructions",
    "seed",
    "seedFixed",
    "params",
]);

const memory = new Map<string, CanvasNodeMetadata>();

function cloneValue<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value)) as T;
}

export function isInheritableNodeField(key: string) {
    return INHERITABLE_FIELDS.has(key);
}

function snapshotNodeSettings(metadata: CanvasNodeMetadata | undefined): CanvasNodeMetadata {
    const snapshot: CanvasNodeMetadata = {};
    const target = snapshot as unknown as Record<string, unknown>;
    for (const key of INHERITABLE_FIELDS) {
        if (metadata && key in metadata && metadata[key as keyof CanvasNodeMetadata] !== undefined) {
            target[key] = cloneValue(metadata[key as keyof CanvasNodeMetadata]);
        }
    }
    return snapshot;
}

export function rememberNodeSettings(type: CanvasNodeTypeId, metadata: CanvasNodeMetadata | undefined) {
    const snapshot = snapshotNodeSettings(metadata);
    if (Object.keys(snapshot).length) memory.set(type, snapshot);
}

export function recallNodeSettings(type: CanvasNodeTypeId): CanvasNodeMetadata | undefined {
    const settings = memory.get(type);
    if (!settings) return undefined;
    return cloneValue(settings);
}
