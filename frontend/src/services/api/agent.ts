import i18n from "@/i18n";
import { serverProtocolRoot } from "@/services/api/runs";
import { apiErrorMessage, httpJson } from "@/services/api/http";
import type { AiConfig } from "@/stores/use-config-store";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/**
 * One entry of the agent's own model list (`SM model_list`).
 *
 * `hasKey` rather than a key: the frame carries every `api_key` from `model.conf`, the server strips them,
 * and what is left is whether there is one. `baseUrl` and `modelName` do travel — they are where a model
 * points, which is how two entries called the same thing are told apart.
 */
/**
 * One model, as the agent describes it and as a form may change it.
 *
 * Every field of a `model.conf` entry except the key, which never leaves the server (`hasKey` says whether
 * there is one). The reasoning blocks arrive as JSON, because that is what they are: a request body merged in
 * at that reasoning level, shown in the editor as text (`lib/agent-models.ts`).
 */
export type AgentModel = {
    id: number;
    name: string;
    protocolType?: string;
    baseUrl?: string;
    modelName?: string;
    contextLimit?: number;
    maxTokens?: number;
    reasoning0?: unknown;
    reasoning1?: unknown;
    reasoning2?: unknown;
    reasoningField?: string;
    serialToolCalls?: boolean;
    /** The input modalities this model declares, as `model.conf` holds them: `null` or absent is "not
     *  declared — the protocol decides", `[]` is "declared, and it takes no media". The server always states
     *  the field, so the two never have to be guessed apart. */
    inputModalities?: string[] | null;
    hasKey?: boolean;
};

/**
 * The agent, as sessions.
 *
 * A session is one agent process with one socket, named by whatever surface owns it: the canvas panel
 * owns `canvas:<canvasId>`, a node's panel owns `node:<id>`. Everything the agent knows about itself — which models
 * exist, which one this session is on, how hard it is thinking — belongs to that process and is only
 * ever read back from what it announces. Nothing here mirrors it, and nothing is shared between two
 * sessions: the processes are independent, they are small, and there are as many as there are surfaces.
 *
 * That is why there is a `connect` step at all: a session has to exist before its model can be chosen,
 * because the list of models comes from the agent itself.
 */
export type AgentEvent = {
    type: "models" | "user" | "steering" | "delta" | "reasoning" | "model" | "reasoning_level" | "command" | "tool_call" | "tool_result" | "notice" | "usage" | "tool" | "history" | "turn" | "done" | "error" | "closed";
    text?: string;
    /** `turn`: how long the turn in flight had been running when the frame was written — a duration, not the
     *  instant it began, because the page and the session can be two machines with two clocks. Absent means
     *  "just began", which is what a page counts forward from (`turnStartedAt`). */
    elapsedMs?: number;
    models?: AgentModel[];
    active?: AgentModel;
    level?: number;
    coreVersion?: string;
    ok?: boolean;
    message?: string;
    callId?: string;
    name?: string;
    input?: string;
    output?: string;
    /** `tool_result`: the agent's own verdict on the call — failed rather than did something. */
    isError?: boolean;
    /** `tool`: what the agent wants run, as it sent it. The canvas is what runs it. */
    arguments?: unknown;
    /** `history`: the conversation this session is holding, as the frames it said — what a page that
     *  connects draws instead of an empty panel. Replaces what the panel has. Nothing in it is a summary:
     *  reasoning, tool calls and their results are all there. */
    history?: AgentEvent[];
    /** `turn`: whether a turn is in flight, stated on connect. A replayed conversation is all finished
     *  messages, and so is a turn that has not said anything yet, so this is the one fact that tells them
     *  apart — and the server is the only side that knows it. Always stated, never omitted. */
    running?: boolean;
    /** `steering`: `queued` when a message sent into a running task was taken into the queue, `delivered`
     *  when the agent has worked it into the conversation. */
    phase?: string;
    /** `usage`: the agent's own measurement of the work it is doing — how full the context is, and how
     *  fast the last step went. `models` carries the same three when the agent restored a count from a
     *  session file at startup. */
    contextTokens?: number;
    stepTps?: number;
    ttftMs?: number;
};

