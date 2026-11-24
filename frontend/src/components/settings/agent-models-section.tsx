import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/kit/button";
import { Tooltip } from "@/components/kit/tooltip";
import { AgentModelDialog } from "@/components/settings/agent-model-dialog";
import { emptyModelDraft, modelDraftOf, modelSyncPayload, type ModelChange, type ModelDraft } from "@/lib/agent-models";
import type { AgentModel } from "@/services/api/agent";
import { loadAgentModels, saveAgentModels } from "@/services/api/agent-models";
import { apiErrorMessage } from "@/services/api/http";
import { useConfigStore } from "@/stores/use-config-store";

/**
 * The agent's models: the list AlayaCore reads, and the three things a page may do to it.
 *
 * The list is `model.conf`, and the server writes it (`GET`/`PUT /api/agent/models`): the agent is not asked
 * anything, because it cannot be — AlayaCore's wire has had no command that takes a model list since version 19,
 * and an editor that needed an agent could not repair a `model.conf` that stops the agent from starting. So
 * there is nothing to save up and no Apply button: every change is the whole list sent back, the file is
 * written, and the answer is the list as it now stands.
 *
 * A running agent reads the file when it starts, so the server tells every live one to read it again
 * (`model_load`) — that is the one thing about this window an agent hears.
 *
 * The two edits are dialogs (`agent-model-dialog`) rather than a row of inputs under the list: a model is a
 * small document — a name, an id, an address, a protocol, a key, two token caps, three reasoning blocks, two
 * switches and the input types it declares (#249, #256) — and a dozen fields on one line is a form nobody can
 * read.
 */
export function AgentModelsSection() {
    const { t } = useTranslation();
    const baseUrl = useConfigStore((state) => state.config.baseUrl);
    const [models, setModels] = useState<AgentModel[]>([]);
    // What the file says that this build could not read: a line that is not a field, a value it could not parse.
    // The model is still shown and still editable, and the line is still in the file.
    const [problems, setProblems] = useState<string[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [editor, setEditor] = useState<{ draft: ModelDraft; id?: number } | null>(null);

    // The window is the list's lifetime: read once when it opens, and again when the address of the server it is
    // read from changes. Nothing is kept, because the file is the truth.
    useEffect(() => {
        let live = true;
        setError("");
        void loadAgentModels({ baseUrl })
            .then((answer) => {
                if (!live) return;
                setModels(answer.models);
                setProblems(answer.problems);
                setLoaded(true);
            })
            .catch((cause: unknown) => {
                if (!live) return;
                setError(apiErrorMessage(cause, t("config.preferences.agentModelsUnavailable")));
                setLoaded(true);
            });
        return () => {
            live = false;
        };
    }, [baseUrl, t]);

    // One request at a time: the answer is the list, so two in flight would leave the later one showing a list
    // the earlier one has already replaced.
    const sync = useCallback(
        async (change?: ModelChange) => {
            setBusy(true);
            setError("");
            try {
                const answer = await saveAgentModels({ baseUrl }, modelSyncPayload(models, change));
                setModels(answer.models);
                setProblems(answer.problems);
            } catch (cause: unknown) {
                // The server's own sentence: the entry it would not write, and why — the agent would skip it on
                // the next start, so a save that only looked saved is the one failure worth saying out loud.
                setError(apiErrorMessage(cause, t("config.preferences.agentModelsUnavailable")));
            } finally {
                setBusy(false);
            }
        },
        [baseUrl, models, t],
    );

    const save = (draft: ModelDraft) => {
        void sync(editor?.id === undefined ? { kind: "add", draft } : { kind: "edit", id: editor.id, draft });
        setEditor(null);
    };

    const protocolLabel = (protocol: string | undefined) => (protocol === "anthropic" ? t("config.preferences.protocolAnthropic") : t("config.preferences.protocolOpenAI"));

    return (
        <div className="mb-4 border-t border-stone-200 pt-4 dark:border-stone-800">
            <div className="mb-1 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">{t("config.preferences.agentModels")}</div>
                <Button size="small" disabled={busy || !loaded} icon={<Plus className="size-3.5" />} onClick={() => setEditor({ draft: emptyModelDraft })}>
                    {t("config.preferences.addModel")}
                </Button>
            </div>
            <div className="mb-2 text-xs text-stone-500">{t("config.preferences.agentModelsNote")}</div>

            {!loaded ? (
                <div className="mb-2 text-xs text-stone-500">{t("config.preferences.agentModelsLoading")}</div>
            ) : models.length === 0 ? (
                <div className="mb-2 text-xs text-stone-500">{t("config.preferences.noAgentModels")}</div>
            ) : (
                <div className="mb-2 divide-y divide-stone-200 rounded-md border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                    {models.map((model) => (
                        <div key={model.id} className="flex items-center gap-3 px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">{model.name || model.modelName}</div>
                                <div className="truncate text-xs text-stone-500">
                                    {protocolLabel(model.protocolType)} · {model.baseUrl}
                                    {model.modelName ? ` · ${model.modelName}` : ""}
                                </div>
                            </div>
                            {/* A key is shown as one: six dots, whether it is six characters or sixty. */}
                            <Tooltip title={model.hasKey ? t("config.preferences.apiKeyStored") : t("config.preferences.apiKeyMissing")}>
                                <span className="shrink-0 font-mono text-xs text-stone-400 select-none">{model.hasKey ? "••••••" : "—"}</span>
                            </Tooltip>
                            <Tooltip title={t("config.preferences.editModel")}>
                                <Button size="small" type="text" disabled={busy} aria-label={t("config.preferences.editModel")} onClick={() => setEditor({ draft: modelDraftOf(model), id: model.id })} icon={<Pencil className="size-3.5" />} />
                            </Tooltip>
                            <Tooltip title={t("config.preferences.deleteModel")}>
                                <Button size="small" type="text" danger disabled={busy} aria-label={t("config.preferences.deleteModel")} onClick={() => void sync({ kind: "delete", id: model.id })} icon={<Trash2 className="size-3.5" />} />
                            </Tooltip>
                        </div>
                    ))}
                </div>
            )}

            {problems.length > 0 ? <div className="mb-2 text-xs leading-5 text-amber-600 dark:text-amber-400">{problems.join(" / ")}</div> : null}
            {error ? <div className="mb-2 text-xs leading-5 text-red-500 dark:text-red-400">{error}</div> : null}

            {editor ? <AgentModelDialog draft={editor.draft} editing={editor.id !== undefined} onCancel={() => setEditor(null)} onSave={save} /> : null}
        </div>
    );
}
