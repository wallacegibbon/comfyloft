import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Bot, ChevronRight, CircleCheck, CircleDashed, CircleX, Eraser, Info, LoaderCircle, Mic, Square, X } from "lucide-react";

import { citationLabel, mentionResolver, referenceBlock, referenceLine, type Citation, type MentionSegment } from "@/lib/canvas/agent-references";
import { insertSpoken } from "@/lib/canvas/agent-dictation";
import { agentIsWorking, agentRunState, resumeTurn, textOf, transcriptEvent, transcriptWindow, turnStartedAt, type AgentRunState, type ToolStep, type TranscriptMessage } from "@/lib/canvas/agent-transcript";
import { contextSegment, speedSegment } from "@/lib/canvas/agent-usage";
import { nodeContentOf } from "@/lib/canvas/node-prompt-field";
import { reasoningPreview } from "@/lib/canvas/reasoning-preview";
import { toolSubjectOf } from "@/lib/canvas/tool-argument";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { confirm } from "@/components/kit/confirm";
import { apiErrorMessage } from "@/services/api/http";
import { AgentSettingsControls } from "./agent-settings-controls";
import { AgentMarkdown } from "./agent-markdown";
import { useHoldToTalk } from "./use-hold-to-talk";
import { transcribeSpeech } from "@/services/api/speech";
import { agentSession, cancelAgentSession, canvasAgent, clearAgentConversation, closeAgentSession, onAgentEvent, openAgentSession, sendAgentMessage, subscribeAgentSessions, type AgentEvent } from "@/services/api/agent";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * The canvas agent, as a card that floats above the canvas instead of living in it.
 *
 * It is not a node: it does not pan, it does not zoom, it is not selected, exported or garbage
 * collected with the content. That is what a conversation is — a surface for working *on* the canvas,
 * not another thing on it. It carries `data-canvas-overlay` so the wheel and the drag stop at its edge
 * (see `lib/canvas-overlay.ts`), and its window — open, place, size — is remembered in the document
 * (`CanvasAgentWindow`), so a canvas reopens with the conversation where it was left.
 */

type Props = {
    canvasId: string;
    nodes: CanvasNodeData[];
    onFocusNode: (nodeId: string) => void;
    /** Ask the canvas to let the user click the node to cite. Resolves with the node, or null if cancelled. */
    onPickNode: () => Promise<string | null>;
};

const NODE_LABEL: Record<string, string> = {
    [CanvasNodeType.Image]: "image",
    [CanvasNodeType.Video]: "video",
    [CanvasNodeType.Audio]: "audio",
    [CanvasNodeType.Text]: "text",
};

/** How a call that ended reads: green when it worked, red when it did not. */
const TOOL_OK = "#22c55e";
const TOOL_FAILED = "#ef4444";

/** How much of a conversation the panel keeps mounted, until "earlier messages" is pressed. */
const MESSAGE_WINDOW = 20;

