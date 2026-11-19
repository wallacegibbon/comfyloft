import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Image upscaling through the run protocol.
 *
 * The upscaler used to be a multipart post to `/v1/images/upscale`. It is one of the workflows the
 * canvas drives from a button rather than the model list, so it was the last image action outside
 * the run protocol: now the source image is uploaded once, named by role, and the chosen workflow's
 * own knobs are the typed inputs.
 */
// `t` answers with the key, except where the caller passes the sentence to wrap: the reference-prefix
// template takes the user's words as `prompt`, and keeping them makes the assertion below about the words
// that reached the run rather than about the wrapper's own text.
vi.mock("@/i18n", () => ({ default: { t: (key: string, options?: { prompt?: string }) => (typeof options?.prompt === "string" ? options.prompt : key) } }));
vi.mock("@/services/api/server-status", () => ({ noteServerError: () => undefined, noteServerResponse: () => undefined }));

// Media conversion is a browser concern; these tests are about the request the canvas builds. A generated
// image is measured where it is served, not downloaded and re-uploaded (#173).
vi.mock("@/services/image-storage", () => ({
    imageToDataUrl: async () => "data:image/png;base64,AAAA",
    readImageSize: async () => ({ width: 512, height: 512 }),
}));
vi.mock("@/lib/image-utils", () => ({
    dataUrlToFile: (image: { name?: string }) => new File([new Uint8Array([1, 2, 3])], image.name || "source.png", { type: "image/png" }),
}));

const { requestEdit, requestGeneration } = await import("@/services/api/image");
const { planRunShape } = await import("@/lib/canvas/run-shape");

// A run belongs to a canvas (#156): these cases post into one.
const { setActiveCanvas } = await import("@/services/canvas-files");
const CANVAS_ID = "40e8afb47f10";
setActiveCanvas(CANVAS_ID);
type Config = Parameters<typeof requestEdit>[0];

const server = () =>
    ({
        baseUrl: "http://127.0.0.1:8190/v1",
        apiKey: "local",
        apiFormat: "openai",
        channels: [],
        models: ["image-qwen21"],
        model: "image-qwen21",
        imageModel: "image-qwen21",
        size: "1024x1024",
        count: "1",
        systemPrompt: "",
        quality: "",
        params: {},
    }) as unknown as Config;

const image = (name: string, storageKey?: string) => ({ id: name, name, dataUrl: "data:image/png;base64,AAAA", storageKey }) as never;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

const run = (overrides: Record<string, unknown> = {}) => ({
    id: "task_upscale_1",
    workflow: "image-esrgan-upscale",
    status: "running",
    progress: { step: 0, total: 0 },
    outputs: [],
    error: null,
    ...overrides,
});

const succeeded = () =>
    json(
        run({
            status: "succeeded",
            outputs: [{ index: 0, kind: "image", mime: "image/png", bytes: 3, filename: "task_upscale_1.png", url: `/api/canvases/${CANVAS_ID}/files/task_upscale_1.png` }],
        }),
    );

type Call = { url: string; method: string; body: unknown };

/** Where the server is in these cases: `serverProtocolRoot` strips the legacy `/v1`, nothing else. */
const ROOT = "http://127.0.0.1:8190";

/** The name the server gives an uploaded file: its id is that name, not a handle of its own (#156). */
const UPLOAD_ID = "up-9f01ab2c.png";

/**
 * Route a stubbed fetch by the **whole** URL, and answer `404` to anything else.
 *
 * This is deliberate. A stub that matched a path suffix (`url.endsWith("/runs")`) accepts a request sent
 * to the wrong place, and the test then passes on a URL the server does not serve — which is exactly how
 * `POST /api/runs` survived #156 until a browser click found it (#161). Here an unexpected address is a
 * failure the caller cannot miss.
 */
