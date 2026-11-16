import i18n from "@/i18n";
import { readSetting, writeSetting } from "@/stores/use-settings-store";

/**
 * Which language dictation tells the speech server to expect.
 *
 * The hint is **not** advisory. Measured on this workspace's own server (audio.cpp, both models it serves) with a
 * one-second tone, whose answer is pure decoding bias: SenseVoice-Small answers `Yeah.` with no `language` field
 * at all, `Yeah.` under `en`, and `我。` under `zh`; Qwen3-ASR answers nothing with no field, `.` under `en`, and
 * `嗯。` under `zh`. Two things follow, and the second one contradicts what #239 assumed: a server here treats the
 * field as a constraint, and **omitting it is not auto-detection — on this server it is English**. The user's
 * report matches: with `en` a Chinese sentence is nonsense, with `zh` a Chinese sentence *and* the English words
 * inside it both come out right.
 *
 * **So it is a preference, and only two values.** Not a constant: #246 already ruled that a name baked into the
 * build fits one machine and expires, and this fits one speaker. Not a field on a profile either, for #252's
 * reason — the language is a fact about the mouth, not about the server at the address, and the same person dictates
 * into whichever profile is active. `zh` and `en` are the two words anyone here speaks; a third option (auto, or a
 * language nobody uses) is a field that can only be set wrong (#246).
 *
 * **A workspace that has never chosen** follows the language the interface is written in — which is what shipped
 * before this was a control, so nothing changes for anyone who never opens the window. It is a guess about the
 * chrome, and it is a bad one for an English interface over a Chinese sentence: that is exactly the case this
 * control exists for, and it is why the guess is the fallback and no longer the rule.
 */
export type DictationLanguage = "zh" | "en";

/** The setting's key in the preferences document, which the server holds and never reads. */
const SETTING_KEY = "dictationLanguage";

/** The two values, in the order the window lists them. Anything else is not a choice this build makes. */
const CHOICES: string[] = ["en", "zh"];

/** A stored value is trusted only if it is one of the two: anything else is an older or hand-edited file. */
function isDictationLanguage(value: unknown): value is DictationLanguage {
    return CHOICES.includes(String(value));
}

/** What a workspace that has never chosen sends: the language it is being read in. */
function guessFromInterface(): DictationLanguage {
    const language = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase();
    return language.startsWith("zh") ? "zh" : "en";
}

/**
 * The language to put on the next recording.
 *
 * Read at the moment of the request rather than captured at mount, so choosing a different one in the preferences
 * window takes effect on the next press without a reload.
 */
export function readDictationLanguage(): DictationLanguage {
    const stored = readSetting<unknown>(SETTING_KEY, undefined);
    return isDictationLanguage(stored) ? stored : guessFromInterface();
}

/** One choice, written. There is no third state: the control always shows what the next press will send. */
export function writeDictationLanguage(language: DictationLanguage) {
    writeSetting(SETTING_KEY, language);
}
