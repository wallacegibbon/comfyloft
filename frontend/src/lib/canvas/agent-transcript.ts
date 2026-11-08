/**
 * The transcript of a conversation with the agent: what was said, in the order it arrived.
 *
 * A message is a **list of parts**, not a sentence with a list of tool calls hanging off it. The old
 * shape could not say *where* in a message a call happened, so a call made between two sentences was
 * drawn above both of them — the panel read as if the agent had used every tool before it said anything.
 * A part is appended when its frame arrives and never moves, so the transcript is the arrival order by
 * construction: a sentence, a call, the sentence that reads its result (#221).
 *
 * The ids are ordered by arrival too. They are a counter and not a timestamp: a call and the text after
 * it land in the same millisecond, and a timestamp cannot say which came first. They are padded so that
 * sorting the ids as strings sorts the messages as they were read.
 *
 * The only rule is the end of the list. A message that arrives — the user's words, a notice, an error —
 * takes its place at the end; text and calls keep going into the answer that is at the end, and if what is
 * at the end is not an answer, they open one below it. Nothing reaches back into an earlier bubble, so a
 * message that arrived mid-answer reads in the place it arrived, and the answer goes on underneath.
 */

import { referenceEntries, withoutReferences, type Citation } from "@/lib/canvas/agent-references";
import type { AgentEvent } from "@/services/api/agent";

/** One tool call: what it was called, what it was given, and how it ended. */
export type ToolStep = {
    kind: "tool";
    callId: string;
    name: string;
    input?: string;
    output?: string;
    /**
     * `running` until the agent says how it went — and for a call a stopped turn never heard about,
     * which is not the same thing as a failure and is not drawn as one.
     */
    state: "running" | "ok" | "failed";
};

/** One thing said while the agent was working: its reasoning, a sentence, or a call it made. */
type MessagePart = { kind: "text"; text: string } | { kind: "reasoning"; text: string } | ToolStep;

/** Whose words these are: a person's, the agent's, the agent's own commentary, or something going wrong. */
type MessageRole = "user" | "assistant" | "system" | "error";

/** One message on screen, as the frames built it. */
export type TranscriptMessage = {
    id: string;
    role: MessageRole;
    /** The message, in the order it arrived. */
    parts: MessagePart[];
    /** The nodes a user message cited: what turns its `@label`s into links. */
    mentions: Citation[];
    /** An assistant message is still being written until the turn ends. */
    streaming: boolean;
};

let sequence = 0;

/** The id of the next message: the order things were said in, while the panel is open. */
function nextMessageId(): string {
    sequence += 1;
    return `m${String(sequence).padStart(6, "0")}`;
}

/** A message that starts empty and is filled in as its frames arrive. */
function newMessage(role: MessageRole, streaming = false): TranscriptMessage {
    return { id: nextMessageId(), role, parts: [], mentions: [], streaming };
}

/**
 * A message from the agent's echo of what the user sent.
 *
 * The words are the ones the person typed, with the citation block taken off, and the citations are read
 * back out of that same block — live or replayed, this is the same frame, so it is read in one place.
 */
function userMessage(said: string): TranscriptMessage {
    return { ...newMessage("user"), parts: said ? [{ kind: "text", text: withoutReferences(said) }] : [], mentions: referenceEntries(said) };
}

/** A sentence the agent said about its own work, or a failure of its own: one part, no streaming. */
function wholeMessage(role: "system" | "error", text: string): TranscriptMessage {
    return { ...newMessage(role), parts: text ? [{ kind: "text", text }] : [] };
}

/**
 * Fold one frame into the transcript: a thing said goes to the end, and text and calls go into the answer
 * that is at the end.
 *
 * A tool *result* is the exception, and it is not a thing said: it answers a call that was made earlier,
 * so it updates that call where it sits, wherever that is.
 */
