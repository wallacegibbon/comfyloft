import type { AgentModel } from "@/services/api/agent";
import { httpJson } from "@/services/api/http";
import { serverProtocolRoot } from "@/services/api/runs";

/**
 * The agent's models, as the file they live in.
 *
 * `model.conf` is AlayaCore's list of providers, and this server is what writes it: the preferences window reads
 * it and sends the whole list back with one model added, changed or removed. The agent is asked nothing to do
 * that, because AlayaCore's wire has had no command for it since version 19 (`:model_sync` is gone; `model_load`
 * only re-reads the file) — and it must not be asked, or a `model.conf` that stops AlayaCore from starting
 * could not be repaired from here.
 *
 * **What a page never holds: the key.** `hasKey` says one is stored. The file has it, the server writes it back,
 * so an entry that says nothing about a key keeps the stored one and a typed key replaces it.
 *
 * **The request body is the file.** Entries use `model.conf`'s own field names (`protocol_type`, `base_url`,
 * …), because that is what they become: the same names the agent announces in `model_list`.
 */

/** `{baseUrl}` is all these need, which is why they take that and not the whole config. */
type Server = { baseUrl: string };

const modelsUrl = (server: Server) => `${serverProtocolRoot(server.baseUrl)}/api/agent/models`;

/**
 * One model as the editor sends it back.
 *
 * `id` names the entry this one replaces, by position: the file has no ids, AlayaCore assigns positions on load,
 * and that is what `model_set` takes. No `id` is a new model. A reasoning block or `input_modalities` is
 * replaced only when it is here, and `null` is an answer — it removes what is stored, which is how a cleared box
 * or a switch turned off is said.
 */
export type AgentModelEdit = {
    id?: number;
    name: string;
    protocol_type: string;
    base_url: string;
    model_name: string;
    context_limit?: number;
    max_tokens?: number;
    reasoning_0?: unknown;
    reasoning_1?: unknown;
    reasoning_2?: unknown;
    reasoning_field?: string;
    serial_tool_calls?: boolean;
    input_modalities?: string[] | null;
    /** Only when this page has one to give: a model being created, or one whose key was just retyped. */
    api_key?: string;
};

/** The list, and what the file says that this build could not read. */
type AgentModelsState = {
    models: AgentModel[];
    /** Sentences from the server, about lines it kept as written: a model is still shown and still editable. */
    problems: string[];
};

/** The list on the server, which is `model.conf`. */
export async function loadAgentModels(server: Server, options: { signal?: AbortSignal } = {}): Promise<AgentModelsState> {
    return stateOf(await httpJson<AgentModelsState>(modelsUrl(server), { signal: options.signal, timeout: 8000 }));
}

/**
 * Write this list, and answer with the list as the server now has it.
 *
 * The whole list goes, in the page's order, because the list is the file: a model that is missing is a model
 * that was deleted. The answer is what to show next — the entries as they were written, with the ids the
 * positions now have.
 */
export async function saveAgentModels(server: Server, models: AgentModelEdit[], options: { signal?: AbortSignal } = {}): Promise<AgentModelsState> {
    return stateOf(
        await httpJson<AgentModelsState>(modelsUrl(server), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ models }),
            signal: options.signal,
            timeout: 8000,
        }),
    );
}

/** The answer with its two lists always present, so a caller never has to ask whether one is there. */
function stateOf(answer: AgentModelsState): AgentModelsState {
    return { models: answer.models ?? [], problems: answer.problems ?? [] };
}
