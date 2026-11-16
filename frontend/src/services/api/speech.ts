import i18n from "@/i18n";
import { serverRoot } from "@/constant/app-mode";
import { wavBytes } from "@/lib/wav";
import { ApiError, apiErrorMessage, httpJson, throwIfCanceled } from "@/services/api/http";

/**
 * Speech to text, through the server, and the list of speech servers it can be sent to.
 *
 * The page cannot call the speech server itself: it answers no CORS headers, so a request from this origin can
 * be sent and the answer can never be read — and on a phone opening the canvas over the LAN, `127.0.0.1` is the
 * phone. So the recording goes to `/api/speech/transcriptions` on the server, which is the one process that can
 * reach the address, and the address is the active profile's (`internal/server/routes_speech.go`, #239, #252).
 *
 * **The one shape this build speaks.** An OpenAI-compatible `POST /v1/audio/transcriptions` taking multipart
 * WAV and answering `{"text": "..."}` — a local audio.cpp server, in the default this build fills in. That shape
 * is a fact about the protocol; the address, the model name and the credential are facts about the server at
 * the other end, so they are a profile (#246).
 *
 * **What is not here: the key.** `data/settings.json` is served to every browser that loads the canvas
 * (`/config.js`), so a credential in it would be a credential for anyone who can reach the server. It is stored
 * next to its profile on the server, mode 0600, and a page can only learn whether one is there and hand over a
 * new one (#246, #252).
 */

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/** What the panel says when it failed without a sentence of its own. */
const SPEECH_FALLBACK = "speechFailed";

/** `{baseUrl}` is all these need, which is why they take that and not the whole config. */
type Server = { baseUrl: string };

/**
 * One speech server, as the server describes it: where it listens, the model it calls its own, and whether it
 * has a key. The key itself never reaches this object.
 */
export type SpeechProfile = {
    id: number;
    name: string;
    url: string;
    model: string;
    hasKey: boolean;
};

/** The list and which entry dictation uses (0 when none is configured). */
export type SpeechProfilesState = {
    profiles: SpeechProfile[];
    active: number;
};

/**
 * One entry as a page sends it back: an id for a profile that exists, and a key only when there is one to give.
 *
 * An entry with no `key` says nothing about the stored one, which is how a key survives an edit to the address;
 * `""` removes it. That is the same rule the agent's models follow (`lib/agent-models.ts`).
 */
export type SpeechProfileInput = {
    id?: number;
    name: string;
    url: string;
    model: string;
    key?: string;
};

/**
 * Transcribe one recording.
 *
 * Samples and their rate go in — the WAV is written here, so the caller never holds a file format. An empty
 * transcript (silence, or a cough) comes back as an empty string: that is an answer, not a failure.
 *
 * The request carries the recording and one other thing: the language the user chose to speak into the
 * microphone (`lib/dictation-language.ts`). Where it goes is the server's business, so nothing in this call can
 * name a different speech server than the active profile.
 */
export async function transcribeSpeech(server: Server, samples: Float32Array, sampleRate: number, language: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const body = new FormData();
    // Which language to expect, as the user chose it. Not a hint the model may ignore: some servers decode
    // strictly by this field, and leaving it out is not auto-detection — on the server this project is measured
    // against it answers exactly like `en` (`lib/dictation-language.ts`, #352).
    body.append("language", language);
    body.append("file", new File([wavBytes(samples, sampleRate)], "speech.wav", { type: "audio/wav" }));

    try {
        const payload = await httpJson<{ text?: string }>(`${serverRoot(server.baseUrl)}/api/speech/transcriptions`, {
            method: "POST",
            body,
            signal: options.signal,
            timeout: 180_000,
        });
        return (payload?.text || "").trim();
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(speechFailure(error, apiText(SPEECH_FALLBACK)));
    }
}

const SPEECH_PROFILES_URL = (server: Server) => `${serverRoot(server.baseUrl)}/api/speech/profiles`;

/** The list, and which entry dictation uses. */
export async function loadSpeechProfiles(server: Server, options: { signal?: AbortSignal } = {}): Promise<SpeechProfilesState> {
    try {
        return profilesOf(await httpJson<SpeechProfilesState>(SPEECH_PROFILES_URL(server), { signal: options.signal, timeout: 8000 }));
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(speechFailure(error, apiText("speechProfilesFailed")));
    }
}

/**
 * Make the list these profiles, with this one active.
 *
 * The whole list goes back, because the list is the file: an entry that is missing is a profile that was
 * deleted. The answer is the list the server now has, which is what the caller should show — including the ids
 * it assigned to the profiles that were just added.
 */
export async function saveSpeechProfiles(server: Server, state: { profiles: SpeechProfileInput[]; active: number }, options: { signal?: AbortSignal } = {}): Promise<SpeechProfilesState> {
    try {
        const payload = await httpJson<SpeechProfilesState>(SPEECH_PROFILES_URL(server), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profiles: state.profiles, active: state.active }),
            signal: options.signal,
            timeout: 8000,
        });
        return profilesOf(payload);
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(speechFailure(error, apiText("speechProfilesFailed")));
    }
}

/**
 * The sentence for a failed speech request.
 *
 * Two codes are worth saying here rather than as the server said them, because both are about where the answer
 * lives rather than about a value the reader can see. `speech_profile_missing` is an empty list, which is a
 * setting with a name in this window. `speech_profile_unknown` is another window having written the list first,
 * and "there is no speech profile 7" is not something a reader can act on. Everything else — including every
 * refusal from the speech server itself — arrives in its own words, because they name the thing to change.
 */
function speechFailure(error: unknown, fallback: string): string {
    const code = error instanceof ApiError && error.data && typeof error.data === "object" ? (error.data as { error?: { code?: unknown } }).error?.code : undefined;
    if (code === "speech_profile_missing") return apiText("speechProfileMissing");
    if (code === "speech_profile_unknown") return apiText("speechProfileStale");
    return apiErrorMessage(error, fallback);
}

/** A decoded answer, with the two fields defaulted: a page should never render `undefined` as a list. */
function profilesOf(payload: SpeechProfilesState | undefined): SpeechProfilesState {
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    const active = typeof payload?.active === "number" ? payload.active : 0;
    return { profiles, active };
}
