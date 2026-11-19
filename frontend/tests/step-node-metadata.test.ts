import { afterAll, expect, test } from "vitest";
import type { AiConfig } from "../src/stores/use-config-store";

// Config and i18n use browser storage during module initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { defaultConfig, modelForWorkflow, modelIsStep } = await import("../src/stores/use-config-store");
const { buildImageGenerationMetadata, buildStepNodeMetadata } = await import("../src/lib/canvas/canvas-node-factory");
const { nodeCanGenerate } = await import("../src/lib/canvas/canvas-generation-helpers");
const { IMAGE_ANGLE_WORKFLOW, IMAGE_UPSCALE_WORKFLOW } = await import("../src/lib/canvas/tool-workflows");

/**
 * A canvas set to Z-Image, with the two image tools the toolbar drives. The tools declare the inputs they
 * accept, because that list is what a run is validated against — a knob outside it must not reach a node.
 */
const config: AiConfig = {
    ...defaultConfig,
    model: "default::image-z-image-turbo",
    imageModel: "default::image-z-image-turbo",
    channels: [
        {
            id: "default",
            name: "Default",
            baseUrl: "http://127.0.0.1:8190",
            models: [
                { name: "image-z-image-turbo", capability: "image", workflowId: "image-z-image-turbo", hasPrompt: true },
                {
                    name: "image-esrgan-upscale",
                    capability: "image",
                    workflowId: IMAGE_UPSCALE_WORKFLOW,
                    tool: true,
                    hasPrompt: false,
                    inputs: ["prompt", "upscale_model"],
                },
                // The workflow's other base model: a variant is never what a workflow answers to.
                { name: "img-esrgan-int8", capability: "image", workflowId: IMAGE_UPSCALE_WORKFLOW, baseModel: "esrgan_int8.safetensors" },
                {
                    name: "image-qwen21-angle",
                    capability: "image",
                    workflowId: IMAGE_ANGLE_WORKFLOW,
                    tool: true,
                    hasPrompt: true,
                    inputs: ["prompt", "horizontalAngle", "pitchAngle", "cameraDistance", "seed"],
                },
            ],
        },
    ],
};

// What the 放大 / 超分 buttons run. The node used to record nothing, so its panel fell back to whatever the
// canvas was set to and showed a text-to-image composer with a send button over a picture that had just been
// upscaled (#263 for the video half of this).
test("a node an upscale button creates is the upscaler, not the canvas's model", () => {
    const metadata = buildStepNodeMetadata(config, IMAGE_UPSCALE_WORKFLOW, { upscale_model: "RealESRGAN_x4plus.pth" });
    expect(metadata.model).toBe("default::image-esrgan-upscale");
    expect(metadata.model).not.toBe(config.model);
    expect(modelIsStep(config, metadata.model || "")).toBe(true);
    // The chosen model file is part of what the run was told, so the panel reads it back instead of the default.
    expect(metadata.params).toEqual({ upscale_model: "RealESRGAN_x4plus.pth" });
});

test("a knob the workflow does not declare is not written onto the node", () => {
    const metadata = buildStepNodeMetadata(config, IMAGE_UPSCALE_WORKFLOW, { upscale_model: "RealESRGAN_x2plus.pth", seed: 7, size: "1024x1024" });
    expect(metadata.params).toEqual({ upscale_model: "RealESRGAN_x2plus.pth" });
});

// The angle re-render submits its own workflow too; what it used to record was the model of the picture it
// re-rendered, so its panel offered that model's controls and the angle it ran with was nowhere on the node.
test("an angle node records the angle workflow and the camera it was asked for", () => {
    const metadata = buildStepNodeMetadata(config, IMAGE_ANGLE_WORKFLOW, { horizontalAngle: 40, pitchAngle: -10, cameraDistance: 3 });
    expect(metadata.model).toBe("default::image-qwen21-angle");
    expect(metadata.params).toEqual({ horizontalAngle: 40, pitchAngle: -10, cameraDistance: 3 });
});

test("the model a workflow answers to is its base entry, not a variant", () => {
    expect(modelForWorkflow(config, IMAGE_UPSCALE_WORKFLOW)).toBe("default::image-esrgan-upscale");
    expect(modelForWorkflow(config, "image-not-installed")).toBe("");
    expect(modelForWorkflow(config, "  ")).toBe("");
});

