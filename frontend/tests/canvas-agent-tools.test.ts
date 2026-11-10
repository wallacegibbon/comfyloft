import { describe, expect, test } from "vitest";

import { runTool, type CanvasHands } from "../src/lib/canvas/canvas-agent-tools";
import { settleMoveMembership, withGroupMembers, withoutEmptiedGroups } from "../src/lib/canvas/canvas-node-geometry";
import type { GenerateStart } from "../src/lib/canvas/agent-generate";
import type { VideoFramePosition } from "../src/lib/canvas/canvas-video-frame";
import { registerBuiltinNodes } from "../src/components/canvas/nodes/builtin-nodes";
import type { SettingsContract } from "../src/lib/canvas/node-settings";
import type { StopOutcome } from "../src/lib/canvas/canvas-agent-tools";
import type { ModelCatalog } from "../src/lib/canvas/node-model";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, CanvasTrashEntry } from "../src/types/canvas";

/**
 * The tools the agent may call, and what each one writes.
 *
 * These are decisions rather than wiring, so they are called here the way the page calls them: a name, the
 * arguments as they arrived, the hands the page lends, and a session to answer on. What the fix behind them
 * has to hold is one thing above all: a text node is its words and nothing else, so every tool that treats
 * it as something with a question refuses instead of writing a field no surface shows (#278).
 */

// The node types' own definitions, which is where "a card that frames a picture keeps its shape" lives
// (docs/decisions.md #264): `resize_node` asks them rather than switching on the type itself.
registerBuiltinNodes();

function node(type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id: `${type}-1`, type, position: { x: 0, y: 0 }, width: 320, height: 240, metadata };
}

/** The page's hands, with every write recorded instead of performed. */
function handsFor(
    nodes: CanvasNodeData[],
    connections: CanvasConnection[] = [],
    contract: SettingsContract | ((run?: { model?: string; mode?: string }) => SettingsContract) = {},
    stopped: StopOutcome = { running: true, cancel: "cancelled" },
    catalog: ModelCatalog = { options: [], accepts: () => undefined },
    trash: CanvasTrashEntry[] = [],
) {
    const written = {
        contracts: [] as Array<[string, { model?: string; mode?: string } | undefined]>,
        prompts: [] as Array<[string, string]>,
        texts: [] as Array<[string, string]>,
        generated: [] as Array<[string, string]>,
        created: [] as string[],
        resized: [] as Array<[string, number, number]>,
        moved: [] as Array<[string, { x: number; y: number }]>,
        grouped: [] as string[][],
        ungrouped: [] as string[][],
        deleted: [] as string[],
        restored: [] as string[],
        settings: [] as Array<[string, CanvasNodeMetadata]>,
        stopped: [] as string[],
        captured: [] as Array<[string, string]>,
        joined: [] as string[][],
        reencoded: [] as boolean[],
    };
    const hands: CanvasHands = {
        nodes: () => nodes,
        connections: () => connections,
        createNode: (type) => {
            written.created.push(type);
            return node(type);
        },
        generateNode: async (nodeId, mode, prompt) => {
            written.generated.push([nodeId, prompt]);
            void mode;
        },
        setNodePrompt: (nodeId, prompt) => void written.prompts.push([nodeId, prompt]),
        writeText: (nodeId, text) => void written.texts.push([nodeId, text]),
        connectNodes: () => false,
        // Deleting a card's last member empties it, and the canvas removes the shell (#318) — the same rule
        // `withoutEmptiedGroups` applies to a move, so this answers with what it would have taken away.
        deleteNodes: (nodeIds) => {
            written.deleted.push(...nodeIds);
            const kept = nodes.filter((each) => !nodeIds.includes(each.id)).map((each) => (each.metadata?.groupId && nodeIds.includes(each.metadata.groupId) ? { ...each, metadata: { ...each.metadata, groupId: undefined } } : each));
            return { removed: withoutEmptiedGroups(nodes, kept, []).removed };
        },
        // The trash the page lends: what it holds, and the restore that takes one out of it.
        trash: () => trash,
        restoreNodes: (nodeIds) => {
            written.restored.push(...nodeIds);
            return { restored: nodeIds.filter((id) => trash.some((entry) => entry.node.id === id)), missing: nodeIds.filter((id) => !trash.some((entry) => entry.node.id === id)) };
        },
        focusNode: () => {},
        // The real hands move through `withGroupMembers` and `settleMoveMembership`, which are the canvas's own
        // rules and tested where they live; these answer with what those rules would have done, so what the
        // tool reports is what a real page would report.
        moveNode: (nodeId, position) => {
            written.moved.push([nodeId, position]);
            const named = nodes.find((each) => each.id === nodeId);
            if (!named) return null;
            const carried = withGroupMembers(new Set([nodeId]), nodes);
            const dx = position.x - named.position.x;
            const dy = position.y - named.position.y;
            const moved = nodes.map((each) => (carried.has(each.id) ? { ...each, position: { x: each.position.x + dx, y: each.position.y + dy } } : each));
            const settled = settleMoveMembership(moved, carried);
            const after = new Map(settled.map((each) => [each.id, each.metadata?.groupId]));
            const membership = nodes.filter((each) => each.metadata?.groupId !== after.get(each.id)).map((each) => ({ nodeId: each.id, from: each.metadata?.groupId, to: after.get(each.id) }));
            const removed = withoutEmptiedGroups(nodes, settled, []).removed;
            return { carried: [...carried], membership, removed };
        },
        resizeNode: (nodeId, width, height) => void written.resized.push([nodeId, width, height]),
        // The real hands group through `applyGroupSelection`, which is the canvas's own rule and tested
        // where it lives; what these have to answer is only what the tool reports back.
        groupNodes: (nodeIds) => {
            written.grouped.push(nodeIds);
            return nodeIds.length < 2 ? null : { groupId: "group-1", memberIds: nodeIds };
        },
        ungroupNodes: (nodeIds) => {
            written.ungrouped.push(nodeIds);
            const dissolved = nodes.filter((each) => nodeIds.includes(each.id) && each.type === "group").map((each) => each.id);
            const released = nodes.filter((each) => (nodeIds.includes(each.id) ? Boolean(each.metadata?.groupId) : dissolved.includes(each.metadata?.groupId || ""))).map((each) => each.id);
            return dissolved.length || released.length ? { released, dissolved } : null;
        },
        // The published contract is the page's to read and the panel's to ask; what these answer is only
        // whether a setting is written and how the answer reads. A function is asked about the run a call is
        // about to make, which is the contract a stated size has to be judged by.
        nodeContract: (nodeId, run) => {
            written.contracts.push([nodeId, run]);
            return typeof contract === "function" ? contract(run) : contract;
        },
        writeMetadata: (nodeId, patch) => void written.settings.push([nodeId, patch]),
        // The catalog is the page's reading of the published models; the tools' own decisions are tested in
        // `node-model.test.ts`, so these answer with the fixture the test handed in.
        modelCatalog: () => catalog,
        // Stopping is the page's two endings (a watch, and the run's own record) collapsed into one answer;
        // what these have to say is only what the tool tells the agent.
        stopNode: async (nodeId) => {
            written.stopped.push(nodeId);
            return stopped;
        },
        // The page decodes a frame and writes a node; what these answer is only what the tool reports, so a
        // frame is a name and a size, and the tests that care about the refusal replace them.
        captureFrame: async (nodeId, frame) => {
            written.captured.push([nodeId, frame]);
            const frames = (frame === "both" ? ["first", "last"] : [frame]).map((each, index) => ({ nodeId: `image-frame-${index + 1}`, frame: each as VideoFramePosition, width: 1280, height: 720 }));
            return { ok: true, frames };
        },
        joinClips: async (nodeIds, options) => {
            written.joined.push(nodeIds);
            written.reencoded.push(Boolean(options?.reencode));
            return { ok: true, nodeId: "video-joined", width: 1280, height: 720, durationMs: 60_000 };
        },
    };
    return { hands, written };
}

const card = "宫崎骏风格的森林。";
const textSaying = (content: string) => node("text", { content });

