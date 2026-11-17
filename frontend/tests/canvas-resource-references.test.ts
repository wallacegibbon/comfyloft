import { describe, expect, it } from "vitest";

import { buildNodeMentionReferences, getGenerationResourceNodes, getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/**
 * A card is not one of its own inputs.
 *
 * Two surfaces ask the same question — "is anything wired into this node?" — the panel that refuses a reference
 * its workflow will not read, and the run that gathers what to send. They must not answer from different
 * helpers, and for a while they did: when nothing was wired, the mention list fell back to the node itself, and
 * a card holding a picture *is* a resource node. An unconnected picture card therefore named its own picture,
 * the panel drew a warning about a connection that was not on screen, and its press was refused by that
 * connection too (docs/decisions.md #355). A node's own content never travels into its own request: what a run
 * reads is what the wires carry.
 */

const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}, x = 0): CanvasNodeData => ({
    id,
    type,
    position: { x, y: 0 },
    width: 340,
    height: 240,
    metadata,
});

const connect = (fromNodeId: string, toNodeId: string): CanvasConnection => ({ id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId });

const picture = (id: string, x = 0) => node(id, CanvasNodeType.Image, { content: "data:image/png;base64,AAA" }, x);
const clip = (id: string, x = 0) => node(id, CanvasNodeType.Video, { content: "data:video/mp4;base64,AAA" }, x);
const sound = (id: string, x = 0) => node(id, CanvasNodeType.Audio, { content: "data:audio/mpeg;base64,AAA" }, x);
const words = (id: string, content = "a red ceramic teapot", x = 0) => node(id, CanvasNodeType.Text, { content }, x);
const blank = (id: string, x = 0) => node(id, CanvasNodeType.Image, {}, x);
const member = (id: string, groupId: string, x = 0) => node(id, CanvasNodeType.Image, { content: "data:image/png;base64,AAA", groupId }, x);

/** What the node may name — the list the panel asks its questions with. */
const named = (target: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) => buildNodeMentionReferences(target, nodes, connections).map((reference) => ({ nodeId: reference.nodeId, kind: reference.kind }));

/** What a run would read, flattened to the same shape: a group is its children. */
const readByRun = (targetId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) =>
    getGenerationResourceNodes(targetId, nodes, connections)
        .flatMap((input) => (input.type === CanvasNodeType.Group ? getGroupResourceNodes(input.id, nodes) : [input]))
        .map((input) => input.id)
        .sort();

describe("a card that holds something and is wired to nothing", () => {
    it("names nothing — the case that warned about a picture that was not connected", () => {
        const own = picture("n1");

        expect(named(own, [own], [])).toEqual([]);
    });

    it("names nothing whatever kind it holds", () => {
        for (const own of [picture("n1"), clip("n1"), sound("n1"), words("n1")]) {
            expect(named(own, [own], [])).toEqual([]);
        }
    });

    it("names nothing for a card made of a group's children, which is what a step's card is", () => {
        const group = node("g1", CanvasNodeType.Group, {}, 0);
        const child = member("c1", "g1", 400);
        const made = node("n1", CanvasNodeType.Image, { content: "data:image/png;base64,AAA", groupId: "g1" }, 800);

        expect(named(made, [group, child, made], [])).toEqual([]);
    });
});

describe("a card that is wired to something", () => {
    it("names the picture wired into it, once, as an image", () => {
        const source = picture("src", 0);
        const target = picture("tgt", 400);

        expect(named(target, [source, target], [connect("src", "tgt")])).toEqual([{ nodeId: "src", kind: "image" }]);
    });

    it("still leaves the card's own picture out when a real input is wired in", () => {
        const source = picture("src", 0);
        const target = picture("tgt", 400);

        expect(named(target, [source, target], [connect("src", "tgt")]).map((reference) => reference.nodeId)).not.toContain("tgt");
    });

    it("names what a wired group holds rather than the group", () => {
        const group = node("g1", CanvasNodeType.Group, {}, 0);
        const first = member("c1", "g1", 400);
        const second = member("c2", "g1", 700);
        const target = picture("tgt", 1000);

        expect(named(target, [group, first, second, target], [connect("g1", "tgt")]).map((reference) => reference.nodeId)).toEqual(["c1", "c2"]);
    });

    it("leaves a wired card that holds nothing out: a wire carries content (#230)", () => {
        const target = picture("tgt", 400);

        expect(named(target, [blank("src"), target], [connect("src", "tgt")])).toEqual([]);
    });

    it("names words as words, so the panel can still tell a text input from media", () => {
        const source = words("src");
        const target = picture("tgt", 400);

        expect(named(target, [source, target], [connect("src", "tgt")])).toEqual([{ nodeId: "src", kind: "text" }]);
    });
});

describe("the two questions", () => {
    it("are answered with the same set of nodes, wired or not", () => {
        const cases: Array<{ nodes: CanvasNodeData[]; connections: CanvasConnection[] }> = [
            { nodes: [picture("tgt")], connections: [] },
            { nodes: [picture("src"), picture("tgt")], connections: [connect("src", "tgt")] },
            { nodes: [words("src"), picture("tgt")], connections: [connect("src", "tgt")] },
            { nodes: [blank("src"), picture("tgt")], connections: [connect("src", "tgt")] },
            { nodes: [node("g1", CanvasNodeType.Group), member("c1", "g1"), picture("tgt")], connections: [connect("g1", "tgt")] },
        ];

        for (const { nodes, connections } of cases) {
            expect(
                named(nodes[nodes.length - 1], nodes, connections)
                    .map((reference) => reference.nodeId)
                    .sort(),
            ).toEqual(readByRun("tgt", nodes, connections));
        }
    });
});
