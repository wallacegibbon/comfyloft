import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isSpeakable, isTalkChord, isTalkKey, MAX_SPEECH_SECONDS } from "@/lib/canvas/agent-dictation";
import { canOpenMicrophone, startPcmRecording, type PcmRecording } from "@/lib/pcm-recorder";

/**
 * Hold a key, say a sentence, let go: the words come back.
 *
 * The gesture is the whole interface — `Ctrl`/`⌘` plus `'` or plus the backquote above Tab, or a button held
 * down with a pointer — and what it produces is text handed to the caller, which puts it where the caret was.
 * It deliberately does not know where that is: this hook is about the sound, and the panel is about the draft.
 *
 * **The keys.** `Ctrl + '` and `Ctrl + the backquote above Tab` are one gesture, matched once in
 * `agent-dictation.ts` so that the microphone, the cap and the caret never learn which was held (#314). The
 * quote because quoting is what a person does with speech; the backquote because it sits on the home row and
 * asks less of a keyboard. Neither collides with anything here: `Space` is the canvas's temporary tool,
 * `Shift` and `Ctrl` on their own are additive selection and the temporary tool, and every key the canvas
 * reads is "modifier + letter". A chord with a printable in it also cannot be started by accident the way a
 * held modifier can, and neither types anything nor is bound by a browser (`⌘+'` is Firefox's quick-find and
 * `⌘` with the backquote cycles a window — both on macOS, which is why `Ctrl` is said first).
 *
 * **Repeat.** A modifier held down does not repeat; a printable key does, dozens of times a second, so the
 * repeats are dropped rather than treated as "press again".
 *
 * **The lost keyup.** Switching windows mid-sentence means the key comes up on a page that is not listening,
 * and a microphone that is never told to stop is the one failure worth code: the window losing focus ends the
 * recording. What no event can cover — a pointer capture that never releases, a key the window never hears come
 * up — is what the length cap is for: the recording ends itself at a minute and says so (#251). A gesture too
 * short to be speech is dropped silently rather than being reported as a broken microphone (#239).
 */

type DictationPhase = "idle" | "listening" | "transcribing";

type Options = {
    /** Send the recording and answer with what was said; "" when nothing was. */
    transcribe: (samples: Float32Array, sampleRate: number) => Promise<string>;
    /** What was said, once it is known and it is not empty. */
    onWords: (text: string) => void;
    /**
     * A gesture has begun, before the microphone is asked for.
     *
     * Every outcome of a gesture is drawn inside the panel that asked for it — the "listening" line, the
     * sentence for a microphone that could not be opened, the length cap, the words themselves. So the panel
     * that owns a gesture has to be visible for the whole of it: a window that opened only when the words
     * landed would leave a silent attempt, a refused microphone and a box of text nobody can read (#353).
     */
    onStart: () => void;
};

type HoldToTalk = {
    phase: DictationPhase;
    /** The sentence to show for the last attempt that failed, or "". */
    error: string;
    /** The sentence to show for an attempt that ended for a reason that is not a failure, or "". */
    notice: string;
    start: () => void;
    stop: () => void;
};

export function useHoldToTalk({ transcribe, onWords, onStart }: Options): HoldToTalk {
    const { t } = useTranslation();
    const [phase, setPhase] = useState<DictationPhase>("idle");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");

    const recordingRef = useRef<PcmRecording | null>(null);
    /** A gesture is held down. It can outlive `start()`: the microphone is opened asynchronously. */
    const heldRef = useRef(false);
    /** A recording is on its way to the server, and a second gesture would race it. */
    const busyRef = useRef(false);
    /** The last gesture ended at the length cap rather than at the user's release. */
    const limitedRef = useRef(false);
    /**
     * `stop`, reachable from the recorder's own callback.
     *
     * The cap fires from inside the audio callback, which can be before `start`'s promise resolves, so it
     * cannot close over one render's `stop` — the ref is assigned every render and read whenever it fires.
     */
    const stopRef = useRef<() => void>(() => {});

    // The callbacks are read through refs so the listeners can be attached once: `transcribe` closes over a
    // config object that is rebuilt on every render of the panel.
    const transcribeRef = useRef(transcribe);
    transcribeRef.current = transcribe;
    const onWordsRef = useRef(onWords);
    onWordsRef.current = onWords;
    const onStartRef = useRef(onStart);
    onStartRef.current = onStart;

    const start = useCallback(() => {
        if (heldRef.current || busyRef.current) return;
        // Said before anything is asked for, because everything that can go wrong from here on is reported in
        // that window: a browser that will not open a microphone, a gesture with no sound in it, a refusal from
        // the speech server. A gesture started in a closed window would otherwise be invisible end to end, and
        // the words it produced would land in a box nobody can see (#353).
        onStartRef.current();
        // A page a browser will not open a microphone on is the first thing to check: the answer is a sentence
        // about the address, not a `TypeError` from inside the recorder (#242). Nothing starts, nothing looks
        // like it started, and the microphone is never asked for.
        if (!canOpenMicrophone()) {
            setError(t("canvas.agent.microphoneUnavailable"));
            return;
        }
        heldRef.current = true;
        limitedRef.current = false;
        setError("");
        setNotice("");
        setPhase("listening");
        void (async () => {
            let recording: PcmRecording;
            try {
                recording = await startPcmRecording({
                    maxSeconds: MAX_SPEECH_SECONDS,
                    // Ended by its own length: the same path a release takes, so the words still land — with a
                    // sentence saying why the microphone stopped without anybody letting go.
                    onLimit: () => {
                        limitedRef.current = true;
                        stopRef.current();
                    },
                });
            } catch (failure) {
                heldRef.current = false;
                setPhase("idle");
                setError(failure instanceof Error ? failure.message : String(failure));
                return;
            }
            // The gesture ended while the microphone was opening — the permission prompt, usually. There is
            // nothing recorded and nothing to say about it.
            if (!heldRef.current) {
                recording.stop();
                setPhase("idle");
                return;
            }
            recordingRef.current = recording;
        })();
    }, [t]);

    const stop = useCallback(() => {
        if (!heldRef.current) return;
        heldRef.current = false;
        if (limitedRef.current) {
            limitedRef.current = false;
            setNotice(t("canvas.agent.dictationLimit"));
        }
        const recording = recordingRef.current;
        recordingRef.current = null;
        // Still opening: the start path sees the released gesture and throws the stream away.
        if (!recording) return;
        const { samples, sampleRate } = recording.stop();
        if (!isSpeakable(samples.length, sampleRate)) {
            setPhase("idle");
            return;
        }
        busyRef.current = true;
        setPhase("transcribing");
        void (async () => {
            try {
                const text = await transcribeRef.current(samples, sampleRate);
                if (text) onWordsRef.current(text);
            } catch (failure) {
                setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
                busyRef.current = false;
                setPhase("idle");
            }
        })();
    }, [t]);

    stopRef.current = stop;

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!isTalkChord(event)) return;
            event.preventDefault();
            if (event.repeat) return;
            start();
        };
        // Either half of the chord ends it: the key first is "I am done", the modifier first is "oops".
        const onKeyUp = (event: KeyboardEvent) => {
            if (isTalkKey(event) || event.key === "Control" || event.key === "Meta") stop();
        };
        const onBlur = () => stop();
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", onBlur);
        };
    }, [start, stop]);

    // Closed in the middle of a sentence: the microphone belongs to this gesture and does not outlive it.
    useEffect(
        () => () => {
            recordingRef.current?.stop();
        },
        [],
    );

    return { phase, error, notice, start, stop };
}