const textOf = async (hands: CanvasHands, name: string, args: Record<string, unknown>) => {
    const answer = await runTool(name, args, hands, "canvas:test");
    return { answer, text: (answer.content[0] as { text: string }).text };
};

/**
 * A film's frames, taken out of it as pictures.
 *
 * This is how a longer clip is made: the last frame of one clip becomes the first frame of the next, so the
 * capability has to be a node on the canvas rather than bytes handed back to the caller — the caller is a
 * model, and a picture in a conversation is 2–3 MiB a look (#319).
 */
describe("capture_frame: a film's frames, as pictures", () => {
    test("takes both frames by default, and says what can be done with them", async () => {
        const { hands, written } = handsFor([placed("video-1", "video", { content: "/api/canvases/c/files/clip.mp4" })]);
        const { answer, text } = await textOf(hands, "capture_frame", { nodeId: "video-1" });

        expect(answer.isError).not.toBe(true);
        expect(written.captured).toEqual([["video-1", "both"]]);
        expect(text).toContain("took both frames of video-1");
        expect(text).toContain("image-frame-1 (1280×720) is the first");
        expect(text).toContain("image-frame-2 (1280×720) is the last");
        // Material: no model, so the one thing a caller can do with it is connect it.
        expect(text).toContain("They hold no model, so they are material");
    });

    test("one frame, named, and what the next clip does with it", async () => {
        const { hands, written } = handsFor([placed("video-1", "video", { content: "/api/canvases/c/files/clip.mp4" })]);
        const { text } = await textOf(hands, "capture_frame", { nodeId: "video-1", frame: "last" });

        expect(written.captured).toEqual([["video-1", "last"]]);
        expect(text).toContain("took the last frame of video-1: image-frame-1 (1280×720), connected from video-1");
        expect(text).toContain("a film's last frame is where the next clip continues from");
    });

    test("a picture is one frame already, and a word a playhead is not on offer", async () => {
        const { hands, written } = handsFor([node("image", { content: "/api/canvases/c/files/a.png" })]);
        const picture = await textOf(hands, "capture_frame", { nodeId: "image-1", frame: "first" });
        expect(picture.answer.isError).toBe(true);
        expect(picture.text).toContain("a picture is one frame already");
        expect(written.captured).toEqual([]);

        const film = handsFor([placed("video-1", "video", { content: "/api/canvases/c/files/clip.mp4" })]);
        const playhead = await textOf(film.hands, "capture_frame", { nodeId: "video-1", frame: "current" });
        expect(playhead.answer.isError).toBe(true);
        expect(playhead.text).toContain('take "first", "last", or "both"');
        expect(film.written.captured).toEqual([]);
    });

    test("a clip that is not there yet has no frame, and says which way it is missing", async () => {
        const waiting = handsFor([placed("video-1", "video", { status: "loading" })]);
        const running = await textOf(waiting.hands, "capture_frame", { nodeId: "video-1" });
        expect(running.answer.isError).toBe(true);
        expect(running.text).toContain("holds no clip yet");
        expect(running.text).toContain("it is generating now");

        const empty = handsFor([placed("video-2", "video")]);
        const nothing = await textOf(empty.hands, "capture_frame", { nodeId: "video-2" });
        expect(nothing.text).toContain("press it with generate");
    });

    test("the page's refusal is the answer, not a run that quietly did nothing", async () => {
        const { hands } = handsFor([placed("video-1", "video", { content: "/api/canvases/c/files/clip.mp4" })]);
        hands.captureFrame = async () => ({ ok: false, reason: "the browser could not read a frame out of video-1: the clip may be in a container or codec it cannot decode" });
        const { answer, text } = await textOf(hands, "capture_frame", { nodeId: "video-1" });

        expect(answer.isError).toBe(true);
        expect(text).toContain("could not read a frame");
    });
});

/**
 * Joining clips into one — the end of a chain.
 *
 * Each clip was made from the frame the one before it ended on; the user asked for a longer video, and a
 * chain of five clips is not one. The order is the call's list, because a wire cannot say "third".
 */
describe("join_clips: several clips into one", () => {
    const film = (id: string) => placed(id, "video", { content: `/api/canvases/c/files/${id}.mp4` });

    test("joins in the order the call names, and answers with the whole length", async () => {
        const { hands, written } = handsFor([film("video-1"), film("video-2"), film("video-3")]);
        const { answer, text } = await textOf(hands, "join_clips", { nodeIds: ["video-3", "video-1", "video-2"] });

        expect(answer.isError).not.toBe(true);
        // The list, not the canvas order and not the wire order.
        expect(written.joined).toEqual([["video-3", "video-1", "video-2"]]);
        expect(text).toContain("joined video-3, video-1, video-2 into video-joined");
        expect(text).toContain("1:00");
        expect(text).toContain("It holds no model, so it is material");
    });

    test("one clip is not a join, and the answer says why", async () => {
        const { hands, written } = handsFor([film("video-1")]);
        const { answer, text } = await textOf(hands, "join_clips", { nodeIds: ["video-1"] });

        expect(answer.isError).toBe(true);
        expect(text).toContain("at least two clips");
        expect(written.joined).toEqual([]);
    });

    test("a missing id, a picture, and a clip nobody has made yet are each named", async () => {
        const { hands } = handsFor([film("video-1"), node("image", { content: "/api/canvases/c/files/a.png" }), placed("video-2", "video")]);

        const missing = await textOf(hands, "join_clips", { nodeIds: ["video-1", "video-9"] });
        expect(missing.answer.isError).toBe(true);
        expect(missing.text).toContain('no node with id "video-9"');

        const picture = await textOf(hands, "join_clips", { nodeIds: ["video-1", "image-1"] });
        expect(picture.answer.isError).toBe(true);
        expect(picture.text).toContain("join_clips joins films");

        const empty = await textOf(hands, "join_clips", { nodeIds: ["video-1", "video-2"] });
        expect(empty.answer.isError).toBe(true);
        expect(empty.text).toContain("video-2 holds no clip yet");
    });

    test("re-encoding is the caller's to ask for, and it is passed through", async () => {
        const { hands, written } = handsFor([film("video-1"), film("video-2")]);
        await textOf(hands, "join_clips", { nodeIds: ["video-1", "video-2"], reencode: true });
        expect(written.reencoded).toEqual([true]);

        const plain = handsFor([film("video-1"), film("video-2")]);
        await textOf(plain.hands, "join_clips", { nodeIds: ["video-1", "video-2"] });
        expect(plain.written.reencoded).toEqual([false]);

        const odd = await textOf(plain.hands, "join_clips", { nodeIds: ["video-1", "video-2"], reencode: "yes" });
        expect(odd.answer.isError).toBe(true);
        expect(odd.text).toContain("it is true or false");
    });

    test("clips that were not made the same way are refused by the page, in its own words", async () => {
        const { hands } = handsFor([film("video-1"), film("video-2")]);
        hands.joinClips = async () => ({ ok: false, reason: "video-2 is 25 fps and video-1 is 24 fps: joining them would re-encode every frame of the result, so send reencode if that is what you want" });
        const { answer, text } = await textOf(hands, "join_clips", { nodeIds: ["video-1", "video-2"] });

        expect(answer.isError).toBe(true);
        expect(text).toContain("25 fps");
        expect(text).toContain("reencode");
    });
});

describe("set_text: writing what the card says", () => {
    test("writes the text itself, and it is the only field a text node has", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "set_text", { nodeId: "text-1", text: "夜里的森林。" });
        expect(answer.isError).not.toBe(true);
        expect(written.texts).toEqual([["text-1", "夜里的森林。"]]);
        expect(written.prompts).toEqual([]);
        expect(text).toContain("text-1 now says: 夜里的森林。");
    });

    test("refuses a node whose content is not words, and says what to do instead", async () => {
        const { hands, written } = handsFor([node("image", { content: "/api/canvases/c/files/a.png", prompt: "a brass compass" })]);
        const { answer, text } = await textOf(hands, "set_text", { nodeId: "image-1", text: "a brass compass" });
        expect(answer.isError).toBe(true);
        expect(written.texts).toEqual([]);
        expect(text).toContain("it holds a picture");
        expect(text).toContain("set_prompt");
    });

    test("asks for the words when the call carries none", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "set_text", { nodeId: "text-1" });
        expect(answer.isError).toBe(true);
        expect(text).toContain("set_text needs text");
    });

    test("answers a node the canvas does not hold", async () => {
        const { hands } = handsFor([]);
        const { answer } = await textOf(hands, "set_text", { nodeId: "text-9", text: "anything" });
        expect(answer.isError).toBe(true);
    });
});

