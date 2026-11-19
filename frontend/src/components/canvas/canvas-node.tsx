import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Download, Group, Image as ImageIcon, Music2, Play, Puzzle, Video } from "lucide-react";

import { type CanvasTheme } from "@/lib/canvas-theme";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { pickImageSource } from "@/lib/image-thumbnail";
import { previewUrlFor, subscribeImagePreviews, getImagePreviewRevision } from "@/services/image-storage";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { NODE_CARD_FRAME, NODE_CARD_RADIUS, NODE_MIN_SIZE, nodeRatio } from "@/lib/canvas/canvas-node-size";
import { LoraNodeContent } from "@/components/canvas/nodes/lora-node";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasNodeProgressRing } from "./canvas-node-progress-ring";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useTranslation } from "react-i18next";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const selectionBlue = "#2f80ff";

type CanvasNodeProps = {
    data: CanvasNodeData;
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    referenceSelectionState?: "target" | "disabled" | "available";
    showPanel: boolean;
    showImageInfo: boolean;
    mentionReferences?: CanvasResourceReference[];
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    groupChildCount?: number;
    isGroupDropTarget?: boolean;
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onSelectCapture?: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResizeStart: (nodeId: string) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd: (nodeId: string) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onVideoDimensions?: (nodeId: string, width: number, height: number) => void;
    onDownloadImage?: (node: CanvasNodeData) => void;
    /** Opens a picture or a clip at its own size — what the double click on a card asks for. */
    onPreviewNode?: (node: CanvasNodeData) => void;
    onSelectReference?: (nodeId: string) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

type NodeContentRendererProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    scale: number;
    onContentChange: (nodeId: string, content: string) => void;
    onVideoDimensions?: (nodeId: string, width: number, height: number) => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onDownloadImage?: () => void;
    groupChildCount: number;
};

/**
 * The radius a card's content is clipped to — the frame's own corner, less its thickness.
 *
 * The frame is drawn outside the card's rect (#360) with radius `NODE_CARD_RADIUS`, so the curve its inner edge
 * describes is 2px tighter. Content clipped to the outer radius sits inside that curve and the canvas shows through
 * the four corners: the same off-by-the-frame error, at the corners instead of the sides.
 */
const CONTENT_RADIUS = NODE_CARD_RADIUS - NODE_CARD_FRAME;

