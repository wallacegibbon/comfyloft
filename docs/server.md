# comfyloft-server (Go)

The server behind Comfy Loft: a local service that runs ComfyUI workflows. It is the repository root
— `cmd/`, `internal/`, and the runtime assets (`workflows/`, `resources.json`, `prompts/`) live at the top
level, while the canvas frontend sits beside them in `frontend/`.

Two names, on purpose (docs/decisions.md #146): the **binary** is `comfyloft-server`, because what it faces
is ComfyUI, and its module path and config directory follow that. The **project's** own identity is
`comfyloft` — the Go module is `comfyloft`, and so are the npm package, the browser storage keys and the
export marker. Display text says `Comfy Loft`.

It is **two statically linked binaries** — `bin/comfyloft-server` (this service) and `bin/comfyloft-mcp`
(the stdio bridge AlayaCore spawns to reach the canvas tools) — and no Node runtime, no `node_modules`,
no Python virtualenv. Configuration comes from the environment; all mutable state lives in `data/`, and
the agent's own configuration lives under the user's config directory (#147).

## Why Go

The server used to be ~7400 lines of JavaScript in the upstream fork, and needed a
matching Node install on every machine. The server is the one component the canvas cannot
work without, so it is now a static binary that starts in milliseconds and cannot break
because a transitive npm package changed. `make verify-static` asserts the build has no
dynamic dependencies at all.

The Go implementation is a port of that Node server.

## Requirements

- Go 1.26+ (build only)
- A running ComfyUI (default `http://127.0.0.1:8188`)
- Optional: `ffprobe` (character-swap workflows read the source video length) and `zenity` (the
  "pick a model file" dialog). The system panel needs neither: its numbers come from ComfyUI.

## Platforms

Nothing in the server is tied to one OS: it is pure Go with `CGO_ENABLED=0`, so it
cross-compiles to the three mainstream targets from any host, and the frontend is just a
browser bundle.

```bash
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o comfyloft-server.exe ./cmd/comfyloft-server
CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -o comfyloft-server-mac ./cmd/comfyloft-server
```

Linux is the target that is actually run and tested. Two things lean on facilities a container or
another OS may not have, and both degrade on their own rather than failing the process:

| What                       | Needs           | Without it                                                             |
| -------------------------- | --------------- | ---------------------------------------------------------------------- |
| "Pick a model file" dialog | `zenity`        | the request fails with a message telling you to type the relative path |
| Character-swap duration    | `ffprobe`       | the run falls back to the workflow's default duration, and says so      |

`start.sh` is a bash script, so Windows needs WSL or Git Bash; running `bin/comfyloft-server`
by hand works anywhere.

## Quick start

```bash
make build          # -> bin/comfyloft-server + bin/comfyloft-mcp (static)
COMFYLOFT_SERVER_HOST=192.168.3.232 ./bin/comfyloft-server
```

Run it from the repository root: the asset root (`workflows/`, `resources/`, `prompts/`)
is discovered from the working directory first, then the executable's directory. Set
`COMFYLOFT_SERVER_ROOT` to override.

Verify: `curl -s localhost:8190/health`.

## Configuration

Every variable is optional; the defaults match the previous implementation.

| Variable             | Default                            | Meaning                                                                                                                                                            |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COMFYLOFT_SERVER_HOST`       | `127.0.0.1`                        | Server listen address, bound as given. `0.0.0.0` accepts every interface.                                                                                         |
| `COMFYLOFT_SERVER_PORT`       | `8190`                             | Server listen port.                                                                                                                                               |
| `COMFY_URL`          | `http://127.0.0.1:8188`            | ComfyUI base URL.                                                                                                                                                  |
| `INSTALL_INTO_COMFY` | _(empty)_                          | `1` = this server can write into ComfyUI's folders (`models/`, `custom_nodes/`) because it runs there or sees them through a mount. Installs stay off without it. |
| `WORKFLOW_DIR`       | `<root>/workflows`                 | Registry directory.                                                                                                                                                |
| `DATA_DIR`           | `<root>/data`                      | Tasks, locks, preferences.                                                                                                                                         |
| `CANVAS_ROOT`        | `<root>/canvases`                  | The canvases, one directory each. This is the workspace: back it up and you have the work.                                                                          |
| `WEB_DIR`            | *(unset)*                          | A canvas bundle to serve from this server: `GET /` answers with its `index.html` and any file under it (#219). `start.sh` and `make run` point it at `frontend/dist`. Unset means the canvas is served elsewhere and only `/api/*` is answered. |
| `RUNTIME_CONFIG_PATH` | *(unset)*                        | An **opt-in** copy of the first-paint script (`GET /config.js`), for a canvas published by a static host with no server in the request path. Written at start and after every save. Unset — the normal case, and what `start.sh` does — means nothing is written: the server answers the route instead. |
| `PUBLIC_BASE_URL`    | `http://COMFYLOFT_SERVER_HOST:COMFYLOFT_SERVER_PORT` | Absolute prefix for the URLs the server returns (run outputs, previews), and the address included in the first-paint script. Set it when a proxy publishes the server under another address, or when the canvas is served from an origin of its own. |
| `CORS_ORIGINS`       | canvas + ComfyUI origins           | Extra allow list for canvases on another host. A canvas on the server's own host is allowed by rule. `*` is refused.                                              |

`COMFYLOFT_SERVER_HOST` is not a policy switch: `COMFYLOFT_SERVER_HOST=192.168.3.232` binds the LAN address exactly
like `127.0.0.1` binds loopback, and the server says so in a startup warning when that address is
reachable from the network.

The canvas comes from this same address (`WEB_DIR`), so the page, its API calls and its pictures are
one origin: no `CORS_ORIGINS` entry to maintain, and no cross-origin image for a canvas to refuse to
export. A canvas served from a _different_ host — `npm run dev` without the proxy, or a static host of
your own — is allowed when it shares the server's host name or is listed in `CORS_ORIGINS`.

### There is no authentication

The server has no token, no password and no user account, and the startup warning says so. What it
does have is one rule enforced by `internal/httpx`: a **browser** may write only from an origin the
operator allowed (its own host, loopback, or `CORS_ORIGINS`), which is what stops a random page from
driving the server through the user's browser.

That rule does not apply to anything that is not a browser, and it was never the whole surface: a
client that can reach the port can submit runs (burning GPU time on the machine behind `COMFY_URL`),
read and delete everything under `CANVAS_ROOT` — the documents and their media — and open
`/api/agent/socket/{name}`, which spawns AlayaCore with `read_file` enabled, so it can also read files
on the server's host. `POST /api/resources/install` is the one dangerous route with its own lock (it
refuses to write into ComfyUI's folders unless `INSTALL_INTO_COMFY=1`).

So the honest statement is: **bind it to loopback, or put it on a network whose devices you trust.**
Reaching it from elsewhere is a job for an SSH tunnel or a reverse proxy that terminates
authentication; there is no configuration in this server that makes an untrusted network safe.
| `REQUEST_TIMEOUT_MS` | `600000` | Image generation timeout. |
| `COMFY_RETRY_ATTEMPTS` | `3` | How many times a **GET** to ComfyUI is retried. A POST is never retried: it can enqueue the same job twice. |
| `COMFY_RETRY_DELAY_MS` | `500` | Base delay between those retries; it grows linearly with the attempt number. |
| `CLEANUP_INTERVAL_MS` | `3600000` | How often finished **run records** are pruned. Only runs when `TASK_RETENTION_DAYS` or `MAX_STORED_TASKS` is set. Deleting a record never deletes an artifact: the files belong to the canvas, and its own sweep collects the ones no document refers to. |
| `MAX_WORKFLOW_BYTES` | `5242880` | How large one file under `workflows/` may be; a bigger graph is refused at scan time. |
| `VIDEO_TIMEOUT_MS` | `10800000` | Video timeout, three hours. A render nobody ends never reports back, so this is a ceiling and not a limit on the work; `0` means no limit, for an operator who means it. |
| `AUDIO_TIMEOUT_MS` | `1800000` | Audio/music timeout, thirty minutes; `0` means no limit. A song is the same order of work as a short video, so it is bounded the same way. |
| `POLL_INTERVAL_MS` | `750` | ComfyUI history poll interval. |
| `SCAN_ON_START` | `1` | Scan ComfyUI for nodes and models at boot. |
| `TASK_RETENTION_DAYS` | `0` | Prune finished run records older than this; `0` keeps everything. Artifacts are not yours to prune here — they belong to a canvas. |
| `MAX_STORED_TASKS` | `0` | Cap on stored tasks; `0` is unlimited. |
| `MAX_UPLOAD_BYTES` | `52428800` | Per-file upload limit. |
| `MAX_IMPORT_BYTES` | `8589934592` | Ceiling for one imported canvas archive: the body and the bytes it unpacks to. Its own number because a canvas archive carries every clip that canvas shows. |
| `RESOURCE_CONCURRENCY` | `2` | Parallel downloads during a resource install. |
| `ALAYACORE_BIN` | _(found)_ | The agent binary. Empty looks on `PATH`, then beside the server. |
| `AGENT_CONFIG_PATH` | `UserConfigDir()/comfyloft-server/alayacore` | The agent's own config directory: `model.conf`, `runtime.conf`, and the `mcp.conf` the server writes. No address or machine name in the path — both used to be there and both lost the operator's models when that one string changed (#245). Two servers sharing one home directory need this set per unit. |
| `AGENT_AUTO_SUMMARIZE` | `0` | Passed to the agent as `--auto-summarize`: at this percentage of the model's context, AlayaCore summarizes the conversation to make room. `0` — and unset — is off, and passes no flag at all. A value outside `0`–`100` stops the server at startup instead of quietly meaning "off", because off is what a mistyped threshold looks like. |
| `MCP_BIN` | beside the server binary (`comfyloft-mcp`) | Overrides where the bridge is expected. The path goes into the static `mcp.conf` on every start, so a moved release directory does not leave a stale one behind. |

### The server runs beside ComfyUI

An install is a plain file write into ComfyUI's model folders, so the server belongs on the
ComfyUI machine, or on a host where those folders are mounted. Whether that is true cannot be
discovered from inside the process — a mount at another path looks exactly like a remote machine,
and two machines that both install to `/opt/ComfyUI` look exactly like one — so it is configured,
not detected:

| `INSTALL_INTO_COMFY`  | Behaviour                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1`                   | the server may write into ComfyUI's folders: installs allowed, nothing is inspected                                                                                                                                                                          |
| unset / anything else | installs off: `GET /api/resources/status` reports `modelInstall { allowed: false, comfyHost }`, the canvas shows a banner and disables the download buttons, and `POST /api/resources/install` answers `400 model_install_disabled` naming `COMFY_URL`'s host |

Fail-closed on purpose. The failure this prevents is not one the user can react to: writing into a
path that happens to exist on this host succeeds, several gigabytes land on the wrong disk, and
ComfyUI still reports the model as missing with nothing in the log. One line in `.env` — shipped
filled in by `.env.example`, which is the single-machine template — is cheaper than that.

### What works, and what does not, when the server is not on the ComfyUI machine

Everything the server _reads over HTTP_ works from anywhere; everything that touches ComfyUI's
filesystem does not, and no environment variable can change that — a folder path is a folder path
on the server's own host by definition.

| Feature                                                          | Path                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Generation, uploads, fetching images/videos, queue, system stats | HTTP (`/prompt`, `/upload/image`, `/view`, `/queue`, `/system_stats`)       |
| Which models are installed (panel "present/missing")             | HTTP (`/object_info`)                                                       |
| Installing models and custom nodes                               | **local write** — needs `INSTALL_INTO_COMFY=1` and the folders on this host |
| `extra_model_paths.yaml` (mapped drives, NFS model dirs)         | **local read** under ComfyUI's own directory                                |
| Knowing where to write at all                                    | ComfyUI's reported folder layout (`custom_nodes`)                           |
| "Runtime deps" interpreter hint                                  | **local read** of `/proc`                                                   |
| Replacing a model via the file picker                            | **local** GUI dialog                                                        |

So a server on another machine still generates images; it just cannot install models, and it says
so instead of filling the wrong disk. Run it beside ComfyUI when you want the whole panel.

An install also needs to know _where_ ComfyUI is, and the only thing that knows is ComfyUI: the
`custom_nodes` entry of `GET /internal/folder_paths`. There is no configuration override and no
fallback inference — model folders can live outside the tree (`extra_model_paths`), so deriving a
root from them writes custom nodes into the wrong place, silently. A build that does not report
`custom_nodes` cannot be installed into: the request answers `400 install_root_unknown`, names the
version ComfyUI reported, and says what to fix. No minimum version is documented, because the
capability is checked rather than a number.

Workflows are the server's own: `workflows/registry.json` plus its graphs. There is no polling and
no automatic import of ComfyUI's workflow folder. To add a graph made in ComfyUI, export it in
**API format** (the UI format ComfyUI saves is rejected) and drop the file into `workflows/`, then
scan with `POST /api/resources/refresh` — the refresh button in the canvas's _Add workflows_ window.
One scan both registers the graph and clears its availability, which is why it is the only scan
route: no "scan only the workflow folder" endpoint, no reload endpoint and no background poller.

The file name _is_ the workflow's identity, and it has to say what it is:

```
workflows/image-my-flow.json      id = name = image-my-flow, file = image-my-flow.json
workflows/video-h3-t2v.json       id = name = video-h3-t2v, file = video-h3-t2v.json
```

`<type>-<slug>.json`, where `<type>` is `image`, `video`, `audio` or `text` and `<slug>` is
lowercase letters, digits, `-` or `_`. Nothing is copied, renamed or re-slugged — the file you edit
is the file that runs, and `workflows/` holds no duplicates. A file that breaks the rule (no
prefix, wrong prefix for the graph it contains, or capitals and spaces in the name) is **not
registered**; the scan reports it as `workflow files left unregistered` with the reason, and the
fix is to rename the file.

Anything a graph cannot describe — a prompt binding, presets, and the media a workflow accepts —
is left for you to add in `registry.json`; the scan warns when a registered graph has no prompt
binding or no output node. Media acceptance (`accepts`, `frameMode`, `mode`, `promptInject`,
`promptReorder`, `sourceVideoFrames`) is validated by one function, so a new workflow declares its
contract instead of adding a branch to a handler. `GET /api/workflows/{id}/schema` publishes the
same contract as typed `inputs`, which is what `POST /api/canvases/{id}/runs` validates a request against.

## Endpoints

Prompts are the agent's, not the server's: these routes carry what the canvas wants asked and stream
back what AlayaCore says. The server owns no wording, no model choice and no state — see
[`decisions.md`](decisions.md) #75 for why, and AlayaCore's own `adapter-guide` for the frames.

| Method   | Path                           | Purpose                                                                                              |
| -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/agent/socket/{session}`  | One agent process, named by the client, both directions. A canvas's conversation is kept inside it. |
| `DELETE` | `/api/agent/session/{session}` | Forget a conversation: releases the process and removes the file. Idempotent. |
| `POST`   | `/mcp` (own listener)          | The agent's tools, reached through `comfyloft-mcp`. Loopback only — never the address above.      |

A session is one `alayacore --rawio` process with one socket, filed under a name the **client** chooses:
the canvas agent panel calls its own `canvas:<canvasId>`, and the models editor calls `settings`. That
prefix is the only thing the server reads about a name — it never learns what a node is, and it does not
care which canvas a name points at beyond where the file goes.

A canvas's name also owns a **conversation file**: `<CANVAS_ROOT>/<id>/session.alaya`, passed to AlayaCore
as `--session`. That file, not the process, is what outlives a process, and it is part of the canvas —
deleting the canvas deletes it, copying the canvas's directory copies it (decisions #178). It is not part of
the document, so an export carries the nodes and their media and not what was said about them.

The **process belongs to the canvas**, not to a connection: it is started by the first connection and
released only when the conversation is ended (below). A reload, a panel closed and reopened, a second tab —
all the same event to the server, "nobody is looking right now" — leave the agent running, a turn in flight
included. A page that connects is then given the conversation as one `history` event, carrying the frames
as the events a live turn sends (`user`, `reasoning`, `tool_call`, `tool_result`, `delta`), so it draws what
was said, thought and called instead of an empty panel (decisions #223). Where those frames come from
depends on the process and not on the page: one that has just started replays its file, and one that has
been running all along is read back from the session's own transcript.

A name that is not a canvas keeps no file at all: a node panel asks one question at a time and writes the
answer into the node, so a file there would carry an earlier question into the next answer and leave one
per node on disk.

The lifetimes differ and both are the client's to end, because the client is what knows a conversation is
over rather than merely unwatched. A canvas's session lives until the conversation says `{"close":true}` or
its canvas is deleted; a name that keeps no conversation — the models editor — ends with its socket, so a
form that is closed holds no process. A socket going away is not an ending for a canvas: nothing is released
because a page stopped reading, which is what lets a turn finish while the panel is shut. Nothing expires on
the server's side — see [`decisions.md`](decisions.md) #80 for the cost of that.

Down the socket: `models`, `history`, `turn`, `user`, `delta`, `reasoning`, `model`, `reasoning_level`,
`command`, `tool_call`, `tool_result`, `notice`, `usage`, `steering`, `tool`, `done`, `error`, `closed`.
The first message is the agent's startup broadcast, which is where the model list comes from; `history`
follows it, carrying the conversation the session is holding; `turn` follows that, saying whether a turn is
in flight — a replayed conversation is all finished messages, and so is a turn that has not produced its
first one, so the transcript alone cannot tell a page which of the two it is looking at. Up: `{"prompt":…}`
(with optional `images` as data URLs), `{"command":…,"args":…}` for one of AlayaCore's own settings,
`{"cancel":true}`, `{"toolResult":…}` for a tool the agent asked for, and `{"close":true}`.

`notice` is AlayaCore's `SM notify` — the agent saying what it is doing to itself ("Summarizing
conversation…", "retrying in 5s (retry 1/3)"). It is not conversation, so it is not in the session file, and
it is not a failure, so it is not an `error`; `tool_result` carries `isError` from the UF frame's `is_error`,
which is the one thing a result adds to the step the canvas has already drawn (decisions #222).

`usage` is SM `task`'s telemetry — `context_tokens`, `step_tps` and `ttft_ms`: how full the context is, and
how fast the last step went with the wait for its first token. The numbers are the agent's measurements,
relayed as it restates them and never computed here. The session also keeps the last three it heard, and
`models` carries them to a page that connects — the count restored from a session file at startup and then
every restatement since, a summarize included — so a reloaded panel knows the context before it asks
anything. It is kept on the session rather than on the page because a reload replaces the page and not the
process (decisions #224, #346). The active model's `contextLimit` on that frame comes out of the model list
when the list names the model, because the limit is the entry's and an editor can rewrite it (#347).

`done` marks the end of a turn and carries the elapsed time only: the answer is what the deltas built,
and a second copy of it would be a second truth.

`{"command":"model_sync","args":…}` is the one command the server rewrites on the way in. It carries the
whole model list, and AlayaCore replaces every model in `model.conf` from it — while the list a canvas is
shown is `agent.Model`, which has no `api_key` in it (`hasKey` says there is one). Sent as it stands, one
deleted model would take every key on the machine with it. So the server rebuilds each model it knows from
the entry the agent announced, replaces only the four fields a canvas can see, and takes a key only when the
canvas had one to send; it then hands the list it is about to write to every other live session, because
they all read the one file at startup (decisions #201).

A second connection to the same name takes the session over: the newcomer gets the model list and every
frame, and the connection it replaced is told `closed`. One session still has one set of eyes — two
readers would take half the frames each — but the eyes belong to the newest tab, because that is the
one in front of the person (#160).

A built-in tool (`read_file`, enabled for the skills the agent loads) runs inside AlayaCore, so the call
and its result arrive as frames and the server relays both without answering either.

### The agent's hands are MCP, over a bridge

Anything the agent does that AlayaCore cannot do by itself — build a node, wire an edge, start a
generation — is a tool this server serves, because the server is already the process holding the socket
to the browser. AlayaCore learns about it from a file, and that file is static: every session reads the
same one.

```
server: canvas
command: "/path/to/bin/comfyloft-mcp"
args: []
proto-version: 2025-11-25
```

`comfyloft-mcp` is spawned by AlayaCore, speaks JSON-RPC on stdin/stdout, and forwards each call to the
server over loopback. The server rewrites that file on every start — the path moves with the release
directory, and a stale one fails as `handshake: EOF`, which names the symptom rather than the cause (#147).

**The session travels in the environment, not in the address.** The server spawns AlayaCore with

```
COMFYLOFT_MCP=http://127.0.0.1:<ephemeral>
COMFYLOFT_SESSION=<session name>
```

and AlayaCore hands its environment to the bridge it starts. The bridge puts the session in
`X-Comfyloft-Session` and its own version in `X-Comfyloft-Bridge`; the server refuses a version it does
not speak, because two binaries can come from two builds — and says which half to rebuild.

That is a second, **loopback-only** listener, never the address `COMFYLOFT_SERVER_HOST` names: a tool that creates
nodes and starts generations has no business being reachable from the network, and requiring a custom
header means a browser cannot reach it cross-site without a preflight this server never answers.

**The rules ride in the system prompt.** Every spawn also carries the server's own `--system` text
(`canvasInstructions` in `agent_instructions.go`), and each rule there is one a tool description could not
state: a connection reuses what is already on the canvas and a copy forks it, so wire before you duplicate;
the viewport is the user's, so `focus_node` points at what the answer is about — the node that changed, the
node the user asked about, one per answer; and a prompt is said once, in the node's own box **or** in a text
node connected to it, never both (#203, #204). A tool description explains one tool and cannot state a
preference between two; a skill would have to be read before it helped, and the first canvas move is exactly
when nothing has been read (#183).

**A run outlives the tool call that started it.** `generate` answers as soon as the run is queued — a
picture takes minutes, and a tool call is not a progress bar — so the agent's turn can end with the work
still going, and nothing in the conversation would ever say the picture arrived. What the page sends with
the run is who asked (`askedBy`: the session, and the node it pressed), the run record keeps it, and when
the run ends the server says how it went through the same door the user's typing uses: a prompt on that
session, which AlayaCore echoes and answers like any other message, so the panel draws it as one
(decisions #225). Nothing waits for the agent to be idle — AlayaCore queues a prompt into the run already
in progress. A run the user started carries no `askedBy` and is not reported to anybody.

`generate`'s answer carries the other half of it, because that is what the agent's next move depends on: a
run id means the message is coming, a refusal says why nothing was started (and fails the call), and a press
that reports no run within 15 s says so rather than guessing either way.

Media, runs and files:

| Method | Path                              | Purpose                                                                                                    |
| ------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/canvases/{id}/uploads`      | Upload one media file into that canvas. Returns its file name and URL.                                     |
| `POST` | `/api/canvases/import`            | One exported canvas archive in, one canvas out: the server unpacks `canvas.json`, `manifest.json` and `files/` into a new canvas directory. |
| `POST` | `/api/canvases/{id}/runs`         | Submit a run into that canvas. Always `202` with the run, never blocks.                                     |
| `GET`  | `/api/runs`                       | Runs, newest first; `?status=` and `?workflow=` filter.                                                     |
| `GET`  | `/api/runs/{id}`                  | Status, progress, preview frame, outputs, error.                                                            |
| `GET`  | `/api/runs/{id}/preview`          | In-flight preview frame, when one exists.                                                                   |
| `DELETE` | `/api/runs/{id}`                | Cancel (idempotent; also interrupts ComfyUI).                                                               |
| `POST` | `/api/canvases/{id}/join`         | Join several of that canvas's clips into one file, in the order given. Not a run: a stream copy, no model, no queue (#324). `{"files": ["<name>", …], "reencode": false}`; clips that disagree on codec, size, pixel format, frame rate, sample rate or channel count are refused with the field that differs, and `reencode` is the caller asking for every frame to be rewritten. Answers like an upload, plus the joined clip's `durationMs`, `width` and `height`. |
| `GET`  | `/api/canvases/{id}/files/{name}` | One file of a canvas: an upload or a finished run's artifact. Cacheable for good — a name is written once.  |

Metadata and management:

| Method | Path                     | Purpose                                                                                                                                                                                                                                                                     |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                | Liveness, ComfyUI reachability, counts.                                                                                                                                                                                                                                     |
| `GET`  | `/api/workflows`         | Full workflow list: availability, typed parameters, and the model ids each workflow answers to (`models`). Every registered workflow, tool or model.                                                                                                                        |
| `GET`  | `/api/resources/status`  | Model and node install status.                                                                                                                                                                                                                                              |
| `POST` | `/api/resources/install` | Start an install job.                                                                                                                                                                                                                                                       |
| `POST` | `/api/resources/refresh` | The only rescan: reloads the resource index, re-scans ComfyUI (nodes, models, availability, new workflow graphs) and returns the resource status. This is the panel's refresh button.                                                                                       |
| `GET`  | `/api/system/stats`      | VRAM and RAM **of the machine running ComfyUI** (read from ComfyUI's own `/system_stats`), plus the last OOM. `available: false` when ComfyUI does not report its devices — the panel then shows nothing, because the server host's own memory is somebody else's machine. |
| `GET`  | `/api/workflows/{id}/schema` | The typed inputs, media roles and outputs of one workflow — the contract a run is validated against. |
| `GET`  | `/api/resources/jobs/{id}` | One install job: what it is downloading and how far it has got. |
| `POST` | `/api/resources/jobs/{id}/cancel` | Stop that job. Files already written stay. |
| `POST` | `/api/resources/pick-replacement` | Open the operator's file dialog on a model directory, and answer with the file chosen. |
| `POST` | `/api/resources/replacement` | Point a resource at a file that is already installed (the alias the panel's "choose replacement" writes). |
| `GET`  | `/api/loras`             | The LoRA files ComfyUI reports, filtered by `?q=`. |
| `POST` | `/api/system/free-memory` | Ask ComfyUI to free VRAM, then report what that freed. `503` when ComfyUI is unreachable. |

Workspace:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/canvases` | Every canvas, newest first: id, title, timestamps, `rev`, document size. |
| `POST` | `/api/canvases` | Create one. `{title, document}`; the document may be omitted and is then `{}`. |
| `GET` | `/api/canvases/{id}` | One canvas and its document. |
| `PUT` | `/api/canvases/{id}` | Save the document. `{document, title?}`; `If-Match: <rev>` refuses a stale write with `409`. |
| `DELETE` | `/api/canvases/{id}` | Delete it, and everything under it. |
| `GET` | `/api/settings` | The workspace preferences: one document, opaque to the server. |
| `PUT` | `/api/settings` | Replace them. `{settings: {...}}`. |
| `GET` | `/api/speech/profiles` | The speech servers dictation can use: `{profiles: [{id, name, url, model, hasKey}], active}`, never a key (decisions #252). |
| `PUT` | `/api/speech/profiles` | Write the whole list back — the page's order, so a missing entry is a deleted profile. An entry without a `key` field keeps the stored one; `""` removes it. |
| `POST` | `/api/speech/transcriptions` | One recording in, `{text}` out. Names no server: the active profile's address, model and key are used, so a form field cannot redirect the audio (decisions #239, #252). |

The canvas, when `WEB_DIR` names one — the only endpoints here that are not under `/api`:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/` (and any path that is not `/api/*`) | A file of the bundle, or its `index.html` for a client-side route. Hashed assets under `/assets/` are `immutable`; everything else is `no-store`; a missing file is `404`, never the page. |
| `GET` | `/config.js` | The settings document as the script the page loads before its bundle, so the theme and the language are known before the first frame. `no-cache` with an `ETag`. Not read from `WEB_DIR`, even when a build left a template there (#220). |

A canvas is a directory, not a row:

```
<CANVAS_ROOT>/<id>/canvas.meta.json   id, title, createdAt, updatedAt, rev — what the list needs
<CANVAS_ROOT>/<id>/canvas.json        the document
<CANVAS_ROOT>/<id>/files/             the media its nodes point at
<CANVAS_ROOT>/<id>/session.alaya      the agent's conversation, once there is one — the agent's own file
```

The id is the directory name and is never derived from the title, so renaming a canvas never moves a
directory. The server does **not** parse `canvas.json`: it checks that it is a JSON object under
16 MiB and otherwise stores the bytes. What a node is, is the canvas's business — a server that
understood nodes would have to be rebuilt every time one was added.

### Preferences live with the workspace

`data/settings.json` holds one document — theme, language, panel widths, the channel names and the
model selections — that the canvas itself defines. The server checks only that it is a JSON object
and stores it whole: a settings document with per-key endpoints would need a merge, and a merge is
where preferences quietly lose keys.

The theme and the language have to be applied before the first frame, so the page loads `/config.js`
before its own bundle and the server answers it — from this document, per request (#220). A preferences
document that only arrives over HTTP opens every dark workspace white for a moment and every English
workspace in Chinese.

The script carries a server address only when `PUBLIC_BASE_URL` names one: a page the server served
already knows where the server is, and its own origin is the only answer that survives a LAN name, a
phone or a reverse proxy (#219). `RUNTIME_CONFIG_PATH` writes the same script to a file for the one layout
the route cannot reach — a canvas published by a static host.

Two rules make the directory safe to write on every keystroke. Every write goes through a temporary
file in the same directory and is renamed into place, so a reader never sees half a document. Every
write also bumps `rev`, and a save whose `If-Match` names an older one is refused with `409` and the
current summary in `details.current` — the browser is a cache now, and a cache that races must lose.

**One thing is deliberately not in that document.** The speech servers — where each one listens, the model it
calls its own, and the credential it wants — live in `data/speech.json`, mode `0600`: `/config.js` is the
document whole, so a credential in the preferences would be handed to every client that can load the canvas,
and `RUNTIME_CONFIG_PATH` publishes that script as a file for a static host. `GET /api/speech/profiles` answers
the list and which entry is active, with `hasKey` and never a key; `PUT /api/speech/profiles` takes the whole
list back with `{"profiles":[…],"active":<id>}`, where an entry without a key field keeps the stored one and
`""` removes it. Dictation is sent to the active profile with the key as `Authorization: Bearer`, and no key is
ever sent back over HTTP (decisions #246, #252). Where it goes is in the log, for the same reason the agent's
models are (#255):

```
speech: 1 profile(s) loaded; dictation goes to "Local audio.cpp" -> http://127.0.0.1:18080/v1/audio/transcriptions, model refine, with a key
speech: transcribing 32044 bytes with "Local audio.cpp" -> http://127.0.0.1:18080/v1/audio/transcriptions, model refine
```

A run carries its own `preview` (`{url, mime}` with a timestamp) and its own `progress` in the
payload, so a client polling a run needs no second endpoint for either — there is no `/api/previews`
and no `/api/progress`, and the socket that feeds them stays inside the server.

`loras` is the one input the engine applies itself rather than a binding. Everything else a run
carries reaches a node.

### Prompt models are the agent's

The server has no prompt model of its own: `/api/agent/socket/{session}` spawns AlayaCore,
and every question about models — which exist, which is active, how hard it should think — is answered
by the agent's own `model.conf` and its `reasoning_0/1/2` blocks. Nothing here configures a provider,
negotiates a thinking parameter or retries a rejected field: AlayaCore does, and the server relays
what it says.

That list is also edited from the canvas, and still by the agent: the preferences window lists the models,
and adding, changing or removing one sends `model_sync` — the same command, with the server completing the
entries the page was not shown (decisions #201). Nothing here parses `model.conf`.

The form covers the entry rather than a corner of it (#249): the name, the model id, the address, the
protocol, the key, `context_limit`, `max_tokens`, `reasoning_field`, `serial_tool_calls` and the three
reasoning blocks, each written as the JSON it is. A block that will not parse keeps the form from saving, and
the merge refuses one that is not an object — the blocks are merged into a request body as they stand. A
cleared block is sent as `null`, which removes it; a field the page says nothing about is kept as it was.

`input_modalities` has three states and the form has one control that says all three (#256): a switch for
whether the model declares anything at all, and four boxes — image, video, audio, document — for what it
declares. Switch off writes no line, so the protocol decides what the model is sent; switch on with nothing
ticked writes `[]`, which declares "no media"; a list declares that list. There is no `text` box: AlayaCore
never filters text, so `[]` and `["text"]` are one model, and a stored `["text"]` is left spelled as it is.
Switching on starts empty rather than pre-ticked, because the two mistakes cost differently — a medium the
endpoint does not accept fails the whole request, every time, since the part is in the conversation the agent
keeps replaying, while one it would have accepted is only replaced by a note saying it was not delivered.

A core older than this option neither reports the line nor keeps it: `model_sync` re-formats `model.conf`
from the model struct the process holds, so an agent started before AlayaCore was upgraded announces
`inputModalities: null` for a model whose file declares one and drops the line on the next edit. Measured
against the pre-upgrade build: a rename through it wrote the file without `input_modalities`. Restarting the
server is what fixes it — the agent processes are spawned per session, so a new one is the new core.

**Where a turn goes is in the log** (#255). A `model` frame carries the id and the name of the active model and
nothing else, so the address is looked up in the list the agent announced and printed with it:

```
agent: connected session=… pid=… models=3 sending to "Fleet / qwen3" -> http://127.0.0.1:8080/v1, model qwen3-8b, openai
agent: session=… sending to "Fleet / kimi" -> https://api.moonshot.cn/v1, model kimi-k2, openai
```

One line when a session starts and one whenever the destination actually changes — a `model` frame that restates
the same thing, or a re-saved list, writes nothing. The `api_key` is never part of it.

## Architecture

```
cmd/comfyloft-server      startup, signal handling, task cleanup loop
cmd/comfyloft-mcp        the stdio bridge: JSON-RPC in, loopback call out
internal/mcpstdio        the bridge's protocol half, testable without a process
internal/config          environment -> immutable Config
internal/httpx           error type, JSON responses, middleware, multipart
internal/ws              the WebSocket the agent's socket and previews ride on
internal/comfy           ComfyUI HTTP client + minimal WebSocket client
internal/workflow        registry, graph model, bindings, base-model variants
internal/generate        runner, LoRA injection, step planning, previews
internal/setup           availability scan, model aliases, model path resolution
internal/task            the run queue: persistence, progress, cancel, multi-output records
internal/upload          uploaded media: bytes on disk, index, cached ComfyUI reference
internal/resource        resources.json, install jobs, main-model override
internal/canvas          the canvas directory: documents, revisions, files, import
internal/prompt          Qwen's `图片N` renumbering, MOSS layout prompts
internal/store           main-model overrides, speech profiles
internal/settings        the preferences document, opaque to the server
internal/sysinfo         ComfyUI's /system_stats, as the panel's units
internal/agent           spawning AlayaCore, its event whitelist, models, notices
internal/logx            structured log lines with request ids
internal/util            the few helpers that are not any one package's business
internal/server          route table and wiring
```

Four design notes worth knowing before changing anything:

- **The agent is relayed, not modelled.** `internal/agent` writes a user message as the wire's own content items
  and a flush, relays the frames that come back, and keeps only what AlayaCore cannot say twice — the
  conversation's frames, its startup broadcast, the model entries `model_sync` has to round-trip — plus the
  routing for one socket and one tool call. It keeps no opinion about what the agent is doing: the turn in flight
  comes off the agent's own task frame, the models off its `model_list`, a failure off its `error`. A fact this
  side derives is a second truth that only the agent can correct, and its failures are invisible in proportion to
  how rare they are (#343, and #342 for the turn).

- **Graphs are generic JSON.** There are fourteen ComfyUI graphs beside `registry.json`, and they
  carry node classes this codebase will never model. `internal/workflow` offers typed accessors
  (`Node.ClassType()`, `Node.Inputs()`) and everything above it is typed.
- **Bindings keep their raw JSON.** `registry.json` is user-editable, so a binding
  is a thin typed view over the raw object. A closed struct would silently drop
  fields when a newer workflow uses them.
- **Request-scoped copies only.** `ApplyBindings` and `ApplyLoraChain` always clone.
  The graphs loaded from disk are immutable, so concurrent requests cannot see each
  other's parameters.

## Relationship to ComfyUI's HTTP API

The server sits on top of ComfyUI, so the job skeleton is ComfyUI's: submit, get a prompt id, poll
until done, fetch the artifact. `internal/comfy/client.go` speaks exactly that set of endpoints —
`POST /prompt`, `GET /history/{prompt_id}`, `GET /view`, `POST /upload/image`, `POST /interrupt`,
`GET /queue`, `GET /object_info`, and a WebSocket for progress. What is ours is the abstraction above
it: a caller names a **workflow** and its inputs and never sees a node graph.

| ComfyUI                                                  | Server                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /prompt` with a full API-format graph              | `POST /api/canvases/{id}/runs` with `{workflow, inputs, media}`                                   |
| `prompt_id`                                              | `run.id`                                                                                         |
| `POST /upload/image` → file name                         | `POST /api/canvases/{id}/uploads` → file name, referenced by role                                |
| `GET /queue` (running/pending)                           | `GET /api/runs?status=`                                                                          |
| `GET /history/{prompt_id}`                               | `GET /api/runs/{id}`                                                                             |
| `GET /view?filename=&subfolder=&type=`                   | `GET /api/canvases/{id}/files/{name}` (one file route for uploads and artifacts)                   |
| `POST /interrupt` + queue deletion                       | `DELETE /api/runs/{id}` (idempotent, reports `cancelled` at once)                                |
| WebSocket `executing` / `progress` / binary preview      | `GET /api/runs/{id}` progress + `GET /api/runs/{id}/preview` (polled; the socket stays internal) |
| `GET /object_info` (node classes and their file options) | `GET /api/workflows[/{id}/schema]` (runnable capabilities, availability, typed inputs)           |

Where the two differ, and why:

- **What is submitted.** ComfyUI takes a graph: node ids, classes, every link. The server takes
  `{workflow, inputs, media}`; the graph lives in `workflows/*.json` and bindings translate inputs
  into it (`internal/workflow/bindings.go`). This is the difference that produces all the others: the
  client that knows a workflow id does not need to know `"37:13"` exists. Raw graphs are refused on
  purpose — the exposed surface is the registered capability set, not the executor.
- **When a request is judged.** ComfyUI validates a graph when it executes. The server validates at
  submission against the schema: closed key set, types, ranges, `required`, media counts and roles
  (`internal/workflow/inputs.go`, `media.go`). A `400` now instead of a failed run later.
- **How media is referenced.** In ComfyUI an upload returns a filename that the graph has to place in
  the right socket, which means the client must understand the wiring. Here an upload returns an id
  (its name in the canvas's `files/`) and the run references it by **role** (`source`, `mask`,
  `first_frame`, `last_frame`, `reference`, `video`, `audio`); the workflow's bindings decide which
  socket it lands on.
- **Where artifacts live.** `/view` needs the filename and subfolder from ComfyUI's own history and
  serves from its output directory. The server copies results into `CANVAS_ROOT/<id>/files/` — the
  canvas that asked for them — and serves them from there by name with their MIME type and size, so a
  finished run stays fetchable after ComfyUI cleans up or restarts, and deleting a canvas takes its
  artifacts with it.
- **State.** ComfyUI's queue and history are in memory. Runs are persisted to `data/tasks.json` and
  reconciled on boot (file still in the canvas → completed, in flight → failed with an explanation).
  Uploads have no index at all: an upload is a file, its id is its name, and "does it exist" is asked
  of the directory.
- **Progress.** ComfyUI pushes it over the WebSocket. The server consumes that socket and exposes
  polling, so a browser needs no long-lived connection and a reload loses nothing.
- **Cancellation.** ComfyUI has a global interrupt plus queue deletion. A run has its own idempotent
  `DELETE`, which maps to both and is reflected immediately.
- **Discovery.** `/object_info` describes node classes and their file options. `/api/workflows`
  describes _runnable capabilities_: whether the models and nodes are installed, the modes/variants,
  and the typed inputs — it is computed from `object_info`, but it answers a different question.
- **Trust boundary.** ComfyUI is single-user and unauthenticated. The server has an origin allow
  list and no authentication (see "There is no authentication"), and it is the only surface meant to
  be reachable from a browser.

The same request, both ways — one image:

```jsonc
// ComfyUI POST /prompt
{"prompt": {
  "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["1", 1]}},
  "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "x.safetensors"}},
  "7": {"class_type": "KSampler", "inputs": {"seed": 42, "steps": 8, "model": ["1", 0], "positive": ["4", 0]}},
  "9": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "out"}}
}, "client_id": "..."}

// Server POST /api/canvases/{id}/runs
{"workflow": "image-z-image-turbo",
 "inputs": {"prompt": "a cat", "size": "1024x1024", "quality": "medium"}}
```

The resemblance is deliberate where it is: single queue, single GPU, submit → id → poll → fetch is
what ComfyUI actually offers and there is nothing to gain from inventing a different lifecycle. The
difference is the unit of exchange — ComfyUI exchanges graphs, the server exchanges workflow runs.

## Language policy

The backend is English-only: log lines, error messages and warnings are all English,
and no Go package is localized. Translation lives exclusively in the canvas frontend.
The same rule covers the rest of the repository — documentation, code comments and
commit messages are English too, with UI copy and model-facing data as the only
exceptions (see [`decisions.md`](decisions.md) #17 and the Language section of the
[README](../README.md)).

Error `code` values are stable (`model_not_found`, `missing_reference_image`,
`LIMIT_FILE_SIZE`, …), so the frontend can map them to localized text instead of
displaying `error.message` verbatim.

Two things stay Chinese on purpose, because they are _data_ rather than messaging:

- **The one instruction a button sends the agent** — the caption button asks, in Chinese, for a
  description of the reference picture (`canvas-node-prompt-panel.tsx`). It is input to a model,
  not text for a human, and translating it would change what comes back. Everything else that
  faces a model is English: the canvas rules the server puts in the system prompt, the run
  notices, and the tool answers.
- **Chinese-matching regexes** — patterns that renumber `图片N` / `第N张` references after a
  Qwen edit reorders them, and the `物体：` / `人物：` / `文字：` prefixes of a MOSS layout
  caption (`internal/prompt`). They match what a user or a Chinese model writes, so a
  translation would stop them matching.

## Testing

```bash
make check        # gofmt check + go vet + the suite + the dead-export check
make test-race    # the same suite under the race detector (needs a C toolchain)
make verify-static
cd frontend && npm run check && npx vitest run     # the canvas
```

The suite covers binding application, LoRA injection, Qwen's `图片N` renumbering and the
MOSS layout prompt, registry loading, the task queue (including cancellation and retention),
configuration validation, resource catalogue validation against the real `resources.json` and
the real workflow graphs (#130), and an end-to-end HTTP test that drives real image
generation against an in-process fake ComfyUI.

## What this server deliberately does not do

Each of these was a feature somewhere else, and the reason it is absent is the reason it is worth having
here.

- **Runtime pip installs.** It wrote into the user's venv and regularly corrupted it. `/api/resources/status`
  reports `runtimeDeps` and the UI shows the exact command to run instead — see
  [`runtime-deps.md`](runtime-deps.md).
- **No remote resource index.** The panel reads `resources.json` only.
- **Memory is ComfyUI's, not this host's.** Since #99 the panel reports what ComfyUI says about the machine
  that does the work, and nothing at all when ComfyUI does not answer — a workbench whose GPU is on another
  box must not show its own RAM as if it were the one running the model.
- **Bake artifacts** (`type: "bake"`) are never installed: they need a local merge, so the panel shows the
  exact command (`tools/bake-moss-preset.py`, exposed as `manualCommand` on the resource).
- **No `/v1`, no API key, no remote bind by default.** See `protocol.md` and decisions #69, #110, #19.