describe("set_prompt: the question a node will be asked", () => {
    test("a text node has no question, so it is refused rather than written somewhere nothing shows", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "set_prompt", { nodeId: "text-1", prompt: "改成夜景。" });
        expect(answer.isError).toBe(true);
        expect(written.prompts).toEqual([]);
        expect(text).toContain("it holds words and has no prompt");
        expect(text).toContain("set_text");
    });

    test("on a picture, it is the words that will make it", async () => {
        const { hands, written } = handsFor([node("image", { content: "/api/canvases/c/files/a.png" })]);
        const { answer } = await textOf(hands, "set_prompt", { nodeId: "image-1", prompt: "a brass compass" });
        expect(answer.isError).not.toBe(true);
        expect(written.prompts).toEqual([["image-1", "a brass compass"]]);
    });
});

/**
 * Four questions, four readers, and the rule that keeps them apart.
 *
 * A node says four things: what its next run is set to (`read_node`), the words it will be asked
 * (`read_prompt`), the words it holds (`read_text`), and the picture, film or sound itself (`read_media`). They
 * used to be two tools cut by payload size, one of which carried the bytes, so "when was this made" cost a
 * picture: 20 reads carried 54.9 MiB in one session, 99.7% of the conversation. One question, one reader, and
 * the only expensive one has a name that says so.
 */
describe("read_node: what the next run is set to", () => {
    test("the settings, in the same words set_node writes them", async () => {
        const { hands } = handsFor([placed("image-1", "image", { model: "default::image-qwen21", imageMode: "edit", size: "1360x768", seed: "42", seedFixed: "true" })], [], { accepts: ["size", "seed"] });
        const { answer, text } = await textOf(hands, "read_node", { nodeId: "image-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toBe("image-1 (image) is set to run image-qwen21 as edit, size 1360x768, seed 42");
    });

    test("a node nothing is set to run says so", async () => {
        const { hands } = handsFor([placed("image-1", "image")]);
        const { text } = await textOf(hands, "read_node", { nodeId: "image-1" });

        expect(text).toBe("image-1 (image) is not set to run anything: no model has been picked for it");
    });

    /**
     * Material is a different answer from "nothing picked yet".
     *
     * A node holding a picture this canvas did not make — a frame taken from a film, a crop, an upload, a mask
     * — has no run, and nothing can give it one: a run reads only what is connected to it, never its own
     * content, so a press would replace the picture with a render that never saw it (#297). Saying "no model
     * has been picked for it" would read as an invitation to pick one.
     */
    test("material says there is no run and none can be set, and names the way out", async () => {
        const { hands } = handsFor([placed("image-1", "image", { content: "/api/canvases/c/files/a.png", prompt: "a brass compass" })]);
        const { answer, text } = await textOf(hands, "read_node", { nodeId: "image-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("holds a picture this canvas did not make — material, not a run");
        expect(text).toContain("no model can be set on it");
        expect(text).toContain("Connect it to a node that runs");
        expect(text).not.toContain("has been picked");
    });

    // What the workflow takes and what is wired in front of it: the half of a run that no setting can state.
    test("says what a press would need, before the press rather than after the refusal", async () => {
        const angle = placed("image-1", "image", { prompt: "turn it to the left" });
        const contract = { media: { images: { min: 1, max: 1 }, videos: { min: 0, max: 0 }, audios: { min: 0, max: 0 }, minTotal: 0 } };

        const short = await textOf(handsFor([angle], [], contract).hands, "read_node", { nodeId: "image-1" });
        expect(short.text).toContain("it takes 1 image; nothing connected, so a press would be refused");

        const wired = handsFor([placed("source", "image", { content: "/api/canvases/c/files/a.png" }), angle], [{ id: "c1", fromNodeId: "source", toNodeId: "image-1" }], contract);
        const ready = await textOf(wired.hands, "read_node", { nodeId: "image-1" });
        expect(ready.text).toContain("it takes 1 image; 1 image connected");
        expect(ready.text).not.toContain("would be refused");
    });

    test("a text node has no run, and the answer points at its card", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "read_node", { nodeId: "text-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("has no run to configure");
        expect(text).toContain("read_text");
        expect(text).not.toContain(card);
    });

    test("carries no bytes, whatever the node holds", async () => {
        const { hands } = handsFor([placed("image-1", "image", { content: "data:image/png;base64,AAAA", model: "default::image-qwen21" })]);
        const { answer } = await textOf(hands, "read_node", { nodeId: "image-1" });

        expect(answer.content.every((block) => block.type === "text")).toBe(true);
        expect(JSON.stringify(answer.content)).not.toContain("AAAA");
    });
});

/**
 * What a wire cannot make true.
 *
 * The canvas states the meaning of a picture into an image node in `connect`'s own description — "what makes
 * its next generation an edit of it" — and a workflow that declares `images: {max: 0}` cannot keep it: the
 * request is accepted, no binding reads the upload, and the run comes back as a fresh draw with nothing said
 * anywhere (#348). The connection is the call that makes the pair inconsistent, so the sentence is said here,
 * and it is `requiresClause`'s — the one `read_node` prints — rather than a second reading of the declaration.
 */
describe("connect: a wire the target's workflow will not read", () => {
    const wordsOnly = { media: { images: { min: 0, max: 0 }, videos: { min: 0, max: 0 }, audios: { min: 0, max: 0 }, minTotal: 0 } };
    const editor = { media: { images: { min: 1, max: 4 }, videos: { min: 0, max: 0 }, audios: { min: 0, max: 0 }, minTotal: 0 } };
    const picture = (id: string) => placed(id, "image", { content: `/api/canvases/c/files/${id}.png` });
    const connects = (hands: CanvasHands) => void (hands.connectNodes = () => true);

    test("a picture into a workflow that takes words only says so, and is not an error", async () => {
        const { hands } = handsFor([picture("image-1"), placed("image-2", "image", { prompt: "a brass compass" })], [], wordsOnly);
        connects(hands);

        const { answer, text } = await textOf(hands, "connect", { fromNodeId: "image-1", toNodeId: "image-2" });

        expect(answer.isError).not.toBe(true);
        expect(text).toBe("connected image-1 -> image-2; note: it takes words only; 1 image connected, so a press would be refused");
    });

    test("nothing is said when the workflow reads the picture", async () => {
        const { hands } = handsFor([picture("image-1"), placed("image-2", "image", { prompt: "make it night" })], [], editor);
        connects(hands);

        const { text } = await textOf(hands, "connect", { fromNodeId: "image-1", toNodeId: "image-2" });

        expect(text).toBe("connected image-1 -> image-2");
    });

    // The bound is the declaration's, both ways: one picture past a declared four is as unread as one into a
    // workflow that takes none, because the binding drops what it has no socket for.
    test("the connection that goes past the declared count is named too", async () => {
        const wired = [1, 2, 3, 4, 5].map((n) => picture(`image-${n}`));
        const before = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, fromNodeId: `image-${n}`, toNodeId: "image-9" }));
        const { hands } = handsFor([...wired, placed("image-9", "image", { prompt: "blend these" })], before, editor);
        connects(hands);

        const { text } = await textOf(hands, "connect", { fromNodeId: "image-5", toNodeId: "image-9" });

        expect(text).toBe("connected image-5 -> image-9; note: it takes 1-4 images; 5 images connected, so a press would be refused");
    });

    // A picture into a text card is a reference the card reads (#185), not a run's input: a card publishes no
    // media contract, and nothing is claimed about what it does not declare.
    test("a reference into a text card is the card's own business", async () => {
        const { hands } = handsFor([picture("image-1"), textSaying(card)], [], {});
        connects(hands);

        const { text } = await textOf(hands, "connect", { fromNodeId: "image-1", toNodeId: "text-1" });

        expect(text).toBe("connected image-1 -> text-1");
    });

    test("an unpublished contract claims nothing", async () => {
        const { hands } = handsFor([picture("image-1"), placed("image-2", "image", { prompt: "a brass compass" })], [], {});
        connects(hands);

        const { text } = await textOf(hands, "connect", { fromNodeId: "image-1", toNodeId: "image-2" });

        expect(text).toBe("connected image-1 -> image-2");
    });
});

describe("read_text: the card", () => {
    test("answers with the words the node holds, whole", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer } = await textOf(hands, "read_text", { nodeId: "text-1" });
        expect(answer.content).toEqual([{ type: "text", text: card }]);
    });

    test("an empty card says so rather than inventing words", async () => {
        const { hands } = handsFor([node("text", { prompt: "a brass compass" })]);
        const { answer, text } = await textOf(hands, "read_text", { nodeId: "text-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("says nothing yet");
        expect(text).toContain("set_text");
    });

    test("a node that holds a picture has no card, and the answer points at the picture", async () => {
        const { hands } = handsFor([node("image", { content: "/api/canvases/c/files/a.png" })]);
        const { answer, text } = await textOf(hands, "read_text", { nodeId: "image-1" });

        expect(answer.isError).toBe(true);
        expect(text).toContain("a picture, not words");
        expect(text).toContain("read_media");
    });
});

describe("read_media: the picture itself", () => {
    test("hands over the media as its own block, with the caption that says what made it", async () => {
        const { hands } = handsFor([placed("image-1", "image", { content: "data:image/png;base64,iVBORw0KGgo=", workflow: "image-z-image-turbo", generatedAt: "2026-11-05T19:52:23.576Z" })]);
        const { answer } = await textOf(hands, "read_media", { nodeId: "image-1" });

        expect(answer.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
        expect(answer.content[1]).toEqual({ type: "text", text: "image-1 (image) made 2026-11-05T19:52:23.576Z with image-z-image-turbo" });
    });

    test("a text node holds no media, and the answer points at its card", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "read_media", { nodeId: "text-1" });

        expect(answer.isError).toBe(true);
        expect(text).toContain("read_text");
    });

    test("a node no run has filled is refused rather than answered with an empty block", async () => {
        const { hands } = handsFor([node("image", { prompt: "a brass compass" })]);
        const { answer, text } = await textOf(hands, "read_media", { nodeId: "image-1" });

        expect(answer.isError).toBe(true);
        expect(text).toContain("holds no media yet");
    });
});

