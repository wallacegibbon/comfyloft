import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { Switch } from "@/components/kit/choice";
import i18n from "@/i18n";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { imageModeFor } from "@/lib/canvas/image-mode";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, readMediaDimensions, sizeForTier } from "@/lib/media-size";
import { acceptsInput, type AiConfig } from "@/stores/use-config-store";

const DIMENSION_STEP = 16;

/** Read by the preferences window's aspect-ratio select. */
export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, label: item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value }));

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "background" | "seedFixed" | "seed", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    showSize?: boolean;
    showTransparent?: boolean;
    showSeed?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, showSize = true, showTransparent = true, showSeed = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: ImageSettingsPanelProps) {
    const { t } = useTranslation();
    const [snapDimensionToStep, setSnapDimensionToStep] = useState(true);
    // A row exists where the run reads what it writes. `size`, `background` and `seed` are the request's own
    // keys, and the contract lists them per workflow and per mode: on a Qwen edit the size row changes nothing
    // (the picture follows its reference), and no workflow but Qwen's declares a background prompt, so the
    // transparent switch was a lie on every Z-Image and MOSS node. This is the send-side rule (#302) asked
    // before the user types instead of after, so a control cannot move a value the run drops (#304).
    const mode = imageModeFor(config, config.model);
    const showSizeRow = showSize && acceptsInput(config, config.model, "size", mode) !== false;
    const showBackgroundRow = showTransparent && acceptsInput(config, config.model, "background", mode) !== false;
    const showSeedRow = showSeed && acceptsInput(config, config.model, "seed", mode) !== false;
    // Nothing to offer is not a panel with a title in it: an upscaler declares none of the three, and a heading
    // over an empty box is the same lie the hidden rows were.
    if (!showSizeRow && !showBackgroundRow && !showSeedRow) return null;
    const activeSize = config.size || "auto";
    const transparentBackground = config.background === "transparent";
    const selectedScale = inferMediaScale(activeSize);
    const selectedRatio = inferMediaRatio(activeSize);
    const dimensions = readMediaDimensions(activeSize, selectedScale, selectedRatio);
    const applySize = (scale: string, ratio: string) => onConfigChange("size", computeMediaSize(scale, ratio));
    const selectScale = (scale: string) => onConfigChange("size", sizeForTier(scale, activeSize));
    const selectRatio = (ratio: string) => applySize(selectedScale, ratio);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep)}x${alignDimension(height, snapDimensionToStep)}`);
    };

    return (
        <>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.image.title")}</div> : null}
                {showSizeRow ? (
                    <>
                        <div className="space-y-2.5">
                            <div className="flex items-center justify-between gap-3">
                                <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.size")}</SettingTitle>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                        {t("settingsPanels.image.align16")}
                                    </span>
                                    <span title={t("settingsPanels.image.align16Hint")} onMouseDown={(event) => event.stopPropagation()}>
                                        <Switch size="small" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                                    </span>
                                </div>
                            </div>
                            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                                <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("width", value)} />
                                <span className="text-lg opacity-45">↔</span>
                                <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("height", value)} />
                            </div>
                        </div>
                        <div className="space-y-2.5">
                            <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.resolution")}</SettingTitle>
                            <div className="grid grid-cols-3 gap-2.5">
                                {/* A tier is how big a picture is; the way to say "the model decides" is the `auto`
                                    aspect below, which states no size at all. An `auto` tier was how a bare ratio
                                    used to be written, and two readers read it differently (#359). */}
                                {mediaScaleOptions.map((value) => (
                                    <OptionPill key={value} selected={selectedScale === value} theme={theme} onClick={() => selectScale(value)}>
                                        {value}
                                    </OptionPill>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-2.5">
                            <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.aspectRatio")}</SettingTitle>
                            <div className="grid grid-cols-4 gap-2.5">
                                {mediaRatioOptions.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                        style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onClick={() => selectRatio(item.value)}
                                    >
                                        <AspectIcon width={item.width} height={item.height} color={theme.node.text} />
                                        <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </>
                ) : null}
                {showBackgroundRow ? (
                    <div className="flex items-center justify-between gap-3">
                        <div className="space-y-0.5">
                            <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.transparent")}</SettingTitle>
                            <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                                {t("settingsPanels.image.transparentHint")}
                            </div>
                        </div>
                        <span onMouseDown={(event) => event.stopPropagation()}>
                            <Switch size="small" checked={transparentBackground} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
                        </span>
                    </div>
                ) : null}
                {showSeedRow ? <SeedSetting fixed={config.seedFixed === "true"} seed={config.seed || ""} theme={theme} onChange={onConfigChange} /> : null}
            </div>
        </>
    );
}

export function SeedSetting({ fixed, seed, theme, onChange }: { fixed: boolean; seed: string; theme: CanvasTheme; onChange: (key: "seedFixed" | "seed", value: string) => void }) {
    const { t } = useTranslation();
    const toggle = (checked: boolean) => {
        onChange("seedFixed", checked ? "true" : "false");
        if (checked && !seed.trim()) onChange("seed", String(randomSeed()));
    };
    return (
        <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.common.fixedSeed")}</SettingTitle>
                    <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                        {t("settingsPanels.common.fixedSeedHint")}
                    </div>
                </div>
                <span onMouseDown={(event) => event.stopPropagation()}>
                    <Switch size="small" checked={fixed} onChange={toggle} />
                </span>
            </div>
            {fixed ? (
                <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
                    <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                        #
                    </span>
                    <input
                        type="number"
                        min={1}
                        max={2147483647}
                        step={1}
                        className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        value={seed}
                        placeholder={t("settingsPanels.common.seedPlaceholder")}
                        onChange={(event) => onChange("seed", event.currentTarget.value.replace(/[^\d]/g, "").slice(0, 10))}
                        onBlur={() => {
                            if (!seed.trim()) onChange("seed", String(randomSeed()));
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </label>
            ) : null}
        </div>
    );
}

function randomSeed() {
    return Math.floor(Math.random() * 2147483646) + 1;
}

export function imageSizeLabel(size: string) {
    const scale = inferMediaScale(size);
    const ratio = inferMediaRatio(size);
    if (ratio === "auto" || size === "auto") return i18n.t("settingsPanels.common.auto");
    if (scale === "auto") return ratio;
    return `${scale} · ${ratio}`;
}

export function OptionPill({ selected, theme, onClick, disabled, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; disabled?: boolean; children: ReactNode }) {
    return (
        <button
            type="button"
            disabled={disabled}
            className={`h-9 rounded-full border px-2 text-sm transition ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:opacity-80"}`}
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function DimensionInput({ prefix, value, disabled, theme, alignToStep, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; alignToStep: boolean; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = alignDimension(Math.max(1, Math.floor(Number(input.value) || value || 1024)), alignToStep);
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value || ""}
                key={`${prefix}-${value}`}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function AspectIcon({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const ratio = width / height;
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

export function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function alignDimension(value: number, enabled: boolean) {
    return enabled ? Math.ceil(value / DIMENSION_STEP) * DIMENSION_STEP : value;
}
