import { beforeEach, describe, expect, it, vi } from "vitest";

// Two things the module reads that a test should not carry: the preference store (stubbed to one object) and the
// interface language, which the fallback is defined against.
const settings: Record<string, unknown> = {};
let interfaceLanguage = "en-US";

vi.mock("@/stores/use-settings-store", () => ({
    readSetting: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
    writeSetting: (key: string, value: unknown) => {
        settings[key] = value;
    },
}));

vi.mock("@/i18n", () => ({
    default: {
        get resolvedLanguage() {
            return interfaceLanguage;
        },
        get language() {
            return interfaceLanguage;
        },
    },
}));

const { readDictationLanguage, writeDictationLanguage } = await import("../src/lib/dictation-language");

/**
 * Which language a recording is labelled with.
 *
 * The rule worth pinning is the one that caused the bug: a workspace whose interface is English and whose user
 * speaks Chinese must not be answered with `en` forever, and it must not be answered with a third value either —
 * omitting the field is a fourth choice, and the wrong one on the servers this project is measured against (#352).
 */
describe("the language dictation sends", () => {
    beforeEach(() => {
        for (const key of Object.keys(settings)) delete settings[key];
        interfaceLanguage = "en-US";
    });

    // Never chosen: what shipped before this was a control, so nothing changes for a workspace that never opens it.
    it("follows the interface it is being read in", () => {
        expect(readDictationLanguage()).toBe("en");

        interfaceLanguage = "zh-CN";
        expect(readDictationLanguage()).toBe("zh");
    });

    // The whole point: the mouth is not the chrome. Chosen once, it holds against either interface.
    it("keeps what was chosen over the interface", () => {
        writeDictationLanguage("zh");
        expect(readDictationLanguage()).toBe("zh");

        interfaceLanguage = "zh-CN";
        writeDictationLanguage("en");
        expect(readDictationLanguage()).toBe("en");
    });

    // A preferences file is somebody's to edit, and a value this build makes no control for is not a choice it
    // should honour: a `ja` in the document would label every recording with a language nobody selected.
    it("ignores a value that is not one of the two", () => {
        for (const stored of ["ja", "", "ZH", "auto", null, 0, {}]) {
            settings.dictationLanguage = stored;
            expect(readDictationLanguage()).toBe("en");
        }
    });

    // One key, read back by the caller that puts it on the request.
    it("writes one key", () => {
        writeDictationLanguage("zh");
        expect(Object.keys(settings)).toEqual(["dictationLanguage"]);
    });
});
