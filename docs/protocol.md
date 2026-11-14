# The server protocol

Status: **landed, and `/v1/*` is gone** (decisions #69). Every media type and every canvas node submits a
run, and so does every tool action that a workflow can do; there is no second way to *generate* media. What
the migration left behind is the shape:

- One execution core over the task store. Video, audio, image and every tool action submit through it.
  Two actions do not, because nothing is asked of a model: joining clips is a mux (`POST
  /api/canvases/{id}/join`, #324) and taking a frame out of a clip is a draw on a canvas in the page (#323).
- Media type is **data**, not routing: `accepts` / `frameMode` / `mode` / `promptInject` / `promptReorder` /
  `sourceVideoFrames` live in `registry.json` and are resolved by `workflow.PlanMedia`; no handler names a
  workflow id, and `outputs.formats` declares the containers an encoder can write.
- `inputs` is typed and checked at submission, with `GET /api/workflows/{id}/schema` publishing the same
  contract (see "What a run may carry, exactly").
- The canvas is the only client: it submits, keeps the run id on the node, drives the step ring from
  `progress`, resumes polling after a reload, and cancels when the user stops it.

**One user action may be several runs.** Raising a clip's frame rate is two GPU jobs (generate, then
interpolate), so it is two runs — the canvas chains them, exactly as its "interpolate" button always
did. A run stays "one workflow, one job", which is what keeps `status`, `progress`, `error` and
`outputs` honest; chaining is the client's business.

The routes below are the contract to build against, and they are the real thing, not a target: every
one of them is served today.

The canvas is the only client. A protocol aimed at one known caller can describe *our* domain
instead of imitating someone else's API, and every compatibility branch we do not need is code
we would maintain forever.

This is not ComfyUI's graph API with renamed fields. ComfyUI exchanges *graphs* (node ids, classes,
every link); the server exchanges *workflow runs* (a workflow id, typed inputs, media roles). The
two share the job skeleton — submit, id, poll, fetch — because the executor underneath is ComfyUI;
the comparison, endpoint by endpoint, is in [`server.md`](server.md#relationship-to-comfyuis-http-api).

## Four resources

```
workflow   what can run        read-only catalog, from workflows/registry.json
canvas     what owns the work  a directory: the document, and files/ for its media
upload     what goes in        a file written into that canvas's files/, referenced by its name
run        one execution       created by POST, owned by an id, terminal once
output     what comes out      one more file in the same canvas's files/
```

That is the whole model. Media type is **data**, not routing: an image, a video and a song are
three runs of three workflows, not three families of endpoints. A run is never free-floating: it was
submitted into a canvas, its bytes land in that canvas, and deleting the canvas deletes them.

## Endpoints

Every write names its canvas, and the two read paths for bytes are files of that canvas.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/workflows` | Catalog, including availability (`null` when no scan has judged a workflow). |
| `GET` | `/api/workflows/{id}/schema` | Machine-readable inputs, media roles, outputs. |
| `POST` | `/api/canvases/{id}/uploads` | Multipart upload of one media file into that canvas. Returns its id, which is its file name in `files/`. |
| `POST` | `/api/canvases/{id}/runs` | Submit a run into that canvas. Always returns `202` with the run. |
| `GET` | `/api/runs/{id}` | Status, progress, outputs, error. |
| `GET` | `/api/runs/{id}/preview` | Best-effort in-flight preview frame (may be absent). |
| `DELETE` | `/api/runs/{id}` | Cancel. Idempotent; also interrupts ComfyUI. |
| `GET` | `/api/runs` | List/filter runs (`status`, `workflow`), newest first. |
| `GET` | `/api/canvases/{id}/files/{name}` | The bytes of one file: an upload, or a finished run's artifact. Cacheable for good — a name is written once. |
| `POST` | `/api/canvases/import` | One exported canvas archive (a zip: `canvas.json`, `manifest.json`, `files/<name>`) in, one canvas out. The files keep the names the document uses, so nothing is rewritten. |
| `POST` | `/api/canvases/{id}/join` | Join that canvas's own clips into one file, in the order named. Not a run: a stream copy, refused with the field that differs when the inputs disagree, and `reencode: true` when the caller means to rewrite every frame. Answers like an upload. |

`/health`, `/api/canvases*`, `/api/settings`, `/api/loras`, `/api/resources/*`, `/api/system/*`,
`/api/speech/*` and `/api/agent/*` are the rest of the surface: they manage the server, the workspace, the
resource packs, dictation and the conversation. None of them runs a workflow except by submitting a run
([`server.md`](server.md) lists them all).

## Submitting a run

`POST /api/canvases/<id>/runs`, one JSON body:

```json
{
  "workflow": "audio-minimax-music-3",
  "inputs": {
    "prompt": "indie folk, fingerpicked",
    "lyrics": "[Verse]\nline one",
    "seed": 42,
    "duration": 60
  },
  "media": {
    "reference": ["up-9f01ab2c.png"],
    "first_frame": ["up-2b7788de.png"],
    "mask": ["up-7c31e5aa.png"]
  },
  "askedBy": { "session": "canvas:40e8afb47f10", "node": "n12" }
}
```

- **`inputs` keys are the workflow's binding keys.** They are described by
  `GET /api/workflows/{id}/schema` (type, default, min/max, enum, required) and validated by one
  generic checker. There is no `params` escape hatch and no per-workflow branch in the handler.
- **`media` keys are roles, not file names.** The workflow declares which roles it accepts and how
  many (`accepts`), so `mask` and `first_frame` are expressible and a wrong role is a `400`, not a
  silently ignored file. A value is an upload's id, which is its name inside that canvas's `files/`.
- When a workflow has modes (`image-qwen21` has edit/inpaint/outpaint/t2i), `mode` selects one and
  the **first mode is the default**. The variant carries its own graph, bindings and media contract,
  so an inpaint request means "source + mask" without the handler knowing the workflow.
- No `wait`, no `stream`, no synchronous variant: see "The id is the contract" below.
- **`askedBy` is optional, and only an agent sets it.** It names the conversation that asked for the
  run, and the node it asked about, so the server can say what became of the run when it ends — as a
  message from the user, on that session (decisions #225). A body without it is a run the user started.

Response (`202` in every case, including a run that finished instantly). `status` is the state at
the moment the response is written, so a queue that picks the run up immediately answers `running`:

```json
{
  "id": "task_6f2c1d4e-8a3b-4c2d-9e7f-0a1b2c3d4e5f",
  "workflow": "audio-minimax-music-3",
  "status": "queued",
  "progress": { "phase": "queued", "step": 0, "total": 30 },
  "preview": null,
  "outputs": [],
  "error": null,
  "created_at": "2026-10-31T06:00:00Z",
  "started_at": null,
  "finished_at": null
}
```

A `404` here means the canvas does not exist (`canvas_not_found`), not that the workflow is unknown —
an unknown workflow is a `404` with its own code, and there is no default canvas to fall back to.

## Reading a run

`status` is one of `queued`, `running`, `succeeded`, `failed`, `cancelled`. Terminal statuses never
change again. `GET /api/runs/{id}`:

```json
{
  "id": "task_6f2c1d4e-8a3b-4c2d-9e7f-0a1b2c3d4e5f",
  "status": "running",
  "progress": { "phase": "executing", "step": 12, "total": 30 },
  "preview": { "url": "/api/runs/task_6f2c1d4e-8a3b-4c2d-9e7f-0a1b2c3d4e5f/preview?t=1761889200123", "mime": "image/jpeg" },
  "outputs": [],
  "error": null
}
```

`preview` is the in-flight frame while a run renders and `null` otherwise. Its `url` carries the
frame's timestamp, so a poll loop can swap the image it is already showing without a second
endpoint or a cache-busting guess by the client.

And once it is done:

```json
{
  "id": "task_6f2c1d4e-8a3b-4c2d-9e7f-0a1b2c3d4e5f",
  "status": "succeeded",
  "progress": { "phase": "done", "step": 30, "total": 30 },
  "outputs": [
    {
      "index": 0,
      "kind": "audio",
      "mime": "audio/mpeg",
      "bytes": 118811,
      "filename": "task_6f2c1d4e-8a3b-4c2d-9e7f-0a1b2c3d4e5f.mp3",
      "url": "/api/canvases/40e8afb47f10/files/task_6f2c1d4e-8a3b-4c2d-9e7f-0a1b2c3d4e5f.mp3"
    }
  ],
  "error": null
}
```

One download route for every kind of artifact, and it is the canvas's file route: an artifact is a
file in the canvas the run was submitted into, named once and served like an upload. There is no
base64 mode, no per-media content endpoint, and no per-run output route to keep in step with it.

## Errors

```json
{ "error": { "code": "unsupported_media_role", "message": "…", "details": {} } }
```

`code` is the contract (stable, documented, mapped to localized text by the canvas). HTTP status
carries the class: `400` bad request, `404` unknown workflow/run/canvas, `409` wrong state,
`422` invalid workflow file, `502` ComfyUI failure, `504` timeout. No `type` field: it would only
repeat the status code.

## What a run may carry, exactly

`GET /api/workflows/{id}/schema` returns `inputs`: the closed list of keys a run accepts, with type,
required, range and (where the server owns the value set) the allowed options. A run is validated
against it **at submission**, so a mistake is a `400` now rather than a failed run minutes later.

The list is assembled from the two sources that make a key reach something — the engine's own request keys, and
the workflow's bindings — and then *decorated* with what the workflow declares about it, so no workflow has to
restate it:

1. The request-level keys the engine itself reads, each only where the workflow declares what consumes it:
   `prompt` (required whenever there is a prompt binding), `size` (a binding sized from `size.*`), `quality` (a
   binding reading a `quality.*` preset field), `seconds` (a binding converting seconds), `mode` (the workflow has
   variants), `frameMode` (it declares a frame-mode rule), `background` (it declares a background prompt),
   `editCanvasSize` (it declares an output size), `layout`/`layoutEnabled` (it renders a layout), and `loras`
   (engine-owned; the stack is refused rather than ignored when a graph cannot take it). There is **no `duration`**
   key: a length is `seconds`. There is **no batch key**: `count` and `n` are refused with `unknown_input`, so N
   pictures are N runs; a graph that batches internally still returns one row per artifact in `outputs`, which is
   why the list carries an `index`. There is **no negative prompt** either: a key by that name anywhere is a `400`,
   and a graph that has a negative text encoder carries its own string, which the server never writes
   (decisions #288).
2. The key every non-media binding *reads*, which need not be the name it has: `horizontal` reads
   `params.horizontalAngle`, so `horizontalAngle` is the caller's key. A binding with no source
   (`task_type`) contributes the key it is named after. A binding whose value is derived from
   somewhere else (`size.width`, `seconds`, `quality.steps`) reads no request key and contributes
   none — advertising it would be a key that is accepted and then ignored, the same failure as a typo
   that does not error.
3. The workflow's declared `parameters` (`seed`, `steps`, `cfg`, `sampler`, …) are the *presentation*
   of those keys: label, range, options, and the value a panel shows before anything is typed. They
   add no key of their own; a parameter that describes nothing (the audio workflow's length bound) is
   prose for the panel, not an input.

A workflow with modes publishes one list per mode (`variantContracts`), read off the entry that mode runs rather
than off its parent: a mode is a different graph, so the list a request names is the list it is validated against
(decisions #303).

Rules worth knowing:

- **Unknown keys are rejected**, with the accepted list in the message. A typo (`setps`) used to be
  ignored silently, which is the worst possible outcome.
- **Media keys are rejected with a pointer**: `refs` is a binding name, but media travels in
  `media.<role>`; the error says so.
- **`quality` is a closed set** (the workflow's preset names plus `auto`) because the server owns
  that vocabulary.
- **Other `select` options are advisory.** A sampler list in `registry.json` is a UI suggestion;
  ComfyUI has more valid samplers than the canvas offers, and rejecting one would be wrong.
- **The output container is checked too.** A workflow declares which containers its encoder writes
  (`outputs.formats`), and requesting another one is a `400` at submission — not a run that fails in
  ComfyUI a minute later. The quality value the selected container requires is filled in from the
  same declaration.
- **The server does not bound a `size`.** It checks the shape — a `size` input is a string `util.ParseSize`
  reads, nothing more — and that the workflow reads the key at all; the ceiling a canvas applies (3840 px on the
  longest side, at most 3:1, 655360–8294400 pixels in total, both sides aligned to 16) is that client's policy,
  not this protocol's. So a caller that is not the canvas may ask for more, and what happens then is the graph's
  and the encoder's business rather than a number this server invented (decisions #306: the limits live in
  `frontend/src/services/api/image.ts`, where the control that promises them is).
- **A workflow may be a step, not a model.** `video-rife` has no prompt: it takes a clip and a
  multiplier. The server does not care — it runs any registered workflow — but it also does not
  pretend such a step is a model a client picks from a list.
- Values reach the bindings unchanged, which is why a new workflow becomes runnable without a new
  route or a new struct.
- **A request is validated once.** `POST /api/canvases/{id}/runs` rejects an unknown key, a wrong
  type, a media mix the workflow does not accept, and an output container the encoder cannot write —
  all before the run is queued. The adapters it replaced each had their own idea of leniency; there
  is only one idea now.

## The id is the contract

`POST` hands out the run id at submission time. Everything after that — progress, outputs, cancel —
hangs off it. Consequences:

- A task longer than any HTTP timeout is fine.
- A browser reload, a closed tab, a dropped tunnel: the run keeps going and can be collected later.
- There is exactly one success shape (`202` + run), so a client has exactly one code path.

One user action may be several runs (generate, then raise the frame rate). Each run stays one
workflow and one job, so its `status`, `progress`, `error` and `outputs` describe exactly one thing;
chaining is the client's business, and the canvas already models it as a second node.

This is why there is no `wait` parameter. A blocking variant would return two different success
shapes (`200` with outputs, `202` with a run), so every client would still have to implement
polling — while the blocking call itself reintroduces the "connection died, work lost" failure the
id exists to remove.

## Execution model

- Runs are queued and executed **one at a time**. ComfyUI owns a single GPU; parallel server
  submissions would only queue inside ComfyUI anyway, with worse diagnostics.
- Every run is persisted (`data/tasks.json`) and reconciled on boot: a run whose output file is
  still in its canvas becomes `succeeded`, a run that was in flight becomes `failed` with an
  explanation.
- Cancelling interrupts the ComfyUI prompt, so the GPU is actually freed.
- A missing model or node is kept out of the canvas's model picker by the availability scan; a run
  request is not gated on that verdict, so a stale or missing one can never refuse a run that would
  work. A run that still fails records the ComfyUI error (code, message, details) on the run.

## What the `/v1` bodies became

The adapters are deleted; what is worth keeping from them is the shape their callers knew. `/v1/videos`'s
`params` JSON string is now `inputs`, and a form field named `image[]` is now `media: {reference: [id]}`.
The full mapping, endpoint by endpoint, is decisions #69 — it is history, not contract.

## Migration, as it happened

Four phases, each leaving the repository runnable and `make check` green: the execution core; the registry as
data; the run routes with the canvas moving node type by node type; and the deletion of the adapters with their
shapes, helpers, tests and docs (#69). Then #156 put runs and uploads under a canvas — `POST /api/runs` and
`POST /api/uploads` were that phase's routes and are gone.