describe("generate: pressing a node's button", () => {
    test("a text node generates nothing, and the answer says what does write it", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "generate", { nodeId: "text-1" });
        expect(answer.isError).toBe(true);
        expect(written.generated).toEqual([]);
        expect(text).toContain("nothing generates them");
        expect(text).toContain("set_text");
    });

    // The frame taken from a film, the crop, the upload: a picture nothing here made. A press would fall back to
    // the canvas's default model — the one path that could still reach it, now that the panel offers no button —
    // and the run would never see the picture it replaced (#297).
    test("material has nothing to press, and the refusal names the way out", async () => {
        const { hands, written } = handsFor([node("image", { content: "/api/canvases/c/files/a.png", prompt: "the last frame" })]);
        const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });

        expect(answer.isError).toBe(true);
        expect(written.generated).toEqual([]);
        expect(text).toContain("material, not a run");
        expect(text).toContain("no model on it to press");
        expect(text).toContain("Connect it to a node that runs");
    });

    /**
     * One press, one word (#285).
     *
     * The rule the four cases below state from four sides: an agent that believes a run is out has to be
     * told how that run ended, and an agent that was told "still setting up" has to be told too — a turn
     * waiting on a message that never comes has no way to continue, and nobody is watching the canvas to
     * notice. So the answer is either "a run exists" (the server will say how it went) or "it did not start"
     * (said now), and the only case that leaves a promise open is the one that states the promise.
     */
    describe("one press, one word", () => {
        const picture = () => node("image", { prompt: "a rabbit" });
        /** Press a picture, and let the test decide when and how the page reports. */
        const pressing = (report: (say: (start: GenerateStart) => void) => Promise<void>) => {
            const { hands, written } = handsFor([picture()]);
            hands.generateNode = async (nodeId, mode, prompt, options) => {
                written.generated.push([nodeId, prompt]);
                void mode;
                await report((start) => options?.onStart?.(start));
            };
            return { hands, written };
        };

        test("a run is answered as a run: it is out, and the server will say how it went", async () => {
            const { hands } = pressing(async (say) => say({ started: true, runId: "task_6f2c" }));
            const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });
            expect(answer.isError).not.toBe(true);
            expect(text).toContain("task_6f2c");
            expect(text).toContain("you will be sent a message");
        });

        test("a refusal is answered with the page's own reason, and promises nothing", async () => {
            const { hands } = pressing(async (say) => say({ started: false, reason: "workflow image-z-image-turbo requires a non-empty prompt" }));
            const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });
            expect(answer.isError).toBe(true);
            expect(text).toContain("requires a non-empty prompt");
            expect(text).toContain("did not start");
            // Nothing is promised, because nothing is coming: the answer is the press's own word (#285).
            expect(text).not.toContain("will be sent");
        });
    });
});

describe("create_node: what this canvas can make", () => {
    test("makes the four content types", async () => {
        for (const type of ["image", "video", "audio", "text"]) {
            const { hands, written } = handsFor([]);
            const answer = await runTool("create_node", { type }, hands, "canvas:test");
            expect(answer.isError).not.toBe(true);
            expect(written.created).toEqual([type]);
        }
    });

    test("refuses a node it cannot fill in, naming what it does make", async () => {
        // A LoRA node needs a file picked in its own panel, which no argument here can supply: the tool used
        // to advertise `lora` and refuse it. A group is no longer refused this way — it holds nodes rather
        // than content, and the menu makes one too (#292).
        const { hands, written } = handsFor([]);
        const answer = await runTool("create_node", { type: "lora" }, hands, "canvas:test");
        expect(answer.isError).toBe(true);
        expect((answer.content[0] as { text: string }).text).toContain("this canvas makes image, video, audio, text, group");
        expect(written.created).toEqual([]);
    });

    test("makes a group, and refuses to put words in it", async () => {
        // The container the menu can make: empty, and asking it anything is a call with no field behind it.
        const empty = handsFor([]);
        const made = await runTool("create_node", { type: "group" }, empty.hands, "canvas:test");
        expect(made.isError).not.toBe(true);
        expect(empty.written.created).toEqual(["group"]);

        const asked = handsFor([]);
        const refused = await textOf(asked.hands, "create_node", { type: "group", prompt: card });
        expect(refused.answer.isError).toBe(true);
        expect(refused.text).toContain("a group is a container");
        expect(refused.text).toContain("group_nodes");
        expect(asked.written.created).toEqual([]);
    });

    test("a text node's starting words are its body, not its prompt", async () => {
        const { hands } = handsFor([]);
        const seen: CanvasNodeMetadata[] = [];
        hands.createNode = (type, position, patch) => {
            void position;
            seen.push(patch || {});
            return node(type);
        };
        await runTool("create_node", { type: "text", prompt: card }, hands, "canvas:test");
        expect(seen).toEqual([{ content: card }]);
    });
});

/**
 * A tool the page does not know is a page older than its own tools.
 *
 * The list the agent is handed comes from the server and the switch behind it is the page's, so they can be
 * built at different times — which is exactly what happened when `set_text` was answered with "this canvas
 * has no tool called set_text" and the agent spent a conversation working around a tool that existed (#230).
 */
