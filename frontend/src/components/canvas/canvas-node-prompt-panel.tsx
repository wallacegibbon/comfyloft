import { useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2 } from "lucide-react";

import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { toast } from "@/components/kit/toast";
import { Tooltip } from "@/components/kit/tooltip";
import { channelModelOf, defaultConfig, modelIsStep, modelOptionName, modelTakesPrompt, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig, type ModelAccepts } from "@/stores/use-config-store";

import { nodePromptOf, promptPatch } from "@/lib/canvas/node-prompt-field";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { isPlainEnterKey } from "@/lib/keyboard-event";
import { NODE_CONTROLS } from "./panels/node-controls";
import { SentPromptDisclosure } from "./sent-prompt-disclosure";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { nodeCanGenerate } from "@/lib/canvas/canvas-generation-helpers";
import { videoModelForMode } from "@/lib/canvas/video-model-mode";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { CanvasToolNodePanel } from "./canvas-tool-node-panel";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    nodes: CanvasNodeData[];
    connectedNodes?: CanvasNodeData[];
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    onOpenMaskEditor?: (nodeId: string) => void;
    onOpenOutpaintEditor?: (nodeId: string) => void;
    onOpenMossLayoutEditor?: (nodeId: string) => void;
};

/**
 * The prompt of one node that generates — the words it will be asked, and the button that asks them.
 *
 * A text card is not one of those: it holds words and nothing asks it anything, so it is edited on the card
 * itself and has no panel at all (#278). That is why this component has three kinds in it and no fourth.
 */
