export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

/**
 * The agent's window on a canvas: whether it is open, where it sits and how big it is.
 *
 * It is part of the document because it is how the person left the canvas, in the same way the
 * viewport is: reopening a canvas puts the conversation back where it was instead of in the corner
 * this build happens to default to. `position` is null while the window has never been dragged, and
 * `size` is null while it is the size it opens at — an explicit value is the user's own, and it is
 * restored as written.
 */
export type CanvasAgentWindow = {
    open: boolean;
    position: Position | null;
    size: { width: number; height: number } | null;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Video = "video",
    Audio = "audio",
    Group = "group",
    Lora = "lora",
}

// Open on purpose, though every type this build defines is a CanvasNodeType: a saved canvas is data, and a
// node whose type this build does not have renders as a missing node rather than being refused. That is
// what a canvas written by an older build looks like after a node type is removed.
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
/** What a node generates: the three kinds a workflow makes. A text node is words, so it generates nothing. */
export type CanvasGenerationMode = "image" | "video" | "audio";

export type CanvasMossLayoutRegion = {
    id: string;
    label: "object" | "character" | "text";
    caption: string;
    text?: string;
    x: number;
    y: number;
    width: number;
    height: number;
};

export type CanvasMossLayout = {
    summary: string;
    regions: CanvasMossLayoutRegion[];
    width?: number;
    height?: number;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    model?: string;
    /**
     * The workflow the server ran for this node's content, as the run named itself
     * (`image-z-image-turbo`).
     *
     * Not the same string as `model`, which is the pick the user made (`default::image-z-image-turbo`):
     * a pick can be renamed or deleted out of the settings afterwards, and what actually ran cannot.
     * Written when the run finishes, with `generatedAt` (docs/decisions.md #227).
     */
    workflow?: string;
    /**
     * The instant the run that produced this node's content finished, as the server stamped it: ISO 8601
     * in UTC, kept verbatim rather than re-formatted for a locale.
     *
     * The node is the only place it survives. The run record is pruned, and a finished image node clears
     * its run id, so anything that wants to know when a picture was made has to read it here.
     */
    generatedAt?: string;
    size?: string;
    quality?: string;
    background?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: string;
    videoSelfLiftMode?: string;
    frameMode?: "first" | "last" | "both";
    imageMode?: "t2i" | "edit" | "inpaint" | "outpaint" | "layout";
    /** The prompt that was actually sent, when it is not the text the user typed (context appended). */
    sentPrompt?: string;
    outpaint?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    layout?: CanvasMossLayout;
    audioFormat?: string;
    audioInstructions?: string;
    references?: string[];
    /**
     * The mask this node stands for, when it is a mask annotation.
     *
     * The node's own picture is the mask drawn over the source, which is what a person needs to see;
     * what a workflow takes as `media.mask` is a different file — binary for the inpaint workflows,
     * the drawn-over picture for the ones that accept it. Binding that file here is what lets the
     * node survive a storage cleanup (`Store.Sweep` keeps every file the document still names)
     * and lets an inpaint run take the mask from whichever node is connected.
     */
    mask?: { storageKey: string; mimeType?: string };
    naturalWidth?: number;
    naturalHeight?: number;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    /**
     * The server run producing this node's content, kept so the watch survives the page.
     *
     * One field for every kind of content. It used to be three — `videoTaskId`, `audioRunId`, `imageRunId` —
     * named after the order the three were moved onto the server, and the predicates that read them drifted
     * with the names: video resumed on a reload whatever its status, audio and image only while they were
     * still `loading`. A canvas written before this keeps its old name until it is opened, where it is read
     * into this one (`adoptLegacyRunIds`).
     */
    runId?: string;
    /**
     * Set while a run is being watched that cannot report progress — one the server picked up again after a
     * restart. The step count and preview frames come from the socket bound to the process that submitted,
     * so the node says it is waiting instead of drawing a bar that will not move (#236).
     */
    progressUnavailable?: boolean;
    previewUrl?: string;
    previewMime?: string;
    previewStep?: number;
    previewTotal?: number;
    stepProgress?: { step: number; total: number; complete?: boolean };
    seed?: string;
    seedFixed?: string;
    aspectRatio?: string;
    groupId?: string;
    params?: Record<string, unknown>; // Per-node model params (e.g. LoRA stack).
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

/**
 * A node the canvas deleted, and the wires it had when it went.
 *
 * Deleting is a move, not a loss: what a node holds is a file inside the canvas, and the server frees a file
 * only when the document no longer names it — so the trash is what keeps a deleted picture on disk (#327).
 * It is part of the document for that reason, and because the memory that used to hold a deletion (the undo
 * stack) dies with the tab: a node in the trash survives a reload, and so does the file it names.
 *
 * A group is never in here: deleting one releases its members and destroys nothing, so there is nothing to
 * recover.
 */
export type CanvasTrashEntry = {
    /** ISO, `util.NowIso`'s shape: the trash is kept newest first. */
    deletedAt: string;
    node: CanvasNodeData;
    /** Every connection that had this node on either end, so a restore puts the wires back with it. */
    connections: CanvasConnection[];
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