export const CanvasNode = React.memo(function CanvasNode({
    data,
    scale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    referenceSelectionState,
    showPanel,
    showImageInfo,
    mentionReferences = [],
    renderPanel,
    groupChildCount = 0,
    isGroupDropTarget = false,
    onMouseDown,
    onSelectCapture,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResizeStart,
    onResize,
    onResizeEnd,
    onContentChange,
    onVideoDimensions,
    onDownloadImage,
    onPreviewNode,
    onSelectReference,
    onContextMenu,
}: CanvasNodeProps) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const [hovered, setHovered] = useState(false);
    const definition = getNodeDefinition(data.type);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const hasImageContent = data.type === CanvasNodeType.Image && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const isGroup = data.type === CanvasNodeType.Group;
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const imageBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : "transparent";
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const minWidth = NODE_MIN_SIZE.width;
            const minHeight = NODE_MIN_SIZE.height;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, onResize, scale],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
        onResizeEnd(data.id);
    }, [data.id, handleResizeMove, onResizeEnd]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        onResizeStart(data.id);
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            // Whether a card may change shape is the node type's word, not this file's: a card that frames
            // a picture is the picture's shape, and the definition says so (`keepsAspectRatio`).
            keepRatio: Boolean(definition?.keepsAspectRatio),
            ratio: nodeRatio(data),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    return (
        <div
            data-node-id={data.id}
            className={`node-element group/node absolute flex select-none flex-col transition-shadow duration-200 ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"} ${referenceSelectionState === "available" ? "cursor-pointer" : referenceSelectionState ? "cursor-not-allowed" : ""}`}
            style={{
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                transition: "box-shadow 200ms ease",
                contain: "layout style",
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onMouseDownCapture={(event) => {
                if (!referenceSelectionState) onSelectCapture?.(event, data.id);
            }}
            onContextMenu={(event) => {
                if (referenceSelectionState) event.preventDefault();
                else onContextMenu(event, data.id);
            }}
        >
            <div
                className="absolute overflow-visible"
                style={{
                    // The frame is drawn *around* the card's rect, not cut out of it. The rect a node record
                    // carries is the picture's rect, and a border taken off it would leave the canvas showing
                    // between the picture and the frame — 4.9px on each side of a 640×186.6 card (#360). The
                    // border-box is the rect plus this on every side, so its content box is the rect itself.
                    inset: -NODE_CARD_FRAME,
                    background: isGroup || hasImageContent || hasVideoContent ? "transparent" : theme.node.fill,
                    borderWidth: NODE_CARD_FRAME,
                    borderRadius: NODE_CARD_RADIUS,
                    borderColor: isGroup ? (isGroupDropTarget || isActive ? selectionBlue : theme.node.stroke) : hasImageContent ? imageBorderColor : isActive ? selectionBlue : isRelated ? theme.node.muted : theme.node.stroke,
                    borderStyle: isGroup ? "dashed" : "solid",
                    boxShadow: isGroupDropTarget ? `0 0 0 2px ${selectionBlue}66, inset 0 0 0 999px ${selectionBlue}10` : isActive ? `0 0 0 1px ${selectionBlue}55` : isRelated ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)` : undefined,
                }}
                onMouseDown={(event) => {
                    if (!referenceSelectionState) onMouseDown(event, data.id);
                    else {
                        // Picking is a way of typing somewhere else: mousedown's default (move the focus here)
                        // would take the caret out of the box that asked, so it is not allowed to happen.
                        event.preventDefault();
                        if (event.button === 0 && referenceSelectionState === "available") {
                            event.stopPropagation();
                            onSelectReference?.(data.id);
                        }
                    }
                }}
                onDoubleClick={(event) => {
                    if (referenceSelectionState) {
                        event.stopPropagation();
                        return;
                    }
                    // A picture and a clip both open at their own size: what a card cannot give is the whole of
                    // it. A clip only asks while it is a still — once it plays, the element takes the pointer and
                    // a double click on it is the browser's own, so that is the one target that is not a request.
                    if ((data.type === CanvasNodeType.Image && hasImageContent) || (data.type === CanvasNodeType.Video && hasVideoContent)) {
                        if (event.target instanceof HTMLVideoElement) return;
                        event.stopPropagation();
                        onPreviewNode?.(data);
                        return;
                    }
                    if (data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    setIsEditingContent(true);
                }}
            >
                <div
                    className="relative flex h-full w-full items-center justify-center overflow-hidden"
                    style={
                        {
                            background: isGroup || hasImageContent || hasVideoContent ? "transparent" : theme.node.fill,
                            borderRadius: CONTENT_RADIUS,
                        } as React.CSSProperties
                    }
                >
                    <NodeContent
                        node={data}
                        theme={theme}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        scale={scale}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onVideoDimensions={onVideoDimensions}
                        onStopEditing={() => setIsEditingContent(false)}
                        onDownloadImage={() => onDownloadImage?.(data)}
                        groupChildCount={groupChildCount}
                    />
                </div>

                {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}

                {!isGroup && !hasImageContent && !hasVideoContent && !hasAudioContent ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} />
                ) : null}

                {referenceSelectionState && (referenceSelectionState !== "available" || hovered) ? (
                    <div
                        className="pointer-events-none absolute inset-0 z-[60] grid place-items-center rounded-[inherit]"
                        style={{
                            background: `color-mix(in srgb, ${theme.canvas.background} ${referenceSelectionState === "target" ? 78 : referenceSelectionState === "disabled" ? 60 : 34}%, transparent)`,
                            boxShadow: referenceSelectionState === "available" ? `inset 0 0 0 2px ${selectionBlue}` : undefined,
                        }}
                    >
                        {referenceSelectionState !== "disabled" ? (
                            <span className="rounded-lg px-3 py-2 text-sm font-medium shadow-sm" style={{ background: theme.toolbar.panel, color: theme.node.text }}>
                                {t(referenceSelectionState === "target" ? "canvas.references.selecting" : "canvas.references.choose")}
                            </span>
                        ) : null}
                    </div>
                ) : null}

                {!isGroup && !referenceSelectionState && data.metadata?.stepProgress && data.metadata.stepProgress.total > 0 ? (
                    <CanvasNodeProgressRing width={data.width} height={data.height} step={data.metadata.stepProgress.step} total={data.metadata.stepProgress.total} complete={data.metadata.stepProgress.complete} />
                ) : null}

                {!referenceSelectionState ? <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} /> : null}
            </div>

            {!referenceSelectionState && !isGroup ? <ConnectionHandleDot side="left" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "target")} /> : null}
            {!referenceSelectionState ? <ConnectionHandleDot side="right" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "source")} /> : null}

            {/* Counter-scale the panel so its on-screen size stays constant while the canvas zooms. */}
            {showPanel && !isGroup && renderPanel ? (
                <div className="absolute left-1/2 top-full z-[70] w-[600px] pt-4" style={{ transform: `translateX(-50%) scale(${1 / scale})`, transformOrigin: "top center" }} data-node-panel={data.id}>
                    {renderPanel(data)}
                </div>
            ) : null}
        </div>
    );
});

function NodeContent(props: NodeContentRendererProps) {
    if (props.node.metadata?.status === "loading") return <LoadingContent theme={props.theme} node={props.node} />;

    const Renderer = nodeContentRenderers[props.node.type as CanvasNodeType];
    let content: ReactNode;
    if (Renderer) content = <Renderer {...props} />;
    else content = <MissingNodeContent theme={props.theme} type={props.node.type} />;

    if (props.node.metadata?.status === "error") {
        return (
            <div className="relative h-full w-full">
                {content}
                <NodeErrorBanner node={props.node} />
            </div>
        );
    }
    return content;
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Lora]: LoraNodeContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Group]: GroupNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function GroupNodeContent({ theme, groupChildCount }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="pointer-events-none flex h-full w-full p-3">
            <div className="flex h-7 max-w-full items-center gap-2 px-1 text-xs font-medium" style={{ color: theme.node.text }}>
                <Group className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
                <span className="truncate">{t("canvas.node.group")}</span>
                <span className="shrink-0 text-[11px] font-normal" style={{ color: theme.node.muted }}>
                    {t("canvas.node.nodeCount", { count: groupChildCount })}
                </span>
            </div>
        </div>
    );
}

function LoadingContent({ theme, node }: Pick<NodeContentRendererProps, "theme" | "node">) {
    const { t } = useTranslation();
    const previewUrl = node.metadata?.previewUrl;
    if (previewUrl) {
        const isVideo = Boolean(node.metadata?.previewMime?.startsWith("video/"));
        const step = node.metadata?.previewStep;
        const total = node.metadata?.previewTotal;
        return (
            <div className="relative h-full w-full overflow-hidden rounded-[18px] bg-black">
                {isVideo ? (
                    <video src={previewUrl} className="pointer-events-none h-full w-full select-none object-contain" autoPlay muted loop playsInline draggable={false} onDragStart={(event) => event.preventDefault()} />
                ) : (
                    <img src={previewUrl} alt="" className="pointer-events-none h-full w-full select-none object-contain" draggable={false} onDragStart={(event) => event.preventDefault()} />
                )}
                <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-medium tracking-wider text-white backdrop-blur-sm">
                    {t("canvas.node.generating")}
                    {step && total ? ` ${step}/${total}` : ""}
                </div>
            </div>
        );
    }
    // A run the server picked up after a restart has no progress to report: the step count and the preview
    // frames came from the socket bound to the process that submitted. Saying so is the whole point — a
    // spinner with a frozen number reads as "stuck" (#236).
    const resumed = Boolean(node.metadata?.progressUnavailable);
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center" style={{ color: theme.node.activeStroke }}>
            <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            <span className="text-[10px] tracking-[0.2em]">{resumed ? t("canvas.node.awaitingResult") : t("canvas.node.generating")}</span>
            {resumed ? <span className="text-[10px] leading-relaxed opacity-60">{t("canvas.node.awaitingResultHint")}</span> : null}
        </div>
    );
}

/**
 * Why a node failed, on the node — the reason and nothing else.
 *
 * Running it again is the generate button, which is where running it the first time was. A retry beside the
 * message was a second way in and a second implementation of the same request, and the two drifted: it did
 * not refuse an empty wire, and it rebuilt references from what the failed attempt recorded instead of the
 * connections the canvas shows (#234).
 */
function NodeErrorBanner({ node }: Pick<NodeContentRendererProps, "node">) {
    const { t } = useTranslation();
    return (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-30 flex justify-center">
            <div className="pointer-events-auto flex max-w-[92%] items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] leading-none shadow-lg" style={{ background: "rgba(88,18,18,.92)", borderColor: "rgba(255,140,140,.45)", color: "#ffecec" }}>
                <span className="min-w-0 truncate">{node.metadata?.errorDetails || t("canvas.node.failed")}</span>
            </div>
        </div>
    );
}

function MissingNodeContent({ theme, type }: Pick<NodeContentRendererProps, "theme"> & { type: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center" style={{ color: theme.node.placeholder }}>
            <Puzzle className="size-7 opacity-40" />
            <span className="text-sm">{t("canvas.node.missingNode")}</span>
            <span className="text-[11px] opacity-70">{t("canvas.node.missingNodeDescription", { type })}</span>
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, onContentChange, onStopEditing }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;
    // A text card is its words: no batch, no run, no question behind it (#278).
    const content = node.metadata?.content || "";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden" style={{ borderRadius: CONTENT_RADIUS }}>
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    data-canvas-scroll
                    className="thin-scrollbar m-0 block h-full w-full select-text appearance-none resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent p-4 font-mono outline-none"
                    style={textStyle}
                    value={content}
                    references={mentionReferences}
                    highlightLabels={false}
                    onChange={(value) => onContentChange(node.id, value)}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : content ? (
                <div data-canvas-scroll className="thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent p-4 font-mono" style={textStyle}>
                    {content}
                </div>
            ) : (
                <div className="p-4 font-mono" style={{ color: theme.node.placeholder }}>
                    {t("canvas.node.editText")}
                </div>
            )}
        </div>
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content) return <EmptyImageContent {...props} />;
    return <ImageContent node={props.node} scale={props.scale} onDownload={props.onDownloadImage} />;
}

function EmptyImageContent({ theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.node.emptyImage")}</span>
        </div>
    );
}

/**
 * A clip on the canvas: a still frame until someone asks for it to play.
 *
 * A native `<video controls>` starts playing when its own surface is clicked, and here that surface is most
 * of the node — so selecting a clip, or opening its composer, also started it. Playback is now a decision:
 * the element carries no controls and takes no pointer events until it is playing, and the only way in is the
 * button over the frame. While it plays the native controls are back, so seeking and volume are the ones the
 * browser already implements.
 *
 * The state comes from the element's own events rather than from the click, so a play started from anywhere —
 * the button, the multi-selection's sync-play, the native controls — leaves the node in the same shape
 * (docs/decisions.md #277).
 *
 * The double click on the still frame asks for the clip at its own size (see the card's `onDoubleClick`); the
 * button answers its own presses, so pressing it twice plays, it does not open anything. The card's toolbar
 * asks for the same thing with a button (#331), so the gesture is a shortcut and not the only way in.
 */
function VideoNodeContent({ node, theme, onVideoDimensions }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [playing, setPlaying] = useState(false);
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyVideo")}</span>
            </div>
        );
    return (
        <div className="relative h-full w-full">
            <video
                ref={videoRef}
                src={node.metadata.content}
                controls={playing}
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    if (video.videoWidth && video.videoHeight) onVideoDimensions?.(node.id, video.videoWidth, video.videoHeight);
                }}
                className={`h-full w-full rounded-[18px] bg-black object-contain ${playing ? "" : "pointer-events-none"}`}
                data-canvas-video={node.id}
                data-canvas-no-zoom
            />
            {playing ? null : (
                // The frame itself stays transparent to the pointer, so a click anywhere but the button is a
                // click on the node. `play()` resumes where a pause left off and starts a finished clip over,
                // which is what the element already does — no seek of our own to get wrong.
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                    <button
                        type="button"
                        aria-label={t("canvas.node.play")}
                        title={t("canvas.node.play")}
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        // Two presses of this button are two plays, not a request to open the clip: the
                        // button says what a click means, and the double click on the card is not it.
                        onDoubleClick={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            void videoRef.current?.play().catch(() => undefined);
                        }}
                        className="pointer-events-auto flex size-12 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-lg backdrop-blur-sm transition hover:scale-105 hover:bg-black/70"
                    >
                        <Play className="size-5 translate-x-[1px] fill-current" />
                    </button>
                </div>
            )}
        </div>
    );
}

function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyAudio")}</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2 className="size-4 shrink-0" />
                <span className="truncate">{t("canvas.node.audio")}</span>
            </div>
            <audio src={node.metadata.content} controls className="w-full" data-canvas-no-zoom />
        </div>
    );
}

function ImageContent({ node, scale, onDownload }: { node: CanvasNodeData; scale: number; onDownload?: () => void }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const content = node.metadata?.content;
    const source = content
        ? pickImageSource({
              previewUrl: previewUrlFor(node.metadata?.storageKey),
              originalUrl: content,
              naturalWidth: node.metadata?.naturalWidth,
              naturalHeight: node.metadata?.naturalHeight,
              renderedWidth: node.width,
              renderedHeight: node.height,
              scale,
          })
        : undefined;

    return (
        <div className="relative h-full w-full overflow-hidden" style={{ borderRadius: CONTENT_RADIUS }}>
            {content ? <img src={source} alt="" draggable={false} onDragStart={(event) => event.preventDefault()} className="pointer-events-none block h-full w-full select-none object-contain" /> : <ImageSlotStatus node={node} />}
            {content ? (
                <button
                    type="button"
                    className="pointer-events-none absolute left-2.5 top-2.5 z-30 flex h-8 items-center gap-1 rounded-lg border px-2 text-[10px] font-medium opacity-0 shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02] group-hover/node:pointer-events-auto group-hover/node:opacity-100"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    title={t("common.download")}
                    onClick={(event) => (event.stopPropagation(), onDownload?.())}
                >
                    <Download className="size-3" />
                    {t("common.download")}
                </button>
            ) : null}
        </div>
    );
}

function ImageSlotStatus({ node }: { node: CanvasNodeData }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const failed = node.metadata?.status === "error";
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? (
                <span className="text-xs leading-5">{node.metadata?.errorDetails || t("canvas.node.failed")}</span>
            ) : (
                <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            )}
            {!failed ? <span className="text-[10px] tracking-[0.2em]">{t("canvas.node.generating")}</span> : null}
        </div>
    );
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
            </span>
        </div>
    );
}

function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function ConnectionHandleDot({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: React.MouseEvent) => void }) {
    const theme = useCanvasTheme();

    return (
        <div
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onMouseDown}
        >
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}
