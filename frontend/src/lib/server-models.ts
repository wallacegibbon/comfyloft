import { isToolWorkflow } from "@/lib/canvas/tool-workflows";
import type { ServerWorkflow, WorkflowAccepts, WorkflowOutputShape } from "@/services/api/workflows";
import type { ChannelModel, ModelAccepts, ModelCapability } from "@/stores/use-config-store";

/**
 * The server's workflows as model entries for the picker.
 *
 * A workflow is what runs; a model is what the user picks. One graph answers to several ids when it
 * offers more than one base model, and the server reports those ids because it is the side that
 * spells and resolves them (`img-zit-int8`). Everything else here is the client's own decision:
 * which media kinds are selectable, and that a disabled or unavailable workflow is left out rather
 * than offered and then refused.
 *
 * A workflow the canvas also drives from a button (interpolate, upscale, angle) is *tagged*, not
 * dropped: the node panel offers it — that is how a node can be an interpolation at all — while the
 * "default model for new nodes" setting must not, because a default has to run from a prompt.
 */
const CAPABILITIES: ModelCapability[] = ["image", "video", "audio"];

/**
 * How long the workflow lets its output be, when it says so at all.
 *
 * A music workflow declares a `duration` parameter with the range it accepts, and that declaration is the
 * only place the canvas can learn the bounds from: `audio-minimax-music-3` allows 4–360 s because the model
 * itself stops there. A workflow that declares none gets no bounds and its node offers no duration control;
 * hardcoding a range here would be a second answer to a question the registry already answers.
 */
