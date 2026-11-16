import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Field } from "@/components/kit/field";
import { Select } from "@/components/kit/select";
import { readDictationLanguage, writeDictationLanguage, type DictationLanguage } from "@/lib/dictation-language";

/**
 * Which language the microphone's recording is labelled with.
 *
 * One `Select`, two choices, and it writes the preference the moment it changes — the same no-Apply shape as
 * every other control in this window (#155). What it shows is always what the next press will send: there is no
 * "未设置" third entry, because a field left out is not "let the model decide" (measured: on this workspace's
 * server it answers exactly like `en`, `lib/dictation-language.ts`).
 *
 * It sits beside the list of speech servers and belongs to neither of them. The list is the server's file because
 * a profile carries a key (#252); this is the workspace's preference because the language is a fact about the
 * person talking, and it stays true whichever profile is active.
 */
export function DictationLanguageField() {
    const { t } = useTranslation();
    const [language, setLanguage] = useState<DictationLanguage>(readDictationLanguage);

    const choose = (next: DictationLanguage) => {
        setLanguage(next);
        writeDictationLanguage(next);
    };

    return (
        <Field label={t("config.preferences.dictationLanguage")} className="mb-4">
            <Select
                value={language}
                onChange={choose}
                // Named in each language, exactly as the interface's own language switcher names them: a person
                // choosing what to *speak* reads the word in that language (#20).
                options={[
                    { value: "en", label: t("config.preferences.dictationLanguageEn") },
                    { value: "zh", label: t("config.preferences.dictationLanguageZh") },
                ]}
            />
            <div className="text-xs leading-5 text-stone-500">{t("config.preferences.dictationLanguageNote")}</div>
        </Field>
    );
}
