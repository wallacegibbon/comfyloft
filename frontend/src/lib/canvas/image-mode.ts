import { channelModelOf, resolveModelForCapability, workflowModelOptions, type AiConfig, type ChannelModel } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * The mode an image run will actually use.
 *
 * A node keeps its `imageMode` after the model under it is changed, so a node that was set to "inpaint" on
 * Qwen keeps saying "inpaint" when it is pointed at a workflow that has one mode and no mask binding. The
 * panel clamped that for what it displays; the request did not, and sent a mask role and outpaint numbers to
 * a graph that binds neither — accepted and ignored, or refused, depending on the workflow (#267).
 *
 * So the mode is resolved against what the model declares: the node's choice when the model offers it, and
 * otherwise the mode whose contract asks for least (see `cheapestMode`), and nothing at all for a workflow
 * with no modes — the field is then simply not sent.
 *
 * A mode the server reports as blocked is still resolved and still sent: the run refuses it with its own
 * reason (a missing node pack), and quietly turning the request into a different mode would hide that.
 */
export function imageModeFor(config: AiConfig, model: string) {
    const channelModel = channelModelOf(config, model)?.model;
    const modes = channelModel?.variantModes;
    if (!channelModel || !modes?.length) return "";
    const chosen = String(config.imageMode || "");
    if (modes.includes(chosen)) return chosen;
    return cheapestMode(channelModel) || modes[0];
}

/**
 * The declared mode that asks the least of the caller: the one whose contract needs no reference, no mask and
 * no padding.
 *
 * This is what a stale `imageMode` falls back to, and it is deliberately not a name: the mode that means
 * "words only" is `t2i` in the Qwen family, and a family that never offers one still needs an answer. What the
 * canvas knows is the contracts, so the answer is the mode with the smallest minimum — the one a request is
 * least likely to be refused for. A family whose modes declare no contracts at all ties at zero and answers
 * with its first declared mode, which is at least the same answer every time.
 */
function cheapestMode(model: ChannelModel) {
    let best: { mode: string; cost: number } | undefined;
    for (const mode of model.variantModes || []) {
        const accepts = model.contracts?.[mode]?.accepts;
        const cost = (accepts?.images?.min ?? 0) + (accepts?.videos?.min ?? 0) + (accepts?.audios?.min ?? 0) + (accepts?.minTotal ?? 0);
        if (!best || cost < best.cost) best = { mode, cost };
    }
    return best?.mode || "";
}

/** The two picture verbs a card's bar offers. Each is named for the graph it runs, not for the card it sits on. */
export type ImageModeVerb = "inpaint" | "outpaint";

type ImageModeModel = { ok: true; model: string } | { ok: false; reason: ImageModeRefusal };

/** Why a verb cannot run: no workflow here has that graph, or that graph's own nodes are not installed. */
type ImageModeRefusal = "none" | "blocked";

/**
 * Which workflow runs an image mode, found by the mode the workflow declares.
 *
 * The film side has had this shape since #266: `videoModelForMode` asks each workflow which `mode` it is rather
 * than keeping a table of ids. A family's modes arrive on the same wire (`variantModes`), so a picture's two
 * paint verbs can be answered the same way — and #357 put those verbs where a card is asked them before any
 * model has been chosen: a picture brought in from outside records no model at all (#297), and the workflow a
 * card was made with may read no pictures, which is what #330 watched come back "a fresh text-to-image of the
 * sentence".
 *
 * The card's own model answers when it declares the mode — that is the settings-popover path, and nothing here
 * moves a card off the model it was built with. Only when it cannot does the search go over the workflow list
 * the pickers show, and a mode whose nodes are missing is no answer: #311 refused writing a blocked mode for the
 * agent because it opened the mask editor and then failed inside ComfyUI, and a bar button would repeat that
 * mistake. A family that declares no modes is not asked either — `imageModeFor` above sends such a workflow no
 * mode at all, so it cannot run one.
 *
 * Whatever is chosen is recorded on the card the editor makes, never back onto the picture: material keeps being
 * material (#297).
 */
export function modelForImageMode(config: AiConfig, currentModel: string | undefined, mode: ImageModeVerb): ImageModeModel {
    const own = resolveModelForCapability(config, currentModel, "image");
    if (runsMode(config, own, mode)) return { ok: true, model: own };
    let blocked = false;
    for (const value of workflowModelOptions(config, "image")) {
        const channelModel = channelModelOf(config, value)?.model;
        // The card's own family is searched too: when it declares the mode but its nodes are missing, "that node
        // pack is not installed" is the sentence the person can act on, and skipping the family would send them
        // looking for a workflow that does not exist.
        if (!channelModel?.variantModes?.includes(mode)) continue;
        if (channelModel.blockedModes?.includes(mode)) {
            blocked = true;
            continue;
        }
        return { ok: true, model: value };
    }
    return { ok: false, reason: blocked ? "blocked" : "none" };
}

/** Whether running this model would run this mode: the model has to declare the mode and have its nodes. */
function runsMode(config: AiConfig, model: string, mode: ImageModeVerb) {
    const channelModel = channelModelOf(config, model)?.model;
    return Boolean(channelModel?.variantModes?.includes(mode)) && !channelModel?.blockedModes?.includes(mode);
}

/**
 * The one sentence for a verb nothing here can run, chosen by why.
 *
 * Two reasons, and both are errands the person can run: install a workflow, or install a node pack. #311 settled
 * the second one for the agent — a blocked mode is refused with the blocked list named, not run into ComfyUI to
 * fail there — and a press on the bar answers the same way, in the caller that opens the preferences.
 */
export function imageModeRefusalKey(reason: ImageModeRefusal) {
    return reason === "blocked" ? "canvas.runtime.modeBlocked" : "canvas.runtime.modeNoWorkflow";
}

/** What pressing send on a card that is in a paint mode means. */
type ModePress = "run" | "window" | "refuse";

/**
 * Whether that press asks the card's own ask again, or states a new one.
 *
 * A card that was made by an outpaint run records the canvas it was asked for (`outpaint`) and has the picture
 * it extends wired into it — so asking it again is the same ask, and an image node answers in place (#228,
 * #297: "content plus a recorded model: a run of its own, and pressing send asks that model again"). Opening
 * the window for that press instead put the answer in a second card every time, which is what the user meant by
 * "它并不是原地生成，而是会创建一个新的节点". The window is for stating a *new* ask: a different canvas is a
 * different shape, and a card that holds a picture is never resized by one (#354) — so it is a new card, and the
 * card's bar has the verb that opens it (#357).
 *
 * An inpaint card is already in that shape: the mask is a node wired into it, so a press finds the mask and
 * re-runs. A card that cannot run its own mode — no mask yet, no canvas stated, nothing wired in — is shown the
 * window that states it, and a card with nothing to draw on gets the sentence instead of a button that opens
 * nothing.
 */
export function pressInMode(node: CanvasNodeData, mode: ImageModeVerb, wired: { picture: boolean; mask: boolean }): ModePress {
    if (mode === "inpaint") {
        if (wired.mask) return "run";
        return node.metadata?.content ? "window" : "refuse";
    }
    if (node.metadata?.outpaint && wired.picture) return "run";
    return node.metadata?.content ? "window" : "refuse";
}

/**
 * What a refused press is missing, in the dictionary's words.
 *
 * Both modes need a picture to work on, but they need different things beyond it — a mask drawn on one, a canvas
 * stated around one — and the two sentences name different errands, as every refusal in this tree does.
 */
export function modeRefusalKey(mode: ImageModeVerb) {
    return mode === "inpaint" ? "canvas.runtime.maskNodeNeeded" : "canvas.runtime.outpaintSourceNeeded";
}
