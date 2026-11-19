import { describe, expect, test } from "vitest";

import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions, sizeForTier } from "../src/lib/media-size";

/**
 * What a size control writes.
 *
 * A card's box and a run's request are both read from the one stored `size`, so the value space is decided here,
 * at the control that writes it: pixels, or `auto` (#359). Every control offers only half of a size — a tier
 * without a shape, a shape without a tier — so each has to answer for the half it is not offering, or what it
 * writes is not a size at all. That is how a bare ratio got into a document in the first place.
 */
describe("what a size control writes", () => {
    test("a shape at a tier is the pixels that tier means for that shape", () => {
        expect(computeMediaSize("1k", "16:9")).toBe("1536x864");
        expect(computeMediaSize("2k", "16:9")).toBe("2048x1152");
        expect(computeMediaSize("4k", "9:16")).toBe("2160x3840");
    });

    test("no combination a control can produce writes a bare ratio", () => {
        for (const scale of [...mediaScaleOptions, "auto"]) {
            for (const ratio of ["1:1", "16:9", "2:1", "9:21"]) {
                // Either the pixels that means, or the answer that says this tier cannot hold that shape at all
                // (4k at 2:1 would be 5760 wide). Never the shape on its own, which is the half-size two
                // readers used to read two different ways.
                expect(computeMediaSize(scale, ratio)).toMatch(/^(\d+x\d+|auto)$/);
            }
        }
    });

    test("a shape the pills do not offer is made at the tier's own short side", () => {
        // A typed size and a chosen shape are the same kind of number, on the same numbers.
        expect(computeMediaSize("1k", "2:1")).toBe("2048x1024");
    });

    test("a shape too lopsided for a run writes no size rather than one the run would refuse", () => {
        expect(computeMediaSize("1k", "8:1")).toBe("auto");
        expect(computeMediaSize("4k", "1:6")).toBe("auto");
    });

    test("choosing a tier keeps the shape the size already states", () => {
        expect(sizeForTier("2k", "1536x864")).toBe("2048x1152");
        expect(sizeForTier("4k", "864x1536")).toBe("2160x3840");
    });

    test("choosing a tier when nothing is stated states a square, not the same nothing", () => {
        // The default is `auto`, so this is the path a person on a fresh canvas takes. Reading the shape `auto`
        // implies and writing it back left the preferences' resolution control doing nothing at all.
        expect(sizeForTier("2k", "auto")).toBe("2048x2048");
        expect(sizeForTier("1k", "")).toBe("1024x1024");
    });

    test("`auto` is still what says the graph decides, and it states neither tier nor shape", () => {
        expect(computeMediaSize("2k", "auto")).toBe("auto");
        expect(inferMediaScale("auto")).toBe("auto");
        expect(inferMediaRatio("auto")).toBe("auto");
    });
});