function durationOf(workflow: ServerWorkflow) {
    // The bound lives on the key the run reads (`seconds`), declared by the workflow that owns it: the audio
    // model accepts 4–360 s and says so, and no second key names the same thing (#302).
    const parameter = (workflow.parameters || []).find((item) => item?.key === "seconds" && item.type === "number");
    const min = Number(parameter?.min);
    const max = Number(parameter?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined;
    return { min, max };
}

/** A contract from the wire, keeping only the numbers the panel shows. */
function acceptsOf(accepts: WorkflowAccepts | undefined): ModelAccepts | undefined {
    if (!accepts) return undefined;
    const limit = (value: { min?: number; max?: number } | undefined) => (value ? { min: Number(value.min) || 0, max: Number(value.max) || 0 } : undefined);
    const images = limit(accepts.images);
    const videos = limit(accepts.videos);
    const audios = limit(accepts.audios);
    const minTotal = Number(accepts.minTotal) || 0;
    if (!images && !videos && !audios && !minTotal) return undefined;
    return { images, videos, audios, minTotal };
}

/** The keys a run may carry, as the server listed them. Absent means it did not say, which is not "none". */
function inputsOf(inputs: string[] | undefined) {
    if (!Array.isArray(inputs)) return undefined;
    const keys = inputs.filter((key): key is string => typeof key === "string" && Boolean(key.trim())).map((key) => key.trim());
    return keys.length ? keys : undefined;
}

/**
 * What the graph says sizes its own output, as the server read it.
 *
 * Nothing is claimed when the server said nothing — an absent answer is not "the request states it", and a client
 * that fills the gap with a guess is what drew square cards around portrait pictures (#359).
 */
function outputOf(output: WorkflowOutputShape | undefined) {
    const sizedBy = typeof output?.sizedBy === "string" ? output.sizedBy.trim() : "";
    if (!sizedBy) return undefined;
    return { sizedBy, key: output?.key?.trim() || undefined, pixels: output?.pixels?.trim() || undefined };
}

/** Whether the workflow can be asked something in words. */
function hasPromptBinding(workflow: ServerWorkflow) {
    return Boolean(workflow.bindings && Object.prototype.hasOwnProperty.call(workflow.bindings, "prompt"));
}

/**
 * Whether the user's seconds reach the graph at all.
 *
 * A binding is what puts a value into a node, so a workflow whose bindings never read `seconds` cannot be
 * told how long its output should be — the length comes from somewhere else (the clip being edited) or
 * from the binding's own default. `video-h3-character-swap` is the first kind: its `videos` binding names
 * `sourceLengthInput: "length"`, so the source clip decides. The panel asks this instead of recognising the
 * workflow's id, which is what it used to do.
 */
function bindsSeconds(workflow: ServerWorkflow) {
    return Object.values(workflow.bindings || {}).some((binding) => typeof binding === "object" && binding !== null && (binding as { from?: unknown }).from === "seconds");
}

/**
 * Whether the workflow declares the `transition_step` knob.
 *
 * That knob is the one the SelfLift fast/quality toggle writes (`services/api/video.ts`), so its presence is
 * what makes the toggle real: a workflow without it would be sent a value nothing reads. The H3 workflows
 * declare it; nothing else does.
 */
function hasSelfLift(workflow: ServerWorkflow) {
    return (workflow.parameters || []).some((parameter) => parameter?.key === "transition_step");
}

/** The knobs a node panel renders, reduced to what a control needs. */
function parametersOf(workflow: ServerWorkflow) {
    const parameters = (workflow.parameters || [])
        .filter((item) => item && typeof item.key === "string" && item.key.trim())
        .map((item) => ({
            key: item.key.trim(),
            label: item.label?.trim() || undefined,
            type: item.type?.trim() || undefined,
            default: item.default,
            min: Number.isFinite(item.min) ? Number(item.min) : undefined,
            max: Number.isFinite(item.max) ? Number(item.max) : undefined,
            step: Number.isFinite(item.step) ? Number(item.step) : undefined,
            options: item.options?.map((option) => (typeof option === "string" ? option : String((option as { value?: unknown })?.value ?? ""))).filter(Boolean),
        }));
    return parameters.length ? parameters : undefined;
}

/** The models one workflow contributes, in the order the server listed them. */
export function modelsOf(workflow: ServerWorkflow): ChannelModel[] {
    const capability = workflow.type as ModelCapability;
    if (!CAPABILITIES.includes(capability)) return [];
    if (workflow.availability?.available === false) return [];
    const duration = durationOf(workflow);
    const contracts = workflow.variantContracts
        ? Object.fromEntries(Object.entries(workflow.variantContracts).map(([mode, contract]) => [mode, { accepts: acceptsOf(contract?.accepts), mode: contract?.mode, inputs: inputsOf(contract?.inputs), output: outputOf(contract?.output) }]))
        : undefined;

    return (workflow.models || []).map((model) => ({
        name: model.id,
        capability,
        label: model.label || workflow.label || model.id,
        workflowId: workflow.id,
        baseModel: model.baseModel || undefined,
        baseModelLabel: model.baseModelLabel || undefined,
        variantModes: workflow.variantModes,
        variantLabels: workflow.variantLabels,
        // A mode whose own nodes or models are missing: offered, marked, and refused by the popover
        // instead of failing inside ComfyUI after the user has committed to it.
        blockedModes: Object.keys(workflow.availability?.modeProblems || {}),
        imageInputs: model.imageInputs,
        duration,
        tool: isToolWorkflow(workflow.id),
        hasPrompt: hasPromptBinding(workflow),
        bindsSeconds: bindsSeconds(workflow),
        selfLift: hasSelfLift(workflow),
        mode: workflow.mode || undefined,
        accepts: acceptsOf(workflow.accepts),
        inputs: inputsOf(workflow.inputs),
        output: outputOf(workflow.output),
        contracts,
        parameters: parametersOf(workflow),
    }));
}

/** Every selectable model the server offers. */
export function serverModels(workflows: ServerWorkflow[]) {
    return workflows.flatMap(modelsOf);
}

/**
 * A total order over the entries, so an unchanged list does not rewrite the config store every eight
 * seconds — including the fields that are only labels, because editing a workflow's label should reach
 * the picker.
 */
export function modelSignature(models: ChannelModel[]) {
    return JSON.stringify(
        models.map((model) => [
            model.name,
            model.capability,
            model.label || "",
            model.workflowId || "",
            model.baseModel || "",
            model.baseModelLabel || "",
            model.imageInputs ?? -1,
            model.duration?.min ?? -1,
            model.duration?.max ?? -1,
            model.variantModes || [],
            model.variantLabels || {},
            model.blockedModes || [],
            model.tool ? 1 : 0,
            model.hasPrompt ? 1 : 0,
            model.bindsSeconds ? 1 : 0,
            model.selfLift ? 1 : 0,
            model.mode || "",
            model.accepts || null,
            model.inputs || null,
            model.output || null,
            model.contracts || null,
            model.parameters || null,
        ]),
    );
}

/**
 * Which workflow a fresh canvas starts on, per media kind.
 *
 * Not a model list — the server still decides what exists. This is the same kind of choice as
 * `tool-workflows.ts`: the canvas is the only client, so which of several available workflows is the
 * sensible starting point is ours. The server's order is alphabetical, which puts
 * `video-h3-character-swap` first — a workflow that needs a source clip and a reference image, a poor
 * answer to "make me a video". A preferred id the server does not offer is ignored, so removing or
 * renaming a workflow cannot leave the canvas pointing at nothing.
 */
const PREFERRED_WORKFLOW: Partial<Record<ModelCapability, string>> = {
    image: "image-z-image-turbo",
    video: "video-h3-t2v",
    audio: "audio-minimax-music-3",
};

/** The option to keep: the current one, else the preferred workflow, else whatever comes first. */
export function pickModelOption(capability: ModelCapability, current: string, options: string[]) {
    if (current && options.includes(current)) return current;
    const preferred = PREFERRED_WORKFLOW[capability];
    const match = preferred ? options.find((option) => option === preferred || option.endsWith(`::${preferred}`)) : undefined;
    return match || options[0] || "";
}