// A workflow the model list does not offer has no model to name. Writing the bare workflow id would be a
// value nothing resolves, which is the fallback that made an interpolation node show as text-to-video — so the
// node claims no model, and keeps the knobs, which are what the run was told.
test("a workflow nothing offers leaves no model claim and keeps what the run was told", () => {
    const metadata = buildStepNodeMetadata(config, "image-not-installed", { upscale_model: "RealESRGAN_x4plus.pth" });
    expect(metadata.model).toBeUndefined();
    expect(metadata.params).toEqual({ upscale_model: "RealESRGAN_x4plus.pth" });
});

// The node a button creates is a node like any other: it appears configured and waits for its own send button.
// Nothing runs from the toolbar, so the multiplier the interpolation was not asked for is never spent, and the
// upscaler's weight is whatever the workflow declares until someone chooses another.
test("a node a button creates is ready to run, and runs nothing until asked", () => {
    const metadata = buildStepNodeMetadata(config, IMAGE_UPSCALE_WORKFLOW);
    expect(metadata.model).toBe("default::image-esrgan-upscale");
    // No params: the workflow's own declaration decides, so there is no second copy of the default on the node.
    expect(metadata.params).toBeUndefined();
    // No content yet — and that is what makes it a generator rather than material: its panel is the step panel,
    // with the source wired in and a send button that is the first thing that spends anything (#297, #301).
    expect(nodeCanGenerate({ id: "n", type: "image", position: { x: 0, y: 0 }, width: 240, height: 240, metadata } as never)).toBe(true);
});

// A variant mode that reads a picture takes no size: its answer is the shape of the picture it repaints, or the
// canvas an outpaint states. The record used to write `size: "auto"` for those runs anyway, and a card's box is
// decided from that record at the press — so re-asking a card that had been drawn at its answer's shape shrank
// it to whatever `auto` resolves to (#354, #358). The absence is the declaration's answer, the same one that
// hides the size control for those modes (#304).
test("a run in a mode that takes no size records no shape", () => {
    const family: AiConfig = {
        ...config,
        channels: [
            {
                id: "default",
                name: "Default",
                baseUrl: "http://127.0.0.1:8190",
                models: [
                    { name: "image-undescribed", capability: "image", workflowId: "image-undescribed", hasPrompt: true },
                    {
                        name: "image-qwen21",
                        capability: "image",
                        workflowId: "image-qwen21",
                        hasPrompt: true,
                        variantModes: ["t2i", "edit", "outpaint"],
                        contracts: {
                            t2i: { inputs: ["prompt", "seed", "size", "quality"] },
                            edit: { inputs: ["prompt", "seed"] },
                            outpaint: { inputs: ["prompt", "seed", "left", "top", "right", "bottom", "megapixels", "outpaintWidth", "outpaintHeight"] },
                        },
                    },
                ],
            },
        ],
    };
    const asked = {
        ...family,
        model: "default::image-qwen21",
        imageMode: "outpaint",
        size: "auto",
        quality: "auto",
        outpaint: { left: 0, top: 0, right: 256, bottom: 0, width: 1280, height: 768 },
    };
    const metadata = buildImageGenerationMetadata(asked, []);
    expect(metadata.model).toBe("default::image-qwen21");
    expect(metadata.imageMode).toBe("outpaint");
    // What the run was actually told is kept: the canvas it was asked to draw.
    expect(metadata.outpaint).toEqual(asked.outpaint);
    // And what it was never told is not claimed.
    expect(metadata.size).toBeUndefined();
    // A mode that does size things keeps its size: the absence follows the declaration, it is not a blanket rule.
    expect(buildImageGenerationMetadata({ ...asked, imageMode: "t2i", size: "1:1" }, []).size).toBe("1:1");
    // The edit mode reads pictures and lists no size among its inputs, so it records none either.
    expect(buildImageGenerationMetadata({ ...asked, imageMode: "edit" }, []).size).toBeUndefined();
    // A model the server listed no inputs for is left alone: nothing is claimed about it (#304's three states).
    expect(buildImageGenerationMetadata({ ...family, model: "default::image-undescribed", size: "1:1" }, []).size).toBe("1:1");
});