/**
 * What the agent reports about its own work: the tokens its context holds, and the speed of the last
 * step (`step_tps` — output tokens over the whole round trip, latency included) with the wait for its
 * first token. All three are measurements this side cannot take, so they are kept as reported (#224).
 */
export type AgentUsage = { contextTokens: number; stepTps: number; ttftMs: number };

/**
 * One content block of a tool result, in the protocol's own shape.
 *
 * A block says what it is — `type`, and `mimeType` for the media ones — so nothing between the canvas and
 * the agent has to decide what to do with it: text, a picture, a sound, and a `resource` blob (which is how
 * a film travels, the protocol having no video block of its own).
 */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "audio"; data: string; mimeType: string } | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

type AgentMessage = {
    prompt?: string;
    images?: string[];
    command?: string;
    args?: string;
    cancel?: boolean;
    close?: boolean;
    /** The canvas answering a `tool` event: what running it found, as content blocks. */
    toolResult?: { callId: string; content: ToolContent[]; isError?: boolean };
};

/** What one session is, right now — the agent's own last word about itself. */
export type AgentSession = {
    name: string;
    connected: boolean;
    models: AgentModel[];
    active?: AgentModel;
    level?: number;
    /** How full the active model's context is and how fast it is going, as the agent last said. */
    usage?: AgentUsage;
};

type Live = {
    name: string;
    socket: WebSocket;
    opened: boolean;
    session: AgentSession;
    opening: Promise<AgentSession>;
};

const sessions = new Map<string, Live>();

/**
 * Who is listening, by session name.
 *
 * Module-level and not held by the socket, because a panel subscribes when it mounts — before its
 * session exists, since the session is what the connect button starts. A registry that lived on the
 * socket would have nothing to attach to at that moment, and the panel would sit on a turn forever.
 */
const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
function listenersOf(name: string) {
    let set = listeners.get(name);
    if (!set) {
        set = new Set();
        listeners.set(name, set);
    }
    return set;
}
/** Whoever wants every session's events, tools being the one thing that does not care who asked. */
const everyone = new Set<(name: string, event: AgentEvent) => void>();
const watchers = new Set<() => void>();
let revision = 0;

// A session that has never been opened must hand React the *same* object every time it is asked, or a
// snapshot comparison sees a change on every check and re-renders forever.
const blanks = new Map<string, AgentSession>();
function blank(name: string): AgentSession {
    const existing = blanks.get(name);
    if (existing) return existing;
    const created: AgentSession = { name, connected: false, models: [] };
    blanks.set(name, created);
    return created;
}

function notify() {
    revision++;
    for (const watcher of watchers) watcher();
}

/** React reads sessions through this: any change anywhere bumps the revision. */
export function subscribeAgentSessions(watcher: () => void): () => void {
    watchers.add(watcher);
    return () => watchers.delete(watcher);
}

/** What a session looks like now, or a disconnected one that has never been opened. */
export function agentSession(name: string): AgentSession {
    return sessions.get(name)?.session || blank(name);
}

/**
 * A session's name: the canvas panel's, one per canvas.
 *
 * The canvas's name carries the canvas id because the conversation is kept inside that canvas: the server
 * reads the id out of the name and puts the file in the canvas's own directory, so the conversation is
 * deleted, copied and inspected with the canvas it belongs to (decisions #178). One name for every canvas
 * meant one conversation for every canvas — what was said on one showed up on the next.
 */
export const canvasAgent = (canvasId: string) => `canvas:${canvasId}`;

/**
 * The models editor's session.
 *
 * The list of models is the agent's — announced at startup and restated after a change — so editing it
 * needs one. It is not a canvas and keeps no conversation: the preferences window opens it while it is on
 * screen and drops it when it closes, and the only thing it is ever asked is `model_sync`.
 */
export const settingsAgent = "settings";

function socketUrl(config: AiConfig, name: string): string {
    const root = serverProtocolRoot(config.baseUrl);
    // Where the conversation is kept is the name's business, and the server answers it: a canvas keeps one in
    // a file that outlives the socket, inside the canvas the name points at, and a name that is not a canvas
    // (the models editor) keeps nothing. Nothing here has to say which kind this is.
    return `${root.replace(/^http/i, "ws")}/api/agent/socket/${encodeURIComponent(name)}`;
}

