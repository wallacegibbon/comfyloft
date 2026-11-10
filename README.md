# Comfy Loft

A local workbench for ComfyUI: images, video and audio made on your own machine. No cloud API, no
vendor account, no per-image bill — the models, the graphs and the hardware are yours.

## Credits

This project is a fork of
[1314521gjy/ComfyUI-Local-Infinite-Canvas](https://github.com/1314521gjy/ComfyUI-Local-Infinite-Canvas),
itself a modified copy of [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas).
Both are MIT; their copyright notices and licence texts are kept verbatim at
[`frontend/LICENSE`](frontend/LICENSE), and this project is MIT too ([`LICENSE`](LICENSE)).

Both halves have been rewritten since: the server is a Go service where the fork shipped Node, and the
canvas has been reworked rather than patched. Nothing from upstream is compatible in either direction —
treat `frontend/` as this project's own code.

## Not an OpenAI-compatible server

This is the largest departure from the fork, and it is deliberate. The upstream project presented ComfyUI
as an **OpenAI-compatible provider**: `/v1/models` listed the workflows, and generation went through
`/v1/images/generations`, `/v1/videos` and `/v1/audio/speech` — the shape a cloud-model client already
speaks. All of them are deleted here — `/v1/models` in #68, the nine generation routes in #69 — not
deprecated.

What this server speaks instead is a small protocol of its own, laid directly over ComfyUI's vocabulary:

| Idea | Where it lives |
| --- | --- |
| a **workflow** | `workflows/registry.json` + `workflows/<type>-<slug>.json`; `GET /api/workflows` reports them, and `GET /api/workflows/{id}/schema` publishes the inputs each accepts |
| a **run** | one submission of one workflow, `POST /api/canvases/{id}/runs`: an id, typed `inputs`, `progress`, `outputs`, `error` |
| a **canvas** | the workspace that owns the uploads a run is given and the media it produces |

There is no `/v1/...` route, no chat-completions envelope, no OpenAI `object` field. `/v1/...` appears in
this repository only as the address that AlayaCore's own model provider answers on.

**Why** A ComfyUI graph does not fit one text prompt plus a handful of vendor fields. Which reference
images, first or last frame, which LoRA at which strength, which base model, which seed, how many outputs
— an OpenAI-shaped endpoint can only carry those by smuggling them through the prompt string or a
proprietary `extra_body`, and an API that needs that has stopped being compatible. The canvas is the only
client, so imitating someone else's API buys nothing: the protocol describes the domain instead, every
input is checked at submission against the same schema it publishes, and there is no compatibility branch
to maintain ([`docs/protocol.md`](docs/protocol.md)).

**What it costs** A client that only speaks OpenAI cannot drive this server. There is no drop-in for a
generic image or chat tool, and a new integration has to read `docs/protocol.md` and speak this protocol.
That is the trade: one client shaped like the domain rather than many shaped like none of it.

## What it does

- **Infinite canvas**: text / image / video / group nodes; wiring, box selection, export, autosave.
- **Workflows are the unit**: the server runs ComfyUI workflows (`GET /api/workflows`, `POST /api/canvases/{id}/runs`) and reports what each accepts; the canvas decides which of them the picker offers.
- **Images**: Z-Image Turbo, MOSS SFT (8-step, regional layout), Qwen Image 2.1 (multi-image edit, masked inpaint, outpaint).
- **Video**: MiniMax-H3 text-to-video, first/last-frame and multi-reference, with sampling preview and LoRA cards.
- **Upscaling**: ESRGAN for images.
- **LoRA card**: a node that carries a LoRA and its strength into whatever it is wired to.
- **Prompts come from AlayaCore**: one `alayacore --rawio` process per request, its frames relayed to the canvas; the model, the skills and the wording are the agent's.
- **System panel**: VRAM / RAM / GPU / ComfyUI status, one-click VRAM release.
- **Local-only by construction**: there is no cloud mode and no flag to re-enable one. The image/video/prompt workbenches, the cloud model channels, the prompt library and the prompt-API settings tab are deleted, not hidden: there is one channel, it is the server that served the page, and prompts are the agent's (`docs/decisions.md` #71, #76).

## Layout

The repository root *is* the Go server (`cmd/` + `internal/` + runtime assets);
the canvas frontend is a self-contained subtree beside it (see Credits):

```text
.
├── cmd/
│   ├── comfyloft-server/   # the service: API, workflows, the canvas's websocket
│   └── comfyloft-mcp/     # the stdio bridge AlayaCore spawns to reach the canvas tools
├── internal/          # the whole server (config/comfy/workflow/generate/resource/prompt/…)
├── workflows/         # what the product exposes: graphs + registry.json
├── resources.json     # what has to be installed: models, node packs, runtime deps
├── prompts/           # prompt skill files
├── data/              # runtime state: tasks.json, settings.json, resource-lock.json (not tracked)
├── canvases/          # the workspace: one directory per canvas (not tracked)
├── bin/               # build output (not tracked)
├── frontend/          # the canvas frontend (from the upstream project, since reworked)
├── docs/              # server API and env vars, the run protocol, prompt optimization, runtime deps
├── tools/             # development scripts and the dead-export check (`tools/deadcode`)
├── Makefile           # make build / check / check-full / verify-static / frontend / frontend-check
└── start.sh           # builds what is missing or out of date, then starts the server (serves the canvas)
```

Two directories carry the runtime assets, and the split is deliberate:

- **`workflows/`** is the outward face: one graph per model, plus `registry.json` describing
  how it is presented (name, type, prompt binding, parameters). Adding a model means dropping
  a `<type>-<slug>.json` here and scanning.
- **`resources.json`** is inward: it lists what has to be present on the machine (models,
  custom nodes, runtime deps). Nothing is bundled with the binary: a model comes from its URLs and a
  node pack comes from its archive, both pinned — a model by `sha256`, a node pack by
  `pinnedCommit`. A `payload/` directory is still honoured as an escape hatch if a file ever has to
  ship inside the release; nothing is staged there today.

  A pack does not list the files it needs: those are read off the graphs under `workflows/`, so the
  panel and the workflows cannot disagree. The only list a pack writes down is its `alternates` — the
  second precision of a base model, the other upscale checkpoints — because no graph names them.

What does ship with the installer is the application itself: the server binary, the canvas bundle,
the graphs under `workflows/` and this index. That is why the panel lists no pack for them — a pack is
a bundle of downloads, and the installer's own files are not one.

## Language

Everything written for a human is **English**: documentation, code comments, log lines, error
messages and commit messages. Two kinds of text do not follow the rule, and only because they
are data or user-facing copy rather than prose:

- **UI copy** lives in the i18n dictionaries (`frontend/src/i18n`), never inline in
  a component, so the same screen can be read in Chinese and English. A workspace that has never
  chosen a language opens in English, and English is the fallback (decisions #170). That includes workflow
  metadata: `workflows/registry.json` is English (it is data the server serves) and the canvas
  translates the labels it displays by model id — `frontend/src/lib/server-labels.ts`, decisions
  #20.
- **Model-facing and protocol Chinese** — H3 writing instructions in `internal/prompt`, the
  Chinese-matching regexes, and ComfyUI mode strings such as `文生视频(T2VA)` — stays Chinese
  because translating it would change generation behaviour or break parsing.

The reasoning and the exact exceptions: [`docs/decisions.md`](docs/decisions.md) #8, #9, #17, #20.
What Chinese still lives in the source, and why each line is data rather than copy, is #216.

## Quick start

```bash
# Dependencies (first run)
make frontend          # installs frontend deps if needed, then vite build
make build             # Go server, static binary; start.sh rebuilds it when it is out of date

# Configure and start
cp .env.example .env   # adjust COMFY_URL / COMFYLOFT_SERVER_HOST for this machine
                        # (INSTALL_INTO_COMFY=1 there is what allows the panel to install models)
./start.sh
```

Canvas and server `http://127.0.0.1:8190` — one process, one port: the server serves the bundle
(docs/decisions.md #219).
ComfyUI `http://127.0.0.1:8188` must already be running; the workbench only connects, never starts it.

> The canvas bundle `frontend/dist/` is build output and is not tracked. `./start.sh` rebuilds it when it is
> missing or older than the sources it is built from, so a restart is enough; `make frontend` builds it
> without starting anything, and `make frontend-check` typechecks without emitting. `WEB_DIR` is what points
> the server at it (`start.sh` and `make run` set it); a server without it answers `/api/*` only, which is
> the development shape.
>
> The two binaries are treated the same way: `./start.sh` rebuilds `bin/comfyloft-server` and
> `bin/comfyloft-mcp` when either is missing or older than `cmd/`, `internal/`, `go.mod` or `go.sum`, so
> editing a `.go` file and restarting is enough. A release directory holds no sources, so it starts with no
> Go toolchain on the machine at all.

### Reaching the workbench from another device

`COMFYLOFT_SERVER_HOST` is a listen address, not a policy switch: put the machine's LAN address there and the
server binds it, the same way `127.0.0.1` binds loopback. Nothing else has to be enabled.

```bash
# .env
COMFYLOFT_SERVER_HOST=192.168.3.232  # the server, and therefore the canvas
COMFYLOFT_SERVER_PORT=8190
```

That is the whole change: the canvas is served from the same address, so open
`http://192.168.3.232:8190` from the phone and it is the workbench. Nothing writes an address into the
page any more (`/config.js` carries the workspace preferences, from the server's own settings document),
and nothing has to be added to `CORS_ORIGINS`, because the page and its pictures are one origin. Serving
the canvas from *another* host is still possible — that is what `PUBLIC_BASE_URL`, `CORS_ORIGINS` and
`RUNTIME_CONFIG_PATH` are for.

One thing to know when the server is reachable from the network: **it has no authentication.** Any
device that can reach the port can run a workflow, read its artifacts and drive a canvas's agent (the
server warns about this at startup). There is no token to turn on — the browser could not have kept
one — so the choice is the address you bind and the network it sits on.

Server endpoints and environment variables: [`docs/server.md`](docs/server.md).

## Processes and interface ownership

Three processes, all calls one-directional; the browser only talks to the server.

| Process | Port | What it is | Started by |
|---|---|---|---|
| Server | `8190` | Go static binary that runs ComfyUI workflows through its own run protocol — and serves the canvas bundle | `./start.sh` |
| ComfyUI | `8188` | Python, does the actual image / video work | You, wherever it runs — nothing here starts it |
| alayacore | *(spawned per request)* | The agent that answers prompts | The ecosystem's own install |

```text
browser ─→ :8190 server ─┬─→ :8188 ComfyUI      images / videos
```

The frontend sources contain no reference to `8188`; the canvas never bypasses the server.

**There are no other background services.** The local agent used by Codex and the
CORS-avoidance proxy have been removed from the repository; `./start.sh` starts one server process,
which also answers `GET /` with the bundle it sits beside.

### Where each endpoint lives

**The server serves no `/v1/...` at all.** It has its own protocol — `POST /api/canvases/{id}/runs`
produces every kind of media, `GET /api/workflows` describes what can run — and OpenAI's paths are not
among its endpoints; [Not an OpenAI-compatible server](#not-an-openai-compatible-server) says why.
`/v1/...` in this repository belongs to the model provider AlayaCore talks to.

**Server `:8190` endpoints:**

| Endpoint | Purpose |
|---|---|
| `/api/canvases*` | The workspace: list, create, read, save and delete a canvas, and serve its files |
| `/api/canvases/{id}/runs`, `/api/runs*` | Produce media into a canvas (submit, poll, download, cancel) |
| `/api/canvases/{id}/uploads` | Stage one media file inside that canvas |
| `/api/canvases/{id}/files/{name}` | One file of that canvas |
| `/api/canvases/import` | One exported canvas zip in, one canvas out |
| `/api/settings` | The workspace preferences: one document the canvas defines |
| `/api/workflows/*` | Workflow metadata, schemas, and the ComfyUI availability scan |
| `/api/agent/socket/{session}`, `/api/agent/session/{session}` | The agent: one WebSocket per session, named by the surface that owns it |
| `/mcp` (its own listener) | The agent's hands: the MCP server a session's tool calls arrive at. Loopback only |
| `/api/resources/*` | Download models, install custom nodes |
| `/api/system/*`, `/api/loras`, `/health` | System status, LoRA files, liveness |
| `GET /` (and any path that is not `/api/*`) | The canvas bundle: `WEB_DIR`'s files, or its `index.html` for a client-side route. Unset `WEB_DIR`, and only `/api/*` is answered |
| `GET /config.js` | The workspace preferences as the script the page loads before its bundle, so the theme and the language are right on the first frame |

**ComfyUI `:8188` endpoints** — only the server's ComfyUI client (`internal/comfy`) calls
these, the canvas never sees them:

`POST /prompt`, `GET /history/:id`, `GET /view`, `POST /upload/image`, `GET /object_info`,
`GET /internal/folder_paths`, `GET /system_stats`, `POST /free`, `POST /interrupt`, `/queue`

**AlayaCore** — spawned by the server, one process per prompt request
(`alayacore --rawio --builtin-tools=read_file --skill <container> --config-path <dir>`), speaking its
own frame protocol on stdin/stdout. Its model list, model choice and skills are its own
`model.conf`; the server names the directory and never reads it.

> ⚠️ A server "model" **is** a workflow: `image-z-image-turbo`, `video-h3-t2v`, and one id per
> installed base model. They come from `GET /api/workflows`. A **prompt** model is a different thing
> and belongs to the agent — the two lists have nothing to do with each other.

## Documentation

- [`docs/server.md`](docs/server.md): server endpoints, environment variables, architecture and language policy.
- [`docs/protocol.md`](docs/protocol.md): the run protocol — submit, poll, outputs, media and errors.
- [`docs/decisions.md`](docs/decisions.md): why the code looks the way it does — one entry per decision, with its cost.
- [`docs/known-issues.md`](docs/known-issues.md): the open problems, what breaks and what the fix is.
- [`docs/runtime-deps.md`](docs/runtime-deps.md): SageAttention and other runtimes must be installed with `pip` by hand (the workbench no longer does it).
- [`tools/bake-moss-preset.py`](tools/bake-moss-preset.py): bakes MOSS Base+SFT into `moss_balanced_s100.safetensors` — the `builder` behind the `type: "bake"` entry in the resource index; run it with ComfyUI's Python (it imports torch).
- [`tools/deadcode`](tools/deadcode/main.go): the Go half of the canvas's export check — `make deadcode` fails on an exported identifier nothing outside its own file can reach.

## License

MIT, see [`LICENSE`](LICENSE).