export function transcriptEvent(messages: TranscriptMessage[], event: AgentEvent): TranscriptMessage[] {
    switch (event.type) {
        case "user":
            // The agent echoing what was said to it. It arrives when the agent says it arrived — including
            // in the middle of an answer, which is not this side's business to schedule.
            return append(messages, userMessage(event.text || ""));
        case "notice":
            // The agent's own system messages: only in the live stream, and only where they happened.
            return event.text ? append(messages, wholeMessage("system", event.text)) : messages;
        case "error":
            return append(messages, wholeMessage("error", event.message || ""));
        case "history":
            // The conversation the agent loaded from its session file and replayed — the whole truth about
            // this panel's past, so it replaces what is on screen rather than appending to it. It is the
            // frames themselves, so they go through the same fold a live turn does: nothing here is
            // re-read, merged or re-invented, and reasoning and tool steps survive a reload because the
            // agent replays them (#222).
            return endTurn((event.history || []).reduce<TranscriptMessage[]>(transcriptEvent, []));
        case "done":
        case "closed":
            return endTurn(messages);
        case "delta":
        case "reasoning":
        case "tool_call":
        case "tool_result":
            return answerFrame(messages, event);
        default:
            // `models`, `model`, `reasoning_level`, `command`, `steering`, `tool`: the session's own state
            // or a tool the canvas runs itself. Nothing to draw in the transcript.
            return messages;
    }
}

/**
 * The words of a message, in order — what it reads as.
 *
 * Only the text parts: reasoning is a path to the answer and a call is an action, neither of which is
 * something either side said. An empty string is how "it has not said anything yet" is asked.
 */
export function textOf(message: TranscriptMessage): string {
    return message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
}

/**
 * Whether the turn the user started is running and has not put any words on screen yet — what the panel's
 * one "working" line is drawn from.
 *
 * It asks `busy` rather than the transcript because the send is the event. Between the message going out and
 * the first frame coming back — the model's first token, or the call it opens with — nothing has arrived, and
 * a line that waited for a frame was absent for exactly the stretch a reader has nothing else to go on. The
 * panel records a turn where the socket takes the message and drops it when the turn ends, so there is one
 * word for "a turn is running" and this reads it.
 *
 * An answer that has already said something does not need it: the words are the sign of life, and they are
 * right above. An answer that has only called a tool keeps it, which is why the question is about the text
 * and not about the parts.
 */
export function agentIsWorking(messages: TranscriptMessage[], busy: boolean): boolean {
    if (!busy) return false;
    const last = messages[messages.length - 1];
    if (last?.streaming && textOf(last)) return false;
    return true;
}

/**
 * When the turn in flight began, as this page's clock reads it.
 *
 * `elapsedMs` is how long the turn had already been running when the session said so — the `turn` frame it
 * sends on every connection — and `now` is the instant that frame was read. The subtraction is what makes a
 * reload continue the count instead of restarting it (#342): the start belongs to the turn, and while the page
 * was away the session was the only side holding it. A negative age is read as no age, so a start is never in
 * the future and a count never runs backwards.
 */
export function turnStartedAt(elapsedMs: number | undefined, now: number): number {
    return now - Math.max(0, elapsedMs ?? 0);
}

/**
 * The panel's one line about the running turn — which of the four states it is in.
 *
 * The wait and the queue are the same subject (a turn is running) and they used to be two rows with a
 * spinner each, in two different places (#315). One row cannot show one and hide the other, so the choice is
 * made here, once, instead of in a pair of conditions in the JSX: `waiting-queued` exists so that a queued
 * message never replaces the wait it was queued into, and `queued` exists because `agentIsWorking` goes false
 * the moment the answer has words while the queue outlives that — a queue nobody can see looks like a message
 * that was lost.
 *
 * A count of zero is no queue: the number comes from counted frames, and a row is not drawn for nothing.
 */
export type AgentRunState = "idle" | "waiting" | "waiting-queued" | "queued";

export function agentRunState(working: boolean, queued: number): AgentRunState {
    const hasQueue = queued > 0;
    if (working) return hasQueue ? "waiting-queued" : "waiting";
    return hasQueue ? "queued" : "idle";
}

/**
 * One frame of an answer being written.
 *
 * The answer is the message at the end — the one nothing has arrived after yet. If what is at the end is
 * not an answer (the user's words came in, or nothing has been said at all), the frame opens one below it.
 */
function answerFrame(messages: TranscriptMessage[], event: AgentEvent): TranscriptMessage[] {
    if (event.type === "tool_result") return settleCall(messages, event.callId || "", event);
    const at = messages.length - 1;
    if (at >= 0 && messages[at].role === "assistant" && messages[at].streaming) return replace(messages, at, grow(messages[at], event));
    const opened = grow(newMessage("assistant", true), event);
    // A frame that says nothing opens nothing: an empty bubble with a spinner in it looks like a turn
    // that is happening when nothing has arrived.
    return opened.parts.length ? [...messages, opened] : messages;
}

