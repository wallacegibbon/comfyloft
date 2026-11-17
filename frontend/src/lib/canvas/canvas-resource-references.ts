import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { nodeContentOf } from "@/lib/canvas/node-prompt-field";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasResourceKind = "image" | "video" | "audio" | "text" | "lora";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    text?: string;
    loras?: Array<{ name: string; strength: number }>;
    active: boolean;
};

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true);
}

/**
 * The nodes this node may name: what is wired into it, and itself never.
 *
 * This used to fall back to the node itself when nothing was wired, because a card that holds a picture *is* a
 * resource node. Nothing else answers that question the same way: the run reads `getGenerationResourceNodes`, the
 * reference bar draws the connections, the agent counts the wires — so an unconnected picture card was the one
 * case where the answer was its own picture, and the panel, which asks in order to refuse a press, refused its
 * own (#355).
 */
function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return expandGroupResourceNodes(getContextInputNodes(nodeId, nodes, connections), nodes);
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return getContextInputNodes(nodeId, nodes, connections);
}

/**
 * The nodes a run on `nodeId` would read, including the ones that hold nothing.
 *
 * `getGenerationResourceNodes` answers "which nodes are inputs" and leaves out a node that holds nothing,
 * because there is nothing to read from it. This asks the same question with that filter removed, so a run
 * wired to an empty node can be refused by its name instead of quietly running without it (#230).
 */
export function generationInputCandidates(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    const candidates = incomingNodes(nodeId, nodes, connections).filter((node) => node.id !== nodeId);
    return [...new Map(candidates.map((node) => [node.id, node])).values()];
}

function incomingNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return connections
        .filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node));
}

function getContextInputNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return incomingNodes(nodeId, nodes, connections).filter((node) => isCanvasReferenceNode(node, nodes));
}

function hasGroupResources(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return node.type === CanvasNodeType.Group && getGroupResourceNodes(node.id, nodes).length > 0;
}

export function isCanvasReferenceNode(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return isResourceNode(node) || hasGroupResources(node, nodes);
}

function expandGroupResourceNodes(inputNodes: CanvasNodeData[], nodes: CanvasNodeData[]) {
    const resources = inputNodes.flatMap((node) => (node.type === CanvasNodeType.Group ? getGroupResourceNodes(node.id, nodes) : [node]));
    return [...new Map(resources.map((node) => [node.id, node])).values()];
}

export function getGroupResourceNodes(groupId: string, nodes: CanvasNodeData[]) {
    return nodes.filter((node) => node.metadata?.groupId === groupId && isResourceNode(node));
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0, lora: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        const index = counts[kind]++;
        const label = labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: label,
                previewUrl: node.metadata?.content || resource?.url,
                text: resourceText(node),
                loras: resource?.kind === "lora" ? resource.loras : undefined,
                active,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return i18n.t("canvas.references.videoLabel", { index: index + 1 });
    if (kind === "audio") return i18n.t("canvas.references.audioLabel", { index: index + 1 });
    if (kind === "lora") return `LoRA ${index + 1}`;
    return i18n.t("canvas.references.textLabel", { index: index + 1 });
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

/**
 * The words a node holds, for a reference: its content, and never its prompt.
 *
 * A prompt is private — it is what the node was asked, not what it says — so nothing outside the node
 * may read it. This used to answer `content || composerContent || prompt`, which made an empty text node
 * look like a text node with something to give, and put one node's question into another node's request
 * (#230).
 */
function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return nodeContentOf(node) || undefined;
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    return resource?.kind === "text" ? resource.text : undefined;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && nodeContentOf(node)) return "text";
    // A node declares what it contributes through definition.resource.
    return getNodeDefinition(node.type)?.resource?.(node)?.kind || null;
}