export function CanvasAgentPanel({ canvasId, nodes, onFocusNode, onPickNode }: Props) {
    const { t, i18n } = useTranslation();
    const theme = useCanvasTheme();
    const config = useEffectiveConfig();
    const agentWindow = useCanvasAgentStore((state) => state.windows[canvasId]);
    const open = agentWindow?.open ?? false;
    const position = agentWindow?.position ?? null;
    const size = agentWindow?.size ?? null;
    const setSize = useCanvasAgentStore((state) => state.setSize);
    const setOpen = useCanvasAgentStore((state) => state.setOpen);
    const setPosition = useCanvasAgentStore((state) => state.setPosition);

    /** This canvas's conversation, by name. It is also the name of the file the agent keeps it in. */
    const session = useMemo(() => canvasAgent(canvasId), [canvasId]);

    /**
     * What each node is called, mapped once for the whole panel.
     *
     * Every run of text in every answer resolves `@label` against this, so mapping it inside that walk —
     * once per run, translator call per node included — made a frame cost grow with the canvas times the
     * answer (#237). The identity matters too: a finished answer is only rebuilt when something it reads
     * has actually changed, and this is one of those things.
     */
    // A citation is a node: its id is the one token that names exactly one of them, and it is what the box
    // writes when something is picked (#321).
    const citationLabels = useMemo(() => nodes.map((node) => ({ id: node.id, label: node.id })), [nodes]);

    /**
     * How full the context is and how fast the agent is going, as it last reported — plus the size of the
     * context, which is the active model's and not a measurement of anything.
     *
     * Both are read from the session's own state rather than kept here: the agent announces them, this
     * side draws them, and a second copy is a second thing to keep in step. Two subscriptions because a
     * snapshot has to be one value with a stable identity, and the pair is not.
     */
    const usage = useSyncExternalStore(subscribeAgentSessions, () => agentSession(session).usage);
    const contextLimit = useSyncExternalStore(subscribeAgentSessions, () => agentSession(session).active?.contextLimit || 0);
    const context = usage ? contextSegment(usage.contextTokens, contextLimit) : "";
    const speed = usage ? speedSegment(usage) : "";

    const [messages, setMessages] = useState<TranscriptMessage[]>([]);
    const [draft, setDraft] = useState("");
    const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "closed">("idle");
    /**
     * The turn in flight, and when it began on this page's clock — one fact, because the number drawn from it
     * is the turn's (#342).
     *
     * `null` is "no turn is running", and that is all `busy` still is: the flag and the instant are the same
     * piece of state, so "the agent is working" and "it began at" cannot come to disagree. The instant is
     * `performance.now()`, which only moves forward — a system clock adjusted mid-turn would otherwise walk the
     * count backwards.
     *
     * Two things set it, and they are the two ways a page can learn that a turn is running: the send that
     * opens one, and the `turn` frame for a turn that began before this page existed. That frame is the only
     * account of the wait a reload cannot lose.
     */
    const [turn, setTurn] = useState<{ startedAt: number } | null>(null);
    const busy = turn !== null;
    /**
     * Note that a turn is running.
     *
     * The first thing that says so wins: a message sent into a turn already running joins it and does not
     * restart its clock (#342), and a frame from a turn this page did not open is a turn whose real start the
     * `turn` frame states, or has just stated — so this never overwrites an age the session gave.
     */
    const beginTurn = () => {
        const startedAt = performance.now();
        setTurn((current) => current ?? { startedAt });
    };
    /**
     * The turn is running and has put nothing on screen for itself yet.
     *
     * Read from the turn — which the send records — and not from the transcript, so the line is on screen from
     * the moment the message goes out rather than from the first frame that comes back (see
     * `agentIsWorking`).
     */
    const working = agentIsWorking(messages, busy);
    /**
     * How many seconds this turn has been running.
     *
     * The tick is this side's — one subtraction, re-rendering this row and nothing else, because the
     * transcript below is memoised — but the start is the session's, so a page that comes back mid-turn counts
     * from where the turn began instead of from where it came back (#342). A counter that keeps climbing is
     * what tells a reader the difference between an agent that is thinking and a panel that is doing nothing
     * at all: the same seconds with no motion is what a hang looks like.
     */
    const [waited, setWaited] = useState(0);
    useEffect(() => {
        if (!working || !turn) {
            setWaited(0);
            return;
        }
        const { startedAt } = turn;
        const tick = () => setWaited(Math.floor((performance.now() - startedAt) / 1000));
        tick();
        // One tick a second, and only while the wait lasts.
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [working, turn]);
    /**
     * How many messages are waiting in the agent's queue for the running task.
     *
     * The agent announces each one as it takes it (`queued`), and announces `delivered` **once** for the
     * whole batch — it inserts them together. So the number is built from the queued frames and cleared
     * outright on delivery, not decremented: one delivery empties the queue.
     */
    const [steering, setSteering] = useState(0);
    /**
     * The turn, as one line of text.
     *
     * The two facts that used to be two rows — is the agent waiting, and how many messages are queued behind
     * it — are decided in `agentRunState` and worded here per state, rather than glued together out of two
     * sentences: a language that names the count first is a translation, not a second layout.
     */
    const runState = agentRunState(working, steering);
    const turnLines: Record<AgentRunState, string> = {
        idle: "",
        waiting: t("canvas.agent.working", { seconds: waited }),
        "waiting-queued": t("canvas.agent.workingQueued", { seconds: waited, count: steering }),
        queued: t("canvas.agent.steeringQueued", { count: steering }),
    };
    const turnLine = turnLines[runState];
    /**
     * Whether the stop button is asking what to do with the queue.
     *
     * Only ever open when there is something to ask about: with nothing queued, stopping has one answer and
     * a dialog over it would be a question with no alternatives. The question itself has two answers —
     * AlayaCore's one optional cancel argument, with it or without it — and closing the dialog is not a third
     * one: nothing is sent at all until one of the two is pressed.
     */
    const [stopAsk, setStopAsk] = useState(false);
    /**
     * How many of the newest messages are mounted.
     *
     * A conversation is never trimmed — it is replayed whole from the agent's session file every time the
     * window opens — and a finished message stays in the DOM whether or not it is on screen. A long answer
     * is a few hundred elements, so the transcript is mounted newest-first up to this many and the rest is
     * one press away. The memoised bodies already make a frame cost the same at any length (#237); this is
     * about the mount.
     */
    const [windowSize, setWindowSize] = useState(MESSAGE_WINDOW);
    /**
     * The nodes this draft cites, in the order they were cited, each with the label the text shows.
     *
     * The id is what the click follows and the label is what the reader sees; keeping both here is what
     * makes two nodes with the same name two citations instead of one (#163).
     */
    const [citations, setCitations] = useState<Citation[]>([]);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const dragRef = useRef<{ dx: number; dy: number } | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);

    // The conversation is the socket, and the socket belongs to this panel's lifetime, not to a render.
    const connect = useCallback(async () => {
        setStatus((current) => (current === "connected" ? current : "connecting"));
        try {
            await openAgentSession(config, session);
            setStatus("connected");
        } catch (error) {
            setStatus("closed");
            setMessages((current) => transcriptEvent(current, { type: "error", message: error instanceof Error ? error.message : t("canvas.agent.connectFailed") }));
        }
    }, [canvasId, config, t]);

    // The panel opens the conversation, and it is the only thing that does. The ref keeps the effect off
    // the render: `config` is a fresh object every time, so depending on `connect` would close and reopen
    // the socket on every keystroke elsewhere on the canvas.
    const connectRef = useRef(connect);
    connectRef.current = connect;

    /**
     * Throw the conversation away on both sides, then open a new one.
     *
     * The server decides: it refuses a session with a turn in flight and changes nothing, and on success
     * it has already released the agent and removed the file. Only then does this side drop the socket
     * and open a new one, which spawns an agent with nothing to replay. This panel draws its transcript
     * from that history, which is why an empty one is an empty panel rather than a second source of truth
     * to clear.
     */
    const clearHistory = async () => {
        // The button is disabled mid-turn, and this is the same refusal one layer down: the panel is not
        // the authority on whether the agent is idle, the server is (docs/decisions.md #187).
        if (busy) return;
        try {
            await clearAgentConversation(config, session);
        } catch (error) {
            // The server's own words: "the agent is in the middle of a turn" is actionable in a way that
            // "could not clear" is not, and nothing was changed, so the conversation is still usable.
            setMessages((current) => transcriptEvent(current, { type: "error", message: apiErrorMessage(error, t("canvas.agent.clearHistoryFailed")) }));
            return;
        }
        setTurn(null);
        // A failed connect reports itself; there is nothing left here to undo.
        void connectRef.current();
    };

    useEffect(() => {
        if (!open) return;
        void connectRef.current();
        // Closing the panel closes the socket and leaves the agent — with the turn it is running, which is
        // now the canvas's and not this window's. The wait this window was drawing ends with the window:
        // reopening it asks the session again (the `turn` frame, which carries how long the turn has been
        // running), so nothing here is remembered.
        return () => {
            closeAgentSession(session);
            setTurn(null);
            setSteering(0);
        };
    }, [open, session]);

    useEffect(() => onAgentEvent(session, applyEvent), [session]);

    /**
     * One frame, three things: the session's own state, whether a turn is running, and the transcript.
     *
     * The transcript is `transcriptEvent`'s — the order messages are drawn in is decided there, once, and
     * it is the order the frames arrived in. What is left here is what only the panel knows: connected or
     * not, working or idle, and how many messages are waiting in the agent's queue.
     */
    const applyEvent = (event: AgentEvent) => {
        if (event.type === "steering") {
            // A queue nobody can see looks like a message that was lost. The size travels with the frame,
            // counted by the session from the agent's own phases, so the page draws it instead of keeping a
            // tally of its own — the tally was what a reload lost (#345).
            setSteering(event.queued ?? 0);
            return;
        }
        if (event.type === "turn") {
            // What the session says about itself, which the transcript cannot: a replayed conversation is all
            // finished messages, exactly like a turn that has not said anything yet. It arrives on connect,
            // and it is the only thing that can say "the words below are the beginning of an answer that is
            // still going" — the agent outlives this socket, so the panel may join one already running.
            //
            // It is also the only thing that can say how long that answer has been going: `elapsedMs` is the
            // turn's age when the frame was written, and reading it against this page's own clock is what
            // makes a reload continue the count instead of restarting it (#342). The queue travels with it for
            // the same reason: a page that comes back is told how many messages are waiting (#345).
            setTurn(event.running ? { startedAt: turnStartedAt(event.elapsedMs, performance.now()) } : null);
            setSteering(event.queued ?? 0);
            if (event.running) setMessages(resumeTurn);
            return;
        }
        if (event.type === "delta" || event.type === "reasoning" || event.type === "tool_call" || event.type === "tool_result") {
            // Anything arriving mid-turn means the agent is working, whoever asked it. `busy` normally
            // follows the send and the `done`, but a turn that outlived its panel would otherwise look idle.
            beginTurn();
        }
        if (event.type === "done") setTurn(null);
        if (event.type === "error") {
            // The agent's answer about the message itself. A message it could not take never becomes a task, so
            // no `done` is coming and the row would stand over nothing for as long as the panel is open. A
            // failure *inside* a turn is followed by its own `done` a frame later, which makes this redundant
            // rather than wrong (#342).
            setTurn(null);
        }
        if (event.type === "closed") {
            setStatus("closed");
            setTurn(null);
            setSteering(0);
        }
        setMessages((current) => transcriptEvent(current, event));
    };

    const submit = async () => {
        const text = draft.trim();
        // Not `busy`: AlayaCore queues, and a message sent mid-loop is inserted between the agent's steps.
        // Refusing to send would only make the user wait for a turn that may be long.
        if (!text) return;
        // Sending into a socket that is not open would drop the message and leave the panel stuck on a
        // turn that never ends, so the conversation is opened (or reopened) first. It is idempotent.
        try {
            await connectRef.current();
        } catch {
            return;
        }
        const context = referenceBlock(
            t("canvas.agent.contextMarker"),
            citations.flatMap((citation) => {
                const line = describeNode(
                    nodes.find((node) => node.id === citation.id),
                    citation.label,
                );
                return line ? [line] : [];
            }),
        );
        // Nothing is drawn here. What the panel shows is the conversation the agent reports — its echo of
        // this message, then what it answers — so there is one copy of it and no second one to keep in step.
        setDraft("");
        setCitations([]);
        // A message sent into a turn that is already running joins it rather than starting a second one, so
        // this leaves an age the session stated alone.
        beginTurn();
        // A message that could not be written would leave the panel on a turn nobody is running.
        if (!sendAgentMessage(session, { prompt: context + text })) {
            setTurn(null);
            setMessages((current) => transcriptEvent(current, { type: "error", message: t("canvas.agent.sendFailed") }));
        }
    };

    // --- size -------------------------------------------------------------------------------------------
    // It opens at a share of the canvas rather than a fixed pair of numbers: the panel is for reading long
    // answers and watching tools run, and 380×480 was too small for either on a normal window. Measured
    // against the space the canvas actually has, so a small window still gets a panel that fits in it.
    // A remembered size is used as written but still bounded by the room: the window may have been much
    // larger when the size was chosen, and a panel taller than the canvas cannot be grabbed to shrink.
    const host = cardRef.current?.parentElement?.getBoundingClientRect() ?? null;
    const roomWidth = host?.width || window.innerWidth;
    const roomHeight = host?.height || window.innerHeight;
    const width = Math.min(size?.width ?? Math.min(520, roomWidth - 24), roomWidth - 16);
    const height = Math.min(size?.height ?? Math.min(760, Math.max(420, Math.round(roomHeight * 0.8))), roomHeight - 16);
    // A window remembered off-screen — the browser got smaller since it was placed — is pulled back into
    // the canvas when it is drawn, but the stored value is left alone: the person's own position is what
    // goes back to disk if they close without touching it.
    const placed = position
        ? {
              left: Math.min(Math.max(8, position.x), Math.max(8, roomWidth - width - 8)),
              top: Math.min(Math.max(8, position.y), Math.max(8, roomHeight - height - 8)),
          }
        : null;

    // --- dragging ---------------------------------------------------------------------------------------
    // Pointer events are captured on the header, so a fast drag that leaves the card keeps moving it.
    const startDrag = (event: React.PointerEvent) => {
        const rect = cardRef.current?.getBoundingClientRect();
        if (!rect) return;
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        setPosition(canvasId, { x: rect.left, y: rect.top });
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
    };
    const moveDrag = (event: React.PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const host = cardRef.current?.parentElement?.getBoundingClientRect();
        const width = cardRef.current?.offsetWidth || 520;
        const height = cardRef.current?.offsetHeight || 480;
        const maxX = (host?.width || window.innerWidth) - width - 8;
        const maxY = (host?.height || window.innerHeight) - height - 8;
        setPosition(canvasId, { x: Math.min(Math.max(8, event.clientX - drag.dx), Math.max(8, maxX)), y: Math.min(Math.max(8, event.clientY - drag.dy), Math.max(8, maxY)) });
    };
    const endDrag = (event: React.PointerEvent) => {
        dragRef.current = null;
        (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    };

    /**
     * Which corner is being pulled, and the room the panel had when the gesture started.
     *
     * `anchor` is the panel's explicit position, or null when it is sitting in its default corner (anchored by
     * its right and bottom edges) — a corner can only move the far one if there is a near one to hold still.
     */
    const resizeRef = useRef<{ corner: "top-left" | "bottom-right"; x: number; y: number; width: number; height: number; anchor: { x: number; y: number } | null } | null>(null);
    const startResize = (corner: "top-left" | "bottom-right") => (event: React.PointerEvent) => {
        event.preventDefault();
        event.stopPropagation();
        resizeRef.current = { corner, x: event.clientX, y: event.clientY, width, height, anchor: placed ? { x: placed.left, y: placed.top } : null };
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    };
    const moveResize = (event: React.PointerEvent) => {
        const grip = resizeRef.current;
        if (!grip) return;
        const host = cardRef.current?.parentElement?.getBoundingClientRect();
        // The panel is the window's: it may be made as big as the canvas it floats in, and no bigger.
        const limit = (value: number, min: number, max: number) => Math.min(Math.max(min, value), Math.max(min, max));
        const dx = event.clientX - grip.x;
        const dy = event.clientY - grip.y;
        // Pulling a corner towards the middle shrinks; from the top-left that means the opposite sign.
        const sign = grip.corner === "top-left" ? -1 : 1;
        const nextWidth = limit(grip.width + sign * dx, 320, (host?.width || window.innerWidth) - 16);
        const nextHeight = limit(grip.height + sign * dy, 280, (host?.height || window.innerHeight) - 16);
        setSize(canvasId, { width: nextWidth, height: nextHeight });
        // With an explicit position the panel is pinned by its top-left corner, so moving that corner is moving
        // the panel: the opposite one stays where it is, which is what makes it look like the corner was pulled.
        if (grip.anchor && grip.corner === "top-left") setPosition(canvasId, { x: grip.anchor.x + (grip.width - nextWidth), y: grip.anchor.y + (grip.height - nextHeight) });
    };
    const endResize = (event: React.PointerEvent) => {
        resizeRef.current = null;
        (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    };

    // --- dictation --------------------------------------------------------------------------------------
    /**
     * The caret the box last showed.
     *
     * Speaking is another way of typing, so the words go where typing would have gone — and by the time they
     * arrive the box has not had the focus for several seconds, because the gesture started on the canvas or
     * on a button. A textarea keeps its selection while unfocused, so the box itself is the answer while it is
     * open (`onSelect` keeps this in step); the end of the draft is the answer for a box that has never been
     * touched, which is where a first keystroke would land.
     */
    const caretPointRef = useRef<{ start: number; end: number } | null>(null);

    /** What was said, put in at the caret — and the panel opens, because that is where the words went. */
    const insertSpeech = (text: string) => {
        const selection = caretPointRef.current ?? { start: draft.length, end: draft.length };
        const { value, caret } = insertSpoken(draft, text, selection);
        caretPointRef.current = { start: caret, end: caret };
        caretRef.current = caret;
        setDraft(value);
        setOpen(canvasId, true);
    };

    /**
     * Hold `Ctrl`/`⌘` and `'` or the backquote above Tab, or hold the microphone button: the words land in
     * the box at the caret.
     *
     * The sound's language follows the one the interface is written in, which is a hint and not a
     * constraint — the model answers in the language it hears either way (`services/api/speech.ts`).
     */
    const speech = useHoldToTalk({
        transcribe: (samples, sampleRate) => transcribeSpeech(config, samples, sampleRate, i18n.language?.toLowerCase().startsWith("zh") ? "zh" : "en"),
        onWords: insertSpeech,
    });

    // --- citations --------------------------------------------------------------------------------------
    /** The `@` a pick is answering, so the label lands where it was typed. */
    const pickAtRef = useRef<number>(-1);
    /** Where the caret belongs once the draft has been rewritten — a pick puts it after the label. */
    const caretRef = useRef<number | null>(null);

    /** Put the caret in the box at this position, which is also what takes the focus back from the canvas. */
    const focusAt = (caret: number | null) => {
        if (caret === null) {
            caretRef.current = null;
            return;
        }
        const input = inputRef.current;
        if (!input) return;
        caretRef.current = null;
        input.focus();
        input.setSelectionRange(caret, caret);
    };

    const cite = (nodeId: string) => {
        const at = pickAtRef.current;
        pickAtRef.current = -1;
        if (at < 0) return;
        // A citation is the node's id: the one token that names exactly one node, the same token every tool
        // answers with, and therefore the same token an answer writes back (#321).
        const already = citations.find((citation) => citation.id === nodeId);
        const label = already
            ? already.label
            : citationLabel(
                  nodeId,
                  citations.map((citation) => citation.label),
              );
        // The `@` and the space around the label: the next thing typed belongs after it, not inside it.
        caretRef.current = at + label.length + 2;
        setDraft((current) => `${current.slice(0, at)}@${label} ${current.slice(at + 1)}`);
        setCitations((current) => (current.some((citation) => citation.id === nodeId) ? current : [...current, { id: nodeId, label }]));
    };

    // The click happened on the canvas, so the box has to take the focus and the caret back once the draft is
    // in the DOM — the pick is a way of typing, and typing continues where it left off.
    useEffect(() => {
        if (caretRef.current === null) return;
        focusAt(caretRef.current);
    }, [draft]);

    /**
     * `@` is a request to pick a node on the canvas, the way a reference's + does — the user points at the
     * thing itself rather than at a name in a list. The character stays in the draft, where the label
     * replaces it once something is picked; a cancelled pick leaves the `@` as typed, and the box focused.
     */
    const onChange = (value: string) => {
        const caret = inputRef.current?.selectionStart ?? value.length;
        // Any `@` that just landed at the caret asks for a pick. It does not need a space in front of it: Chinese
        // text has no spaces to put there, and an `@` that was not meant as a citation is one escape away from
        // staying exactly as typed.
        const typed = value.length > draft.length && caret > 0 && value[caret - 1] === "@";
        setDraft(value);
        if (!typed) return;
        const at = caret - 1;
        pickAtRef.current = at;
        void onPickNode().then((nodeId) => {
            if (nodeId) cite(nodeId);
            else focusAt(at + 1);
        });
    };

    /**
     * Follow the newest message only while the reader is at the bottom.
     *
     * Someone who scrolled up to read is not asking to be dragged back down, and someone who scrolls back to
     * the end is asking for the follow to resume. The position is the truth and is read again on every
     * message, because a wheel gesture and a scroll event both have to survive a tab that is not drawing —
     * and because being at the bottom is the whole condition: there is no separate "follow mode" to get out
     * of step with where the reader actually is.
     */
    const followRef = useRef(true);
    const atBottom = (element: HTMLDivElement) => element.scrollHeight - element.scrollTop - element.clientHeight < 24;

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        if (!followRef.current) {
            if (!atBottom(element)) return;
            followRef.current = true;
        }
        element.scrollTop = element.scrollHeight;
        // Only the messages: the turn's own row is outside this box (#315), so nothing in here appears
        // without a message to announce it.
    }, [messages]);

    /**
     * Showing more of the conversation must not move what is being read.
     *
     * The older messages go in *above* the reader, and a browser keeps `scrollTop` — so without this the
     * press threw the view up by however much was inserted. The distance to the bottom is what stays the
     * same: it is measured before the state changes and put back once the taller content is in the DOM.
     */
    const anchorRef = useRef<number | null>(null);
    useLayoutEffect(() => {
        const element = scrollRef.current;
        if (!element || anchorRef.current === null) return;
        element.scrollTop = element.scrollHeight - anchorRef.current;
        anchorRef.current = null;
    }, [windowSize]);
    const showEarlier = () => {
        const element = scrollRef.current;
        anchorRef.current = element ? element.scrollHeight - element.scrollTop : null;
        setWindowSize((current) => current + MESSAGE_WINDOW);
    };
    const { shown, hidden } = transcriptWindow(messages, windowSize);

    if (!open) return null;

    const style = placed ?? { right: 24, bottom: 24 };

    return (
        <div
            ref={cardRef}
            data-canvas-overlay=""
            className="absolute z-[95] flex max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-2xl border shadow-2xl backdrop-blur"
            style={{ ...style, width, height, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
        >
            <div className="flex cursor-grab items-center gap-2 border-b px-3 py-2 active:cursor-grabbing" style={{ borderColor: theme.toolbar.border }} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
                <Bot className="size-4 shrink-0" style={{ color: theme.node.activeStroke }} />
                <span className="text-sm font-medium">{t("canvas.agent.title")}</span>
                <span className="truncate text-xs opacity-60">{status === "connected" ? t("canvas.agent.connected") : status === "connecting" ? t("canvas.agent.connecting") : t("canvas.agent.disconnected")}</span>
                <button
                    type="button"
                    className="ml-auto rounded p-1 opacity-60 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-25 disabled:hover:opacity-25"
                    disabled={busy}
                    onClick={() =>
                        confirm({
                            title: t("canvas.agent.clearHistory"),
                            content: t("canvas.agent.clearHistoryConfirm"),
                            okText: t("canvas.agent.clearHistoryOk"),
                            cancelText: t("common.cancel"),
                            danger: true,
                            onOk: () => clearHistory(),
                        })
                    }
                    title={busy ? t("canvas.agent.clearHistoryBusy") : t("canvas.agent.clearHistory")}
                    aria-label={busy ? t("canvas.agent.clearHistoryBusy") : t("canvas.agent.clearHistory")}
                >
                    <Eraser className="size-3.5" />
                </button>
                <button type="button" className="rounded p-1 opacity-60 hover:opacity-100" onClick={() => setOpen(canvasId, false)} title={t("canvas.agent.close")} aria-label={t("canvas.agent.close")}>
                    <X className="size-3.5" />
                </button>
            </div>

            {status === "connected" ? (
                <div className="border-b px-2 py-1.5" style={{ borderColor: theme.toolbar.border }}>
                    <AgentSettingsControls session={session} className="flex min-w-0 items-center gap-1" />
                </div>
            ) : null}

            <div
                ref={scrollRef}
                className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm"
                data-canvas-scroll=""
                onScroll={(event) => {
                    followRef.current = atBottom(event.currentTarget);
                }}
                onWheel={(event) => {
                    // A wheel up is the reader taking over, at once: waiting for the scroll position to say so
                    // would let one more message drag them back down in the middle of the gesture.
                    if (event.deltaY < 0) followRef.current = false;
                }}
            >
                {messages.length === 0 ? <p className="text-xs opacity-50">{t("canvas.agent.hint")}</p> : null}
                {/* What is not mounted is still there, one press away — and pressing it must not move the
                    words being read (see `showEarlier`). The count is what one press adds, so it never
                    promises more than the button does. */}
                {hidden > 0 ? (
                    <button type="button" className="block w-full rounded-lg border border-dashed px-2 py-1 text-center text-[11px] opacity-60 hover:opacity-100" style={{ borderColor: theme.toolbar.border }} onClick={showEarlier}>
                        {t("canvas.agent.earlierMessages", { count: Math.min(hidden, MESSAGE_WINDOW) })}
                    </button>
                ) : null}
                {/* One left edge for everything. A user message is already told apart by its box, and
                    pushing it to the right only made the transcript read in two columns. A system notice
                    is neither side talking, so it sits between the bubbles, smaller than either. */}
                {shown.map((message) =>
                    message.role === "system" ? (
                        <div key={message.id} className="flex items-start gap-1.5 px-1 text-[11px] opacity-50">
                            <Info className="mt-0.5 size-3 shrink-0" />
                            <span className="whitespace-pre-wrap">{textOf(message)}</span>
                        </div>
                    ) : (
                        <div key={message.id} className={message.role === "user" ? "rounded-xl px-3 py-2" : "mr-2 space-y-1"} style={message.role === "user" ? { background: theme.node.fill, border: `1px solid ${theme.node.stroke}` } : undefined}>
                            {/* The parts, in the order the frames arrived: a sentence, a call, the sentence
                                that reads its result — never the calls gathered at the top. */}
                            {message.parts.map((part, index) =>
                                part.kind === "tool" ? (
                                    <ToolStepLine key={`${message.id}-${index}`} step={part} live={message.streaming} />
                                ) : part.kind === "reasoning" ? (
                                    <ReasoningBlock key={`${message.id}-${index}`} text={part.text} />
                                ) : message.role === "error" ? (
                                    <p key={`${message.id}-${index}`} className="whitespace-pre-wrap text-xs" style={{ color: TOOL_FAILED }}>
                                        {part.text}
                                    </p>
                                ) : message.role === "assistant" ? (
                                    // An answer is a document — the model writes lists and tables, and a `pre-wrap`
                                    // paragraph printed the pipes instead of the table (#237). What the user typed
                                    // keeps the line breaks it was typed with, so only this side is parsed.
                                    <AnswerBody key={`${message.id}-${index}`} text={part.text} mentions={message.mentions} labels={citationLabels} color={theme.node.activeStroke} onFocusNode={onFocusNode} />
                                ) : (
                                    <p key={`${message.id}-${index}`} className="whitespace-pre-wrap leading-relaxed">
                                        <PlainBody key={`${message.id}-${index}`} text={part.text} mentions={message.mentions} labels={citationLabels} color={theme.node.activeStroke} onFocusNode={onFocusNode} />
                                    </p>
                                ),
                            )}
                        </div>
                    ),
                )}
            </div>

            <div className="relative border-t px-2 py-2" style={{ borderColor: theme.toolbar.border }}>
                {/* The turn, in one row: waiting for its first word, how many messages are queued behind it,
                    or both at once. It is drawn from the send (`agentIsWorking`) rather than from a frame, so
                    it is up before the model has said anything, and it is not a word about thinking — the
                    folded reasoning in the transcript already carries that.

                    One row, because the wait and the queue are one subject: they used to be two rows with two
                    spinners in two places, so queuing a message mid-turn showed two of them and the wait could
                    scroll out of sight in a long conversation (#315). This row does not scroll — it sits where
                    the message was sent from and where the stop button is, and what happens to those queued
                    words when the turn is stopped is asked at the moment of stopping (see the dialog below).
                    The microphone's row under it is a different subject. */}
                {runState !== "idle" ? (
                    <p className="flex items-center gap-1.5 px-1 pb-1 text-[11px] tabular-nums opacity-60" title={working ? t("canvas.agent.workingHint") : undefined}>
                        <LoaderCircle className="size-3 animate-spin" />
                        {turnLine}
                    </p>
                ) : null}
                {/* What the microphone is doing, in the place the words are about to appear. A failure is
                    the speech server's own sentence, verbatim: "only WAV audio uploads are supported" is
                    actionable where "dictation failed" is not. */}
                {speech.phase !== "idle" ? (
                    <p className="flex items-center gap-1.5 px-1 pb-1 text-[11px] opacity-60">
                        {speech.phase === "listening" ? <Mic className="size-3 animate-pulse" /> : <LoaderCircle className="size-3 animate-spin" />}
                        {speech.phase === "listening" ? t("canvas.agent.dictating") : t("canvas.agent.transcribing")}
                    </p>
                ) : null}
                {speech.error ? (
                    <p className="px-1 pb-1 text-[11px] leading-4" style={{ color: TOOL_FAILED }}>
                        {speech.error}
                    </p>
                ) : null}
                {/* Not a failure: the microphone stopped because the gesture reached its length. The words it
                    caught are on their way, which is why this is not the red line above. */}
                {speech.notice ? <p className="px-1 pb-1 text-[11px] leading-4 opacity-60">{speech.notice}</p> : null}
                <textarea
                    ref={inputRef}
                    value={draft}
                    onChange={(event) => onChange(event.target.value)}
                    // The whole event: a click, an arrow key and a typed character all move the caret, and the
                    // words have to land where the last of them left it.
                    onSelect={() => {
                        const input = inputRef.current;
                        if (input) caretPointRef.current = { start: input.selectionStart, end: input.selectionEnd };
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            submit();
                        }
                    }}
                    rows={2}
                    placeholder={t("canvas.agent.placeholder")}
                    className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:opacity-40"
                    style={{ color: theme.node.text }}
                />
                <div className="flex flex-wrap items-center justify-between gap-1">
                    {/* The agent's own two numbers, in the shape its status bar writes them:
                        "22K/1M 2.2% | 129.5 tok/s (ttft 0.8s)". Nothing here is measured on this side. */}
                    {context || speed ? (
                        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 px-1 text-[11px] tabular-nums opacity-60" title={t("canvas.agent.usageHint")}>
                            {context ? <span>{context}</span> : null}
                            {context && speed ? (
                                <span className="opacity-40" aria-hidden>
                                    |
                                </span>
                            ) : null}
                            {speed ? <span>{speed}</span> : null}
                        </p>
                    ) : null}
                    <div className="ml-auto flex items-center gap-1">
                        {/* Holding this is the same gesture as holding the key: press, speak, let go — the
                            only way to dictate on a device with no keyboard, and the way anyone finds out the
                            key exists. `preventDefault` keeps the focus and the caret in the box below, so
                            the words land where they would have been typed. */}
                        <button
                            type="button"
                            className="rounded-full p-2 hover:opacity-80"
                            style={speech.phase === "listening" ? { background: TOOL_FAILED, color: "#fff" } : { background: theme.node.fill, border: `1px solid ${theme.node.stroke}` }}
                            onPointerDown={(event) => {
                                event.preventDefault();
                                event.currentTarget.setPointerCapture?.(event.pointerId);
                                speech.start();
                            }}
                            onPointerUp={() => speech.stop()}
                            onPointerCancel={() => speech.stop()}
                            title={t("canvas.agent.holdToTalk")}
                            aria-label={t("canvas.agent.holdToTalk")}
                        >
                            <Mic className="size-4" />
                        </button>
                        {busy ? (
                            <button
                                type="button"
                                className="rounded-full p-2 hover:opacity-80"
                                // Nothing queued: one answer, and the button is it. Something queued: the
                                // queue's fate is a real choice, so it is asked before anything is stopped.
                                onClick={() => (steering > 0 ? setStopAsk(true) : cancelAgentSession(session))}
                                title={t("canvas.agent.stop")}
                                aria-label={t("canvas.agent.stop")}
                            >
                                <Square className="size-3.5" />
                            </button>
                        ) : null}
                        <button
                            type="button"
                            className="rounded-full p-2 hover:opacity-80 disabled:opacity-30"
                            style={{ background: theme.node.fill, border: `1px solid ${theme.node.stroke}` }}
                            disabled={!draft.trim()}
                            onClick={() => void submit()}
                            title={t("canvas.agent.send")}
                            aria-label={t("canvas.agent.send")}
                        >
                            <ArrowUp className="size-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/*
             * The one cancel that has two shapes. A bare cancel takes the queued messages with the task and
             * says so in the transcript; `keep_steering` leaves them to run as the next prompt. Which one is
             * meant is the user's to say, the words at stake are theirs, and the count is the whole point of
             * asking — so the question carries it. Closing this (X, Esc) sends nothing: the turn goes on.
             */}
            <Dialog
                open={stopAsk}
                onClose={() => setStopAsk(false)}
                title={t("canvas.agent.stopQueuedTitle")}
                footer={
                    <>
                        <Button
                            onClick={() => {
                                setStopAsk(false);
                                cancelAgentSession(session, true);
                            }}
                        >
                            {t("canvas.agent.stopKeepQueued")}
                        </Button>
                        <Button
                            type="primary"
                            danger
                            onClick={() => {
                                setStopAsk(false);
                                cancelAgentSession(session);
                            }}
                        >
                            {t("canvas.agent.stopDropQueued")}
                        </Button>
                    </>
                }
                size="form"
            >
                <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">{t("canvas.agent.stopQueued", { count: steering })}</p>
            </Dialog>

            {/* Drag the corner and the panel is the size you left it — for this session, like its position. */}
            <div data-canvas-agent-grip="top-left" className="absolute left-0 top-0 z-10 size-3 cursor-nwse-resize" onPointerDown={startResize("top-left")} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} aria-hidden>
                <div className="absolute left-1 top-1 size-1.5 rounded-tl-sm border-l-2 border-t-2 opacity-40" style={{ borderColor: theme.node.text }} />
            </div>
            <div
                data-canvas-agent-grip="bottom-right"
                className="absolute bottom-0 right-0 z-10 size-4 cursor-nwse-resize"
                onPointerDown={startResize("bottom-right")}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                aria-hidden
            >
                <div className="absolute bottom-1 right-1 size-2 rounded-br-sm border-b-2 border-r-2 opacity-40" style={{ borderColor: theme.node.text }} />
            </div>
        </div>
    );
}