function stubServer(handlers: { status?: () => Response } = {}) {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: String(init.method || "GET"), body: init.body });
        if (url === `${ROOT}/api/canvases/${CANVAS_ID}/uploads`) return json({ upload: { id: UPLOAD_ID, kind: "image", mime: "image/png", bytes: 3, filename: "source.png" } });
        if (url === `${ROOT}/api/canvases/${CANVAS_ID}/runs`) return json(run({ status: "queued" }), 202);
        if (url === `${ROOT}/api/runs/task_upscale_1`) return handlers.status?.() ?? succeeded();
        return json({ error: { code: "not_found", message: `no such route: ${init.method || "GET"} ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, fetchMock };
}

/** The JSON body of the one run-submission call. */
function runBody(calls: Call[]) {
    const call = calls.find((item) => item.url === `${ROOT}/api/canvases/${CANVAS_ID}/runs` && item.method === "POST");
    if (!call) throw new Error(`no run was submitted; the calls were ${calls.map((item) => `${item.method} ${item.url}`).join(", ")}`);
    return JSON.parse(String(call.body));
}

beforeEach(() => {
    vi.unstubAllGlobals();
});

/** A config whose one model is a *step*: no prompt binding, one declared knob. */
const stepServer = () =>
    ({
        ...server(),
        channels: [
            {
                id: "local",
                name: "local",
                baseUrl: "http://127.0.0.1:8190/v1",
                models: [
                    {
                        name: "image-esrgan-upscale",
                        capability: "image",
                        workflowId: "image-esrgan-upscale",
                        tool: true,
                        hasPrompt: false,
                        imageInputs: 1,
                        parameters: [{ key: "upscale_model", type: "select", options: ["RealESRGAN_x2plus.pth", "RealESRGAN_x4plus.pth"], default: "RealESRGAN_x2plus.pth" }],
                    },
                ],
            },
        ],
        model: "local::image-esrgan-upscale",
        imageModel: "local::image-esrgan-upscale",
        params: { upscale_model: "RealESRGAN_x4plus.pth" },
    }) as unknown as Config;

describe("an image node running a step", () => {
    it("sends the declared knob and the source picture, and no prompt", async () => {
        const { calls } = stubServer();

        await requestEdit(stepServer(), "words an upscaler never reads", [image("source.png")]);

        const body = runBody(calls);
        expect(body.workflow).toBe("image-esrgan-upscale");
        // No `prompt`, no `size`, no `mode`: the upscaler declares none of them, and the server accepts and
        // ignores an undeclared key, so sending one would read as a knob that did nothing.
        expect(body.inputs).toEqual({ upscale_model: "RealESRGAN_x4plus.pth" });
        expect(body.media).toEqual({ image: [UPLOAD_ID] });
    });
});

// A step that takes words: the angle re-render is told what to keep and what to change, and it is one of the
// workflows the canvas drives from a button. It is a step because it is a tool — not because it has no prompt
// box — so its request carries the prompt *and* its knobs (docs/decisions.md #267).
const angleServer = () =>
    ({
        ...server(),
        channels: [
            {
                id: "local",
                name: "local",
                baseUrl: "http://127.0.0.1:8190/v1",
                models: [
                    {
                        name: "image-qwen21-angle",
                        capability: "image",
                        workflowId: "image-qwen21-angle",
                        tool: true,
                        hasPrompt: true,
                        imageInputs: 1,
                        parameters: [],
                    },
                ],
            },
        ],
        model: "local::image-qwen21-angle",
        imageModel: "local::image-qwen21-angle",
        params: { horizontalAngle: 30, pitchAngle: 5, cameraDistance: 4 },
    }) as unknown as Config;

describe("a step that takes words", () => {
    it("sends the prompt beside its knobs, and only because it binds one", async () => {
        const { calls } = stubServer();

        await requestEdit(angleServer(), "keep the colours, turn the camera left", [image("source.png")]);

        const body = runBody(calls);
        expect(body.workflow).toBe("image-qwen21-angle");
        expect(body.inputs).toEqual({ prompt: "keep the colours, turn the camera left", horizontalAngle: 30, pitchAngle: 5, cameraDistance: 4 });
        expect(body.media).toEqual({ image: [UPLOAD_ID] });
    });
});

// `layout` is the node's own word, not a mode the server has: it means "a text-to-image run whose prompt
// carries a MOSS layout". Reading it off the *resolved* mode dropped the layout on every workflow without
// variants — the case that actually works — while sending nothing (docs/decisions.md #271).
describe("a layout run", () => {
    const layout = { rows: [{ cells: [{ nodeId: "image-1", w: 1, h: 1 }] }] };
    const moss = () =>
        ({
            ...server(),
            imageMode: "layout",
            layout,
            channels: [
                {
                    id: "local",
                    name: "local",
                    baseUrl: "http://127.0.0.1:8190/v1",
                    models: [{ name: "image-moss-sft-8step", capability: "image", workflowId: "image-moss-sft-8step", hasPrompt: true }],
                },
            ],
            model: "local::image-moss-sft-8step",
            imageModel: "local::image-moss-sft-8step",
        }) as unknown as Config;

    it("carries the layout, and sends no mode the workflow does not have", async () => {
        const { calls } = stubServer();

        await requestGeneration(moss(), "a poster in four panels");

        const body = runBody(calls);
        expect(body.inputs.layout).toEqual(layout);
        expect(body.inputs.layoutEnabled).toBe(true);
        // A workflow with no variants is sent no `mode` at all, exactly as before.
        expect(body.inputs.mode).toBeUndefined();
    });

    it("pins a declared mode when the family has one, and still carries the layout", async () => {
        const { calls } = stubServer();
        const family = {
            ...moss(),
            channels: [
                {
                    id: "local",
                    name: "local",
                    baseUrl: "http://127.0.0.1:8190/v1",
                    models: [
                        {
                            name: "image-family",
                            capability: "image",
                            workflowId: "image-family",
                            hasPrompt: true,
                            variantModes: ["edit", "t2i"],
                            contracts: { edit: { accepts: { images: { min: 1, max: 4 } } }, t2i: { accepts: { images: { max: 0 } } } },
                        },
                    ],
                },
            ],
            model: "local::image-family",
            imageModel: "local::image-family",
        } as unknown as Config;

        await requestGeneration(family, "a poster in four panels");

        const body = runBody(calls);
        // `layout` is not a mode this family declares, so the run pins the mode that asks least — and the
        // layout, which is what the node asked for, is still attached.
        expect(body.inputs.mode).toBe("t2i");
        expect(body.inputs.layout).toEqual(layout);
    });
});

// A knob the running model does not declare used to be sent and refused: `unknown_input`, on a field the user
// never typed. The node keeps its params when the model changes, so the request is where they are pruned
// (docs/decisions.md #274).
describe("a stale knob", () => {
    it("is dropped from the request instead of being refused by the server", async () => {
        const { calls } = stubServer();
        const image = {
            ...server(),
            channels: [
                {
                    id: "local",
                    name: "local",
                    baseUrl: "http://127.0.0.1:8190/v1",
                    models: [{ name: "image-z-image-turbo", capability: "image", workflowId: "image-z-image-turbo", hasPrompt: true, inputs: ["prompt", "size", "seed", "editCanvasSize"] }],
                },
            ],
            model: "local::image-z-image-turbo",
            imageModel: "local::image-z-image-turbo",
            // `upscale_model` is what the upscaler wrote onto the node before the model was changed.
            params: { upscale_model: "RealESRGAN_x4plus.pth", seed: 7 },
        } as unknown as Config;

        await requestGeneration(image, "a brass compass");

        const body = runBody(calls);
        expect(body.inputs).toEqual({ prompt: "a brass compass", seed: 7, size: "1024x1024" });
    });

    it("covers the engine's own keys too, not only the knobs", async () => {
        // `size` and `quality` are the server's keys, and a workflow offers each only where it declares what reads
        // it (#302). This one declares neither, so the canvas sends neither — a key the run would ignore is not a
        // key to send.
        const { calls } = stubServer();
        const image = {
            ...server(),
            channels: [
                {
                    id: "local",
                    name: "local",
                    baseUrl: "http://127.0.0.1:8190/v1",
                    // Qwen's contract, which reads neither `size` nor `quality`: its picture follows the reference
                    // and its own `resolution` knob.
                    models: [{ name: "image-qwen21", capability: "image", workflowId: "image-qwen21", hasPrompt: true, inputs: ["prompt", "mode", "seed", "cfg", "resolution"] }],
                },
            ],
            model: "local::image-qwen21",
            imageModel: "local::image-qwen21",
            params: { seed: 7 },
        } as unknown as Config;

        await requestGeneration(image, "a brass compass");

        const body = runBody(calls);
        expect(body.inputs).toEqual({ prompt: "a brass compass", seed: 7 });
    });
});

/**
 * What a run is told about shape, from the answer the graph published for it.
 *
 * The card and the request used to compute this separately, and they came apart: a stored `2:1` drew a 1536x864
 * card while the run asked for 2048x1024, and `auto` drew a square card while the graph drew its own portrait.
 * Both readers now go through `planRunShape`, so these cases pin the request half against the card half
 * (`node-card-size.test.ts` pins the other) — #359.
 */
const withShapeAnswer = (name: string, output: Record<string, string>, inputs: string[]) =>
    ({
        ...server(),
        channels: [{ id: "local", name: "local", baseUrl: "http://127.0.0.1:8190/v1", models: [{ name, capability: "image", workflowId: name, hasPrompt: true, inputs, output }] }],
        model: `local::${name}`,
        imageModel: `local::${name}`,
    }) as unknown as Config;

describe("what a run is told about shape", () => {
    it("states the size a graph sized by the ask was asked for, and the card is drawn at that same shape", async () => {
        const { calls } = stubServer();
        const config = { ...withShapeAnswer("image-zit", { sizedBy: "ask", pixels: "832x1216" }, ["prompt", "size"]), size: "1536x864" };

        await requestGeneration(config, "a lighthouse at dawn");

        expect(runBody(calls).inputs.size).toBe("1536x864");
        // The agreement the bug was: the shape the request states and the shape the card frames are one number.
        const card = planRunShape(config, "image", { model: "image-zit", size: "1536x864" });
        expect(card.size).toBe("1536x864");
        expect(card.shape!.width / card.shape!.height).toBeCloseTo(1536 / 864, 4);
    });

    it("sends no size for a graph that draws its own, and reads the shape off its knob", async () => {
        const { calls } = stubServer();
        const config = { ...withShapeAnswer("image-qwen", { sizedBy: "squareOf", key: "resolution", pixels: "1024x1024" }, ["prompt", "resolution"]), params: { resolution: 1536 } };

        await requestGeneration(config, "a brass compass");

        expect(runBody(calls).inputs.size).toBeUndefined();
        // The card still knows the shape: the square the knob says, not the size the canvas happens to hold.
        expect(planRunShape(config, "image", { model: "image-qwen", size: "1024x1024", params: { resolution: 1536 } }).shape).toEqual({ width: 1536, height: 1536 });
    });

    it("sends no size for a graph that keeps the picture it was handed", async () => {
        const { calls } = stubServer();
        const config = { ...withShapeAnswer("image-keep", { sizedBy: "source" }, ["prompt"]), size: "1536x864" };

        await requestGeneration(config, "repaint the window");

        expect(runBody(calls).inputs.size).toBeUndefined();
    });

    it("sends no size for `auto`, so the graph draws what it was built to draw", async () => {
        const { calls } = stubServer();
        const config = { ...withShapeAnswer("image-zit", { sizedBy: "ask", pixels: "832x1216" }, ["prompt", "size"]), size: "auto" };

        await requestGeneration(config, "a lighthouse at dawn");

        expect(runBody(calls).inputs.size).toBeUndefined();
        // and the card is the graph's own shape rather than a square invented next to it
        expect(planRunShape(config, "image", { model: "image-zit", size: "auto" }).shape).toEqual({ width: 832, height: 1216 });
    });

    it("refuses a size a run would not take, in the words of the rule it broke", async () => {
        stubServer();
        const config = { ...withShapeAnswer("image-zit", { sizedBy: "ask", pixels: "832x1216" }, ["prompt", "size"]), size: "2:1" };

        await expect(requestGeneration(config, "a lighthouse at dawn")).rejects.toThrow("apiErrors.invalidImageSizeFormat");

        const lopsided = { ...config, size: "1600x480" };
        await expect(requestGeneration(lopsided, "a lighthouse at dawn")).rejects.toThrow("apiErrors.imageRatioLimit");
    });
});
