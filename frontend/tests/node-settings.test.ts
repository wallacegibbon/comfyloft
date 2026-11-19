import { describe, expect, test } from "vitest";

import { planNodeSettings, type SettingsContract } from "../src/lib/canvas/node-settings";
import type { CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

/**
 * What a settings call writes, and what it refuses.
 *
 * The tool states a size, a length, a seed, a background, a container, a sound's words, or the workflow's own
 * knobs, and every one of them lands in the field the node's own panel writes — so a setting the panel shows
 * and a setting an agent states are one value, not two. What is checked here is the three refusals that keep
 * that true: a setting the kind does not keep, a key the workflow does not read, and a value a run could not
 * take (docs/decisions.md #309).
 */

const node = (type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id: `${type}-1`, type, position: { x: 0, y: 0 }, width: 320, height: 240, metadata });

/** A contract as the server publishes it: the keys a run reads. */
const accepts = (...keys: string[]): SettingsContract => ({ accepts: keys });

const image = node("image");
const video = node("video");
const audio = node("audio");

describe("a picture's settings", () => {
    test("writes the size into the field the panel's two boxes write, aligned the way the request aligns it", () => {
        const plan = planNodeSettings(image, { size: "1000x1000" }, accepts("size"));
        expect(plan).toEqual({ ok: true, patch: { size: "1008x1008" }, written: ["size 1008x1008"] });
    });

    test("a size a picture may not be is refused with the reason, not written", () => {
        const tooBig = planNodeSettings(image, { size: "4096x4096" }, accepts("size"));
        expect(tooBig.ok).toBe(false);
        expect(!tooBig.ok && tooBig.reason).toContain("3840");

        // A shape is not a size: the pixels are what a node stores, and what its panel reads back.
        const shape = planNodeSettings(image, { size: "16:9" }, accepts("size"));
        expect(shape.ok).toBe(false);
        expect(!shape.ok && shape.reason).toContain("1360x768");
    });

    test("a seed is written with the fixed flag the request reads, and cleared together", () => {
        expect(planNodeSettings(image, { seed: 42 }, accepts("seed"))).toEqual({ ok: true, patch: { seed: "42", seedFixed: "true" }, written: ["seed 42"] });
        expect(planNodeSettings(image, { seed: "random" }, accepts("seed"))).toEqual({ ok: true, patch: { seed: "", seedFixed: "false" }, written: ["seed cleared"] });
    });

    test("the transparent background is the one value a run can be told", () => {
        expect(planNodeSettings(image, { background: "transparent" }, accepts("background"))).toMatchObject({ ok: true, patch: { background: "transparent" } });
        expect(planNodeSettings(image, { background: "" }, accepts("background"))).toMatchObject({ ok: true, patch: { background: "" } });
        const other = planNodeSettings(image, { background: "blue" }, accepts("background"));
        expect(!other.ok && other.reason).toContain('"transparent"');
    });

    test("the workflow's knobs are merged over the node's own, and refused by key", () => {
        const withKnobs = node("image", { params: { steps: 8, cfg: 2.5 } });
        const plan = planNodeSettings(withKnobs, { params: { steps: 20 } }, accepts("size", "steps", "cfg"));
        expect(plan).toEqual({ ok: true, patch: { params: { steps: 20, cfg: 2.5 } }, written: ["params.steps 20"] });

        const unknown = planNodeSettings(withKnobs, { params: { setps: 20 } }, accepts("size", "steps", "cfg"));
        expect(unknown.ok).toBe(false);
        expect(!unknown.ok && unknown.reason).toContain("cfg, size, steps");
    });

    test("two knobs have an owner elsewhere, and say which", () => {
        const lora = planNodeSettings(image, { params: { loras: [] } }, accepts("loras"));
        expect(!lora.ok && lora.reason).toContain("LoRA nodes connected");
        const layout = planNodeSettings(image, { params: { layout: {} } }, accepts("layout"));
        expect(!layout.ok && layout.reason).toContain("its own editor");
    });
});

describe("what the kind does not keep", () => {
    test("a length is not a picture's setting, and the refusal names what it does keep", () => {
        const plan = planNodeSettings(image, { seconds: 4 }, accepts("size", "seconds"));
        expect(plan.ok).toBe(false);
        expect(!plan.ok && plan.reason).toContain("image nodes keep size, background, seed, params");
    });

    test("a sound has no params: its request carries none", () => {
        const plan = planNodeSettings(audio, { params: { steps: 8 } }, accepts("seconds", "format", "lyrics"));
        expect(!plan.ok && plan.reason).toContain("no knobs of its own");
    });

    test("a text card, a group and a LoRA node have no run to configure", () => {
        for (const [kind, words] of [
            [node("text", { content: "a cat" }), "its words"],
            [node("group"), "holds nodes"],
            [node("lora"), "the stack its own panel picks"],
        ] as const) {
            const plan = planNodeSettings(kind, { size: "1024x1024" }, accepts("size"));
            expect(plan.ok).toBe(false);
            expect(!plan.ok && plan.reason).toContain(words);
        }
    });

    // Material has no run to shape, and no picker to give it one any more: what it is *for* is a connection
    // (#297), so the refusal names that rather than a control that does not exist.
    test("material has no run to shape, and the refusal says how it is used instead", () => {
        const crop = node("image", { content: "/api/canvases/c/files/a.png" });
        const plan = planNodeSettings(crop, { size: "1024x1024" }, accepts("size"));
        expect(!plan.ok && plan.reason).toContain("holds material and no model");
        expect(!plan.ok && plan.reason).toContain("connecting it to a node that runs");
    });

    // The one setting whose key the film's own request reads, so a workflow that takes no frames refuses it
    // with the list it does read — the same three-state answer every other setting gets (#304, #324).
    test("a film's frame mode is a setting, and it is refused by a workflow that takes no frames", () => {
        const film = node("video", { content: "/api/canvases/c/files/a.mp4", model: "default::video-h3-ref2va" });
        const plan = planNodeSettings(film, { frameMode: "last" }, accepts("frameMode", "seconds"));
        expect(plan.ok).toBe(true);
        expect(plan.ok && plan.patch).toEqual({ frameMode: "last" });

        const refuses = planNodeSettings(film, { frameMode: "first" }, accepts("prompt", "seconds"));
        expect(!refuses.ok && refuses.reason).toContain("frameMode means nothing to this workflow");

        const nonsense = planNodeSettings(film, { frameMode: "middle" }, accepts("frameMode"));
        expect(!nonsense.ok && nonsense.reason).toContain('"first", "last", or "both"');
    });
});