export function CanvasNodePromptPanel({
    node,
    nodes,
    isRunning,
    onConfigChange,
    onGenerate,
    onStop,
    mentionReferences = [],
    connectedNodes = [],
    onDisconnectReference,
    onStartReferenceSelection,
    onImageSettingsOpenChange,
    onOpenMaskEditor,
    onOpenOutpaintEditor,
    onOpenMossLayoutEditor,
}: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openPreferences = useConfigStore((state) => state.openPreferences);
    const theme = useCanvasTheme();
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    // The words this box holds — the question, never the answer: `nodePromptOf` is the field the panel and
    // the agent's `set_prompt` both write (#229).
    const [prompt, setPrompt] = useState(nodePromptOf(node));
    const [draft, setDraft] = useState(prompt);
    const draftRef = useRef(draft);
    const promptRef = useRef(prompt);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    draftRef.current = draft;
    promptRef.current = prompt;
    const [expanded, setExpanded] = useState(false);
    const imageReferences = mentionReferences.filter((reference) => reference.kind === "image");
    // What a connected text node will add to the request. The box does not hold it — nothing copies it
    // there — so it is the request, not the panel, that carries these words (docs/decisions.md #185).
    const connectedText = mentionReferences.some((reference) => reference.kind === "text" && reference.text?.trim());
    const channelModel = channelModelOf(config, config.model)?.model;
    const workflowId = channelModel?.workflowId || modelOptionName(config.model);
    // What the selected workflow declared, rather than which workflow it is: a workflow whose contract allows
    // no media at all refuses a reference, and one whose bindings never read `seconds` takes its length from
    // the clip being edited. Both used to be recognised by id (`video-h3-t2v`, `video-h3-character-swap`).
    const refusesMedia = !canTakeMedia(channelModel?.accepts);
    // The words for a reference this workflow will not read. A film's alternatives are its own — first/last
    // frame, multi-reference — and a picture's are its edit modes, so the sentence follows the kind instead of
    // being one string for both: a disabled button explained in another node type's vocabulary is worse than
    // no explanation at all.
    const noReferencesHint = mode === "image" ? t("canvas.promptPanel.imageAddDisabled") : t("canvas.promptPanel.videoTextAddDisabled");
    const noReferencesWarning = mode === "image" ? t("canvas.promptPanel.imageRefsWarning") : t("canvas.promptPanel.videoTextRefsWarning");
    const sourceVideoReference = mentionReferences.find((reference) => reference.kind === "video");
    const sourceVideoNode = sourceVideoReference ? nodes.find((item) => item.id === sourceVideoReference.nodeId) : undefined;
    const sourceVideoDurationSeconds = sourceVideoNode?.metadata?.durationMs && sourceVideoNode.metadata.durationMs > 0 ? sourceVideoNode.metadata.durationMs / 1000 : undefined;
    const hasMediaReferences = mentionReferences.some((reference) => reference.kind !== "text");
    const textVideoHasReferences = refusesMedia && hasMediaReferences;
    // Which controls sit beside the prompt box is the kind's business: one component per kind, looked up here
    // instead of four arms of `mode === …` in the middle of the JSX below.
    const Controls = NODE_CONTROLS[mode];
    const frameMode: "first" | "last" | "both" = node.metadata?.frameMode === "last" || node.metadata?.frameMode === "both" || node.metadata?.frameMode === "first" ? node.metadata.frameMode : imageReferences.length >= 2 ? "both" : "first";
    const changeVideoMode = (value: "text" | "frames" | "reference") => {
        const nextModel = videoModelForMode(config, value);
        onConfigChange(node.id, { ...(nextModel ? { model: nextModel } : {}), videoMode: value, ...(value === "frames" ? { frameMode } : {}) });
    };

    // The words this panel shows are the node's — the field `nodePromptOf` names — which is the one the
    // agent's `set_prompt` writes too.
    const storedPrompt = nodePromptOf(node);

    // Follow the store, and only the store. A generation leaves the words alone, so nothing here is clobbered
    // by pressing generate; an agent's `set_prompt` is a different writer, and before this the textarea kept
    // showing what it had when the node was opened until the panel was collapsed and opened again. What the
    // user is typing wins: a box with the caret in it is not the store's to rewrite, and their next keystroke
    // reaches the store anyway.
    useEffect(() => {
        if (storedPrompt === promptRef.current) return;
        if (document.activeElement === textareaRef.current) return;
        setPrompt(storedPrompt);
        setDraft(storedPrompt);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id, storedPrompt]);

    const commitPrompt = (value = textareaRef.current?.value ?? draft) => {
        if (value === promptRef.current) return;
        setPrompt(value);
        onConfigChange(node.id, promptPatch(node, value));
    };

    const commitPromptRef = useRef(commitPrompt);
    commitPromptRef.current = commitPrompt;

    useEffect(() => {
        const commitOnOutsidePointer = (event: PointerEvent) => {
            if (panelRef.current?.contains(event.target as Node)) return;
            commitPromptRef.current();
        };
        document.addEventListener("pointerdown", commitOnOutsidePointer, true);
        return () => document.removeEventListener("pointerdown", commitOnOutsidePointer, true);
    }, []);

    const submit = () => {
        const text = draft.trim();
        if (isRunning) return;
        // Nothing typed and nothing holding words on the other end. An empty node is not an input — a wire
        // carries content (#230) — so this is the state a half-wired canvas reaches, and a button that does
        // nothing is the one answer nobody can act on.
        if (!text && !connectedText) {
            toast.warning(t("canvas.runtime.nothingToSend"));
            return;
        }
        if (textVideoHasReferences) {
            toast.warning(noReferencesWarning);
            return;
        }
        commitPrompt(draft);
        if (mode === "image" && workflowId === "image-qwen21") {
            // A mask is a node: whichever connected node carries one supplies it, so a run wired by
            // hand works the same as one the editor made. Without a mask there is nothing to inpaint.
            const hasMask = imageReferences.some((reference) => Boolean(nodes.find((item) => item.id === reference.nodeId)?.metadata?.mask?.storageKey));
            if (config.imageMode === "inpaint" && !hasMask) {
                // The editor draws on the node's own picture, so it cannot open on a node that has none:
                // without this the button would just do nothing.
                if (!node.metadata?.content) {
                    toast.warning(t("canvas.runtime.maskNodeNeeded"));
                    return;
                }
                onOpenMaskEditor?.(node.id);
                return;
            }
            if (config.imageMode === "outpaint") {
                onOpenOutpaintEditor?.(node.id);
                return;
            }
        }
        onGenerate(node.id, mode, text);
    };

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    // Material — content with no model recorded — is shown its own panel: what it is, and where to go instead
    // (`nodeCanGenerate`).
    //
    // It has no picker and no reference bar, because a node with no run has no inputs and nothing to choose: a
    // press could only repaint the picture with the canvas's default model, which is both destructive and a
    // claim the node never made. The picker used to be here as "the way out" — choosing a model *is* saying
    // "generate here" — but a run reads only what is connected to it and never its own content, so what that
    // press bought was a render that had never seen the picture, written over it (docs/decisions.md #297).
    if (!nodeCanGenerate(node)) {
        return (
            <div
                data-canvas-no-zoom
                className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
            >
                <div className="space-y-1 px-1 text-sm leading-5">
                    <div>{t("canvas.promptPanel.material")}</div>
                    <div className="text-xs leading-4 opacity-55">{t("canvas.promptPanel.materialHint")}</div>
                </div>
            </div>
        );
    }

    // A node that runs a step is shown the step panel: an interpolation takes a clip and a multiplier, an
    // upscaler a picture and a model, an angle re-render a picture and three knobs. What that panel shows comes
    // from the workflow's own contract, not from what this panel knows about the workflows that take a prompt.
    //
    // A step that *takes* words keeps its box — the angle re-render is asked what to do with the picture — so
    // the prompt is handed to the step panel rather than the panel being chosen by whether a box exists. That
    // choice was the bug: a step with a `prompt` binding looked like a composer model, so its knobs were never
    // shown and its run went down the from-prompt request path (#267).
    if (modelIsStep(globalConfig, config.model)) {
        return (
            <CanvasToolNodePanel
                node={node}
                nodes={nodes}
                config={config}
                connectedNodes={connectedNodes}
                isRunning={isRunning}
                onConfigChange={onConfigChange}
                onGenerate={onGenerate}
                onStop={onStop}
                onDisconnectReference={onDisconnectReference}
                onStartReferenceSelection={onStartReferenceSelection}
                prompt={modelTakesPrompt(globalConfig, config.model) ? { value: draft, onChange: setDraft, onCommit: commitPrompt, placeholder: t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode}`) } : undefined}
            />
        );
    }

    return (
        <div
            ref={panelRef}
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} addDisabled={refusesMedia} addDisabledHint={noReferencesHint} />
            {textVideoHasReferences ? <div className="mb-2 text-xs leading-4 text-[#ef4444]">{noReferencesWarning}</div> : null}
            <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => commitPrompt()}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (isPlainEnterKey(event)) {
                        event.preventDefault();
                        submit();
                    }
                }}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode}`)}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button
                            type="text"
                            className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0"
                            style={{ color: theme.node.text }}
                            icon={<Maximize2 className="size-3.5" />}
                            onClick={openExpandedEditor}
                            aria-label={t("canvas.promptPanel.expandEditor")}
                        />
                    </Tooltip>
                    <Controls
                        node={node}
                        config={config}
                        onConfigChange={onConfigChange}
                        onOpenPreferences={() => openPreferences()}
                        onImageSettingsOpenChange={onImageSettingsOpenChange}
                        onOpenMaskEditor={onOpenMaskEditor}
                        onOpenOutpaintEditor={onOpenOutpaintEditor}
                        onOpenMossLayoutEditor={onOpenMossLayoutEditor}
                        frameMode={frameMode}
                        onVideoModeChange={changeVideoMode}
                        sourceDurationSeconds={sourceVideoDurationSeconds}
                    />
                </div>
                <Button
                    type="primary"
                    className={`ml-auto !h-10 shrink-0 !rounded-full ${isRunning ? "!min-w-10 !px-2" : "!min-w-16 !px-3"}`}
                    danger={isRunning}
                    disabled={!isRunning && !draft.trim() && !connectedText}
                    title={isRunning ? t("canvas.promptPanel.stop") : undefined}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={t(isRunning ? "canvas.promptPanel.stop" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">{isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</span>
                </Button>
            </div>
            <SentPromptDisclosure sent={node.metadata?.sentPrompt} current={draft} />
            <Dialog
                title={t("canvas.promptPanel.editorTitle")}
                open={expanded}
                size="panel"
                onClose={() => {
                    commitPrompt();
                    setExpanded(false);
                }}
            >
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar
                        nodeId={node.id}
                        nodes={nodes}
                        connectedNodes={connectedNodes}
                        onDisconnect={onDisconnectReference}
                        onStartSelection={(nodeId) => {
                            setExpanded(false);
                            onStartReferenceSelection?.(nodeId);
                        }}
                        addDisabled={refusesMedia}
                        addDisabledHint={noReferencesHint}
                    />
                    {textVideoHasReferences ? <div className="mb-2 text-xs leading-4 text-[#ef4444]">{noReferencesWarning}</div> : null}
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => commitPrompt()}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (isPlainEnterKey(event)) {
                                event.preventDefault();
                                submit();
                            }
                        }}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full resize-none rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode}`)}
                    />
                </div>
            </Dialog>
        </div>
    );
}

/**
 * The kind a node generates. A card that holds words is not here at all: it has no panel and nothing to
 * generate, so the callers never ask — `nodeTakesPanel` is the one that says so (#278).
 */
function defaultMode(type: CanvasNodeData["type"]): CanvasGenerationMode {
    return type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? "",
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        videoSelfLiftMode: node.metadata?.videoSelfLiftMode || globalConfig.videoSelfLiftMode || "fast",
        frameMode: node.metadata?.frameMode,
        imageMode: node.metadata?.imageMode || globalConfig.imageMode || "",
        outpaint: node.metadata?.outpaint || globalConfig.outpaint,
        layout: node.metadata?.layout || globalConfig.layout,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSeconds: node.metadata?.seconds || globalConfig.audioSeconds || defaultConfig.audioSeconds,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        seed: node.metadata?.seed || globalConfig.seed || "",
        seedFixed: node.metadata?.seedFixed ?? globalConfig.seedFixed ?? "false",
        params: node.metadata?.params || globalConfig.params,
    };
}

/**
 * Whether a reference could ever reach this workflow.
 *
 * The contract says what the run takes; nothing declared at all is not a refusal, just an absence of a
 * contract — the same three-state reading #256 gave every other acceptance. Summing the three media caps is
 * what makes "text-to-video takes no media" a fact of the declaration instead of a workflow id.
 */
function canTakeMedia(accepts: ModelAccepts | undefined) {
    if (!accepts) return true;
    return (accepts.images?.max ?? 0) + (accepts.videos?.max ?? 0) + (accepts.audios?.max ?? 0) > 0;
}