describe("a name this page does not know", () => {
    test("says the page is older than the tool list, not that the tool does not exist", async () => {
        const { hands } = handsFor([]);
        const answer = await runTool("nudge_node", { nodeId: "text-1" }, hands, "canvas:test");

        expect(answer.isError).toBe(true);
        expect((answer.content[0] as { text: string }).text).toContain("the page in front of the user was built before the tool list you were given");
    });
});

/**
 * A press that would carry nothing is refused before it is made.
 *
 * The page refuses it too, but the agent would be told a run is out and then wait for a message that never
 * comes, so the same function is asked here as well (#230).
 */
describe("generate: a wire that carries nothing", () => {
    test("refuses in the page's own words, and starts nothing", async () => {
        const { hands, written } = handsFor([node("text", { content: "" }), node("image", { prompt: "a brass compass" })], [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-1" }]);
        const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });

        expect(answer.isError).toBe(true);
        expect(text).toMatch(/^text-1 .*holds nothing yet/);
        expect(written.generated).toEqual([]);
    });

    test("presses when the wire does carry something", async () => {
        const { hands, written } = handsFor([node("text", { content: "a red ceramic teapot" }), node("image", { prompt: "a brass compass" })], [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-1" }]);
        // The page reports the run as soon as it exists; a fake that stays silent would be answered with
        // "no run was reported" after the press timeout, which is a different test.
        hands.generateNode = async (nodeId, mode, prompt, options) => {
            written.generated.push([nodeId, prompt]);
            void mode;
            options?.onStart?.({ started: true, runId: "run-1" });
        };
        const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("run run-1 is out");
        expect(written.generated).toEqual([["image-1", "a brass compass"]]);
    });
});

/**
 * `read_prompt` reads the words a node will be asked, and nothing else.
 *
 * A node has two kinds of words and they are not interchangeable: what it holds (the card — `read_text`) and
 * what it will be asked (the prompt its panel shows — this). The settings standing behind the question are
 * neither, so they are `read_node`'s: this answer is the words, which is what makes it usable as the string a
 * rewrite is written against.
 */
describe("read_prompt: the question behind a node", () => {
    test("a text node has no prompt, and the answer points at what it does have", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "read_prompt", { nodeId: "text-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("has no prompt");
        expect(text).not.toContain(card);
        expect(text).toContain("read_text");
    });

    test("says so when nothing has been asked of a picture", async () => {
        const { hands } = handsFor([node("image", { content: "/api/canvases/c/files/a.png" })]);
        const { answer, text } = await textOf(hands, "read_prompt", { nodeId: "image-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("has no prompt");
        expect(text).toContain("nothing has been asked of it yet");
    });

    test("answers with the words and nothing else, even when the node is set to run something", async () => {
        const { hands } = handsFor([node("image", { content: "data:image/png;base64,AAAA", prompt: "a brass compass", model: "default::image-qwen21", size: "1360x768" })]);
        const { text } = await textOf(hands, "read_prompt", { nodeId: "image-1" });

        // Exactly the prompt: what will run is `read_node`'s, and mixing the two is what made a rewrite read
        // the model as if it were part of what the user asked for.
        expect(text).toBe("a brass compass");
    });

    test("refuses a node the canvas does not hold", async () => {
        const { hands } = handsFor([]);
        const { answer } = await textOf(hands, "read_prompt", { nodeId: "text-9" });

        expect(answer.isError).toBe(true);
    });
});

// A card's box, which the agent could not see or set at all until now. What matters here is the rule the
// canvas already had: a card that frames a picture is that picture's shape (#264), so it has one degree of
// freedom — and a call that states two numbers contradicting it is refused with the one that fits, rather
// than quietly resized to something the caller did not ask for.
describe("resize_node: the card's box, not a zoom", () => {
    const picture = (naturalWidth: number, naturalHeight: number) => node("image", { content: "/api/canvases/c/files/a.png", naturalWidth, naturalHeight });

    test("a card that frames a picture is told a width, and the height follows", async () => {
        const { hands, written } = handsFor([picture(1920, 1280)]);
        const { answer, text } = await textOf(hands, "resize_node", { nodeId: "image-1", size: { width: 480 } });

        expect(answer.isError).not.toBe(true);
        expect(written.resized).toEqual([["image-1", 480, 320]]);
        // The answer is the box it now occupies, because the number asked for is not always the number set.
        expect(text).toContain("480×320");
        expect(text).toContain("1920×1280");
    });

    test("a pair that contradicts the picture's shape is refused, with the height that fits", async () => {
        const { hands, written } = handsFor([picture(1920, 1280)]);
        const { answer, text } = await textOf(hands, "resize_node", { nodeId: "image-1", size: { width: 480, height: 200 } });

        expect(answer.isError).toBe(true);
        expect(written.resized).toEqual([]);
        expect(text).toContain("320");
    });

    test("a card of words takes both numbers, and keeps its height when only one is given", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        await textOf(hands, "resize_node", { nodeId: "text-1", size: { width: 400, height: 700 } });
        await textOf(hands, "resize_node", { nodeId: "text-1", size: { width: 500 } });

        expect(written.resized).toEqual([
            ["text-1", 400, 700],
            ["text-1", 500, 240],
        ]);
    });

    test("the floor is refused and named, and it is not the same number on both sides", async () => {
        // A 3:2 card cannot go under the height floor, so its narrowest width is 240 rather than 220 — the same
        // clamp the corner drag applies.
        const tall = handsFor([picture(1920, 1280)]);
        const refused = await textOf(tall.hands, "resize_node", { nodeId: "image-1", size: { width: 200 } });
        expect(refused.answer.isError).toBe(true);
        expect(refused.text).toContain("240");

        const free = handsFor([textSaying(card)]);
        const small = await textOf(free.hands, "resize_node", { nodeId: "text-1", size: { width: 200, height: 120 } });
        expect(small.answer.isError).toBe(true);
        expect(small.text).toContain("220×160");
        expect(free.written.resized).toEqual([]);
    });

    test("asks for the size when the call carries none, and answers a node it does not hold", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const missing = await textOf(hands, "resize_node", { nodeId: "text-1" });
        expect(missing.answer.isError).toBe(true);
        expect(missing.text).toContain("resize_node needs a size");

        const unknown = await textOf(hands, "resize_node", { nodeId: "text-9", size: { width: 400 } });
        expect(unknown.answer.isError).toBe(true);
    });
});

/**
 * Which run a node is, and how that run is shaped: one call, one write.
 *
 * They were two tools, and neither could keep its promise: a size is judged against the workflow that will run
 * it, so a model change that succeeded and a size that was refused left one sentence half applied. The plans are
 * still two (`planNodeModel`, `planNodeSettings`, tested where they live); what is pinned here is the
 * composition — the run first, the shape judged by it, both written together or not at all.
 */
describe("set_node: which run it is, and how it is shaped", () => {
    const catalogWith = (accepts: string[]): ModelCatalog => ({
        options: [{ value: "default::image-qwen21", names: ["image-qwen21"], label: "Qwen Image 2.1", workflowId: "image-qwen21", mode: "", modes: ["t2i", "edit"], blocked: [], step: false, takes: "words only", modeMedia: {}, knobs: [] }],
        accepts: (_value, _mode, key) => accepts.includes(key),
    });

    test("writes the model and the mode, and answers with what the node now runs", async () => {
        const { hands, written } = handsFor([placed("image-1", "image")], [], {}, undefined, catalogWith(["prompt", "editCanvasSize"]));
        const { answer, text } = await textOf(hands, "set_node", { nodeId: "image-1", model: "image-qwen21", mode: "edit" });

        expect(answer.isError).not.toBe(true);
        expect(written.settings).toEqual([["image-1", { model: "default::image-qwen21", imageMode: "edit" }]]);
        expect(text).toBe("image-1 now runs image-qwen21 as edit");
    });

    test("a setting the new run does not read is named, and stays on the node", async () => {
        const sized = placed("image-1", "image", { size: "1360x768", params: { steps: 8 } });
        const { hands, written } = handsFor([sized], [], {}, undefined, catalogWith(["prompt"]));
        const { text } = await textOf(hands, "set_node", { nodeId: "image-1", model: "image-qwen21" });

        expect(written.settings[0][1]).not.toHaveProperty("size");
        expect(text).toContain("no longer reads size, steps");
        expect(text).toContain("still on the node");
    });

    test("a name it does not have is refused before anything is written", async () => {
        const { hands, written } = handsFor([placed("image-1", "image")], [], {}, undefined, catalogWith(["prompt"]));
        const { answer, text } = await textOf(hands, "set_node", { nodeId: "image-1", model: "image-flux" });

        expect(answer.isError).toBe(true);
        expect(written.settings).toEqual([]);
        expect(text).toContain("image-qwen21");
    });

    test("an id the canvas does not hold, and a node with no run to choose", async () => {
        const { hands } = handsFor([textSaying(card)], [], {}, undefined, catalogWith(["prompt"]));
        const unknown = await textOf(hands, "set_node", { nodeId: "image-9", model: "image-qwen21" });
        expect(unknown.answer.isError).toBe(true);

        const words = await textOf(hands, "set_node", { nodeId: "text-1", model: "image-qwen21" });
        expect(words.answer.isError).toBe(true);
        expect(words.text).toContain("holds words");
    });

    /**
     * The picker the panel no longer offers, refused here too — and refused before the name is resolved.
     *
     * This is the door that was still open: a frame taken from a film, a crop, an upload. Giving it a model
     * does not re-run anything, because a run reads what is connected to it and never its own content — it
     * only makes the node pressable, and that press replaces the picture with a render that never saw it
     * (#297). Both halves of "which run this is" are refused: a model, and a mode alone.
     */
    test("material cannot be given a run, by model or by mode", async () => {
        const frame = placed("image-1", "image", { content: "/api/canvases/c/files/frame.png" });

        const byModel = handsFor([frame], [], {}, undefined, catalogWith(["prompt", "editCanvasSize"]));
        const model = await textOf(byModel.hands, "set_node", { nodeId: "image-1", model: "image-qwen21" });
        expect(model.answer.isError).toBe(true);
        expect(byModel.written.settings).toEqual([]);
        expect(model.text).toContain("material, not a run");
        expect(model.text).toContain("would replace what it holds");
        // The refusal is about the node, not the name: an unknown model would be refused differently.
        expect(model.text).not.toContain("is not a model this canvas has");

        const byMode = handsFor([frame], [], {}, undefined, catalogWith(["prompt", "editCanvasSize"]));
        const mode = await textOf(byMode.hands, "set_node", { nodeId: "image-1", mode: "edit" });
        expect(mode.answer.isError).toBe(true);
        expect(byMode.written.settings).toEqual([]);
    });

    test("writes the settings the plan settled on, and answers with the node's own clause", async () => {
        const { hands, written } = handsFor([placed("image-1", "image")], [], { accepts: ["size", "seed"] });
        const { answer, text } = await textOf(hands, "set_node", { nodeId: "image-1", size: "1024x1024", seed: 42 });

        expect(answer.isError).not.toBe(true);
        expect(written.settings).toEqual([["image-1", { size: "1024x1024", seed: "42", seedFixed: "true" }]]);
        // The clause is the read-back: the node as its next run would see it, which is what read_node answers.
        expect(text).toBe("set size 1024x1024, seed 42 on image-1; it is now size 1024x1024, seed 42");
    });

    test("a key the workflow does not read is refused, and nothing is written", async () => {
        const { hands, written } = handsFor([placed("image-1", "image")], [], { accepts: ["seed"] });
        const { answer, text } = await textOf(hands, "set_node", { nodeId: "image-1", size: "1024x1024" });

        expect(answer.isError).toBe(true);
        expect(written.settings).toEqual([]);
        expect(text).toContain("size means nothing to this workflow");
        expect(text).toContain("seed");
    });

    // The reason the two tools became one.
    test("a model and a size land together, judged by the new model's contract", async () => {
        const contractFor = (run?: { model?: string; mode?: string }) => ({ accepts: run?.model === "default::image-qwen21" ? ["size", "seed"] : ["prompt"] });
        const { hands, written } = handsFor([placed("image-1", "image", { size: "1024x1024" })], [], contractFor, undefined, catalogWith(["prompt", "editCanvasSize", "size", "seed"]));
        const { answer, text } = await textOf(hands, "set_node", { nodeId: "image-1", model: "image-qwen21", size: "1360x768" });

        expect(answer.isError).not.toBe(true);
        expect(written.settings).toEqual([["image-1", { model: "default::image-qwen21", size: "1360x768" }]]);
        // The size was judged against the model being set, not the one being replaced.
        expect(written.contracts.at(-1)).toEqual(["image-1", { model: "default::image-qwen21", mode: "" }]);
        expect(text).toBe("image-1 now runs image-qwen21, set size 1360x768");
    });

    test("when the shape is refused, the model is not written either", async () => {
        const { hands, written } = handsFor([placed("image-1", "image")], [], { accepts: ["seed"] }, undefined, catalogWith(["prompt", "editCanvasSize", "size", "seed"]));
        const { answer, text } = await textOf(hands, "set_node", { nodeId: "image-1", model: "image-qwen21", size: "1360x768" });

        expect(answer.isError).toBe(true);
        expect(written.settings).toEqual([]);
        expect(text).toContain("size means nothing to this workflow");
    });

    test("a node kind that has no run to configure is refused", async () => {
        const { hands } = handsFor([textSaying(card)], [], { accepts: ["size"] });
        const words = await textOf(hands, "set_node", { nodeId: "text-1", size: "1024x1024" });

        expect(words.answer.isError).toBe(true);
        expect(words.text).toContain("its words");
    });

    test("a call with nothing stated is refused, and says what it takes", async () => {
        const { hands } = handsFor([placed("image-1", "image")]);
        const { answer, text } = await textOf(hands, "set_node", { nodeId: "image-1" });

        expect(answer.isError).toBe(true);
        expect(text).toContain("nothing was stated");
        expect(text).toContain("size");
    });
});

/**
 * The question no tool could answer: what models does this canvas have.
 *
 * The listing itself is `describeModelCatalogs`'s, tested where it lives (#312); what is checked here is the
 * wiring — one catalog per kind asked of the page, all three unless the call names one, and a kind that is not
 * one of them refused rather than silently ignored.
 */
describe("list_models: what this canvas can run", () => {
    const asked: string[] = [];
    const catalogFor = (capability: string) => ({
        options:
            capability === "image" ? [{ value: "default::image-qwen21", names: ["image-qwen21"], label: "Qwen Image 2.1", workflowId: "image-qwen21", mode: "", modes: [], blocked: [], step: false, takes: "words only", modeMedia: {}, knobs: [] }] : [],
        accepts: () => undefined,
    });
    const hands = (): CanvasHands => {
        const base = handsFor([placed("image-1", "image")]).hands;
        return {
            ...base,
            modelCatalog: (capability) => {
                asked.push(capability);
                return catalogFor(capability);
            },
        };
    };

    test("asks every kind unless the call names one, and lists what it found", async () => {
        asked.length = 0;
        const { text } = await textOf(hands(), "list_models", {});
        expect(asked).toEqual(["image", "video", "audio"]);
        expect(text).toContain("image — 1 workflow to generate with");
        expect(text).toContain("video: none configured on this canvas");
    });

    test("a kind named narrows it to that one", async () => {
        asked.length = 0;
        const { text } = await textOf(hands(), "list_models", { capability: "image" });
        expect(asked).toEqual(["image"]);
        expect(text).toContain("image-qwen21");
        expect(text).not.toContain("audio");
    });

    test("a kind this canvas does not make is refused, with the three it does", async () => {
        const { answer, text } = await textOf(hands(), "list_models", { capability: "text" });
        expect(answer.isError).toBe(true);
        expect(text).toContain("image, video, audio");
    });
});

/**
 * Stopping a run: the one thing an agent could not do once it had started one.
 *
 * Three answers, because the truth has three shapes and only one of them is a failure: the run was cancelled,
 * there was nothing running (the postcondition the caller wanted already held), or the server did not confirm
 * and the work may still be going — which is a failed call, since the caller asked for it to stop (docs/decisions.md #310).
 */
describe("stop_node: ending a run", () => {
    const generating = (metadata: CanvasNodeMetadata = {}) => placed("image-1", "image", metadata);

    test("cancels the run and says the node is idle again", async () => {
        const { hands, written } = handsFor([generating({ runId: "run-1", status: "loading" })]);
        const { answer, text } = await textOf(hands, "stop_node", { nodeId: "image-1" });

        expect(answer.isError).not.toBe(true);
        expect(written.stopped).toEqual(["image-1"]);
        expect(text).toBe("stopped image-1: the run was cancelled and the node is idle again, holding what it held before");
    });

    test("a node that is not generating is not an error: there is nothing to stop", async () => {
        const { hands } = handsFor([generating({ content: "/api/canvases/c/files/a.png", status: "success" })], [], {}, { running: false });
        const { answer, text } = await textOf(hands, "stop_node", { nodeId: "image-1" });
        expect(answer.isError).not.toBe(true);
        expect(text).toContain("there was nothing to stop");
    });

    test("a cancel the server did not confirm is a failed call, and says what may still be running", async () => {
        const { hands } = handsFor([generating({ runId: "run-1", status: "loading" })], [], {}, { running: true, cancel: "unknown", reason: "network down" });
        const { answer, text } = await textOf(hands, "stop_node", { nodeId: "image-1" });
        expect(answer.isError).toBe(true);
        expect(text).toContain("network down");
        expect(text).toContain("may still be rendering");
    });

    test("a press caught before it submitted is said so: nothing was thrown away", async () => {
        const { hands } = handsFor([generating({ status: "loading" })], [], {}, { running: true });
        const { answer, text } = await textOf(hands, "stop_node", { nodeId: "image-1" });
        expect(answer.isError).not.toBe(true);
        expect(text).toContain("nothing had been submitted");
    });

    test("a run that ended before the stop arrived is said so, not claimed as a stop", async () => {
        const { hands } = handsFor([generating({ runId: "run-1", status: "loading" })], [], {}, { running: true, cancel: "finished" });
        const { answer, text } = await textOf(hands, "stop_node", { nodeId: "image-1" });
        expect(answer.isError).not.toBe(true);
        expect(text).toContain("already ended");
    });

    test("a text card generates nothing, so it is refused before the page is asked", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        const { answer } = await textOf(hands, "stop_node", { nodeId: "text-1" });
        expect(answer.isError).toBe(true);
        expect(written.stopped).toEqual([]);
    });
});

/** A node with the id the test needs, since the group tools are about ids and relations between them. */
const placed = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ ...node(type, metadata), id });