/**
 * Open a session, or return the one already open under this name.
 *
 * Resolves on the agent's startup broadcast, which is where the model list comes from — the caller
 * needs it before it can show, or let the user choose, a model for this session.
 */
export function openAgentSession(config: AiConfig, name: string): Promise<AgentSession> {
    const existing = sessions.get(name);
    // A socket that is open, or still opening, is the session. One that is closing or closed is not: its
    // `opening` already resolved, so handing it back would report a connected session with nowhere to send.
    if (existing && (existing.socket.readyState === WebSocket.OPEN || existing.socket.readyState === WebSocket.CONNECTING)) return existing.opening;
    sessions.delete(name);

    let socket: WebSocket;
    try {
        socket = new WebSocket(socketUrl(config, name));
    } catch (error) {
        return Promise.reject(new Error(apiErrorMessage(error, apiText("requestFailed"), "imageTimeout")));
    }
    const live: Live = {
        name,
        socket,
        opened: false,
        session: blank(name),
        opening: Promise.resolve(blank(name)),
    };
    sessions.set(name, live);

    live.opening = new Promise<AgentSession>((resolve, reject) => {
        socket.onmessage = (message) => {
            let event: AgentEvent;
            try {
                event = JSON.parse(message.data as string) as AgentEvent;
            } catch {
                return;
            }
            adopt(live, event);

            // `closed` is the server saying this socket is no longer the one reading the session: a newer
            // tab took it over (#160), or the process died. Either way nothing else will arrive here, and a
            // socket left open would swallow every later question — the panel would sit on a turn that can
            // never end. Dropping it here means the next send opens a new connection, which is also what
            // takes the session back.
            if (event.type === "closed") {
                if (sessions.get(name) === live) sessions.delete(name);
                live.opened = false;
                live.session = blank(name);
                live.socket.close();
            }

            if (!live.opened) {
                live.opened = true;
                if (event.type === "models") {
                    live.session.connected = true;
                    resolve(live.session);
                } else if (event.type === "error") {
                    sessions.delete(name);
                    socket.close();
                    reject(new Error(event.message || apiText("requestFailed")));
                    return;
                }
            }
            for (const listener of listenersOf(name)) listener(event);
            for (const listener of everyone) listener(name, event);
            notify();
        };
        socket.onerror = () => {
            if (live.opened) return;
            live.opened = true;
            sessions.delete(name);
            reject(new Error(apiText("requestFailed")));
        };
        socket.onclose = () => {
            const wasOpen = live.opened;
            live.opened = false;
            live.session = blank(name);
            if (sessions.get(name) === live) sessions.delete(name);
            for (const listener of listenersOf(name)) listener({ type: "closed" });
            notify();
            if (!wasOpen) reject(new Error(apiText("requestFailed")));
        };
    });
    return live.opening;
}

/**
 * Keep the session's own picture current: the agent announces these, nobody else sets them.
 *
 * The object is replaced rather than mutated, because its identity is what tells React something
 * changed. A mutation would update the display of whoever read it first and nobody else.
 */
function adopt(live: Live, event: AgentEvent) {
    switch (event.type) {
        case "models":
            // The startup broadcast, which carries the context count when the agent restored one from a
            // session file — a reloaded page knows how full the conversation is before it asks anything.
            live.session = { ...live.session, connected: true, models: event.models || [], active: event.active, level: event.level, usage: usageOf(event) || live.session.usage };
            break;
        case "model":
            if (event.active) live.session = { ...live.session, active: event.active };
            break;
        case "reasoning_level":
            if (typeof event.level === "number") live.session = { ...live.session, level: event.level };
            break;
        case "usage": {
            const usage = usageOf(event);
            if (usage) live.session = { ...live.session, usage };
            break;
        }
    }
}

/**
 * The telemetry an event carries, or nothing.
 *
 * No context tokens means the agent has counted nothing yet — a step's first frame says `0` before it
 * knows — and that is not a number to draw, so the session keeps whatever it last reported.
 */