/**
 * One tool call, drawn where it happened, with the answer to "did it work?" in front of it.
 *
 * The call is a frame that arrives while the tool runs, and the result is a second frame that says
 * nothing new except how it went — so the step is drawn once and one mark answers it, in the place a
 * tool's icon used to stand: a ball turning while the call is out, a tick when it came back, a cross when
 * it came back as a failure. The state comes first because it is the question the line is read for; which
 * tool it was matters less than whether it is still going. A turn that ended before the result arrived
 * leaves a dash: nothing is known about that call, and a tick or a cross would both be a claim the agent
 * never made.
 */
function ToolStepLine({ step, live }: { step: ToolStep; live: boolean }) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    const running = step.state === "running";
    const stateLabel = !running ? (step.state === "ok" ? t("canvas.agent.toolOk") : t("canvas.agent.toolFailed")) : live ? t("canvas.agent.toolRunning") : t("canvas.agent.toolUnsettled");
    const { subject, range } = toolSubjectOf(step.name, step.input);
    return (
        <div className="flex items-center gap-1 text-[11px] opacity-70">
            <span className="flex size-3 shrink-0 items-center justify-center" title={stateLabel} aria-label={stateLabel}>
                {running ? (
                    live ? (
                        // A ball lit from one side, turning: at rest it is the same shape, and what says the
                        // call is still out is the highlight going round. It turns for as long as the call does.
                        <span className="size-3 animate-spin rounded-full" style={{ background: `radial-gradient(circle at 32% 28%, rgba(255,255,255,.95), rgba(255,255,255,0) 45%), ${theme.node.muted}` }} />
                    ) : (
                        <CircleDashed className="size-3 opacity-60" />
                    )
                ) : step.state === "ok" ? (
                    <CircleCheck className="size-3" style={{ color: TOOL_OK }} />
                ) : (
                    <CircleX className="size-3" style={{ color: TOOL_FAILED }} />
                )}
            </span>
            {/* The tool says what kind of thing it was; what it was about is the argument that names it, and
                that is the half that gets cut — a file name is long, a tool's name and a line range are not. */}
            <span className="shrink-0">{t("canvas.agent.tool", { name: step.name })}</span>
            {subject ? <span className="min-w-0 truncate">{subject}</span> : null}
            {range ? <span className="shrink-0">{range}</span> : null}
        </div>
    );
}