describe("the contract is the panel's own three-state answer", () => {
    test("a key the workflow does not read is refused, and the message lists what it does", () => {
        const plan = planNodeSettings(image, { size: "1024x1024" }, accepts("seed", "steps"));
        expect(!plan.ok && plan.reason).toContain("size means nothing to this workflow");
        expect(!plan.ok && plan.reason).toContain("seed, steps");
    });

    test("a model that publishes nothing is left alone: nothing is claimed about it", () => {
        // The same reading every control gets (#304): no contract is not a refusal, it is silence.
        expect(planNodeSettings(image, { size: "1024x1024" }, {}).ok).toBe(true);
    });

    test("one wrong setting writes none of them", () => {
        const plan = planNodeSettings(image, { size: "1024x1024", seed: 0 }, accepts("size", "seed"));
        expect(plan.ok).toBe(false);
    });

    test("a call that states nothing is refused rather than answered with an empty write", () => {
        const plan = planNodeSettings(image, {}, accepts("size"));
        expect(!plan.ok && plan.reason).toContain("no setting was stated");
    });
});

describe("a film's and a sound's settings", () => {
    test("a film takes a size and a length, and the length is refused outside the declared range", () => {
        expect(planNodeSettings(video, { size: "1280x720", seconds: 5 }, { ...accepts("size", "seconds"), tier: "720" })).toEqual({ ok: true, patch: { size: "1280x720", seconds: "5" }, written: ["size 1280x720", "seconds 5"] });
        const long = planNodeSettings(video, { seconds: 60 }, accepts("seconds"));
        expect(!long.ok && long.reason).toContain("4 to 30 s");
    });

    // A film's pixels are derived from its tier and its shape at submit (`planRunShape`), so a stated
    // size that the tier would not make is a number that would be quietly replaced. Refused, with the number
    // that would be made — and `quality` is the setting that takes the fix.
    test("a film's size is the tier's numbers for its shape, and a disagreement is refused with the size it makes", () => {
        const wrong = planNodeSettings(video, { size: "1280x720" }, { ...accepts("size"), tier: "1080" });
        expect(wrong.ok).toBe(false);
        expect(!wrong.ok && wrong.reason).toContain("1920x1080");
        expect(!wrong.ok && wrong.reason).toContain("quality");
    });

    test("the tier and the size can be stated together, and the tier settles first", () => {
        expect(planNodeSettings(video, { size: "1920x1080", quality: 1080 }, { ...accepts("size"), tier: "720" })).toEqual({
            ok: true,
            patch: { vquality: "1080", size: "1920x1080" },
            written: ["quality 1080", "size 1920x1080"],
        });
        const nonsense = planNodeSettings(video, { quality: "big" }, { ...accepts("size"), tier: "720" });
        expect(!nonsense.ok && nonsense.reason).toContain("not a quality");
    });

    test("a sound's length is bounded by what its model declares", () => {
        const plan = planNodeSettings(audio, { seconds: 30 }, { accepts: ["seconds"], duration: { min: 5, max: 20 } });
        expect(!plan.ok && plan.reason).toContain("5 to 20 s");
        expect(planNodeSettings(audio, { seconds: 12 }, { accepts: ["seconds"], duration: { min: 5, max: 20 } })).toEqual({ ok: true, patch: { seconds: "12" }, written: ["seconds 12"] });
    });

    test("a sound's container is one the canvas writes, and its words go to the lyrics key", () => {
        expect(planNodeSettings(audio, { format: "wav" }, accepts("format"))).toMatchObject({ ok: true, patch: { audioFormat: "wav" } });
        const ogg = planNodeSettings(audio, { format: "ogg" }, accepts("format"));
        expect(!ogg.ok && ogg.reason).toContain("mp3, wav, opus, aac, flac, pcm");

        // The request calls them `lyrics` — the binding's own name, which is the key the contract lists.
        expect(planNodeSettings(audio, { instructions: "秋天来了" }, accepts("lyrics"))).toMatchObject({ ok: true, patch: { audioInstructions: "秋天来了" } });
    });
});