/** The answer, with one more frame at its end. */
function grow(message: TranscriptMessage, event: AgentEvent): TranscriptMessage {
    const parts = message.parts;
    if (event.type === "tool_call") return { ...message, parts: withCall(parts, event) };
    const kind = event.type === "reasoning" ? "reasoning" : "text";
    const text = event.text || "";
    if (!text) return message;
    const last = parts[parts.length - 1];
    // A delta continues what is being said and only opens a part of its own when the last part is
    // something else — which is what keeps one sentence together and a call between two of them.
    if (last && last.kind === kind) return { ...message, parts: replace(parts, parts.length - 1, { ...last, text: last.text + text }) };
    return { ...message, parts: [...parts, { kind, text }] };
}

/**
 * A tool call, which arrives in two frames: the name, then the arguments. One step either way, so the
 * two frames never read as two calls.
 */
function withCall(parts: MessagePart[], event: AgentEvent): MessagePart[] {
    const callId = event.callId || "";
    const said = { ...(event.name ? { name: event.name } : {}), ...(event.input ? { input: event.input } : {}) };
    const at = parts.findLastIndex((part) => part.kind === "tool" && part.callId === callId);
    if (at >= 0) return replace(parts, at, { ...(parts[at] as ToolStep), ...said });
    return [...parts, { kind: "tool", callId, name: event.name || "tool", state: "running", ...said }];
}

/** The result of a call, written onto the step that made it — wherever in the transcript that step is. */
function settleCall(messages: TranscriptMessage[], callId: string, event: AgentEvent): TranscriptMessage[] {
    const at = messages.findLastIndex((message) => message.parts.some((part) => part.kind === "tool" && part.callId === callId));
    // A result for a call nobody saw says nothing about anything on screen.
    if (at < 0) return messages;
    const state: ToolStep["state"] = event.isError ? "failed" : "ok";
    const message = messages[at];
    const parts = message.parts.map((part) => (part.kind === "tool" && part.callId === callId ? { ...part, output: event.output, state } : part));
    return replace(messages, at, { ...message, parts });
}

/** One more message, at the end. Nothing above it is still being written: the answer is what is at the end. */
function append(messages: TranscriptMessage[], message: TranscriptMessage): TranscriptMessage[] {
    return [...endTurn(messages), message];
}

/** The turn is over: no message is still being written. */
function endTurn(messages: TranscriptMessage[]): TranscriptMessage[] {
    if (!messages.some((message) => message.streaming)) return messages;
    return messages.map((message) => (message.streaming ? { ...message, streaming: false } : message));
}

/**
 * The answer at the end is still being written.
 *
 * A conversation handed to a page is a finished one — `history` ends every message, because a record is what
 * was said. A turn, though, can be running while it is replayed: the agent belongs to the canvas now, so a
 * page that comes back in the middle of one is shown the words so far and then the rest arrives live. Without
 * this the rest would land in a second bubble, as if the agent had started over.
 *
 * Only an assistant message can be continued. A turn whose last word was the person's has said nothing yet,
 * and appending to it would put the agent's words in the person's mouth.
 */
export function resumeTurn(messages: TranscriptMessage[]): TranscriptMessage[] {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || last.streaming) return messages;
    return replace(messages, messages.length - 1, { ...last, streaming: true });
}

/** The same list with one item replaced, and the same list again when nothing changed. */
function replace<T>(items: T[], at: number, item: T): T[] {
    return [...items.slice(0, at), item, ...items.slice(at + 1)];
}

/**
 * The tail of a conversation, and how much of it is not on screen.
 *
 * The agent window keeps every message it ever had — the panel's state is not trimmed, and a conversation
 * is replayed whole from the agent's session file — so a canvas that has been talked to for weeks holds
 * every one of them. Rendering all of it is not a re-render cost (a finished message is memoised) but a
 * mount cost: a long answer is a few hundred elements, so a hundred of them is tens of thousands of nodes
 * that nobody is looking at, paid for again every time the window opens (#237).
 *
 * Only the tail is drawn, and the rest is one press away. The newest message is always inside the window,
 * because the newest message is the one being written — the window is at least one message, whatever it is
 * asked for.
 */
export function transcriptWindow(messages: TranscriptMessage[], size: number): { shown: TranscriptMessage[]; hidden: number } {
    const keep = Math.max(1, Math.floor(size));
    const hidden = Math.max(0, messages.length - keep);
    return { shown: hidden ? messages.slice(hidden) : messages, hidden };
}