/**
 * What the agent thought before it answered, folded away by default.
 *
 * Reasoning is the one part that is written but not said: it is useful when an answer surprises the reader
 * and noise the rest of the time, so it is one line that opens. It is drawn where it happened like any
 * other part, and it stays open once it is opened — the text keeps arriving under it.
 *
 * Folded, the row carries the two ends of the thought: it began here, it concluded there, and the middle is
 * elided. A closed drawer labelled only "Thinking" says nothing about what was thought, and the ends are
 * what a reader checks a fold for — the start to recognise it, the end to know whether to open it. The two
 * halves are cut by length, not measured, so the row costs the same on every frame of the thought.
 */
function ReasoningBlock({ text }: { text: string }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const { head, tail } = reasoningPreview(text);
    return (
        <div>
            {/* `w-full` because a button is sized by its content: without it the row would be as wide as the
                thought's first 120 characters and the panel would scroll sideways instead of truncating. */}
            <button type="button" aria-expanded={expanded} className="flex w-full min-w-0 items-center gap-1 text-[11px] opacity-60 hover:opacity-100" onClick={() => setExpanded((open) => !open)}>
                <ChevronRight className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
                <span className="shrink-0">{t("canvas.agent.reasoningTitle")}</span>
                {expanded ? null : (
                    <>
                        {/* The start takes whatever room the label and the end leave; the end is short and keeps
                            its own, so a long thought never cuts the sentence it concluded with.

                            Where the start runs out of room it fades rather than drawing an ellipsis of its own,
                            because the "…" after it is the row's one mark for "the middle is gone" and two of
                            them read as a stutter. The fade is the last 24px of the box, so it is the same
                            softness at every panel width and the clipped character is under it, not sliced.

                            A thought short enough that the start is all of it has no "…" to share, so that one
                            ends in the ellipsis an overflowing line is supposed to end in. */}
                        {head ? (
                            tail ? (
                                <span className="min-w-0 overflow-hidden whitespace-nowrap" style={{ maskImage: "linear-gradient(to right, #000 calc(100% - 24px), transparent)" }}>
                                    {head}
                                </span>
                            ) : (
                                <span className="min-w-0 truncate">{head}</span>
                            )
                        ) : null}
                        {tail ? (
                            <>
                                <span className="shrink-0 opacity-60">…</span>
                                {/* Whole, always: it is short by construction (20 characters), so it fits even a
                                    panel dragged to its minimum, and a tail cut at its own end would be the one
                                    part of the thought the row was showing on purpose. */}
                                <span className="shrink-0">{tail}</span>
                            </>
                        ) : null}
                    </>
                )}
            </button>
            {expanded ? <div className="mt-1 whitespace-pre-wrap border-l pl-2 text-[11px] leading-relaxed opacity-60">{text}</div> : null}
        </div>
    );
}

