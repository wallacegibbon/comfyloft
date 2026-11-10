import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Circle, CircleCheck, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/kit/button";
import { Tooltip } from "@/components/kit/tooltip";
import { SpeechProfileDialog } from "@/components/settings/speech-profile-dialog";
import { emptySpeechDraft, speechDraftOf, speechProfilesPayload, type SpeechChange, type SpeechDraft } from "@/lib/speech-profiles";
import { loadSpeechProfiles, saveSpeechProfiles, type SpeechProfilesState } from "@/services/api/speech";
import { useConfigStore } from "@/stores/use-config-store";

/**
 * The speech servers dictation can be sent to, and the four things a page may do to that list.
 *
 * The list is the server's (`~/.config/comfyloft/speech.json`): it holds each profile's key, which a page must never see, so
 * nothing about it is a preference of this window. What the page has is what `GET /api/speech/profiles`
 * answered — a name, an address, a model name and whether a key is stored — and every change is the whole list
 * sent back with one entry added, changed, removed or made active.
 *
 * Exactly one profile is active while one exists, and the radio says which: dictation is one microphone button,
 * and a list of servers where none is current is a button that fails without saying why.
 *
 * The two edits are dialogs (`speech-profile-dialog`) rather than inputs under the list, for the reason the
 * agent's models are: a server is a small document, and the list behind the dialog stays a list.
 */
export function SpeechProfilesSection() {
    const { t } = useTranslation();
    const baseUrl = useConfigStore((state) => state.config.baseUrl);
    const [state, setState] = useState<SpeechProfilesState | null>(null);
    const [editor, setEditor] = useState<{ draft: SpeechDraft; id?: number; hasKey: boolean } | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    // The window is the list's lifetime: read once when it opens (and when the address of the server it is read
    // from changes), and nothing is kept, because the file is the truth.
    useEffect(() => {
        let live = true;
        setError("");
        void loadSpeechProfiles({ baseUrl })
            .then((answer) => {
                if (live) setState(answer);
            })
            .catch((failure: unknown) => {
                if (live) setError(failure instanceof Error ? failure.message : String(failure));
            });
        return () => {
            live = false;
        };
    }, [baseUrl]);

    // One request at a time: the answer is the list, so two in flight would leave the later one showing a list
    // the earlier one has already replaced.
    const apply = useCallback(
        async (change: SpeechChange) => {
            if (!state) return;
            setBusy(true);
            setError("");
            try {
                setState(await saveSpeechProfiles({ baseUrl }, speechProfilesPayload(state, change)));
            } catch (failure) {
                setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
                setBusy(false);
            }
        },
        [baseUrl, state],
    );

    const save = (draft: SpeechDraft) => {
        void apply(editor?.id === undefined ? { kind: "add", draft } : { kind: "edit", id: editor.id, draft });
        setEditor(null);
    };

    const profiles = state?.profiles ?? [];
    const active = state?.active ?? 0;

    return (
        <div className="mb-4 border-t border-stone-200 pt-4 dark:border-stone-800">
            <div className="mb-1 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">{t("config.preferences.speech")}</div>
                <Button size="small" disabled={!state || busy} icon={<Plus className="size-3.5" />} onClick={() => setEditor({ draft: emptySpeechDraft, hasKey: false })}>
                    {t("config.preferences.speechAdd")}
                </Button>
            </div>
            <div className="mb-2 text-xs text-stone-500">{t("config.preferences.speechNote")}</div>

            {state === null ? (
                <div className="mb-2 text-xs text-stone-500">{t("config.preferences.speechLoading")}</div>
            ) : profiles.length === 0 ? (
                <div className="mb-2 text-xs text-stone-500">{t("config.preferences.speechEmpty")}</div>
            ) : (
                <div className="mb-2 divide-y divide-stone-200 rounded-md border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                    {profiles.map((profile) => (
                        <div key={profile.id} className="flex items-center gap-3 px-3 py-2">
                            {/* The radio: which server the microphone sends to. Clicking the current one is
                                harmless — the answer is the same list — so it is not disabled, and its tooltip
                                can say which of the two things it means. */}
                            <Tooltip title={profile.id === active ? t("config.preferences.speechActive") : t("config.preferences.speechActivate")}>
                                <Button
                                    size="small"
                                    type="text"
                                    disabled={busy}
                                    aria-label={t("config.preferences.speechActivate")}
                                    aria-pressed={profile.id === active}
                                    onClick={() => void apply({ kind: "activate", id: profile.id })}
                                    icon={profile.id === active ? <CircleCheck className="size-4" /> : <Circle className="size-4 text-stone-400" />}
                                />
                            </Tooltip>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">{profile.name || profile.url}</div>
                                <div className="truncate text-xs text-stone-500">
                                    {profile.url}
                                    {profile.model ? ` · ${profile.model}` : ""}
                                </div>
                            </div>
                            {/* A key is shown as one: six dots, whether it is six characters or sixty. */}
                            <Tooltip title={profile.hasKey ? t("config.preferences.apiKeyStored") : t("config.preferences.apiKeyMissing")}>
                                <span className="shrink-0 font-mono text-xs text-stone-400 select-none">{profile.hasKey ? "••••••" : "—"}</span>
                            </Tooltip>
                            <Tooltip title={t("config.preferences.speechEdit")}>
                                <Button
                                    size="small"
                                    type="text"
                                    disabled={busy}
                                    aria-label={t("config.preferences.speechEdit")}
                                    onClick={() => setEditor({ draft: speechDraftOf(profile), id: profile.id, hasKey: profile.hasKey })}
                                    icon={<Pencil className="size-3.5" />}
                                />
                            </Tooltip>
                            <Tooltip title={t("config.preferences.speechDelete")}>
                                <Button size="small" type="text" danger disabled={busy} aria-label={t("config.preferences.speechDelete")} onClick={() => void apply({ kind: "delete", id: profile.id })} icon={<Trash2 className="size-3.5" />} />
                            </Tooltip>
                        </div>
                    ))}
                </div>
            )}

            {error ? <div className="mb-2 text-xs leading-5 text-red-500 dark:text-red-400">{error}</div> : null}

            {editor ? <SpeechProfileDialog draft={editor.draft} editing={editor.id !== undefined} hasKey={editor.hasKey} onCancel={() => setEditor(null)} onSave={save} /> : null}
        </div>
    );
}
