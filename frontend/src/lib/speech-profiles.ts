import type { SpeechProfile, SpeechProfileInput } from "@/services/api/speech";

/**
 * The editor's side of the speech server list.
 *
 * The list is the server's (`~/.config/comfyloft/speech.json`, `internal/store/speech.go`): the page shows what `GET
 * /api/speech/profiles` answered and sends the whole list back with one entry added, changed, removed or made
 * active. What a page cannot send is the part it has never been shown — a profile's key — so an existing entry
 * travels by id and the fields on this form, and a key travels only when this page has one to give: a profile
 * being created, or one whose key the user has just retyped. An empty key field says nothing and changes
 * nothing, and removing a stored key is its own answer (`removeKey`), because a blank field cannot mean both.
 *
 * Everything is text, including the id-less "new profile" case, so a half-typed form is never a `NaN` and the
 * dialog's Save button is a question about the draft rather than about the list.
 */
export type SpeechDraft = {
    name: string;
    /** The OpenAI-compatible `/v1/audio/transcriptions` address. */
    url: string;
    /** The model name, as the speech server itself spells it; "" sends no `model` field at all. */
    model: string;
    /** A new key. Blank means "the one that is stored", which is the only thing a page can say about it. */
    key: string;
    /** Whether to remove the key the server holds, which is a decision a blank field cannot also carry. */
    removeKey: boolean;
};

/**
 * The speech server this build was measured against: a local audio.cpp server.
 *
 * It is filled in rather than left blank because a fresh form with no address makes a working setup look like a
 * missing one. Any OpenAI-compatible `/v1/audio/transcriptions` that takes WAV works — that is the whole of the
 * protocol this build knows (#239).
 */
const DEFAULT_SPEECH_ADDRESS = "http://127.0.0.1:18080/v1/audio/transcriptions";

/**
 * The model name that address's server reports, filled in for the same reason the address is.
 *
 * `refine` is the offline Qwen3-ASR on the audio.cpp server this was built against (`GET /v1/models` on it lists
 * `refine` and `stream`). It is a default, not a constant: point the address at OpenAI and this has to become
 * `whisper-1` or `gpt-4o-transcribe`, because the name is a fact about the server (#246).
 */
export const DEFAULT_SPEECH_MODEL = "refine";

export const emptySpeechDraft: SpeechDraft = {
    name: "",
    url: DEFAULT_SPEECH_ADDRESS,
    model: DEFAULT_SPEECH_MODEL,
    key: "",
    removeKey: false,
};

/** What one profile on screen looks like in the form. The key is not known here, so it starts empty. */
export function speechDraftOf(profile: SpeechProfile): SpeechDraft {
    return { name: profile.name, url: profile.url, model: profile.model, key: "", removeKey: false };
}

/**
 * Whether a draft is a speech server: an http(s) address with a host, which is the one thing a request needs.
 *
 * The name is optional — a profile is recognisable by its address, and the list falls back to it — and so is the
 * model, because a server that names none (`whisper.cpp`'s `/inference`) is a real shape (#246). The address is
 * checked as a URL here for the same reason the server checks it on the way in: a typo should be said while it
 * is still on screen, not at the first dictation.
 */
export function speechDraftComplete(draft: SpeechDraft): boolean {
    const address = draft.url.trim();
    if (!address) return false;
    let parsed: URL;
    try {
        parsed = new URL(address);
    } catch {
        return false;
    }
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "";
}

/** What one edit does to the list: an entry added, changed, removed, or made the one dictation uses. */
export type SpeechChange = { kind: "add"; draft: SpeechDraft } | { kind: "edit"; id: number; draft: SpeechDraft } | { kind: "delete"; id: number } | { kind: "activate"; id: number };

/** The body of the `PUT` that applies one change: the whole list, and which entry is active. */
export function speechProfilesPayload(state: { profiles: SpeechProfile[]; active: number }, change: SpeechChange): { profiles: SpeechProfileInput[]; active: number } {
    const kept = state.profiles.map((profile) => entryOf(profile));
    switch (change.kind) {
        case "add":
            return { profiles: [...kept, editableOf(change.draft)], active: state.active };
        case "edit":
            return { profiles: kept.map((entry) => (entry.id === change.id ? { ...entry, ...editableOf(change.draft) } : entry)), active: state.active };
        case "delete":
            return { profiles: kept.filter((entry) => entry.id !== change.id), active: state.active };
        case "activate":
            return { profiles: kept, active: change.id };
    }
}

/** One profile the server announced, as this page may describe it back: only what it was shown unchanged. */
function entryOf(profile: SpeechProfile): SpeechProfileInput {
    return { id: profile.id, name: profile.name, url: profile.url, model: profile.model };
}

/** The fields the form owns. The key is one of them only when there is something to say about it. */
function editableOf(draft: SpeechDraft): Omit<SpeechProfileInput, "id"> {
    const entry: Omit<SpeechProfileInput, "id"> = { name: draft.name.trim(), url: draft.url.trim(), model: draft.model.trim() };
    // Removing the stored key is a blank one, spelled as a blank one: absent would mean "keep it".
    if (draft.removeKey) entry.key = "";
    else if (draft.key.trim()) entry.key = draft.key.trim();
    return entry;
}