/**
 * A message's text with each `@label` citation as a link to the node it cited.
 *
 * Which node a mention means comes from the message itself: the block it was sent with carries an id per
 * citation, so two nodes that share a name are two links, not one (#163). A node the canvas still names is
 * the fallback, so an answer that mentions something is clickable too. Clicking does what clicking a row in
 * the side panel does: the canvas moves to that node and selects it.
 *
 * A message is drawn one part at a time (#221), so each run of text is read on its own: two citations with
 * the same label on either side of a tool call resolve to the first of them twice, which is the fallback a
 * transcript written before labels were unique gets anyway.
 *
 * The canvas's labels arrive already mapped (`citationLabels`) rather than as nodes: this runs once per run
 * of text in an answer, and mapping every node — calling the translator per node — once per run was a cost
 * that grew with the square of the canvas (#237).
 */
function withMentions(text: string, resolve: (text: string) => MentionSegment[], onFocusNode: (nodeId: string) => void, color: string): ReactNode {
    const segments = resolve(text);
    if (segments.every((segment) => segment.kind === "text")) return text;
    return segments.map((segment, index) =>
        segment.kind === "text" ? (
            segment.text
        ) : (
            <button key={`${index}-${segment.id}`} type="button" className="cursor-pointer rounded px-0.5 font-medium hover:underline" style={{ color }} onClick={() => onFocusNode(segment.id)}>
                {`@${segment.label}`}
            </button>
        ),
    );
}