/**
 * A card at a place and a size, because a move is judged by where the cards sit: membership follows the
 * rectangle a node lands in (`settleMoveMembership`, docs/decisions.md #316), so a fixture for it has to say
 * where things are rather than leave every node at the origin.
 */
const at = (id: string, type: CanvasNodeData["type"], x: number, y: number, metadata: CanvasNodeMetadata = {}, size = 100): CanvasNodeData => ({ ...node(type, metadata), id, position: { x, y }, width: size, height: size });
const group = (id: string, x: number, y: number): CanvasNodeData => at(id, "group", x, y, {}, 300);
const member = (id: string, groupId: string, x: number, y: number): CanvasNodeData => at(id, "text", x, y, { groupId });
const loose = (id: string, x: number, y: number): CanvasNodeData => at(id, "text", x, y);

/**
 * Moving a group, which is a move of the card and of what it holds.
 *
 * The tool states one card, so a group's members came along only in the drag — an agent tidying a group
 * scattered it instead, leaving the box behind and its members where they were. The answer says how many
 * travelled, because that is the difference between moving a group and moving a box (docs/decisions.md #308).
 */
describe("move_node: what a move carries", () => {
    test("a group's card takes its members with it, and the answer says how many", async () => {
        const { hands, written } = handsFor([placed("group-1", "group"), placed("text-1", "text", { groupId: "group-1" }), placed("image-1", "image", { groupId: "group-1" }), placed("loose", "text")]);
        const { answer, text } = await textOf(hands, "move_node", { nodeId: "group-1", position: { x: 640, y: 320 } });

        expect(answer.isError).not.toBe(true);
        // The corner is what the tool states; the members are the canvas's own rule, one call behind it.
        expect(written.moved).toEqual([["group-1", { x: 640, y: 320 }]]);
        expect(text).toBe("moved group-1 (group) and its 2 members to (640, 320)");
    });

    test("a plain node moves alone and says so", async () => {
        // Nothing to join and nothing to leave: no clause at all, so the common answer stays as short as it was.
        const { hands } = handsFor([loose("text-1", 100, 100)]);
        const { text } = await textOf(hands, "move_node", { nodeId: "text-1", position: { x: 10, y: 20 } });
        expect(text).toBe("moved text-1 (text) to (10, 20)");
    });

    test("a node dropped on a card says which one it joined", async () => {
        // A move is the third way to change membership, and the answer is the agent's only view of it.
        const { hands } = handsFor([group("group-2", 0, 400), loose("text-1", 100, 100)]);
        const { text } = await textOf(hands, "move_node", { nodeId: "text-1", position: { x: 100, y: 450 } });
        expect(text).toBe("moved text-1 (text) to (100, 450); joined group-2");
    });

    test("a member moved from one card onto another names both", async () => {
        const { hands } = handsFor([group("group-1", 0, 0), member("text-1", "group-1", 100, 100), member("text-2", "group-1", 100, 220), group("group-2", 0, 400)]);
        const { text } = await textOf(hands, "move_node", { nodeId: "text-1", position: { x: 100, y: 450 } });
        expect(text).toBe("moved text-1 (text) to (100, 450); left group-1, joined group-2");
    });

    test("taking a card's last member out removes the card it emptied, and says so", async () => {
        // #292's rule applied to the third gesture that can empty a group: the shell is debris the move made.
        const { hands } = handsFor([group("group-1", 0, 0), member("text-1", "group-1", 100, 100)]);
        const { text } = await textOf(hands, "move_node", { nodeId: "text-1", position: { x: 100, y: 450 } });
        expect(text).toBe("moved text-1 (text) to (100, 450); left group-1, removed because nothing was left in it");
    });

    test("a group moved onto another card reports no membership at all", async () => {
        // Its members travel with it, so the landing cannot hand them over (#316) — and the answer must not
        // invent a change that did not happen.
        const { hands } = handsFor([group("group-1", 0, 0), member("text-1", "group-1", 100, 100), group("group-2", 0, 400)]);
        const { text } = await textOf(hands, "move_node", { nodeId: "group-1", position: { x: 0, y: 400 } });
        expect(text).toBe("moved group-1 (group) and its 1 member to (0, 400)");
    });
});
/**
 * The two structure tools: a group holds nodes, so these describe a relation rather than a node.
 *
 * What is checked here is the answer and the three refusals — a single node, a set that is already one
 * group, and ids the canvas does not hold. Which nodes end up in which card is `applyGroupSelection`'s
 * business, tested where it lives.
 */
