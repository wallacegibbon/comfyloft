import type { AiConfig } from "@/stores/use-config-store";
import { httpJson } from "@/services/api/http";
import { serverProtocolRoot } from "@/services/api/runs";

/**
 * The server's workflow list (GET /api/workflows).
 *
 * A workflow is what the server runs, and a run names one. This is the only description of them the
 * canvas needs: `type` says which kind of media comes out, `parameters` carries the loader's option
 * lists, `availability` says whether ComfyUI can run it right now, and `models` lists the ids it
 * answers to. Which of them appear in a model dropdown, and which are driven from a button, is our
 * decision, made in the client.
 */
type WorkflowParameter = {
    key: string;
    label?: string;
    type?: string;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<string | { value: string; label: string }>;
    description?: string;
};

/** How much of one media kind a workflow takes. A declared kind is authoritative: `max: 0` means none. */
type WorkflowMediaLimit = { min?: number; max?: number };

/**
 * A workflow's media contract.
 *
 * It is the same declaration a run is validated against (`internal/workflow/media.go`), so the panel can
 * show what a workflow needs and the server's refusal — if one ever comes — cannot disagree with it.
 * `note` is deliberately not here: the registry is written in English and the UI's copy comes from
 * `i18n`, keyed by workflow id (docs/decisions.md #66).
 */
export type WorkflowAccepts = {
    images?: WorkflowMediaLimit;
    videos?: WorkflowMediaLimit;
    audios?: WorkflowMediaLimit;
    minTotal?: number;
};

/**
 * One mode's contract: what it accepts and the mode it runs in. A mode is a different graph, so it may
 * take a different media mix (inpaint wants a source and a mask; t2i wants none).
 */
type WorkflowContract = {
    accepts?: WorkflowAccepts;
    mode?: string;
    /** The keys a run of this mode may carry. A variant is a different graph, so they differ. */
    inputs?: string[];
};

type WorkflowAvailability = {
    available?: boolean;
    problems?: Array<{ message?: string }>;
    /** Gaps of a mode the workflow offers but does not open with — reported, not blocking. */
    modeProblems?: Record<string, Array<{ message?: string }>>;
};

/**
 * One id a workflow answers to.
 *
 * The same graph can be run with different base models, and each combination has its own spelling
 * (`img-zit-int8`). That spelling is built and resolved by the server, so it arrives from there; the
 * canvas only decides that each one is worth an entry in the model picker.
 */
type ServerWorkflowModel = {
    id: string;
    label?: string;
    baseModel?: string | null;
    baseModelLabel?: string | null;
    imageInputs?: number;
};

export type ServerWorkflow = {
    id: string;
    name: string;
    type: string;
    label?: string;
    description?: string;
    category?: string | null;
    parameters?: WorkflowParameter[];
    /**
     * The server's verdict, or `null` when no scan has judged this workflow yet.
     *
     * Null is not "cannot run": the server only has no verdict when it could not ask ComfyUI, and
     * then nothing runs anyway. Offering the model is the honest answer, and a run reports what
     * actually happened (decisions #351).
     */
    availability?: WorkflowAvailability | null;
    /** The variant modes an image workflow offers (`t2i`, `edit`, `inpaint`, `outpaint`). */
    variantModes?: string[];
    variantLabels?: Record<string, string>;
    models?: ServerWorkflowModel[];
    /**
     * What each binding writes into the graph, keyed by binding name (`prompt`, `video`, `multiplier`).
     * The key's presence is how the canvas knows a workflow can be told something in words — an
     * interpolation has nothing to be asked, so it has no `prompt` binding and its node shows no box.
     */
    bindings?: Record<string, unknown>;
    /** What the workflow accepts, and the mode it runs in. See `WorkflowAccepts`. */
    accepts?: WorkflowAccepts;
    mode?: string;
    /**
     * The keys a run may carry — every key `POST /api/runs` will not refuse. A stored knob belongs to the
     * model that declared it, so the canvas drops the ones the chosen model does not take instead of sending
     * them and being answered with `unknown_input`.
     */
    inputs?: string[];
    /** Per-mode contracts, present only for a workflow with variants. */
    variantContracts?: Record<string, WorkflowContract>;
};

type WorkflowsPayload = { workflows?: ServerWorkflow[] };

/** Read every registered workflow. */
export async function requestWorkflows(config: Pick<AiConfig, "baseUrl">, options: { signal?: AbortSignal } = {}): Promise<ServerWorkflow[]> {
    const payload = await httpJson<WorkflowsPayload>(`${serverProtocolRoot(config.baseUrl)}/api/workflows`, {
        signal: options.signal,
        timeout: 8000,
    });
    return Array.isArray(payload?.workflows) ? payload.workflows.filter((workflow) => Boolean(workflow?.id)) : [];
}