/**
 * A message drawn as it was written — the user's own words, with its `@label`s as links.
 *
 * Memoised for the same reason `AnswerBody` is: the transcript re-renders on every frame of the answer that
 * is still arriving, and a message that has not changed has nothing to say again.
 */
const PlainBody = memo(function PlainBody({ text, mentions, labels, color, onFocusNode }: { text: string; mentions: Citation[]; labels: Citation[]; color: string; onFocusNode: (nodeId: string) => void }) {
    const resolve = useMemo(() => mentionResolver(mentions, labels), [mentions, labels]);
    return <p className="whitespace-pre-wrap leading-relaxed">{withMentions(text, resolve, onFocusNode, color)}</p>;
});

/**
 * An answer's words, and nothing rebuilt while they are not changing.
 *
 * A finished message never changes again, but the panel re-renders on every frame of the answer that is
 * still arriving — so every finished answer in the transcript was parsed and rebuilt tens of times a
 * second. Measured (jsdom, #237): a transcript of ten 4 kB answers cost 55 ms a frame that way, and 2.8 ms
 * for the streaming one alone. The memo makes the frame cost the streaming answer and nothing else, which
 * is why its props are exactly what the body reads and all of them are stable for a finished message: its
 * text, the citations the message recorded, the canvas's labels and the accent colour.
 */
const AnswerBody = memo(function AnswerBody({ text, mentions, labels, color, onFocusNode }: { text: string; mentions: Citation[]; labels: Citation[]; color: string; onFocusNode: (nodeId: string) => void }) {
    // Prepared once for the whole answer, not once per run of text inside it: the tables it needs are the
    // canvas's labels, and sorting them a couple of hundred times a frame was a millisecond of every frame.
    const resolve = useMemo(() => mentionResolver(mentions, labels), [mentions, labels]);
    return (
        <div className="leading-relaxed">
            <AgentMarkdown text={text} renderText={(value) => withMentions(value, resolve, onFocusNode, color)} />
        </div>
    );
});

function describeNode(node: CanvasNodeData | undefined, label: string): string {
    if (!node) return "";
    const kind = NODE_LABEL[node.type] || node.type;
    // What the node holds, never what it was asked: a prompt is private. A picture has no words, so its line
    // names it by id and stops there — the agent reads the node itself when it needs the picture (#230).
    const words = (nodeContentOf(node) || "").slice(0, 200);
    return referenceLine(node.id, kind, label, words);
}
