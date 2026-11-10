import { describe, expect, test } from "vitest";

import { configuredClause, generationClause, requiresClause } from "../src/lib/canvas/node-generation-facts";

/**
 * What a tool says about how a node's content was made.
 *
 * `list_nodes` and `read_node` both print this clause, and the agent's answer to "which model drew this,
 * and when" is only as good as the sentence they print. The stamp is the server's own instant, printed
 * as recorded: a locale would make the same fact read differently for the model and for the user (#227).
 */
/**
 * What a node is set to run, as the one clause `read_prompt` adds to the words.
 *
 * The maker clause answers a question about the past; this one answers the question a rewrite depends on,
 * because H3's skill picks its section order from the input mode and the run is where that mode lives
 * (#257). The picker value is the user's, so the channel prefix goes and the tail stays.
 */
describe("configuredClause", () => {
    test("names the workflow the next run will ask, and the length it will ask for", () => {
        expect(configuredClause({ model: "default::video-h3-frames", seconds: "4" })).toBe("set to run video-h3-frames, 4 s");
    });

    test("names the workflow alone when the node keeps no duration of its own", () => {
        // The global default is not a fact about this node: saying "5 s" because the settings say 5 s
        // would be the tool answering for a run it was not asked about.
        expect(configuredClause({ model: "default::image-qwen21" })).toBe("set to run image-qwen21");
    });

    test("keeps a bare model name, which is what an unpicked channel writes", () => {
        expect(configuredClause({ model: "video-h3-t2v" })).toBe("set to run video-h3-t2v");
    });

    test("says nothing for a node that was never given one", () => {
        // A text node's model belongs to its agent, not to a workflow; a node made before the picker was
        // written has no picker at all. Either way there is no run to describe.
        expect(configuredClause({ prompt: "a cat" })).toBe("");
        expect(configuredClause(undefined)).toBe("");
        expect(configuredClause({ model: "  " })).toBe("");
    });

    // #309: the settings that decide what comes out are facts about the node too, and an agent about to write
    // one has to be able to read the one that is there.
    test("names the settings that shape the run, in the order the request reads them", () => {
        expect(configuredClause({ model: "default::image-qwen21", size: "1360x768", seed: "42", seedFixed: "true", background: "transparent" })).toBe("set to run image-qwen21, size 1360x768, seed 42, transparent background");
    });

    test("says the settings of a node with no picker, because they are still what its run would be", () => {
        expect(configuredClause({ size: "1024x1024" })).toBe("size 1024x1024");
    });

    test("the mode a family is asked in is part of the run, so it is named", () => {
        // Not a setting (#309) — it comes with the model — but the wording a rewrite must use depends on it (#311).
        expect(configuredClause({ model: "default::image-qwen21", imageMode: "edit", size: "1360x768" })).toBe("set to run image-qwen21 as edit, size 1360x768");
    });

    test("a seed is not a fact until the node says it is fixed, which is the pair a run reads", () => {
        expect(configuredClause({ model: "image-z-image-turbo", seed: "42" })).toBe("set to run image-z-image-turbo");
    });

    // #325: what the connected pictures *are* to a film that takes frames — the fact that decides whether a
    // clip continues from a frame or ends on one, and the one setting whose value is not a number of seconds.
    test("names how a film's frames map, in the words the request uses", () => {
        expect(configuredClause({ model: "video-h3-frames", frameMode: "first", seconds: "4" })).toBe("set to run video-h3-frames, 4 s, frames first");
        expect(configuredClause({ model: "video-h3-frames", frameMode: "last" })).toBe("set to run video-h3-frames, frames last");
        expect(configuredClause({ model: "video-h3-frames", frameMode: "both" })).toBe("set to run video-h3-frames, frames first and last");
    });

    test("auto is the absence of a choice, and the workflow's own knobs are named as they are", () => {
        expect(configuredClause({ model: "image-qwen21", size: "auto", params: { steps: 8, cfg: 2.5, loras: [], layout: {} } })).toBe("set to run image-qwen21, params steps 8, cfg 2.5");
    });
});