describe("group_nodes: putting nodes in one card", () => {
    test("hands the ids to the canvas, and says what was wrapped", async () => {
        const { hands, written } = handsFor([placed("image-1", "image"), placed("text-1", "text")]);
        const { answer, text } = await textOf(hands, "group_nodes", { nodeIds: ["image-1", "text-1"] });
        expect(answer.isError).not.toBe(true);
        expect(written.grouped).toEqual([["image-1", "text-1"]]);
        expect(text).toBe("grouped image-1, text-1 into group-1");
    });

    test("refuses one node: a group holds at least two", async () => {
        const { hands } = handsFor([placed("image-1", "image")]);
        const { answer, text } = await textOf(hands, "group_nodes", { nodeIds: ["image-1"] });
        expect(answer.isError).toBe(true);
        expect(text).toContain("nothing was grouped");
        expect(text).toContain("a group holds at least two");
    });

    test("refuses a set that is already one group, and names that group", async () => {
        // A second card around the same nodes is the same thing drawn twice, so the answer points at the
        // group they are in and at the two ways forward instead of making another one.
        const { hands, written } = handsFor([placed("image-1", "image", { groupId: "group-9" }), placed("text-1", "text", { groupId: "group-9" })]);
        const { answer, text } = await textOf(hands, "group_nodes", { nodeIds: ["image-1", "text-1"] });
        expect(answer.isError).toBe(true);
        expect(text).toContain("already one group (group-9)");
        expect(text).toContain("move one of them out of the box");
        expect(written.grouped).toEqual([]);
    });

    test("asks for the ids, and answers an id the canvas does not hold", async () => {
        const { hands } = handsFor([placed("image-1", "image"), placed("text-1", "text")]);
        const none = await textOf(hands, "group_nodes", {});
        expect(none.answer.isError).toBe(true);
        expect(none.text).toContain("group_nodes needs nodeIds");

        const unknown = await textOf(hands, "group_nodes", { nodeIds: ["image-1", "ghost"] });
        expect(unknown.answer.isError).toBe(true);
        expect(unknown.text).toContain('no node with id "ghost"');
    });
});