function usageOf(event: AgentEvent): AgentUsage | undefined {
    if (!event.contextTokens) return undefined;
    return { contextTokens: event.contextTokens, stepTps: event.stepTps || 0, ttftMs: event.ttftMs || 0 };
}

/** Subscribe to one session's events. Works before the session exists, which is the point. */
export function onAgentEvent(name: string, listener: (event: AgentEvent) => void): () => void {
    const set = listenersOf(name);
    set.add(listener);
    return () => {
        set.delete(listener);
    };
}

/**
 * Subscribe to every session's events, with the name they arrived on.
 *
 * The canvas is one, and a tool call is the page doing something to itself, so the surfaces that run
 * tools do not care which agent asked — they answer on the name they were given. A subscription per
 * session would have to be made for sessions that do not exist yet, and for the ones that never will.
 */
export function onAnyAgentEvent(listener: (name: string, event: AgentEvent) => void): () => void {
    everyone.add(listener);
    return () => {
        everyone.delete(listener);
    };
}

/** Say something on a session. */
export function sendAgentMessage(name: string, message: AgentMessage): boolean {
    const live = sessions.get(name);
    if (!live || live.socket.readyState !== WebSocket.OPEN) return false;
    live.socket.send(JSON.stringify(message));
    return true;
}

/**
 * AlayaCore's one cancel argument: stop the task, and leave the words that were queued into it alone so they
 * run as the next prompt (`commands.CancelArgKeepSteering` on the other side). An empty argument — what a
 * cancel carries when nothing says otherwise — drops them with the task, which is why stopping cannot be
 * mistaken for "keep going".
 */
const CANCEL_KEEP_STEERING = "keep_steering";

/**
 * Stop the answer being written. The session keeps its history.
 *
 * `keepSteering` is the choice when the panel has a queue to speak for: the messages typed into the running
 * turn are not lost with it, they become the next question. Without it they go with the task, and AlayaCore
 * says so in the transcript.
 */
export function cancelAgentSession(name: string, keepSteering = false): void {
    sendAgentMessage(name, keepSteering ? { cancel: true, args: CANCEL_KEEP_STEERING } : { cancel: true });
}

/** Close the socket and keep the agent: the window went away, not the conversation. */
export function closeAgentSession(name: string): void {
    const live = sessions.get(name);
    if (!live) return;
    sessions.delete(name);
    live.socket.onclose = null;
    live.socket.close();
    live.session = blank(name);
    notify();
}

/**
 * Forget a conversation: the file, and the agent holding it.
 *
 * The server answers first and this side acts second. It refuses a session with a turn in flight
 * (`409 agent_busy`) and then changes nothing — so the socket is closed only after a delete that
 * happened, and a refusal leaves the conversation exactly as it is, which is what lets the panel go on
 * using it. On success the server has already released the process and removed the file; the next
 * connect spawns a fresh agent, which finds nothing to replay.
 */
export async function clearAgentConversation(config: AiConfig, session: string): Promise<void> {
    await httpJson(`${serverProtocolRoot(config.baseUrl)}/api/agent/session/${encodeURIComponent(session)}`, { method: "DELETE" });
    closeAgentSession(session);
}

/**
 * Forget a canvas's conversation, on the server as well as here.
 *
 * The conversation is part of the canvas, so deleting the canvas already deletes it; this is the other half
 * — the running agent is released first, since a process left writing into a directory that is going away
 * is the one thing that could put it back. Closing the panel is not this: it leaves the conversation for
 * the next visit.
 *
 * A failure is not worth failing a delete over — the canvas is going away either way — but it is worth a
 * line in the console, because it means an agent process outlived its canvas.
 */
export async function forgetCanvasConversation(config: AiConfig, canvasId: string): Promise<void> {
    const name = canvasAgent(canvasId);
    try {
        await clearAgentConversation(config, name);
    } catch (error) {
        // Mid-turn the server refuses, and this canvas is going away regardless: the socket still has
        // to close, or the process would outlive the directory it writes into.
        console.warn(`agent: the server did not forget ${name}`, error);
    } finally {
        closeAgentSession(name);
    }
}