describe("generationClause", () => {
    test("names the workflow and the moment it finished", () => {
        expect(generationClause({ workflow: "image-z-image-turbo", generatedAt: "2026-11-03T13:09:19.928Z" })).toBe("made 2026-11-03T13:09:19.928Z with image-z-image-turbo");
    });

    test("names the workflow alone when there is no stamp to trust", () => {
        expect(generationClause({ workflow: "image-z-image-turbo" })).toBe("made with image-z-image-turbo");
    });

    test("names the moment alone", () => {
        expect(generationClause({ generatedAt: "2026-11-03T13:09:19.928Z" })).toBe("made 2026-11-03T13:09:19.928Z");
    });

    test("says nothing for a node nothing made", () => {
        // A node the user drew on, or one built before the fact was recorded: the tool says nothing rather
        // than "made with unknown", which reads like an answer.
        expect(generationClause({ prompt: "a cat" })).toBe("");
        expect(generationClause(undefined)).toBe("");
        expect(generationClause({ workflow: "  ", generatedAt: "" })).toBe("");
    });
});

/**
 * What a node's run needs, and what it has.
 *
 * The second half of `read_prompt`: a workflow that re-renders a picture from a new angle, swaps a character in
 * a clip, or inpaints a mask takes media a prompt cannot replace. The counts are the workflow's own declaration
 * and the state is the wiring in front of it, so the sentence is the one the server's refusal would give — said
 * before the call (docs/decisions.md #313).
 */
describe("requiresClause", () => {
    const nothing = { image: 0, video: 0, audio: 0 };

    test("a workflow that takes a source picture says how many, and how many there are", () => {
        expect(requiresClause({ images: { min: 1, max: 1 }, videos: { min: 0, max: 0 }, audios: { min: 0, max: 0 }, minTotal: 0 }, { ...nothing, image: 1 })).toBe("it takes 1 image; 1 image connected");
    });

    test("a press that would be refused says so, rather than leaving the caller to find out", () => {
        // The angle re-render and the character swap are this case: the picture is not a nicety.
        expect(requiresClause({ images: { min: 1, max: 1 }, videos: { min: 0, max: 0 }, audios: { min: 0, max: 0 }, minTotal: 0 }, nothing)).toBe("it takes 1 image; nothing connected, so a press would be refused");
    });

    test("a workflow that takes no media says words only, and too much is refused too", () => {
        const t2v = { images: { min: 0, max: 0 }, videos: { min: 0, max: 0 }, audios: { min: 0, max: 0 }, minTotal: 0 };
        expect(requiresClause(t2v, nothing)).toBe("it takes words only; nothing connected");
        expect(requiresClause({ ...t2v, videos: { min: 0, max: 1 } }, { ...nothing, video: 2 })).toBe("it takes up to 1 clip; 2 clips connected, so a press would be refused");
    });

    // A declared zero is a maximum like any other, and the one it is easiest to read as "no limit": the check
    // was `limit.max && …`, so `max: 0` skipped the bound entirely and a words-only workflow was described as
    // ready to press with a picture wired into it — the exact press the server then refused (#348).
    test("a workflow that takes none is refused one, and says so", () => {
        const t2v = { images: { min: 0, max: 0 }, videos: { min: 0, max: 0 }, audios: { min: 0, max: 0 }, minTotal: 0 };
        expect(requiresClause(t2v, { ...nothing, image: 1 })).toBe("it takes words only; 1 image connected, so a press would be refused");
    });

    test("a clip and a picture together, which is the character swap's shape", () => {
        const swap = { images: { min: 1, max: 6 }, videos: { min: 1, max: 1 }, audios: { min: 0, max: 2 }, minTotal: 2 };
        expect(requiresClause(swap, { image: 1, video: 1, audio: 0 })).toBe("it takes 1-6 images and 1 clip; 1 image and 1 clip connected");
        expect(requiresClause(swap, { image: 0, video: 1, audio: 0 })).toBe("it takes 1-6 images and 1 clip; 1 clip connected, so a press would be refused");
    });

    test("says nothing for a workflow that publishes no media contract", () => {
        // Nothing is claimed about a model the server did not describe, which is the three-state rule everywhere.
        expect(requiresClause(undefined, nothing)).toBe("");
    });
});