describe("ungroup_nodes: letting nodes out", () => {
    test("dissolving a group releases its members and says the card is gone", async () => {
        const { hands, written } = handsFor([placed("group-1", "group"), placed("image-1", "image", { groupId: "group-1" }), placed("text-1", "text", { groupId: "group-1" })]);
        const { answer, text } = await textOf(hands, "ungroup_nodes", { nodeIds: ["group-1"] });
        expect(answer.isError).not.toBe(true);
        expect(written.ungrouped).toEqual([["group-1"]]);
        expect(text).toBe("released image-1, text-1; removed group-1");
    });

    test("refuses a member, because a card belongs to a group by where it stands", async () => {
        // Releasing it in place would put it back at its next move: a card drawn inside the box but not in the
        // group (#335). The answer says how to take it out — move it — and nothing is written.
        const { hands, written } = handsFor([placed("group-1", "group"), placed("image-1", "image", { groupId: "group-1" })]);
        const { answer, text } = await textOf(hands, "ungroup_nodes", { nodeIds: ["image-1"] });
        expect(answer.isError).toBe(true);
        expect(text).toContain("inside group-1");
        expect(text).toContain("move it outside the box");
        expect(written.ungrouped).toEqual([]);
    });

    test("refuses a node that is in no group", async () => {
        const { hands } = handsFor([placed("image-1", "image")]);
        const { answer, text } = await textOf(hands, "ungroup_nodes", { nodeIds: ["image-1"] });
        expect(answer.isError).toBe(true);
        expect(text).toContain("not in a group");
    });

    test("asks for the ids, and answers an id the canvas does not hold", async () => {
        const { hands } = handsFor([placed("image-1", "image")]);
        const none = await textOf(hands, "ungroup_nodes", {});
        expect(none.answer.isError).toBe(true);
        expect(none.text).toContain("ungroup_nodes needs nodeIds");

        const unknown = await textOf(hands, "ungroup_nodes", { nodeIds: ["ghost"] });
        expect(unknown.answer.isError).toBe(true);
        expect(unknown.text).toContain('no node with id "ghost"');
    });
});

/**
 * Deleting, which is the fourth gesture that can empty a group.
 *
 * A card whose last member is deleted is a box drawn around nothing, and the delete is what made it that —
 * the same debris grouping, ungrouping and moving remove (#318, amending #292's cost). A card that keeps a
 * member, and a box that was already empty, are not the delete's business.
 */
describe("delete_node: the card a delete empties", () => {
    test("deleting a card's last member removes the card, and says so", async () => {
        const { hands, written } = handsFor([group("group-1", 0, 0), member("text-1", "group-1", 100, 100)]);
        const { answer, text } = await textOf(hands, "delete_node", { nodeId: "text-1" });
        expect(answer.isError).not.toBe(true);
        expect(written.deleted).toEqual(["text-1"]);
        expect(text).toBe("deleted text-1 (text); removed group-1, which the delete left empty. It is in the canvas's trash with the connections it had, so nothing is lost: restore_node puts it back");
    });

    test("a card that still holds a member stays", async () => {
        const { hands } = handsFor([group("group-1", 0, 0), member("text-1", "group-1", 100, 100), member("text-2", "group-1", 100, 220)]);
        const { text } = await textOf(hands, "delete_node", { nodeId: "text-1" });
        expect(text).toBe("deleted text-1 (text). It is in the canvas's trash with the connections it had, so nothing is lost: restore_node puts it back");
    });

    test("a box that was already empty is nobody's debris", async () => {
        const { hands } = handsFor([placed("empty", "group"), placed("text-1", "text")]);
        const { text } = await textOf(hands, "delete_node", { nodeId: "text-1" });
        expect(text).toBe("deleted text-1 (text). It is in the canvas's trash with the connections it had, so nothing is lost: restore_node puts it back");
    });
});

/**
 * The trash, as the tools see it (#327).
 *
 * A delete moves a node instead of destroying it, so three things follow and each is a sentence the agent
 * depends on: the delete says where the node went, an id that is no longer on the canvas is answered as
 * "trashed" rather than "unknown" (which would send it looking for a bug), and `restore_node` puts it back
 * with the connections it had.
 */
describe("the trash", () => {
    const entry = (node: CanvasNodeData, connections: CanvasConnection[] = []): CanvasTrashEntry => ({ deletedAt: new Date().toISOString(), node, connections });
    const gonePicture = { id: "image-9", type: "image" as const, position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { groupId: "group-1" } };

    test("an id that is not on the canvas but is in the trash says so, and names the way back", async () => {
        const { hands } = handsFor([], [], {}, { running: false, cancel: "finished" }, { options: [], accepts: () => undefined }, [entry(gonePicture)]);
        const { answer, text } = await textOf(hands, "read_prompt", { nodeId: "image-9" });
        expect(answer.isError).toBe(true);
        expect(text).toContain("image-9 is not on the canvas: it is in the trash");
        expect(text).toContain("restore_node puts it back");
    });

    test("an id that was never here is still just unknown", async () => {
        const { hands } = handsFor([]);
        const { text } = await textOf(hands, "read_text", { nodeId: "text-404" });
        expect(text).toBe('no node with id "text-404" on this canvas');
    });

    test("restore_node puts it back, and says with what", async () => {
        const wires: CanvasConnection[] = [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-9" }];
        const { hands, written } = handsFor([group("group-1", 0, 0)], [], {}, { running: false, cancel: "finished" }, { options: [], accepts: () => undefined }, [entry(gonePicture, wires)]);
        const { answer, text } = await textOf(hands, "restore_node", { nodeId: "image-9" });
        expect(answer.isError).not.toBe(true);
        expect(written.restored).toEqual(["image-9"]);
        expect(text).toBe("restored image-9 (image), with 1 connection it had, in group group-1. It holds the same content it did before the delete");
    });

    test("restoring something that is not in the trash is refused, and points at where the ids are", async () => {
        const { hands, written } = handsFor([]);
        const { answer, text } = await textOf(hands, "restore_node", { nodeId: "image-9" });
        expect(answer.isError).toBe(true);
        expect(written.restored).toEqual([]);
        expect(text).toContain('nothing in the trash has the id "image-9"');
        expect(text).toContain("list_nodes states what the trash holds");
    });

    test("a group in the trash is a group a restore cannot draw, and the trash never holds one", async () => {
        // What the tool does with an id the page's trash does not have: the same refusal, because the page is
        // the one that decides what a delete keeps (a group is structure, #327).
        const { hands } = handsFor([group("group-1", 0, 0)]);
        const { text } = await textOf(hands, "restore_node", { nodeId: "group-1" });
        expect(text).toContain("nothing in the trash has the id");
    });
});
