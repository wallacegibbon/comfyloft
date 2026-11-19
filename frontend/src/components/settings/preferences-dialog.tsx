import { useTranslation } from "react-i18next";

import { Switch } from "@/components/kit/choice";
import { Dialog } from "@/components/kit/dialog";
import { Field } from "@/components/kit/field";
import { Input } from "@/components/kit/input";
import { Select } from "@/components/kit/select";
import { WorkflowModelPicker } from "@/components/model-picker";
import { imageAspectOptions } from "@/components/image-settings-panel";
import { videoResolutionOptions } from "@/components/video-settings-panel";
import { AgentModelsSection } from "@/components/settings/agent-models-section";
import { SpeechProfilesSection } from "@/components/settings/speech-profiles-section";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions, parseVideoResolution, sizeForTier } from "@/lib/media-size";
import { useConfigStore, type ModelCapability } from "@/stores/use-config-store";

/**
 * The media kinds with a default model to pick.
 *
 * Only these two: text runs on the agent and has no model of its own (`hydrateConfig` clears `textModel`),
 * and the audio model is chosen per node in the prompt panel, so a default here would be a setting nothing
 * reads.
 */
const modelGroups: Array<{ capability: ModelCapability; modelKey: "imageModel" | "videoModel"; labelKey: string }> = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
];

/**
 * The preferences window: the default models and the generation defaults.
 *
 * There is nothing to apply. Every control writes into `use-config-store`, which mirrors the document to
 * the server as it changes (#155, #166), so closing the window loses nothing and a "Done" button would
 * only be claiming to do what already happened.
 *
 * The server itself is not here. The channel is the server that served the page — its address comes from
 * the page and its models from `GET /api/workflows` (#71) — so the "Server" tab that let you rename it and
 * re-tag a model's media kind was a form over values nothing else could change.
 */
export function PreferencesDialog() {
    const { t } = useTranslation();
    const open = useConfigStore((state) => state.preferencesOpen);
    const setOpen = useConfigStore((state) => state.setPreferencesOpen);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    // "auto" is not a resolution, it is the absence of one: it is offered as its own choice and writes no size, so
    // the graph's own answer is what a first run draws and what its card shows (#359).
    const imageResolutionOptions = [{ value: "auto", label: t("settingsPanels.common.auto") }, ...mediaScaleOptions.map((value) => ({ value, label: value.toUpperCase() }))];

    return (
        <Dialog
            open={open}
            onClose={() => setOpen(false)}
            size="panel"
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.preferences.title")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.preferences.description")}</div>
                </div>
            }
            bodyStyle={{ maxHeight: "72vh" }}
            bodyClassName="pr-3"
        >
            <div className="border-b border-stone-200 pb-3 text-xs text-stone-500 dark:border-stone-800">{t("config.settingsNote")}</div>
            <div className="mb-2 mt-4 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
            <div className="mb-4 grid gap-4 md:grid-cols-2">
                {modelGroups.map((group) => (
                    <Field key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                        {/* A default has to run from a prompt, so a tool (an interpolation, an upscaler) is
                            never one of the choices here — it is only ever picked on a node. */}
                        <WorkflowModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} excludeTools fullWidth />
                    </Field>
                ))}
            </div>
            <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>
            <div className="grid gap-4 md:grid-cols-4">
                <Field label={t("config.preferences.imageResolution")} className="mb-4">
                    <Select value={inferMediaScale(config.size)} options={imageResolutionOptions} onChange={(scale) => updateConfig("size", scale === "auto" ? "auto" : sizeForTier(scale, config.size))} />
                </Field>
                <Field label={t("config.preferences.imageAspectRatio")} className="mb-4">
                    <Select value={inferMediaRatio(config.size)} options={imageAspectOptions} onChange={(ratio) => updateConfig("size", computeMediaSize(inferMediaScale(config.size), ratio))} />
                </Field>
                <Field label={t("config.preferences.videoResolution")} className="mb-4">
                    <Select value={parseVideoResolution(config.vquality)} options={videoResolutionOptions} onChange={(value) => updateConfig("vquality", value)} />
                </Field>
            </div>
            <Field className="mb-4">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">{t("config.preferences.autoFocusOnSelect")}</span>
                    <Switch checked={config.autoFocusOnSelect} onChange={(checked) => updateConfig("autoFocusOnSelect", checked)} />
                </div>
            </Field>
            <AgentModelsSection />
            {/* The other way words get into the agent's prompt: speech. The list is the server's, because a
                profile's key is part of it and `/config.js` is this window's document served to every browser —
                so this is a list and a dialog, not two fields. */}
            <SpeechProfilesSection />
            <Field label={t("config.preferences.systemPrompt")} className="mb-0">
                <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
            </Field>
        </Dialog>
    );
}
