# Decisions

Why the code is the shape it is. One entry per choice a reader could otherwise mistake for an accident.

What belongs here: a rule that is true **now**, and the reason the code looks that way — the alternative
rejected, and what the choice costs. Nothing else.

What does not: a feature that has been removed. When a thing is gone the tree no longer holds it and the entry
goes with it; `git show` keeps the history. A tombstone reading "we tried this and took it out" is a graveyard
with a door sign, and it does real harm: it reads like a constraint, and it pulls the next design back towards a
decision made under conditions that no longer exist.

Three things worth knowing before quoting one:

- **This is a record, not a specification.** What is true is the code and `git show`. An entry says what was
  decided and why; it never says what a new design must be. When a design changes, the entry changes with it.
- **A sentence carrying a version, a model name or a number is a measurement of that day.** Where the fixture
  is named (`ComfyUI 0.43.0`, `image-moss-sft-8step`, seed 424242) re-run it; where it is not, treat the number
  as folklore and check before relying on it.
- **Entries before #240 say "gateway".** The process is `comfyloft-server` and the word is historical: do not
  reuse it in new code, comments or prose.

Format: decision, why, consequences, where it lives. Paths are as the tree was when the entry was written —
an entry that names a path for something it deleted is naming a path that no longer exists.

---


## 1. The gateway is Go, built as a static binary with CGO disabled

**Decision** `gateway` is a single Go binary, `CGO_ENABLED=0`, `-trimpath -ldflags '-s -w'`.

**Why** The gateway is the one component the canvas cannot work without. A static binary
starts in milliseconds, cannot break because a transitive npm package changed, and needs no
runtime installed on the target machine. `make verify-static` fails the build if `ldd` ever
reports a dependency.

**Cost** No cgo libraries. The race detector needs cgo, so `make test-race` re-enables it for
the test binary only; the shipped binary stays static.

**Where** `Makefile`, `docs/server.md` (Why Go).

---


## 2. Zero third-party dependencies

**Decision** `go.mod` has no `require` block. The WebSocket client is hand-written
(`internal/comfy/ws.go`), archive extraction uses `archive/zip` and `archive/tar` +
`compress/gzip`.

**Why** Every dependency is a supply chain and a version constraint. The protocol surface this
gateway needs is small: RFC 6455 frames without extensions, and plain zip/tar.

**Cost** The WebSocket client implements only what ComfyUI sends (text frames, ping/pong,
close). Reconnect logic lives in the caller.

**Where** `go.mod`, `internal/comfy/ws.go`, `internal/resource/jobs.go` (`extractArchive`).

---


## 3. The Go module is the repository root

**Decision** `main.go`, `internal/`, `go.mod`, `Makefile` and the runtime assets (`workflows/`,
`resources.json`, `prompts/`) sit at the top level; the canvas frontend is a sibling subtree in
`frontend/`.

**Why** The repository _is_ a Go service with one vendored frontend. An extra `gateway/`
directory only made sense while a second, Node implementation lived next to it.

**Cost** `go build ./...` would walk `frontend/node_modules`, so the Makefile uses an
explicit package list (`./cmd/... ./internal/...`). Measured difference: `go vet` 0.64 s vs 0.89 s,
plus protection from a stray `.go` file inside an npm package.

**Where** `Makefile` (`PKGS`), `README.md` (Layout).

---


## 4. Workflow graphs stay generic JSON

**Decision** Graph files are `map[string]any` end to end. Typed accessors (`Node.ClassType()`,
`Node.Inputs()`) sit on top; nothing models individual node classes.

**Why** There are nineteen ComfyUI graphs carrying node classes this codebase will never know
about, and users add more. A typed model would have to be extended for every new node.

**Cost** Field access is by string, so typos are runtime errors. Mitigated by confining raw map
access to `internal/workflow`.

**Where** `internal/workflow/graph.go`.

---


## 5. Bindings keep their raw JSON

**Decision** A binding is a thin typed view (`Binding.raw`) over the object in `registry.json`.

**Why** `registry.json` is user-editable. A closed struct would silently drop unknown fields
the next time a workflow uses a newer binding option — a bug that only shows up as a missing
parameter in a generated request.

**Cost** Reading a field goes through accessors, and the type system cannot prove completeness.

**Where** `internal/workflow/bindings.go`.

---


## 6. Request-scoped copies only

**Decision** `ApplyBindings` and `ApplyLoraChain` clone the graph before mutating it; graphs
loaded from disk are treated as immutable.

**Why** The registry is shared across requests. Mutating a loaded graph means two concurrent
generations can see each other's parameters — an intermittent, hard-to-reproduce wrong-image
bug.

**Cost** One graph copy per request (a few hundred KB of JSON), which is irrelevant next to
inference time.

**Where** `internal/workflow/bindings.go`, `internal/generate/lora.go`.

---


## 7. Order-preserving maps for anything the UI renders in sequence

**Decision** `variants`, `variantLabels` and `bindings` use `workflow.OrderedMap`, not Go maps.

**Why** Go randomises map iteration. Those keys drive dropdown order, so a plain map would
reshuffle the canvas image-mode selector on every refresh.

**Cost** A small custom type instead of the builtin.

**Where** `internal/workflow/ordered.go`.

---


## 8. Backend messages are English; localization lives only in the frontend

**Decision** Log lines, error messages and warnings are English. Translation happens in
`canvas/web/src/i18n`. Error `code` values are stable identifiers
(`model_not_found`, `missing_reference_image`, …).

**Why** One backend, two UI languages. Translating backend text would mean shipping a locale to
a process whose only consumer is a dashboard, and would make logs unreadable in bug reports.

**Cost** The frontend has to map codes to copy; unmapped errors surface in English.

**Where** `internal/httpx`, `docs/server.md` (Language policy).

---


## 9. Model-facing Chinese stays Chinese

**Decision** The H3 writing instructions, image/caption system prompts, Chinese-matching
regexes (`图片N`, `正向|负向`) and ComfyUI protocol values (`文生视频(T2VA)` …) are not
translated.

**Why** They are input to a model or to ComfyUI, not text for a human. Translating the prompts
would change generation behaviour; translating the regexes would break parsing; the mode
strings are values the frontend sends and the backend matches.

**Cost** The codebase contains Chinese even though it is English-only by policy. Each such site
carries a comment saying so.

**Where** `internal/prompt/*`, `internal/workflow/infer.go`.

---


## 10. Job statuses and progress are a wire contract with the panel

**Decision** Install jobs speak exactly what the canvas panel expects:

```
job.status  : running | done | error | canceled
item.status : queued | downloading | verifying | copying | extracting | baking | done | error | skipped
job.progress: 0..100, weighted by bytes
```

**Why** The panel was written against these values: it renders byte counters and speed only for
`downloading`, stops polling only on `done`/`error`/`canceled`, and passes `progress` straight
to antd's `percent` prop. Sending `completed` or a 0..1 fraction leaves the bar empty forever —
which is exactly what happened once.

**Cost** The vocabulary is frozen by the frontend, and a single large file must move the bar
(hence byte weighting rather than finished-item counting).

**Where** `internal/resource/jobs.go` (`jobProgress`, item status transitions), `internal/resource/bake.go`.

---


## 11. The gateway installs nothing with pip

**Decision** Runtime Python packages are reported (`runtimeDeps` in `/api/resources/status`) and
the UI shows the exact command; the gateway never runs `pip install`.

**Why** The old implementation wrote into the ComfyUI venv and regularly broke it: wrong wheel
for the CUDA/Python/torch combination, installs that reported success but failed on import, and
torch/numpy overwritten underneath ComfyUI.

**Cost** One manual step for the user, and the panel must tell them precisely what to run.

**Where** `internal/resource/resource.go` (`RuntimeDep`), `docs/runtime-deps.md`.

---


## 12. Only three external binaries, everything else in-process

**Decision** `nvidia-smi` (GPU), `zenity` (file picker), `ffprobe` (video duration). Downloads,
verification, archive extraction and file copies all happen in Go.

**Why** A missing external tool used to be able to fail an install. Anything that can be done
in-process is done in-process; the three that remain wrap information only the OS/driver has.

**Cost** Each of the three must degrade with an actionable message when absent — which they do
(`zenity was not found; type the model's relative path instead …`).

**Where** `internal/sysinfo/sysinfo.go`, `internal/setup/setup.go`, `internal/server/server.go`.

---


## 13. `type: "bake"` resources are never installed

**Decision** A bake resource (a checkpoint merged from two others) is excluded from install
jobs. `/api/resources/status` exposes the command that produces it as `manualCommand`, and the
panel shows that command with a copy button.

**Why** Merging needs torch and produces ~10 GB; neither belongs inside an HTTP install
request. Including it in a job meant every MOSS-pack install finished with a guaranteed failure
and a misleading "run the merge inside ComfyUI" message.

**Cost** One documented manual step, and the command must stay correct as the script's flags
change — pinned by `internal/resource/bake_test.go`.

**Where** `internal/resource/bake.go`, `tools/bake-moss-preset.py`.

---


## 14. The asset root is discovered, not hardcoded

**Decision** `COMFYLOFT_SERVER_ROOT` → working directory → executable directory, accepting the first that
contains `workflows/registry.json` or `resources.json`.

**Why** The binary lives in `bin/`, which must not be mistaken for the asset root, and the
gateway is also started from the repository root by `start.sh`. A bare `workflows/` directory is
not enough of a marker — it produced a self-reinforcing wrong guess.

**Cost** Starting from an unrelated directory silently falls back to the working directory; if
that happens, state lands in `./data`.

**Where** `internal/config/config.go` (`resolveRootDir`).

---


## 15. Gates: `make check` must not need a C toolchain

**Decision** `make check` = gofmt check + `go vet` + tests (CGO off). `make check-full` adds
`-race` and therefore needs gcc. `make verify-static` asserts the binary is static.

**Why** The shipped binary must stay cgo-free, but the race detector is the only thing that
catches the concurrency bugs this code has actually had (shared task and job state read while a
worker mutates it).

**Cost** Two gates; contributors without gcc can still run the fast one.

**Where** `Makefile`.

---


## 16. The gateway never starts or stops ComfyUI

**Decision** ComfyUI is external: the gateway connects to `COMFY_URL` and reports when it is
unreachable. `start.sh` does not launch it either: ComfyUI may be on another machine, in a
container, or under a supervisor the user chose, so a start script that assumes it is local
would be wrong more often than right.

**Why** ComfyUI owns the GPU and is usually already running with a user's own configuration.
A gateway that restarts it would race with whatever the user is doing.

**Cost** "ComfyUI is not reachable" is a normal state the UI has to handle, not an error.

**Where** `internal/comfy/client.go`, `start.sh`, `README.md` (process table).

---


## 17. Everything written for a human is English

**Decision** Documentation, code comments, log lines, error messages and commit messages are
English. User-visible copy is not written in the source at all: it lives in the i18n
dictionaries (`canvas/web/src/i18n`) and is translated there. The two exceptions are
the ones already argued for: model-facing Chinese and protocol values (#9), and UI copy as
data (#8).

**Why** One prose language keeps `grep`, diffs, bug reports and commit history readable, and
the frontend is bilingual anyway — a Chinese string in a component is not "a Chinese UI", it
is a string that only ever renders in Chinese and cannot be reviewed by the half of the
audience that reads English. Writing the rule down is the only way to stop the next
contribution from adding one more.

**Cost** Chinese prose that predates the rule has to be translated (what is left, and why each line is
data rather than copy, is #216), and a reviewer has to reject inline copy even when it works in
the current UI language.

**Where** `README.md` (Language), `docs/server.md` (Language policy),
decisions #8, #9 and #216.

---


## 18. `@ant-design/pro-components` is dropped, not worked around

**Decision** The canvas does not depend on `@ant-design/pro-components`; `AppProviders` wraps the tree in antd's
`ConfigProvider` + `App` and nothing else. In be1eea5.

**Why** Every published build declares `antd: ^4.24.15 || ^5.11.2` as a peer while this app runs antd 6, so
`npm ci` aborted with ERESOLVE and the only way in was `legacy-peer-deps=true` for the whole subtree — a flag
that also silences the *next* real peer conflict. The single import was `ProConfigProvider`, which only
re-provides antd's theme and locale context; the app has no Pro component. Removing it restored strict peer
resolution and dropped 130 packages.

**Cost** Anyone who later wants ProTable/ProForm has to add it back, which makes antd 6 support a prerequisite
for that work.

**Where** `frontend/package.json`, `frontend/src/components/layout/app-providers.tsx`.


## 19. `COMFYLOFT_SERVER_HOST` is bound as given; there is no `ALLOW_REMOTE`

**Decision** The server listens on whatever `COMFYLOFT_SERVER_HOST` says — loopback or a LAN address — with no
second switch. `ALLOW_REMOTE` and the startup refusal it gated are gone; what remains is a warning when the
address is reachable from the network. Since #110 removed the token, that warning is the only thing that says the
port is open.

**Why** A workbench whose server is on `192.168.3.232:8190` so a phone can use it *is* the local setup. Calling
that "remote" and making the user flip a flag to reach their own machine was a gate with no bug behind it, and it
failed quietly in the worst way: the canvas started, the server exited, and the UI showed "gateway disconnected".
The real risk is not the bind address but an unauthenticated `/api/*`, which is what the warning names.

**Cost** One keystroke less between a machine and the network. The old behaviour is still one variable away
(`COMFYLOFT_SERVER_HOST=127.0.0.1`, the default). `CORS_ORIGINS` no longer accepts `*` under any condition: the
canvas origin is matched by host, so the wildcard was only ever an accident waiting to happen.

**Where** `internal/config/config.go`, `internal/httpx/middleware.go` (`sameHostOrigin`),
`cmd/comfyloft-server/main.go`, `.env.example`, `docs/server.md`.


## 20. Workflow metadata is English in the registry and translated by id in the canvas

**Decision** `workflows/registry.json` carries English `label`, `description`, `variantLabels`
and `parameters[].label/description` — it is data the gateway serves, so it follows #8. The
canvas translates the strings it displays, in `web/src/lib/server-labels.ts`, keyed by the
stable identifier the gateway already sends:

```ts
gatewayModelLabel(modelId, gatewayLabel); // gateway.models.<id>.label
gatewayVariantLabel(mode, gatewayLabel); // gateway.variants.<mode>
gatewayModelDescription(modelId, gatewayLabel);
```

An id the dictionary does not know falls back to the English text, so a hand-written or
newly added workflow still renders instead of showing a raw key.

**Why not bilingual registry strings** A `{ "zh": …, "en": … }` shape would have changed the
`/v1/models` contract, every consumer of `metadata.label`, and the registry schema, for
metadata that only the canvas displays. Ids (`image-moss-sft-8step`, `inpaint`) are already in
the response and cannot change without breaking stored channel configs, which makes them the
natural dictionary key.

**Why the lookup names the language explicitly** The helper exists to answer with the *Chinese* label, so it
asks the Chinese dictionary by name (`getFixedT("zh-CN")`) and only when `resolvedLanguage` is `zh-CN` — a
plain `t()` would answer in whichever language is being read, which is the one thing it must not do.

**Cost** Two places describe one workflow: the registry (English, API consumers) and the
dictionary (Chinese, this UI). A workflow added by hand shows English in both languages until
someone adds the zh entries — visible, not silent.

**Where** `workflows/registry.json`, `frontend/src/lib/server-labels.ts`,
`frontend/src/i18n/locales/zh-CN.ts` (`gateway.models`, `gateway.variants`), `frontend/src/stores/use-config-store.ts`
(`modelOptionLabel`, `baseModelOptions`), `frontend/src/components/settings/resource-center-panel.tsx` (variant list).

**Not translated on purpose** `parameters[].label/description` for the API and plugin consumers
stay English only (nothing in the canvas renders them yet), `bindings.prompt.default` is model
input (#9), and `name` / `source.name` / `lora.filter` are identifiers and patterns.

---


## 21. Model installs are a configured fact, and they are off until stated

**Decision** `INSTALL_INTO_COMFY=1` is required to install models. Without it
`POST /api/resources/install` answers `400 model_install_disabled`, the panel shows a banner and
disables the download buttons, and nothing is inspected to decide any of this. `.env.example` — the
single-machine template the README tells you to copy — ships the line set.

**Why not detection** The two ways to get it wrong are mirror images and both are cheap to hit. A
bind mount or NFS share at a path different from what ComfyUI reports looks exactly like a remote
machine, so a `stat` blocks a working install. Two hosts that both install to `/opt/ComfyUI` look
exactly like one, so the same `stat` allows one that cannot work. A gate that is wrong in either
direction is worse than no gate, and the operator settles it in one line.

**Why fail-closed, and why that was not true before release** The dangerous failure is not an
error: as root, writing into a path that happens to exist here succeeds, gigabytes land on the
wrong disk, and ComfyUI keeps reporting the model as missing with nothing in the log. A default of
"try anyway" would keep that hole open, and the only defence would be an operator who already knew
the answer. While the project had no installed base the trade was different — refusing by default
would have broken deployments that never set the variable — but before release there are none, so
the safe default costs one line in `.env` and nothing else.

**Cost** A first run that skips `.env` gets the panel with installs off; the banner names the
variable, so it is a one-line fix rather than a mystery. Anyone whose mounts are real but
unusual still has to say so, because the process cannot tell them apart from a remote machine —
that is the point, not a limitation to work around.

**Where** `internal/config/config.go` (`boolValue`), `internal/resource/install_policy.go`,
`internal/resource/jobs.go` (`Install`, `installHint`), `internal/resource/status.go`,
`frontend/src/components/settings/resource-center-panel.tsx`, `frontend/src/services/api/resources.ts`, `docs/server.md`,
`.env.example`, `README.md`.

---


## 22. ComfyUI is the only backend, and workflow JSON is the product model

**Decision** The gateway speaks ComfyUI and nothing else. There is no backend abstraction, no
per-backend resource directory, no adapter contract and no install script. A ComfyUI API-format
graph _is_ how a model is defined here: `workflows/<type>-<slug>.json` plus an entry in
`workflows/registry.json` describing name, type, prompt binding and parameters.

**Why** The graph is already self-describing — `BuildSchema` renders the parameter card,
`InferBindings` finds the prompt and image slots, `InferType` decides image/video/audio,
`ImageInputCapacity` counts reference images. A hand-written workflow DSL would have to
reproduce all of that. Wrapping graphs as OpenAI models is the whole idea of the project, and
one backend keeps it small enough to hold in your head.

**Why not a backend abstraction, given a second backend is conceivable** The seam would have to
cut through 26 Go files (`/prompt`, `/history`, `/view`, `/object_info`,
`/internal/folder_paths`, `nvidia-smi`, `ModelLoaderSpecs`, the graph format itself), not just
the resource installer. Abstracting only `resources/` would leave a per-backend resource system
inside a ComfyUI-only gateway: two vocabularies, no payoff. The cheap path for a future backend
is to make _it_ speak ComfyUI's protocol — that costs a compatibility layer in the new thing
instead of a permanent indirection in this one.

**Cost** The graph format's sharp edges stay exposed: two encodings (API vs UI, the UI one is
rejected with an explanation), and the heuristics listed above can be wrong (no prompt binding
inferred, a node class renamed upstream). Those are handled where they occur — a registration
warning, a naming rule, a `ModelLoaderSpecs` edit — rather than behind an abstraction that would
only hide them.

**Where** `internal/workflow` (registry, inference), `internal/comfy`, `internal/resource`,
`workflows/*.json`.

---


## 23. antd stays; the two ways it leaks are quarantined

**Decision** The canvas keeps antd 6 as its component library. Two kinds of knowledge about
it are not allowed to spread past one file each:

- _antd's internal DOM._ Every `.ant-*` class name used by application logic now lives in
  `frontend/src/lib/canvas-overlay.ts`. The overlay guards match our own `data-canvas-overlay` marker
  and the existing `data-canvas-no-zoom` first; the antd class list is a documented fallback
  array beneath them. When antd goes, that array goes and the canvas is not touched.
- _The palette._ App chrome takes its colours from Tailwind's `stone` scale.
  `frontend/src/lib/canvas-theme.ts` keeps its own hex on purpose — it is feature data (the canvas
  palette handed to node renderers and the plugin context), not app chrome.

**Why** Measured before this decision: 60 of 167 frontend files import antd, ~530 JSX
instances and 121 `message.*` calls go through `App.useApp()`, and the antd chunk is 916 kB
(298 kB gzip), the single largest third-party block. The number that made this worth writing
down is not the byte count though, it is the fighting ratio: `globals.css` spends 323 of its
897 lines overriding `.ant-*`, with 155 `!` utility prefixes across 13 components and 23
`[&_…ant-…]` arbitrary variants in 3. A library that 36% of the file tree depends on and a
third of the stylesheet fights is one we can neither swap nor leave alone.

**Why not remove it now** Replacing it is roughly 14–22 engineer-days, and the expensive part
is exactly the part antd has earned: `Form`, `Modal` and `message`, i.e. focus trapping,
nested dialogs, validation ordering and toast key reuse. The seams above turn removal into a
later, cheaper decision rather than an immediate, riskier one. The real blocker was the
`Modal`–canvas coupling: while the guards read `.ant-*`, any migration would have produced
silent drag/zoom regressions instead of compile errors.

**Verified** `CANVAS_CLICK_GUARD` and `CANVAS_WHEEL_GUARD` reproduce the two previous
selectors byte for byte once the new marker is stripped, and `appPalette` matches the old
inline `neutral` object on all 20 colour slots — the quarantine is a refactor, not a
restyle. Note that `#fafafa` in the dark theme is a cold `neutral-50` while its elevated
surface is a warm `stone-900`; that mix predates this decision and is preserved.

**Cost** Whoever finishes the migration must delete the `ANTD_*` constants in
`canvas-overlay.ts`; leaving them behind means the canvas keeps a hidden dependency on a
library that is no longer installed. `design-tokens.ts` and the `:root` / `.dark` block in
`globals.css` cannot import each other, so changing a semantic colour is two edits — both
file headers say so.

**Where** `frontend/src/lib/canvas-overlay.ts`, `design-tokens.ts`, `app-theme.ts`,
`frontend/src/lib/canvas-theme.ts`, `styles/globals.css`, `frontend/src/components/canvas/infinite-canvas.tsx`,
`frontend/src/components/canvas/canvas-context-menu.tsx`, `canvas-size-picker.tsx`, `frontend/src/components/canvas/canvas-resource-mention-textarea.tsx`.

---


## 24. Transient messages go through one facade, not antd

**Decision** Showing a transient message is `toast.success / error / warning / info / loading`
from `@/components/kit/toast`. That module owns the implementation — currently sonner, which
has no dependencies and only a React peer — and is mounted once, in `AppProviders`. Call sites
deliberately keep antd's shape: `toast.loading(text)` returns its own dismiss handler instead
of an id, so the three export/import flows that do `const hide = …; hide()` were not rewritten.
Do not "simplify" that away; it is the seam that keeps the library choice out of the callers.

**Why** antd's `message` was reached 121 times from 20 files, 19 of them through
`const { message } = App.useApp()`. That hook was the only reason those files imported `App`
at all. After the move, `frontend/src/hooks/use-copy-text.ts` and `frontend/src/components/layout/client-root-init.tsx`
import nothing from antd, the file count went 60 → 58, and `App.useApp()` now survives only in
the three files that still need `modal.confirm` (`frontend/src/pages/canvas/project.tsx`,
`layout/app-config-modal.tsx`, `layout/config-prompt-sources.tsx`) — which is the next slice.
It also fixed a real inconsistency: `canvas-node-prompt-panel.tsx` used antd's _static_
`message`, which does not read `ConfigProvider` and therefore rendered with antd's default
theme rather than ours.

**Cost** The toast looks slightly different — sonner's pill, not antd's, and it shows at most
three at a time where antd showed unbounded. The copy and the timing did not change:
`duration: 3000` matches antd's default, and `loading()` is still sticky. The bundle barely
moved (antd 916 kB → 912 kB) because `message` was a thin slice of a library that is still
installed — the byte win only arrives when antd goes entirely, so do not read this migration
as a size optimisation.

**Verified** `tsc --noEmit` and `vite build` clean; the 121 call sites are accounted for
one-for-one, no bare `message` identifier is left in application code, and the three files
that keep `modal` still destructure it correctly.

**Where** `frontend/src/components/kit/toast.ts`,
`frontend/src/components/layout/app-providers.tsx`, `package.json` (sonner), and the 20 migrated files.

---


## 25. Confirmations are a kit primitive, and antd's static helpers are gone

**Decision** Asking "really?" is `confirm({ title, content, okText, cancelText, danger, onOk })`
from `@/components/kit/confirm`, rendered by a single `<ConfirmHost />` in `AppProviders`. It is
imperative on purpose: all three call sites fire from an event handler deep inside a component,
and threading an `open` boolean through them would cost more than the question is worth. The
dialog is radix's `AlertDialog` — it supplies the focus trap, ESC handling and aria wiring that
made antd's version trustworthy — while every class name is ours. `AppProviders` no longer wraps
the tree in antd's `App`; nothing reaches `App.useApp()` any more (measured: 0 call sites, and
the only remaining `.ant-app` reference in the repo is gone too, so no styles depended on it).

**Why** `App.useApp()` was down to the three files that needed `modal.confirm`
(`frontend/src/pages/canvas/project.tsx`, `layout/app-config-modal.tsx`, `layout/config-prompt-sources.tsx`),
i.e. the last thing keeping those files tied to antd's context. With it gone, the antd chunk fell
from 912.9 kB to 883.5 kB purely by deleting the `App` wrapper, and a future migration no longer
has to reason about a context layer.

**Cost** The `onOk` contract is antd's, not radix's: returning a promise keeps the dialog open
with OK disabled until it settles, and a rejection leaves it open rather than closing silently.
That behaviour had to be reimplemented by hand, so if someone later "cleans up" `handleOk` the
async cases will start closing early. The styling is also ours now — it is meant to look like the
antd dialogs around it, and will need a touch-up if the surrounding design moves.

**Where** `frontend/src/components/kit/confirm.tsx`,
`frontend/src/components/layout/app-providers.tsx`, the three call sites above.

---


## 26. Unit tests run on vitest, because bun was never installed

**Decision** `npm test` is `vitest run`; the suites under `tests/` import from `vitest`, and `vitest.config.ts`
exists so the tests do not drag in the app's build plugins. `bun.lock`, `pnpm-lock.yaml` and
`pnpm-workspace.yaml` are deleted — `Makefile` sets `NPM ?= npm`, so `package-lock.json` was the only lockfile
that ever decided what installed. In cf2e72c.

**Why** `bun test` could not run here at all (`bun: command not found`), so the suite was vestigial: never
executed, state unknown. Running it once made that concrete — 4 of 15 assertions were failing, and had been
wrong on every build this repository produced. A suite nobody can run is not coverage; it is a document that
looks like coverage.

**Cost** The suite covers pure functions only — viewport focus, thumbnail choice, model selection. There are no
component or canvas interaction tests, so overlay guards and kit primitives are still verified by hand.


## 29. Dialogs are a kit primitive too; no antd `Modal` is left

**Decision** All 27 `<Modal>` call sites now render `@/components/kit/dialog`. Its props are the
subset antd's call sites actually used — `open`, `onClose`, `title`, `label`, `footer`, `width`,
`bodyStyle`, `bodyClassName`, `closable`, `maskClosable` — so a call site cannot depend on a
feature that does not exist. `kit/button.tsx` was extracted at the same time, because the confirm
dialog and the two antd-free dialogs needed the same three button looks.

Three behaviours are decided deliberately rather than inherited:

- **Always centred.** 23 of the 27 asked for `centered`; the remainder are content panels where
  centring is not a regression.
- **Closing unmounts the children.** That is antd's `destroyOnHidden`, which 13 sites requested
  explicitly. The others were keeping transient form state alive across opens, which is not worth
  preserving.
- **Footers are explicit.** antd's `okText`/`onOk`/`confirmLoading` are gone; the six sites that
  used them build their own row. More lines, but the loading and disabled states are now visible
  where they are decided instead of inferred from antd props.

**Why this had to carry attributes** This is the part that would have broken silently. The canvas
overlay guards used to match `.ant-modal-root` and `.ant-modal-content`; those class names are
gone, and `frontend/src/lib/canvas-overlay.ts` resolves overlays through `data-canvas-overlay` and
`data-canvas-dialog-content`. The kit dialog emits both, so a dialog opened over the canvas still
swallows clicks and wheel, and the prompt mention menu still measures its boundary. Remove those
attributes and the canvas pans behind its own dialogs — a bug with no compile error anywhere.

**Cost** antd's dialog animated in and out; this one appears instantly. Six call sites had already
opted out of that animation with `transitionName=""`, so for them nothing changed, and the rest
lose a 200 ms transition. There is also no `width` default beyond 520 for panels that omit it.

**Verified** `tsc`, `tsc --noUnusedLocals`, 11 tests and `vite build` clean; in the browser the
resource gate, the asset editor, the system panel, the 980 px settings dialog and the destructive
"clear canvas" dialog all open, close via the X / Escape / their buttons, and the DOM after
closing contains no `ant-modal` at all. The antd chunk went 739 kB → 714 kB (240 → 232 kB gzip).

**Where** `frontend/src/components/kit/dialog.tsx`, `frontend/src/components/kit/button.tsx`,
`frontend/src/components/kit/confirm.tsx`, and the 23 files that used to render `<Modal>`.

---


## 30. Buttons keep antd's prop names, and antd's reset stylesheet is gone

**Decision** `kit/button.tsx` takes `type` / `size` / `icon` / `iconPlacement` / `danger` /
`loading` / `shape` — antd's names — so moving 116 `<Button>` call sites off antd was 30 import
swaps and zero call-site edits. Sizes keep antd's metrics exactly (24 / 32 / 40 px) because these
buttons sit in toolbars measured against those heights. Children render inside
`<span data-slot="text">` and the icon inside `<span data-slot="icon">`, because `globals.css`
collapses the canvas composer's label at narrow widths and needs to select one without the other;
the four `.canvas-composer-icon.ant-btn` rules became `.canvas-composer-icon` plus
`> span:not([data-slot="icon"])`.

**Why keep antd's names** They were never antd's invention: `type`, `size`, `icon` and `danger`
are the words these call sites already think in, and a rename pass would have touched 116 lines to
make them say `variant` instead. The shim is documented at the top of the file so nobody mistakes
it for antd.

**The bug this uncovered** With the kit button in place, the home page's primary button rendered as
an empty white pill. The cause had nothing to do with the button: `antd/dist/reset.css` was
imported from `main.tsx`, so it loaded as an **unlayered stylesheet**, and it contains
`input, button, select… { color: inherit }`. Unlayered CSS outranks _every_ cascade layer, so that
one declaration silently beat every Tailwind text colour on every `<button>` in the app —
including the ones that had been antd's until now, where it made no difference because antd styled
its own internals. `text-white` simply never applied to a button. Tailwind's preflight already
normalises the same elements, so the import is deleted rather than layered; verified afterwards
that antd's Select, Input, Tabs and Switch still render correctly without it.

That failure mode is worth remembering: type checks, unused-symbol checks and the reachability
graph all passed while a primary button was invisible.

**Result** antd component instances 238 → 122; files importing antd 42 → 36. The antd JS chunk did
not shrink (714 kB) because Button is imported internally by the components that remain, so this
step buys removability rather than bytes.

**Where** `frontend/src/components/kit/button.tsx`, `styles/globals.css`, `main.tsx`, and the 30 files whose
antd import lost `Button`.

---


## 31. `Select` is the radix primitive, and `mode="tags"` was never a select

**Decision** `kit/select.tsx` keeps antd's prop shape — `value` / `onChange` / `options` /
`placeholder` / `size` / `loading` / `notFoundContent` — but renders the radix primitive already in
`components/ui/select` (the one `model-picker` uses). The popup portal is marked
`data-canvas-overlay`, which is what lets the canvas stop zooming and deselecting under an open
dropdown without knowing what drew it.

`<Select mode="tags">` at the asset form is a different control and is now `kit/tag-input.tsx`: a
chip list plus a text field, with `,` `，` as separators. Routing it through a listbox bought a
portal, an aria listbox and a hidden search input for a field that has no options to list. It keeps
antd's `value` / `onChange` contract, so `Form.Item` binds to it unchanged — verified by watching
the live preview panel pick up the tags as they are typed.

**Two antd features deliberately not carried over**

- `showSearch` / `optionFilterProp` — the radix listbox has built-in typeahead driven by
  `textValue`. Typing a prefix jumps to the matching option. This is slightly weaker than antd's
  substring filter (it matches from the start), and it is the only behaviour difference from antd
  in this migration. The one call site was a handful of upscale models, so it was not worth a second
  combobox implementation with its own keyboard and aria handling.
- Empty string as a value — radix rejects `value=""`. Both directions travel through a sentinel that
  maps back to `""`, so `value=""` still renders as the placeholder, which is what antd did when no
  option carried `""`.

**The bug the browser caught** The first build rendered **two chevrons**: `kit` drew one so it could
swap it for a spinner while loading, and `SelectTrigger` drew its own. Nothing about that is
type-visible. Fixed with `hideChevron`.

**Dead CSS removed here** The last `.ant-select` users were the three `.canvas-control-select`
workflow rules and `.canvas-compact-control.canvas-control-select`, which had had no matching
element since an earlier pass; plus `.canvas-image-settings-popover .ant-popover-inner`, which had
had none since that panel became a hand-styled portal. `globals.css` now contains no third-party
class name at all.

**Result** files importing antd 10 → 8, and the component kinds left are `Form`, `Drawer`,
`ConfigProvider` and `theme`; antd JS chunk 714 kB → 249 kB (gzip 232 → 87). These are the
first bytes this migration has actually returned, because `Select` was the last component pulled in
from outside the `Button`/`Modal`/`Tooltip` subtree that the remaining components drag along.

**Where** `frontend/src/components/kit/select.tsx`, `frontend/src/components/kit/select.tsx`, `styles/globals.css`, and the
four call sites (`frontend/src/pages/not-found/index.tsx`, `frontend/src/components/canvas/canvas-side-panel.tsx`,
`frontend/src/components/canvas/canvas-tool-node-panel.tsx`, `components/layout/app-config-modal.tsx`).

---


## 32. Drawers are a side of `kit/dialog`

**Decision** `kit/drawer.tsx` reuses the dialog's header / scrolling body / optional footer and
adds `placement` and a width. antd expressed width three ways — `width={640}`, `size={280}` and
`size="large"` — so both `width` and `size` are accepted and resolved to a number (`large` was 736).
`extra` keeps antd's header-right action slot, which the channel editor fills with its save/cancel
pair.

**z-index** 1350/1351: above a dialog (1300) because the channel editor opens _from_ the config
modal, and below a confirmation (1400) because deleting an asset from the detail drawer must still
raise one.

**Where** `components/kit/drawer.tsx` and the three call sites.

---


## 33. antd is gone; here is what that cost and what it returned

**Decision** antd, `@ant-design/icons` and `dayjs` are no longer dependencies. Every component the
app used has a kit equivalent in `components/kit/`, and `Form` has no equivalent at all — its two
real uses hold their values in plain `useState` and its 15 label-only uses became `kit/field`.

**Why reverse #23** #23 said antd stays and its two leaks get quarantined. That was the right call
while the goal was to keep merging upstream. Once the goal became long-term maintainability of a
small local app, quarantine turned out to be a way-station: the seams (#23, #24) and the prop-name
shims (#30) made each component cheap to replace one at a time, and the last four (`Select`,
`Drawer`, `Form`, theme) went the same way. The bundle numbers say the quarantine was doing real
work — the antd chunk stayed at 714 kB from 42 files down to 6, then collapsed 714 → 249 → 219 → 93
→ nothing as `Select`, `Form`, and the providers left.

**What it returned** antd JS chunk 916 kB → 0; vite modules 4126 → 2564; dependencies 32 → 29.
`frontend/src/lib/canvas-overlay.ts` no longer contains a single third-party class name — the contract #23 wrote
("when antd goes, that array goes and the canvas is not touched") is now literally true: the array
went, and the canvas code above it did not change.

**What it cost** Three behaviours are narrower than antd's, and they are worth knowing:

- `Select` typeahead matches a prefix, not a substring (antd's `showSearch` filtered on any
  substring). One call site had it: the upscale model list.
- `Form`'s validation is now written per form, so a _new_ form means writing its own checks rather
  than declaring `rules`. There are two forms left.
- The image toolbar settings dialog renders a preview built from antd tokens; it now uses Tailwind
  classes over `design-tokens`. Nothing reads antd's CSS variables any more, which is why removing
  `ConfigProvider` changed no pixel.

**What the browser caught that the compiler could not** In this pass: a duplicate chevron in
`Select` (the kit drew one and the trigger drew its own), and — after `Form` stopped rendering a
`<form>` element — a browser hint that the API key field was no longer inside a form, i.e. no
password-manager prompt. Both were invisible to `tsc`, `--noUnusedLocals`, the tests and the
reachability graph. The second is the same class of failure as a missing JSX brace: deleting a
component deletes the semantics it silently provided.

**Left alone deliberately** radix logs `Blocked aria-hidden on an element because its descendant retained
focus` when a confirmation opens over the button that opened it: `@radix-ui/react-dialog` calls
`aria-hidden`'s `hideOthers` before focus has moved into the layer, Chrome refuses the attribute, and the
page stays readable — which is the outcome we want. Fixing it means patching radix's `hideOthers` or moving
focus in the trigger's `onPointerDown`; both are larger than a console line nobody sees, and neither changes
what the dialog does.

**Where** `package.json`, `components/kit/*`, `frontend/src/components/kit/field.tsx`, `frontend/src/lib/canvas-overlay.ts`,
`lib/design-tokens.ts`, `frontend/src/components/layout/app-providers.tsx`.

---


## 35. What the dependency audit removed, and what it kept against its own rule

**Removed** `@uiw/react-codemirror`, `@codemirror/lang-javascript`, `@codemirror/lang-json` (the
model script editor that used them, which went with the scripts), `@tanstack/react-query` (only the provider
was rendered; no `useQuery` anywhere, so the client was a cache that always stayed empty),
`class-variance-authority` (no `cva()`), `react-router` (redundant — `react-router-dom` 7 declares
it as a regular dependency), and `streamdown` (a markdown renderer whose components were never
used; only its stylesheet was imported, for a `.agent-streamdown` element that no longer exists,
which also took 147 lines of dead CSS with it).

**Moved to `devDependencies`** `tailwindcss`, `tw-animate-css`, `shadcn` — resolved when the CSS is
built, never at runtime.

**Kept even though each is small and single-use**, because replacing them is a rewrite, not a
deletion, and each one earns its place:

- `copy-to-clipboard` — `navigator.clipboard` is **undefined on a plain-HTTP origin**, which is what
  this app is served from (`http://192.168.3.232:3000`). Its `execCommand` fallback is load-bearing.
- `nanoid` — for the same reason the codebase avoids `crypto.randomUUID`: that API only exists in a
  secure context. `nanoid` works over plain HTTP.
- `three` — the angle dialog's camera-orbit preview.
- `motion` — the canvas side panel's animation.
- `fflate` — the asset package zip. `axios`, `file-saver`, `localforage` — the network, download and
  storage layers.

**Also removed while auditing** two analytics IDs in `frontend/src/constant/runtime-config.ts`. Nothing imported
them, no script was ever assembled, and no docs or `.env` entry mentioned them, so the feature was
never wired to anything.

**The rule applied to the kit's own props** Three props were declared in a component's type, passed
by a call site, and never read by the implementation: `Alert.showIcon`, `Empty.image`,
`Dropdown.trigger`. A prop that lies is worse than a missing one — the call site looks configured.
Five more were implemented but never exercised (`Space.direction`, `Field.htmlFor`,
`TagInput.disabled`, `Tag`'s red and purple) and were deleted so the branches cannot rot.

**The list this audit left alone, and what became of it** ~120 exported symbols appeared to have
no importer. Most are types in `types/canvas-plugin.ts`, which is the **published plugin contract**
mirrored by `plugins/canvas/sdk/src/types.ts` — plugin authors import them, so "unused in this
repo" means the opposite of dead, and they are still there. The rest were resolved in #37, which is
why that entry insists on the reference graph: several of them were not dead, only unexported.

---


## 36. One HTTP layer, replacing axios and three copies of the error reader

**Decision** `frontend/src/services/api/http.ts` owns the transport. `httpJson` / `httpBlob` / `httpVoid` wrap
`fetch`; `readApiErrorMessage` and `apiErrorMessage` own the failure-to-sentence mapping. The four
service files that used axios now call these, and their three copies of
`readApiErrorMessage` / `readAxiosError` / `statusMessage` are gone.

**Why it was not necessary** Nothing used a capability only axios has. The one thing that would
have justified it — `onUploadProgress`, which `fetch` cannot do — appears nowhere. No interceptors
beyond the one below, no `CancelToken` (the app already passes `AbortSignal`), no transform
pipeline. Meanwhile the codebase was already split: 32 axios calls in four files against 17 `fetch`
calls elsewhere, including SSE streaming and blob downloads.

**The part that had to be carried over, not dropped** `image.ts` registered an axios response
interceptor that called `noteGatewayError` for requests to the local gateway. That is what flips the
shared "reconnecting" banner instead of raising one toast per node when the gateway restarts. It now
lives in `http.ts`'s `send()`: any network failure reports its URL, and `noteGatewayError` itself is
selective about which URLs and which errors count. A test pins it. This is the second time in this
migration that the risk was a behaviour hiding in library-specific plumbing rather than in our code
(see #33's `<form>` for the same shape).

**Two behaviours improved** A timeout is now distinguishable from a cancel: `fetch` is aborted with a
`TimeoutError` reason, so the image service keeps its `imageTimeout` wording instead of the axios
path's `ECONNABORTED` special case in one file only. And a non-2xx that a caller expected to be a
blob is still read as text, where axios produced an unreadable `Blob`.

**Verification** 28 tests in `frontend/tests/api-http.test.ts` pin every branch of the mapping — cancel,
timeout, API-supplied message, each status, the fallback, HTML error pages, and the gateway report —
because a browser can demonstrate the result but cannot enumerate the branches.

**Result** vendor chunk 556.7 → 514.4 kB (≈16 kB gzip), runtime dependencies 19 → 17.

**Where** `frontend/src/services/api/http.ts`, `services/api/{image,video,audio,skin-unlocks}.ts`,
`frontend/tests/api-http.test.ts`.

---


## 37. An export is a promise, and ninety-eight were not keeping one

**Decision** A symbol is exported only when another module imports it. Where nothing outside the
declaring file referred to a symbol that was exported anyway, the keyword was removed and the
symbol left exactly where it was; where _nothing at all_ referred to it, it was deleted. 583
exports under `src/` became 464.

**Why** An export is a contract with a caller who may not exist. It pins a name, a signature and
a shape, and every later reader has to establish whether something out there depends on it before
changing it. Most of these were leftovers rather than contracts: the canvas upscale and
angle-transform routines lost their callers when the gateway took over those workflows, and
`setPackMainModel` lost its when the resource panel stopped offering a main-model picker.

**How the two cases were told apart** With the TypeScript language service, not with grep.
`findReferences` follows barrel re-exports, resolves aliases, and reports whether each reference
comes from the declaring file or from elsewhere — three things a text scan cannot do. `tsc
--noUnusedLocals` then supplied the other half: a symbol used only inside its own file is not dead
yet, but once it stops being exported it may be, and the compiler says so.

**What grep would have got wrong** `fetchImageModels` has no caller by name outside `image.ts`.
Its caller is `fetchChannelModels`, one file down. A name-only scan deletes a live function here.
The reverse error is just as likely: `frontend/src/components/kit/select-primitive.tsx` lists every part in a trailing
`export { … }` block, so each part looks referenced — the file appears to use itself. Removing
those entries exposed the truth, and `SelectGroup`, `SelectLabel` and `SelectSeparator` had no
caller inside the file either; they were deleted rather than narrowed, because a component nothing
renders is not an API.

**Cost** Anyone who wants one of these helpers from outside has to add `export` back — a one-word
change made where its intent is obvious. The cost of the alternative is permanent: a reader cannot
distinguish a narrower module from one that happens to have no callers today.

**Where** `canvas/web/src/**`, and the commit that removed the sixteen dead symbols.

---


## 38. Unused translation keys are pruned by key, with reachability decided on the AST

**Decision** A key is deleted when no call site can ask for it. This replaces the pruning by namespace
that came before it, which had to stop at a namespace because a script could not separate a dead string
from one reached through a computed key.

**Why the earlier reasoning could be finished rather than accepted** That warning was right about the
_naive_ script, which is why it stopped. The cases it named are all decidable if the analysis
reads the syntax tree instead of the text: `t(\`settingsPanels.common.${labelKey}\`)` and
`t(\`assets.kinds.${kind}\`)`mark a subtree reachable, and`t(cond ? "a.b" : "a.c")`— the shape
this codebase uses for tooltips — contributes both literals, where a regex sees only the
condition. Keys built by concatenation and by`getFixedT("zh-CN")(…)` are handled the same way.

**The four call sites that stop an analysis dead** `t(item.labelKey)` appears four times. Each
source is a local constant list in the same file, so the eight keys are read out by hand and listed
in the analysis. They are the only place the tool is told the answer instead of deriving it, and
that is the stated risk: a new `t(someVariable)` invalidates the pass.

**Verification, because "nothing looks broken" is not one** The new key set must equal the old set
minus the dead set, key for key, in both dictionaries — a set comparison rather than a diff that a
human skims. It does: zh 1118 → 980, en 1099 → 961. Afterwards the analysis reports zero
unreachable keys, and a DOM scan across every route in both languages returns no rendered key.

**What it found** Two whole namespaces: `config.promptSources.*` (~50 keys for a prompt-library
panel that no longer exists) and `canvas.agentOps.*` (labels for an agent feature that is gone).
Two keys that this migration itself had orphaned — `common.durationMinutes` / `durationSeconds`,
whose only caller was `formatDuration`, deleted two commits earlier — which is the analysis
agreeing with the code rather than with its own assumptions.

**Cost** ~200 lines out of the dictionaries, 18 kB of the index chunk. Deleting the wrong one
shows a raw key to the user, so the two guards above are not optional: the set comparison catches
an over-delete _before_ the build, and the DOM scan catches whatever it cannot see.

**Where** `src/i18n/locales/{zh-CN,en-US}.ts`.

---


## 39. All UI copy lives in the dictionaries — including the panel that kept its own

**Decision** `resource-center-panel.tsx` no longer holds a `copyByLocale` object with `zh` and `en`
side by side. Its 102 strings moved to `resources.panel.*` and are read with
`t("resources.panel", { returnObjects: true })`.

**Why, given the old shape was not wrong** It was correct, bilingual and type-checked, which is
why it survived this long. But it was the only copy in the app that `grep resources.panel`-style
maintenance could not find: someone translating a string had three places to look, and the whole
point of #17 is that there is one. The values were extracted from the component's own object by
script and re-emitted verbatim, so the migration could not retype or re-translate anything — the
check was a value-by-value comparison against the originals, 102 of 102 identical in both
languages.

**What had to be preserved** The type. `type Copy = typeof copyByLocale.zh` made `copy.titlex` a
compile error and, more importantly, checked the two `copy[\`runtimeDep\_${id}\`]`lookups. That is
now`type Copy = typeof import("@/i18n/locales/zh-CN").default.resources.panel`: the dictionary is
the source of truth, and a `Record<string, string>`would have silently allowed a typo through as`undefined` at render time.

**The Chinese that stays, and why each one does** Thirteen lines across six files, all deliberate:

- **Protocol values** `PromptOptimizeMode` (`文生视频(T2VA)` …) and the `referenceNote` hint in
  `canvas-node-prompt-panel.tsx` are form fields sent to the gateway; the backend matches the
  former and feeds the latter to a workflow (#9).
- **Parsed data** the `^(物体|人物|文字)` regex and the `人物：` caption prefix in the MOSS layout
  dialog are an agreement with the gateway about the shape of its output, not copy.
- **Decorative art** the mascot slogans in `canvas-node.tsx` are set in a CJK font stack and
  paired with their own English line (`PROCESS GUARDIAN`, `LIGHT BE WITH YOU`). Translating them
  would print the same sentence twice.
- **Endonyms** `中文` in the language picker and `中` on the switcher name a language in that
  language, which is what every language switcher does.

**Cost** One `as unknown as Copy` cast at the boundary, and a component that now depends on the
dictionary's shape for its types. Both are visible where they are written down.

**Where** `frontend/src/components/settings/resource-center-panel.tsx`, `frontend/src/components/settings/resource-setup-gate.tsx`,
`src/i18n/locales/{zh-CN,en-US}.ts` (`resources.*`).

---


## 40. There is no landing page; `/` is a redirect to a canvas

**Decision** `pages/home` is deleted. `/` renders `CanvasEntry`, which resolves to a canvas
address and replaces the URL with it. The app has exactly one kind of screen — a canvas —
and no page that exists only to be looked at on the way in.

The resolution order is deliberate:

1. the canvas you were **last inside**, from a stored `lastProjectId`;
2. otherwise the most recently modified one;
3. otherwise a new canvas.

**Why not "most recently modified" for step 1** Opening a canvas to read it does not touch
`updatedAt`. Look at canvas A for ten minutes, edit B, close the browser: `updatedAt` says B
but you left A. The remembered id is the only thing that actually answers "where was I".

**Why `replace`, and why it matters more than it looks** Without it the history keeps `/` and
every Back press bounces through the redirect again. This single attribute is the difference
between "the URL is the canvas" and a browser that fights you.

**What it costs** The app has no brand surface left: the toolbar title shows the canvas name,
and `无界工作台` now appears only in the browser tab, appended to the canvas name. That was
the trade the request asked for — the tool is the work, not a front door — but it should be
named rather than discovered.

**Two bugs this surfaced, both pre-existing** The dictionary never had `assets.kinds.audio`,
which the built-in Audio node asks for by name, and it never had `agent.composer.mentions.*`,
which two error paths in `canvas-resource-references.ts` still threw. Both printed raw keys
to the user. The node title was wrong since audio nodes existed; the error messages only fire
when a reference image cannot be read, which is why neither was noticed. They were found by a
check that compares every literal `t("…")` against the flattened dictionary — the inverse of
the dead-key pass in #38, and worth running whenever keys move.

**Follow-up: the list itself became a panel** `pages/canvas/index.tsx` (116 lines) is gone and
`/canvas` no longer renders a page. The list floats over the canvas you are already in, opened
from the switcher or the canvas menu. It is the same body — multi-select for delete, import, and a
card per canvas that exports itself — because that part was always right; only the container
changed. (The batch export it once carried is gone: one archive is one canvas, #172.)

The test that settled it: is this worth a URL? A canvas is — it can be shared, bookmarked, and
reloaded into the same state. A list of canvases cannot: nobody shares "my canvases", refreshing
it means nothing, and Back is worse than Escape. What a route bought was an unmount of the canvas,
a route change, and a full remount to get back to where you already were.

Two details worth keeping. `CanvasDeleteProjectsDialog` renders as a sibling of the manager, not
a child, so the two are independent radix roots rather than a nested focus trap. And `/canvas`
still resolves — to a redirect, so old bookmarks land on a canvas instead of a 404.

**Where** `frontend/src/pages/canvas/entry.tsx`, `frontend/src/router.tsx`, `frontend/src/stores/canvas/use-canvas-store.ts`
(`lastProjectId`), `frontend/src/components/canvas/canvas-top-bar.tsx` (the switcher this made obvious:
switching used to mean leaving the canvas for the list page), `components/canvas/canvas-manager-dialog.tsx`.

---


## 41. `npm run check` is the third gate, because the compiler cannot see these two bugs

**Decision** Two scripts in `canvas/web/scripts/` run as `npm run check:i18n` and
`npm run check:exports`, together with `tsc --noEmit` under `npm run check`. A third,
`check:decisions`, joined them in #336: every `#N` a comment or a doc cites has an entry in this file.

**Why they exist** Both catch a class of bug that type-checks, builds, and passes tests while
being visibly broken:

- **A missing translation key.** A key absent from one dictionary renders the other language's
  text through `fallbackLng` — no error, no warning, just a sentence in the wrong language. The
  inverse is worse: deleting a key that is still asked for prints the key itself on screen. This has happened
  three times in this repository — `assets.kinds.audio` (the built-in Audio node's title, wrong
  since audio nodes existed), `agent.composer.mentions.*` (two error paths), and
  `navigation.config` (the settings button's aria-label, deleted as a dead key by the very commit
  that made it dead).
- **An export nothing imports.** An export is a promise to a caller who may not exist, and a
  `tsc` pass cannot tell an unused export from a used one. See #37 for why grep is not enough.

**What makes them checks and not trivia** They are not advice in a document; they exit non-zero.
`check:i18n` compares every literal `t("…")` against the flattened dictionaries in both
directions, compares the two dictionaries to each other, and treats a `t("…", { returnObjects })`
object path as a branch rather than a missing leaf. `check:exports` uses the language service.

**The two exceptions, written down where the script can see them** `chinese()` in
`lib/server-labels.ts` asks only the zh dictionary, so `gateway.models.*` and
`gateway.variants.*` are zh-only on purpose — enumerating them in `check-i18n.cjs` stops the
"only in zh-CN" check from failing every run. And four `t(variable)` call sites read their key
from a local constant list; the eight resulting keys are listed by hand in `HAND_RESOLVED`,
which is the one place the tool is told the answer instead of deriving it. The script prints any
`t(variable)` it meets so that list stays honest.

**Renamed while passing through** `canvas.projectPage.*` (37 keys) became `canvas.runtime.*`.
`projectPage` named a page that no longer exists — the list is a panel now — and these keys were
never page furniture: they are stop-generation, export, clipboard and failure messages emitted
_by_ the canvas. `canvas.project.*` keeps the list-management keys, which is what "project"
actually means here.

**Where** `frontend/scripts/check-i18n.cjs`, `scripts/check-exports.cjs`,
`scripts/check-decisions.cjs`, `package.json`.


## 42. Ten "which node has which dialog open" states become one

**Decision** `project.tsx` held ten independent `useState<string | null>` — `cropNodeId`,
`maskEditNodeId`, `outpaintNodeId`, `mossLayoutNodeId`, `splitNodeId`, `upscaleNodeId`,
`superResolveNodeId`, `videoUpscaleNodeId`, `angleNodeId`, `infoNodeId` — each meaning "this
editor is open on this node". They are now one nullable record:

```ts
type CanvasNodeTool = "info" | "crop" | … | "angle";
const [activeNodeTool, setActiveNodeTool] = useState<{ kind: CanvasNodeTool; nodeId: string } | null>(null);
```

with `openNodeTool(kind, nodeId)` / `closeNodeTool()`, and the ten `xxxNode` render variables
derived from it by a one-line kind check each.

**Why not leave it alone** It was not merely verbose, it was a bug generator. Three code paths
reset "the open editor" and each cleared a different, incomplete subset:

| path                 | cleared                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `deleteNodes`        | info, crop, maskEdit, angle — **not** outpaint, mossLayout, split, upscale, superResolve, videoUpscale |
| `clearCanvas`        | the same four                                                                                          |
| the `Escape` handler | info, crop, maskEdit only                                                                              |

So pressing Escape with the split dialog up did nothing. Opening the outpaint dialog and then
deleting the node from the keyboard left `outpaintNodeId` pointing at an id that no longer
existed — invisible only because every render site guards on `node.metadata?.content`, so the
stale id silently rendered nothing and stayed set until the next open. With one state the resets
are one line each and cannot drift apart again.

**The invariant it buys** "At most one node editor is open" was previously a convention nobody
enforced; nothing in the type system prevented `cropNodeId` and `splitNodeId` from both being
set. Now it is the shape of the state. `dialogNodeId` deliberately stayed separate: that one is
the composer panel, which is long-lived and _does_ coexist with a modal (you can have the prompt
panel open while a crop dialog floats above it). Only the modal ten were collapsed.

**Cost** 52 `useState` in the component became 43. The diff is 59 insertions and 64 deletions,
almost all of them mechanical renames the compiler checked.

**Where** `frontend/src/pages/canvas/project.tsx`.


## 43. The node editors are a module with a nine-key contract, not a closure

**Decision** Nine editors moved out of `project.tsx` into
`frontend/src/pages/canvas/hooks/use-image-editors.ts` (crop, split, mask, outpaint, MOSS layout, super-resolve,
fast upscale, multi-angle) and `frontend/src/pages/canvas/hooks/use-video-editors.ts` (video upscale, frame
interpolation). `project.tsx` was 3,981 lines; it is now 3,459. Five modules appeared:
the two hooks, `hooks/node-editor-deps.ts` (a type), `frontend/src/lib/canvas/canvas-generated-video.ts` and
`frontend/src/lib/canvas/canvas-node-status.ts`.

**Why these nine and not "generation"** They were the only large, genuinely closed region left.
Every one of them follows the same shape — take the node you were handed, append a child beside it,
wire a connection, select the child, open its composer, and (where it generates) drive exactly one
request. Not one of them _reads_ the graph. That is what made the extraction honest: the whole
surface they need is six setters, two request-registry calls and `closeNodeTool`. Everything else —
`effectiveConfig`, `isAiConfigReady`, `openConfigDialog`, `t` — they can read themselves from the
stores, so it is not in the contract.

`dialogNodeId` and the ten-entry `activeNodeTool` record stayed in the page: the page owns _which_
editor is open, the editor module only owns what happens once you press confirm. Rendering the ten
dialogs stayed in the page too — they are page furniture, positioned against page state.

**Two things fell out of the move**

- `applyGeneratedVideo` and the 420 px video cap were used by both the poller (which stays) and the
  video editors (which left), so they went to `frontend/src/lib/canvas/canvas-generated-video.ts` rather than
  being duplicated or imported page-ward from a hook.
- `NODE_STATUS_*` were four `"idle" | "loading" | "success" | "error"` literals declared in
  `project.tsx` and re-typed by hand in the node components. Now that two more modules needed them
  they moved to `frontend/src/lib/canvas/canvas-node-status.ts`.

**What this is not** It is not a line-count win: 522 lines left the page and 603 arrived elsewhere,
because each hook carries its own imports and the contract type is written down instead of being
implicit. The win is that "what a node editor may touch" is now a 23-line type you can read in one
screen, and that proving an editor correct no longer means standing up a 3,459-line component.

**Where** `frontend/src/pages/canvas/hooks/`, `frontend/src/lib/canvas/`.


## 44. `handleGenerateNode` was 440 lines and four of them did not talk to each other

**Decision** The four generation modes — image, video, audio, text — moved out of `handleGenerateNode`
into `frontend/src/pages/canvas/hooks/use-generation-runs.ts`, one function each. `handleGenerateNode` is now a
123-line orchestrator: resolve config, hydrate the prompt, build a `GenerationRun`, dispatch on mode,
own the shared `catch` and `finally`.

`project.tsx`: 3,459 → 3,150 lines.

**What the four actually shared** Almost nothing. A 440-line function was: ~45 lines of a
`writeBackToSelf` special case, ~40 lines of shared setup, then four branches of 143 / 47 / 29 / 115
lines, then a `catch`/`finally`. The branches agreed only on inputs — which node, the hydrated
prompt, the resolved config, whether to overwrite the source, and the run controller. That is the
whole of `GenerationRun`, and it is why the split is a move and not a rewrite.

**The one thing that is not a pure move** `pendingChildIds`. Each mode records the nodes it created
so the caller's `catch` can stamp them as failed; it has to survive the mode returning early, so it
is a mutable field on the run rather than a return value. Four `pendingChildIds = [...]`
assignments became `run.pendingChildIds = [...]`. Everything else in the four bodies is
byte-identical to what was there before — verified by diffing the moved ranges against
`git show HEAD` with indentation normalised, which leaves only the `}, [deps]);` closer.

**Which state stayed in the page** `runningNodeId`, `setExpandedBatchNodeIds` and the error
stamping in `catch` — because they are about the canvas, not about one request. The five setters and
the two registry calls go in as `GenerationRunDeps`, the same shape as `NodeEditorDeps` (#43).

**Where** `frontend/src/pages/canvas/hooks/use-generation-runs.ts`.


## 45. The page owns the canvas, the generation module owns generation

**Decision** Every function that starts a run lives in `use-generation-runs.ts`, and `project.tsx` holds none:
`handleGenerateNode` dispatches into the module, and the module's four modes (image, video, audio, text) own
their own request, their own watch and their own outcome. What the page keeps is the canvas: the nodes, the
connections, the selection, the dialog.

**Why the seam is there** Not code reuse — the modes share almost nothing — but ownership. A function in the page
that starts a run has to reach into the module for the config, the mode and the completion, and the module then
has to be told what the page is doing. One rule, "a run is started in one file", is what makes the four modes
readable side by side: what they share is a config, a readiness check, one request into one node, and a stamp on
the outcome.

**Cost** The module reads the graph as well as appending to it: `GenerationRunDeps` carries `nodesRef` and
`connectionsRef`, and the two are used where a run needs to look at what it is starting from — the inpaint mode
reads its masks off the nodes it is given (#330). A module that only appended would have needed neither.

**Where** `frontend/src/pages/canvas/hooks/use-generation-runs.ts`.


## 46. Three pieces of housekeeping, and what two of them turned out to be

All three came out of the same audit as #41–#45 and all three changed shape once I read the code.

### `components/layout/` was 80% settings

Ten files lived under a name that described two of them. `app-providers` and `client-root-init`
are the app shell; the rest are the settings feature — the config modal (610 lines), the resource
centre (881), the channel editor, the model picker, the storage-usage panel and the setup gate that
opens the resource centre when nothing is configured.

Six files moved to `components/settings/`. `components/layout/` keeps four: providers, root init,
the reconnect banner and the status actions. The split is by _what the file is_, not by where it
renders — all ten render from the same two places.

### The stores had no rule

`stores/` held `use-panel-store` and `use-canvas-side-panel-store` next to `use-asset-store` and
`use-theme-store`, while `stores/canvas/` held the graph and the plugin registry. Two of those four
are about a canvas and two are about the app, and nothing said which was which.

The rule now holds and is visible from the directory listing: **`stores/` is app-wide** (config,
theme, storage recovery); **`stores/canvas/` is everything about a canvas** (the graph, plugins, the
floating panels, the side panel, the canvas list). Three files moved and two were renamed:

| was                                     | is                                             |
| --------------------------------------- | ---------------------------------------------- |
| `stores/use-panel-store.ts`             | `stores/canvas/use-canvas-panel-store.ts`      |
| `stores/use-canvas-side-panel-store.ts` | `frontend/src/stores/canvas/use-canvas-side-panel-store.ts` |
| `stores/canvas/use-canvas-ui-store.ts`  | `frontend/src/stores/canvas/use-canvas-list-store.ts`       |

**The merge I proposed and did not do** The audit said to fold `useCanvasUiStore` into
`usePanelStore`. Reading them, that is wrong: `useCanvasPanelStore` answers "which floating panel is
open", which is app-level navigation state that outlives any panel; `useCanvasListStore` holds which
canvas rows are ticked and which one is being renamed, which is widget state that belongs to one
open panel. Merging them would have produced a store with two different lifetimes inside it. The
name was the problem — `ui` said nothing — not the split.

### The storage panel reported a number that was quietly wrong

`local-storage-usage.ts` measured one database, hardcoded, named `"infinite-canvas"`. But plugins
write to a second one, `"infinite-canvas-plugins"`, one object store per plugin id. A canvas with
heavy plugins therefore showed less than the browser was actually holding against the quota, and
nothing anywhere said so.

All the database and store names are now in `services/localforage-databases.ts`, which four files
import instead of repeating the strings, and the reader measures both databases.

It also no longer creates what it measures. `indexedDB.open(name)` _creates_ a database that is not
there, so the old reader would have materialised an empty `infinite-canvas` on a fresh profile just
by visiting the settings tab. `indexedDB.databases()` answers "which exist" without touching
anything; the open is only reached for names the browser confirms.

**Two labels were pointing at stores that no longer exist** `agent_chat_messages` and `prompt_cache`
were in `storeLabelKeys` — and their translations in both dictionaries. `check:i18n` could not see
they were dead because the lookup is a template literal, and a template literal registers as a
_prefix_, so everything under `config.localStorage.stores.` counted as reachable. Removed from both
locales along with the labels: 1108 → 1107 keys.

**Verified** `npm run check`, strict `tsc`, 39 tests, build. In the browser the panel renders
`infinite-canvas · v7` with the real per-store breakdown, and `indexedDB.databases()` after visiting
the tab still returns exactly one database — the absent plugin one was reported as absent rather
than created and shown empty.

**Where** `components/settings/`, `stores/canvas/`, `services/localforage-databases.ts`,
`services/local-storage-usage.ts`.


## 47. Content ingress is a module: `File | string` in, node out

**Decision** Eight callbacks that turn something the user handed us into a node moved to
`frontend/src/pages/canvas/hooks/use-content-ingress.ts` (310 lines): the three `create*FileNode`, the clipboard
text node, the system-clipboard paste, the file-picker request, the file-picker handler, and drop.
`project.tsx`: 2,990 → 2,735 lines.

**The line that makes it a module** Not one of them reads the graph. They take a `File` or a string
and append. The only thing they need from the page is where the viewport is looking
(`screenToCanvas`, `getCanvasCenter`, `size`, `containerRef`) plus five setters. That is
`ContentIngressDeps`.

**The picker owns its input** `imageInputRef` and `uploadTargetRef` moved into the hook rather than
being passed in, because the module owns the behaviour that clicks the hidden `<input type="file">`.
The page still renders the element — it destructures `imageInputRef` and attaches it — but it no
longer knows what the ref is for. Passing it in would have been the page owning a piece of the
module's mechanism.

**What stayed behind** `pasteCopiedNodes` (copy/paste of _canvas nodes_, which is graph logic with
connection re-mapping, not content ingress) and `handleAssetInsert` (which inserts from the asset
library and asks the page where the selection is).

**A line was almost lost** The first attempt sliced one line too far and left `handleNodeResize`
with an empty body — a callback that silently does nothing. The compiler caught it only because the
destructured parameters became unused under `--noUnusedParameters`. Every move since then is
checked by reconstructing HEAD minus the moved ranges and diffing it against the result; that diff
is now exactly zero, which is a stronger statement than "tsc passes".

**Verified end to end, not just compiled** The hidden input was driven from the browser with a real
`File` built from a canvas and a `DataTransfer`: a node titled `ingress-test.png` appeared with its
image, selected, composer open, and was deleted afterwards. Console empty.

**Where** `frontend/src/pages/canvas/hooks/use-content-ingress.ts`.


## 48. Three small correctness fixes found by a full read of the frontend

The audit that produced #41–#47 stopped after the first four items. This is the pass that finished
it: 168 files, 29,850 lines, read rather than grepped for keywords.

**What the scan said about the codebase overall** Zero `any`, zero `@ts-ignore`, zero empty
`catch`. Seven non-null assertions, five `eslint-disable`, and every one of the five carries a
comment saying why — three of them in `canvas-node-prompt-panel.tsx` exist to keep a text input from
being reset mid-typing. There is no category of "type system bypassed everywhere". The problems are
in the seams between files, which is exactly what a compiler cannot see.

### The side-panel width had two owners

`use-canvas-side-panel-store.ts` declares `WIDTH_KEY = "canvas-side-panel-width"` and reads it at
boot. The _write_ was a bare literal in `canvas-side-panel.tsx`, on pointer-up:

```ts
localStorage.setItem("canvas-side-panel-width", String(nextWidth));
```

Two files, one key, no link between them. Change the constant and the panel silently stops
remembering its width; change the literal and the same. And `setWidth` was the only setter in that
store that did not persist — `openPanel`, `closePanel` and `setNodeViewMode` all do — so the store
was internally inconsistent about what "set" means.

Writing on every pointer-move would hammer localStorage, which is presumably why it was done at
pointer-up in the component. So the store grew `commitWidth()`, which writes the current width, and
the component calls that instead. Same write frequency, one owner, and `setWidth` is again just the
live setter it looks like.

### Two known bugs, both in the resource centre

Known issues #4 and #5 had been sitting there with the fix written down. #4: the workflow status tag
fell through to "Restart needed" for _any_ unavailable workflow, including one blocked by an
uninstalled custom node — a label promising something a restart will not deliver. It is now a
three-way branch, and a workflow carrying `problems` says "Load failed".

#5: the "Canvas entry" tag rendered exactly when `modelVisible === false`, i.e. when the workflow is
hidden from the picker. The audit offered "invert the condition or rename the label"; the label was
renamed to "Hidden from picker", because inverting a condition on a guess about intent changes
behaviour, and this one does not.

Both were one file away from the `components/layout` → `components/settings` move in #46, which is
how they got found again — known issue #4 still pointed at the old path.

### One thing found, documented, not fixed

`use-canvas-store` and `use-asset-store` both `JSON.parse` persisted state with no guard. A corrupt
blob makes the parse throw, zustand swallows it into `onRehydrateStorage`, that listener ignores the
error, and the app comes up with empty defaults over data that is still in IndexedDB. Recorded as
known issue #12 rather than fixed here, because the half that matters — telling the user their saved
state could not be read — is a product decision, and the parse half on its own changes nothing
anybody can see.

**Verified** `npm run check`, strict `tsc`, 39 tests, build. The width fix was checked end to end in
the browser: drag the resizer 280 → 400, reload, the panel comes back at 400. The two tag fixes
were not exercised, because they need the gateway to report a workflow with problems or a hidden
one, and the local gateway reports neither.

**Where** `frontend/src/stores/canvas/use-canvas-side-panel-store.ts`, `frontend/src/components/canvas/canvas-side-panel.tsx`,
`frontend/src/components/settings/resource-center-panel.tsx`, `i18n/locales/`.


## 50. Every floating panel is 1000×646, or it is not a panel

**Decision** `Dialog` no longer takes `width`. It takes a required `size` from a closed set, and
`size` is not a hint:

```ts
const SIZE_CLASS = {
  panel: "h-[min(760px,88dvh)] w-[1000px]",
  form: "max-h-[90dvh] w-[520px]",
  auto: "max-h-[90dvh] w-auto",
};
```

Thirty call sites were classified. Nineteen are `panel` — the canvas list, the asset library, the
settings modal, the plugin manager, the asset picker, the model picker, the quick-tools settings,
the prompt editor, and all eight image/video editors. Nine are `form` — confirmations, the shortcut
sheet, system status, the cloud-API editor, the card-skin picker, runtime help. Two are `auto`, and
only two: the image preview and the media preview, whose size _is_ the image.

**The problem it fixes** Before this, every dialog's width was a literal between 440 and 1100 and
**not one of the thirty set a height** — height was whatever the content happened to be, capped at
90dvh. So:

- settings (980) → asset library (1100) → canvas list (920) → plugin manager (640): the frame moved
  sideways by 180px between any two of them, and vertically by whatever the content did;
- inside settings, switching between Providers, Prompt API, Preferences, Add workflows and Local
  storage resized the same window five times, because those five tabs have very different content.

A window that resizes to its contents stops reading as a window. The user's sense of "where I am" in
a spatial UI depends on the frame staying put.

**Why not one size for everything** A confirmation is one sentence and a paragraph. Forcing it to
1000×646 would be its own kind of wrong — a giant box that shouts about something small. Keeping
`form` content-sized preserves that, and nothing is lost, because a confirmation is not a place you
_are_, it is a question you answer. `auto` stays for the same reason from the other direction: a
preview's size is information, not layout.

**Why `size` is required and there is no default** A default would have let an unclassified call
site keep its old behaviour silently. Making it required turned the compiler into the checklist:
after the kit changed, `tsc` listed all thirty sites and could not be satisfied until each was
classified.

**Accepted cost** A panel with little content leaves space at the bottom. The video upscale editor
is the clearest case. Measured on a 734px-tall window the panel is 646 tall (`88dvh`); on a 1080p
screen it is 760, and only the tallest editors scroll.

**Measured after the change** Settings across all five tabs: 1000×646, 1000×646, 1000×646, 1000×646,
1000×646. Canvas list: 1000×646. Asset library: 1000×646. Crop editor: 1000×646. Clear-canvas
confirmation: 520×161, unchanged.

**Where** `frontend/src/components/kit/dialog.tsx` and the thirty call sites.


## 51. The editors' canvases fill the panel instead of guessing at the viewport

**Decision** The four editors that sized their image area against the _viewport_ now size it against
the _panel_. The dialog body becomes a flex column (`bodyClassName="flex flex-col"`) and the image
area takes the remaining space (`flex-1 min-h-0`), with a small `min-h` as a floor rather than a
typical value.

| editor    | was                                 | is                                          |
| --------- | ----------------------------------- | ------------------------------------------- |
| crop      | `h-[min(62vh,620px)] min-h-[340px]` | `flex-1 min-h-[260px]`                      |
| mask edit | `h-[min(68vh,720px)] min-h-[360px]` | `min-h-[320px]` (stretched by the grid row) |
| split     | `h-[340px] min-h-[300px]`           | `flex-1 min-h-[240px]`                      |
| node info | `h-[56vh] min-h-[360px]`            | `flex-1 min-h-0`                            |

**Why this was needed at all** Prettier-adjacent: #50 made every panel a fixed height, and these four
had heights expressed in `vh`. On a viewport where `88dvh` is smaller than `62vh` plus chrome — which
is exactly what a 734px-tall window gives — the editor content came out taller than the panel and the
body scrolled. Measured before: the crop dialog needed a scrollbar and its footer was below the fold.
Measured after: `scrollHeight - clientHeight` is 0 in all four, and the crop dialog's Reset / Cancel /
Crop row is visible without scrolling.

The numbers were also the wrong kind of number. `62vh` is a guess about how tall an image wants to be
on somebody else's monitor; `flex-1` is the actual answer, because the panel already knows its height.

**A predating bug found while measuring** In the mask editor the action row needs about 360px for
Reset, Export to canvas and Generate, and sits in a fixed `320px` grid column — so Generate was
clipped by the dialog's `overflow-hidden`. This was true at the old 980px width as well, since the
column was 320 then too; the arithmetic, not the change, is what shows it. The row now wraps
(`flex-wrap`), so the three buttons reflow instead of the last one disappearing.

**Where** `components/canvas/canvas-node-{crop,mask-edit,split}-dialog.tsx`,
`frontend/src/components/canvas/canvas-node-toolbar.tsx`.


## 53. One run protocol; media type is data, not routing

**Decision** Every generation is a `run`: `POST /api/runs` returns an id, and status, progress,
outputs and cancellation all hang off that id. Image, video and audio are three workflows, not
three families of endpoints. `wait`-style blocking endpoints do not exist. The target is written
down in [`protocol.md`](protocol.md); this entry records why, and what lands first.

**What was wrong without it**

- The API grew as _media × action_: `images/generations`, `images/edits`, `images/upscale`,
  `videos`, `videos/upscale`, `videos/interpolate`, `audio/speech`. Every new capability adds a
  route, a handler and a test, and the handlers drift apart.
- Execution model was chosen by media type, not by how long the work takes. Images and audio
  blocked inside one HTTP request; video got a job. Music generation takes minutes, so it ended up
  on the blocking path — exactly the case where a dropped connection loses the work.
- Handler code contained workflow identity: `entry.ID == "video-h3-t2v"`, `"video-h3-fast"`,
  `"video-h3-frames"`, `"video-h3-ref2va"`, `image-qwen21`, `image-moss-*`. Adding a workflow meant
  editing Go, which contradicts `registry.json` being the workflow data.
- One concept, several spellings: duration is `seconds` for video and `duration` for audio;
  resolution is `size`, `quality`, `vquality` and `resolution_name`; everything else went into a
  `params` field that accepts both an object and a JSON string.
- Uploads were classified by magic field names (`contains "image"` or `"frame"`), so an OpenAI
  `mask` could not be expressed at all, and roles depended on field order.
- Outputs had three retrieval paths: base64 in the body, `/files/{name}`, and
  `/v1/videos/{id}/content`.

**Why the id, and why no `wait`** A blocking variant returns two different success shapes (`200`
with the artifact, `202` with a run), so clients need polling anyway — while the blocking call
brings back the failure the id exists to prevent: the connection dies and the finished work is
unreachable. One shape, one code path, and the work survives reloads and disconnects.

**What lands first** The execution core, because it is shared by every later phase: submission,
queueing, persistence, progress and cancellation move into one helper over the existing
`internal/task` store, and audio joins video on it. Audio then stops being a blocking generation —
its `/v1/audio/speech` adapter submits a run and waits on the run, and the run survives the client.
`/v1/*` stays as a thin adapter so the canvas keeps working and the existing e2e tests keep
guarding the behaviour until their node type migrates.

**Order** (each phase leaves `make check` green): execution core → `accepts`/`inputs`/`outputs` in
`registry.json` plus a generic validator, deleting the per-workflow branches → `/api/runs` and
`/api/uploads` next to the adapters, canvas migrating node type by node type → delete adapters,
`/v1/*` and this table's "today" column.

**Where** `docs/protocol.md`, `internal/server/runs.go`, `internal/task`, `internal/server/routes_*.go`.


## 54. Media rules are registry data, not handler branches

**Decision** What a workflow may accept from a request — how many images, one or none, which media
kinds, that first/last-frame mode needs two images for `both` but one otherwise — is declared per
workflow in `registry.json` (`accepts`, `frameMode`, `mode`, `promptInject`, `promptReorder`,
`sourceVideoFrames`) and resolved by one function, `workflow.PlanMedia`. The handlers no longer
mention a workflow id.

**What was wrong without it** `handleVideoCreate` carried a `switch entry.ID` with four arms
(`video-h3-t2v`, `-fast`, `-frames`, `-ref2va`), then a second `switch` for the same ids to build
the error hint, plus `requiredImageCount` reverse-engineering minima out of bindings.
`handleImageEdits` hardcoded `entry.ID == "image-qwen21"` with three count rules, and
`handleImageGenerations` matched `strings.HasPrefix(entry.ID, "image-moss-")` to decide whether to
inject layout JSON. Adding a workflow meant editing Go, which is the opposite of the reason
`registry.json` exists.

**Where the rules went**

| Was                                     | Is                                                            |
| --------------------------------------- | ------------------------------------------------------------- |
| `switch entry.ID` for media counts      | `accepts.images/videos/audios {min,max}` + `accepts.minTotal` |
| `switch entry.ID` for the error hint    | `accepts.note`, appended to every refusal                     |
| frame-mode defaults and per-mode counts | `frameMode {default, images{first,last,both}}`                |
| fixed execution mode per H3 workflow    | `mode` (`text`, `frames`, `reference`)                        |
| Qwen's per-mode image counts            | `variants.<mode>.accepts`                                     |
| Qwen's reference reordering             | `variants.edit.promptReorder: "qwen-edit"`                    |
| MOSS layout prompt injection            | `promptInject: "moss-layout"`                                 |
| probing the source video length         | `sourceVideoFrames: true`                                     |

**Three behaviour changes, all deliberate**

1. Error codes are uniform: a too-many-media refusal is `unsupported_media` (was
   `unsupported_video_media` for video, and `invalid_inpaint_media` / `invalid_outpaint_media` /
   `too_many_reference_images` for Qwen). The canvas does not map these codes; the message, which
   now names the workflow's own hint, is what it shows.
2. Multi-reference rejects more than six images instead of silently truncating to six. The canvas
   already caps at six, so only a hand-written request can reach it — and a silent truncation is
   exactly the class of bug this refactor is meant to remove.
3. A first/last-frame request with `frameMode: both` and one image now fails on the image minimum
   before any upload, with a message that says two are needed.

**Tested** `internal/workflow/media_test.go` exercises the rule engine directly and then asserts the
same answers against the _shipped_ `registry.json` — the old hardcoded behaviour, expressed as data.
`internal/server/video_media_test.go` proves the route calls the engine (a frames workflow refuses
no image, refuses audio, and counts two images for `both`) without a workflow id in the handler.
Verified against the running gateway for all six H3 workflows and all four Qwen modes; a real
image generation still passes end to end.

**Where** `internal/workflow/media.go`, `internal/workflow/entry.go`, `internal/server/routes_generation.go`,
`internal/server/routes_generation.go`, `workflows/registry.json`.


## 55. The run protocol exists on the wire

**Decision** `POST /api/runs` + `/api/uploads` are the gateway's own shape, not a translation of
someone else's: submit returns `202` with a run id, and status, progress, outputs and cancel all
hang off that id. Media is uploaded first (`POST /api/uploads`) and referenced by role. One row per
artifact, so a batch image request returns several outputs from one run. `docs/protocol.md` is the
contract; this entry records what landed and what deliberately did not.

**Why now, and not "just fix audio"** The audio endpoint needed the queue, and the queue needed one
submission path. Building that path twice — once for `/v1/audio/speech`, once for the real protocol —
would have been the only way to get audio working sooner, and the second version would then have to
be kept in step with the first. The cheaper order was: one execution core, then audio as an adapter
on it, then the protocol itself.

**What landed**

| Piece                                                                                              | Where                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Queue, persistence, progress, cancel, one `submitRun`                                              | `internal/server/runs.go`              |
| `POST/GET /api/uploads`, `POST /api/runs`, `GET /api/runs[/{id}[/outputs/{i}]]`, preview, `DELETE` | `internal/server/routes_runs.go`       |
| Upload store with retention pruning and a cached ComfyUI reference                                 | `internal/upload`                      |
| Multi-artifact runs (`outputs[]`), per-output paths, `started_at`                                  | `internal/task`                        |
| Audio as an adapter over the same path                                                             | `internal/server/routes_generation.go` |

**Two deliberate limits**

1. **No `wait`.** The audio adapter blocks because the canvas asks it to; the protocol itself never
   does. A `wait` parameter would give every client two success shapes (`200` with an artifact,
   `202` with a run) and reintroduce "the connection died, the work is lost".
2. **Media roles are the conventional names** (`source`, `mask`, `first_frame`, `last_frame`,
   `reference`, `image`, `video`, `audio`) rather than a per-workflow declaration. The role list is
   one table in `routes_runs.go`; making it data belongs with typed `inputs`, and inventing it
   before the canvas uses it would be dead weight.

**Tested** `internal/server/runs_e2e_test.go`: a two-output image run (both artifacts fetched), an
upload used as a reference image (the injected `LoadImage` node carries the ComfyUI name), and the
refusals — unknown role, wrong kind, missing upload, unknown workflow. `internal/upload` covers kind
inference, reload, size limit and retention pruning. `internal/task` covers multi-output storage and
`OutputPath` bounds. Verified live against the real ComfyUI: an audio run through `/api/runs`, a
two-image batch, and a cancel that emptied the ComfyUI queue.

**Where** `internal/server/routes_runs.go`, `internal/server/runs.go`, `internal/upload`,
`internal/task`, `docs/protocol.md`.


## 56. A run's inputs are typed and checked at submission

**Decision** `inputs` is a closed, typed surface. `GET /api/workflows/{id}/schema` publishes it, and
`POST /api/runs` validates against it before anything is queued. Unknown keys are rejected with the
accepted list; types, ranges and `required` are enforced; `quality` is an enumerated value because
the gateway owns the preset names; other `select` options stay advisory because they are ComfyUI's
vocabulary, not ours. The list is assembled from the request-level keys plus the workflow's declared
`parameters` plus its non-media binding keys, so no workflow restates it.

**What was wrong without it** `inputs` was a bag. A typo (`setps`) was silently ignored and the run
quietly used the default; a wrong value (a string where a number belonged, a size that is not a size,
`count: 0`) travelled into the graph and failed inside ComfyUI — for a queued run that meant the
caller got a failed run minutes later instead of a `400` immediately. `count` was also clamped
silently by `BuildContext`, so a request for zero images was answered with one.

**Why these boundaries**

- _Unknown keys rejected_: silently ignoring input is never what the caller meant.
- _Media binding names rejected, with `use media.<role>`_: the two input channels must not blur;
  the error names the right one.
- _Ranges enforced, sampler lists advisory_: ranges are our own declarations (and were corrected
  while doing this — seeds now allow 0, audio steps allow 1). Sampler/scheduler lists are a curated
  UI subset of ComfyUI's; enforcing them would reject valid values the canvas never offered.
- _`/v1/_` stays lenient\* until the canvas migrates: an adapter that suddenly rejects values an
  existing client sends is a behaviour change disguised as a refactor.

**A race found on the way** Running the suite with `-race` exposed a pre-existing bug: `persistNow`
marshalled the live task records after releasing the lock, racing the worker's progress updates.
It now snapshots under the lock. `make test-race` is clean over repeated runs.

**Tested** `internal/workflow/inputs_test.go`: the declared surface is accepted, ten rejection cases
carry the right code and message, media keys point at `media.<role>`, the schema marks `prompt`
required and `count` bounded, and every shipped workflow accepts a minimal request and rejects a
typo. `internal/server/runs_e2e_test.go` drives the same through HTTP, plus the schema endpoint.
Verified live against the real registry: unknown key, `count: 0`, `size: "huge"`, `steps: 999`,
`refs` as an input and `quality: "ultra"` all answer `400` with a message that says what to change,
and a valid audio run still completes.

**Where** `internal/workflow/inputs.go`, `internal/workflow/render.go`,
`internal/server/routes_runs.go`, `internal/task/task.go`, `workflows/registry.json`.


## 57. The protocol exchanges workflow runs, not graphs

**Decision** The gateway's unit of exchange is a _run of a registered workflow_: `{workflow, inputs,
media}` in, a run id out. It does not accept a ComfyUI graph from a client, and it does not hand out
node ids. The graph is server-side data (`workflows/*.json` + `bindings`). The job skeleton — submit,
id, poll, fetch, cancel — is ComfyUI's, because that is what the executor actually offers; the
abstraction above it is ours.

**Why** A graph API makes the client responsible for wiring it can only learn by reading the
workflow: which node takes the prompt, which socket takes a mask, what `"37:13"` means today. Every
client then re-implements that knowledge, and the gateway cannot validate anything until ComfyUI
fails minutes later. Naming a workflow moves that knowledge to the one place that already has it —
`registry.json` — and makes submission-time validation possible (`inputs`, `accepts`). It is also
what the canvas needs: a node stores a workflow id, not a graph.

**What follows from it**

- Media is referenced by _role_, not by filename-in-a-socket, because the binding decides the socket.
- Artifacts and run state belong to the gateway (`data/outputs`, `data/tasks.json`), not to ComfyUI's
  in-memory history, so a result outlives a ComfyUI restart.
- Progress is exposed as polling even though ComfyUI pushes it over a WebSocket: the socket stays an
  implementation detail, and a browser that reloads loses nothing.
- Raw graph submission stays refused (`ui_workflow_not_supported`, `invalid_api_workflow`). The
  exposed surface is the capability set, not the executor.

**The comparison to keep** `docs/server.md` → "Relationship to ComfyUI's HTTP API": endpoint
mapping, the eight differences, and the same request written both ways. Read it before changing the
protocol; it is the shortest description of what we are and are not.

**Where** `docs/server.md`, `docs/protocol.md`, `internal/comfy/client.go` (the endpoints we borrow),
`internal/workflow/bindings.go` (the translation), `internal/server/routes_runs.go`.


## 58. The canvas's first node lives on the run protocol

**Decision** Audio nodes submit `POST /api/runs` and keep the returned id on the node
(`metadata.audioRunId`). A reload reattaches to that run instead of re-submitting, the step ring is
driven by the run's own `progress`, and stopping a generation deletes the run (which interrupts
ComfyUI, so the GPU is actually freed). Channels that are not the local gateway keep the
`/v1/audio/speech` contract.

**Why audio first** It is the newest node in the canvas and the least entangled: no batch, no
reference images, one artifact. It is also the node that most needed what the protocol provides — a
song takes minutes, so "the browser stayed open" must not be a requirement. Doing it first proves
the protocol against a real node before the image and video paths (uploads, multiple outputs) are
touched.

**How the node decides which contract to use** Two conditions, both cheap and both already known:
the channel's base URL is the local gateway, and the model id starts with `audio-`. The gateway's
naming rule is `<type>-<slug>`, so an audio workflow is recognisable without another request; every
other channel keeps the speech call. When image and video migrate, the same rule does the work.

**What it bought, concretely**

- A closed tab or a refresh no longer loses a finished or still-running song: `hasResumableAudioRun`
  keeps the node `loading` through the restore pass, and one effect resumes the poll.
- Stop is real: aborting the wait calls `DELETE /api/runs/{id}` (`cancelOnAbort`), where the old
  blocking call only dropped the connection and left ComfyUI rendering.
- Errors are the gateway's: a refused container or a ComfyUI validation failure arrives as a run
  error with its code and message, not as a generic "audio generation failed".
- The step ring works without a preview stream, which audio never had.

**A bug it exposed** `format: "wav"` used to reach ComfyUI and fail there; the run path now validates
the declared container at submission — fixed one commit earlier, because the canvas now sends the
container the user chose rather than one the adapter guessed.

**Tested** `frontend/tests/api-runs.test.ts` (root resolution, submit body, polling to terminal, failed runs,
abort-cancels-only-when-asked, relative output URLs) and `frontend/tests/canvas-resumable-runs.test.ts`
(which nodes survive a reload). End to end against a real ComfyUI with the exact payload the canvas
sends: a run reached `succeeded` 30/30 and the downloaded mp3 played; `opus` came back as Ogg/Opus.

**Where** `frontend/src/services/api/runs.ts`, `frontend/src/services/api/audio.ts`,
`frontend/src/pages/canvas/hooks/use-generation-runs.ts`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/lib/canvas/canvas-generation-helpers.ts`.


## 59. A video run carries roles, frames and its own post-step

**Decision** Video nodes submit `POST /api/runs` like every other node, and the request is the
workflow's own contract: `mode` picks the media mix, the frames arrive as `first_frame` /
`last_frame`, multi-reference arrives as `reference` + `video` + `audio`, and `frameMode` says which
frames the request supplies. `interpolation` is a run input the gateway executes: the frame-rate pass
runs on the produced video inside the same run. The task id the node stores is a run id, and the
in-flight preview frame is part of the run payload.

**Amended by #62** The post-step is gone with the `interpolation` run input: interpolation is a workflow now
(`video-rife`), so nothing in a run executes a frame-rate pass. What a video run carries — roles, frames,
`frameMode` — is what this entry is about, and it is unchanged.

**Why the old shape had to go** `/v1/videos` was the most branch-heavy endpoint in the gateway: one
multipart form whose field names (`image[]`, `images`, `first_frame`, `video[]`, `audio[]`) had to be
resolved against the workflow, a `params` JSON string carrying `frameMode` and `interpolation`, and
task polling split across `/{id}`, `/{id}/content`, `/{id}/cancel` and `/api/previews/{promptId}`. A
video took minutes, so the interesting case — the page reloaded mid-render — was the one the shape
handled worst: the id lived on a task nobody could reattach to, and the preview came from an endpoint
keyed by a ComfyUI prompt id the client never saw.

**Why `interpolation` is an input and not a second run** The alternatives were a client-side chain
(submit, download, re-upload, submit again) or a hidden second run inside the gateway. Both leak the
same thing: two ids, two failure modes and an intermediate artifact nobody asked for. The canvas
wants "a 60fps version of this clip", which is one request and one artifact, so the post-step lives
inside the run — the same code `/v1/videos` uses, which is why the two routes cannot drift. It is also
declared: `interpolation` accepts `off|2x|3x` and nothing else, because unlike a sampler name this
set belongs to the gateway.

**Why `frameMode` is an input when the roles could imply it** A single uploaded `last_frame` cannot
be told apart from a single `first_frame` by counting: the default rule (`byCount`) would call it a
first frame and quietly wire the wrong socket. The workflow already declares which frame modes it
accepts and how many images each needs (`frameMode.images`), so the caller states the mode and the
gateway judges it — one owner for the rule, one message when it is violated.

**What the canvas sends now** `prompt`, `mode`, `seconds`, the pixel `size` the settings imply
(`resolution_name` and `ratio` are derived into it, not sent), `frameMode`, `interpolation`, and the
node's own workflow parameters (`seed`, `steps`, `cfg`, `transition_step`, …). Nothing is renamed on
the way in, so a rejected request names the offending key.

**Tested** `internal/server/video_runs_e2e_test.go`: a last-frame request wires `last_frame` and not
`first_frame`; `both` with one image is `missing_reference_image`; an unknown frame mode is
`invalid_frame_mode`; `interpolation: "4x"` is rejected with the accepted set; a `2x` run submits the
generation _and_ the RIFE graph and still stores one artifact; `frameMode` on an image workflow is
`unknown input`. `internal/workflow/inputs_test.go` covers the video-only input surface and
`InterpolationFactor`. `frontend/tests/api-video-runs.test.ts` pins the canvas side: one run per generation,
media by role (frames, references, no media for text-to-video), `interpolation` on the same request,
step and preview reporting, failure named as a video task failure, and cancel only on an explicit
user stop.

**Where** `internal/server/routes_runs.go`, `internal/server/routes_generation.go`, `internal/workflow/inputs.go`,
`frontend/src/services/api/video.ts`, `frontend/src/services/api/runs.ts`, `frontend/src/pages/canvas/project.tsx`,
`docs/protocol.md`.


## 60. An interrupted image batch reattaches to its run

**Decision** An image node keeps the id of the batch run that is producing it (`metadata.imageRunId`,
the same shape audio uses). A reload finds the node `loading` with its placeholder slots still in
place, and one poll fills them from the run instead of asking the gateway for the images a second
time.

**Why it needed more than the audio pattern** Audio has one artifact and one field to write; an image
batch has N placeholders, N uploads to canvas storage and a node that resizes to its first image. So
the fill step moved out of the live request into `fillImageSlot`, and both paths call it: the live
batch keeps its behaviour, and the resume path is the same code reading the same artifacts in the
same order. That is the property worth having — a reloaded batch must be indistinguishable from one
that never stopped, or the two paths will drift.

**What stays unwritten** A single-image retry (the "regenerate this slot" action) does not record a
run id, because the node it repairs usually already has content and would not qualify as resumable
anyway. Retrying is a deliberate, short action; the batch is the one that can quietly outlive a page.

**Tested** `frontend/tests/canvas-resumable-runs.test.ts`: a `loading` image node with `imageRunId` survives
the restore pass (and one with content, or of another type, does not). The fill-and-resume path was
exercised against the real gateway during the image migration.

**Where** `frontend/src/pages/canvas/hooks/use-generation-runs.ts`,
`frontend/src/lib/canvas/canvas-generation-helpers.ts`, `frontend/src/pages/canvas/project.tsx`, `frontend/src/types/canvas.ts`.


## 61. The last generation adapters, and why one of them is not a run

**Decision** Video upscale and the multi-angle re-render submit runs. Video upscale is the registered
workflow `video-seedvr2-upscale` with the clip in the `video` role; the angle tool is the hidden
workflow `image-qwen21-angle` with its three camera inputs and the source in the `reference` role. One
adapter is left: `/v1/videos/interpolate`.

**Why upscale was free** It was never an endpoint-shaped operation — it already had a graph, bindings
and declared parameters. The adapter was a form that renamed `batchSize` to `batch_size` and posted
the file as `video`. Deleting it removed that translation and nothing else. Two dialog values
(`scale`, `fps`) are not sent any more because the graph derives them itself (the target short edge
and the source frame rate); sending them as inputs would be a `400`, which is the validator doing its
job on a field that never reached the graph.

**Why the angle tool fits the same shape** `image-qwen21-angle` is a hidden workflow like the others:
a prompt, three angle inputs and one reference image. `wideAngle` is a UI toggle with no counterpart
in the graph, so it is not sent — inventing a binding that reaches nothing would be worse than
leaving the knob out, and the gateway rejects inputs a workflow does not declare, which is how that
stayed visible.

**Why interpolate is different** RIFE is not a workflow the registry knows: it is `_internal/video-rife.json`
applied by the engine as a post-step. "Interpolate this clip" therefore has no workflow to name, and
the honest options are (a) register RIFE as a workflow and delete the engine's interpolator, or
(b) drop the tool. Option (a) means the post-step of a generation run and the standalone tool share
one graph but not one mechanism, so the choice is deferred to the deletion phase instead of being made
in a hurry — the adapter stays until then, and `docs/protocol.md` says so.

**Tested** `frontend/tests/api-video-runs.test.ts`: an upscale request is one run whose media is the uploaded
clip and whose inputs are only the declared ones (`scale`/`fps` are absent). Against the real gateway
the request was accepted, the graph was built with the clip wired into `LoadVideo`, and ComfyUI's own
`missing_node_type` error came back on the run — the same failure the adapter produced on that
machine, since the SeedVR2 custom node is not installed there.

**Where** `frontend/src/services/api/video.ts`, `frontend/src/services/api/image.ts`,
`frontend/src/pages/canvas/hooks/use-video-editors.ts`, `docs/protocol.md`, `docs/server.md`.


## 62. Frame interpolation is a workflow, not a run input

**Decision** `video-rife` is a registered workflow: one clip in the `video` role, `multiplier` (2 or 3) as an input, its output frame rate derived by a binding (`multiply`, 24 × multiplier). The
`interpolation` run input, its post-step (`internal/server/postprocess.go`), the hand-written
interpolator (`internal/generate/interpolate.go`, 163 lines of its own upload/submit/poll/cancel),
the private `workflows/_internal/` directory and the `/v1/videos/interpolate` adapter are all gone.
Choosing "2×" is now two runs: generate, then interpolate over the result. The canvas chains them.

**This reverses part of #59** That entry kept interpolation inside the run so that "one request is one
artifact" stayed true. The reasoning was half right: the produced bytes are already in the gateway's
hand, so interpolating before storage avoids a download-and-re-upload. Everything else it bought was
worse than it looked:

- It needed **three exceptions** to the rule "a run is one workflow": a private graph directory the
  scanner must ignore, a second executor, and an input that changes what a run means.
- It made **failure lossy**. The artifact is only stored when the run ends, so a missing RIFE node or
  a cancel during interpolation threw away the clip the user had already paid GPU time for. That is a
  correctness bug, not a simplification.
- It made the **missing dependency invisible**: no scan, no resource entry, no way for the canvas to
  warn. (Same root cause as the `hidden` bug reported in the same session.)

The intermediate 24fps clip is not "an artifact nobody asked for" — it is the thing the GPU time
bought. Keeping it is worth two ids.

**What stays** A run is still **one workflow, one job**, so `status`, `progress`, `error` and
`outputs` keep describing exactly one thing. What is dropped is the _user action = one run_
equation: the canvas may chain runs to achieve one effect, and it already had that pattern (its
"interpolate" button was always download → upload → second task → child node).

**Two small engine additions it needed**

- `multiply` in `applyTransform`, with a `factor` on the binding: a derived value written into
  another node, the same shape as `fps` on `secondsToFrames`. Generic numeric coercion, not a special
  case for one workflow.
- `RIFE VFI.ckpt_name` in `ModelLoaderSpecs`. That list is the only thing that makes a model file's
  absence visible; omitting the entry would have kept `rife49.pth` invisible, which is the trap its
  own comment warns about.

**Tested** `internal/workflow/bindings_test.go` (`multiply`: 2 → 48, 3 → 72),
`internal/server/video_runs_e2e_test.go` (a `video-rife` run wires the clip into `LoadVideo`, writes
`multiplier` 3 and `frame_rate` 72 into the RIFE/VHS nodes, and stores one output), plus the shipped
registry still validating. `frontend/tests/api-video-runs.test.ts` pins the canvas side: an interpolate request
is one run with `{multiplier}` and `media.video`, and a generation run no longer carries an
`interpolation` input.

**Resolved** The catalogue caught up. `resources.json` declares the `interp` pack (optional, `video-rife`) and the
node `frame_interpolation_node`: `custom_nodes/ComfyUI-Frame-Interpolation`, upstream Fannovel16, a pinned commit
and the archive for it, `provides: ["RIFE VFI"]`. The checkpoint gets no entry of its own, and must not: the pack
downloads `rife49.pth` into its own `ckpts/` on first run, not into `models/`, which is what that entry's note says
and what a machine running this workflow reports (the node installed, `rife49.pth` the default of its `ckpt_name`).
A clean machine can both report and install this workflow now, so the folder name this paragraph was waiting for is
the one written there.

**Where** `workflows/video-rife.json`, `workflows/registry.json`, `internal/workflow/bindings.go`,
`internal/workflow/loaders.go`, `internal/server/routes_generation.go`, `internal/server/routes_runs.go`,
`frontend/src/services/api/video.ts`.


## 63. An input is a key that reaches something

**Decision** A binding key becomes an accepted input only when a caller can actually set it: either
the binding is addressed by its own name (`from: "params.<key>"`) or it has no `from` at all. A
binding that derives its value elsewhere (`size.width`, `seconds`, `quality.steps`, `params.steps`
under a different name) is no longer advertised.

**Why** Those keys were accepted and then ignored, because the binding reads its own source. That is
the same failure as a typo that does not error — the shape #56 set out to remove — except it looked
like a feature: the schema listed `width` on a text-to-video workflow, `steps` on z-image (which only
takes it through a quality preset), and `frame_rate` on RIFE (derived from the multiplier). Sending
any of them did nothing, silently.

**What it caught** The schema now shows what a workflow really takes: H3 loses `width`/`height`/
`length`/`task_type`, z-image loses `steps`/`cfg`/`width`/`height`/`batch`, audio loses
`formatQuality`/`stepsOverride` (both were the _binding_ name of a value written under another key),
RIFE keeps only `multiplier`.

**What still wins** A workflow's declared `parameters` are authoritative and are registered before
bindings, so a declared key stays accepted even when a same-named binding reads elsewhere. That
combination is a registry mistake, not a supported case; it is why `steps` (declared for audio) still
works while feeding the `stepsOverride` binding.

**Tested** `internal/workflow/inputs_test.go`: `width` (from `size.width`) and `batch` (from `count`)
are rejected as unknown inputs, while the self-named `seed` is still accepted. Every shipped
workflow's schema was re-read through the live gateway.

**Where** `internal/workflow/inputs.go`, `docs/protocol.md`.


## 64. The model list belongs to the client

**Decision** `registry.json` has no `hidden` flag any more, and neither do `/api/workflows` rows or
the availability scan. The gateway registers workflows and reports two facts about each: what it
accepts, and whether it can run here. Which of them appear in a model dropdown is decided by the
canvas (`frontend/src/lib/canvas/tool-workflows.ts`), because the canvas is the only client.

**What `hidden` was doing** Four unrelated jobs at once: keeping a workflow out of the model list,
excluding it from the availability totals and the "what is missing" list, refusing the user's own
visibility toggle, and overlapping with `category: "upscale"`. Only the first is a real need, and it
is not a fact about the workflow — it is a fact about our UI. The result was the bug this session
started from: the panel read "14/14 available" while two upscalers were missing three node classes.

**What replaced it** The canvas already knew which workflows it invokes from a button; those ids are
now one exported list, used by the buttons, the request builders and the model-list filter. An id
cannot drift between "the button submits this" and "this appears in the dropdown" because it is the
same constant.

**Also deleted with it: three dead workflows.** `video-esrgan_2x` and `image-seedvr2-upscale` had no
caller left (no button, no model, nothing in the canvas referenced them), and
`image-krea2-aesthetics` was retired — its only trace was a migration shim that remapped a saved
selection to `image-krea2-turbo`. The shim is gone too: the generic "pick the first available model"
fallback covers it. The `upscale` pack lost those two workflows and the 7B SeedVR2 DiT resource only
they used, so the panel no longer offers an 8.5GB download for a workflow nobody can invoke.

**Tested** `internal/server/setup_report_test.go`: a workflow whose node class is missing appears in
the setup status totals and in `missing.nodes` (models and tools alike), and a workflow row carries no
`hidden` field. `frontend/tests/tool-workflows.test.ts` pins the client-side list. The live gateway's
`/api/setup/status` and `/api/workflows` were re-read after the change.

**Where** `internal/workflow/entry.go`, `internal/workflow/render.go`, `internal/setup/scan.go`,
`internal/server/routes_admin.go`, `internal/resource/status.go`, `workflows/registry.json`,
`resources.json`, `frontend/src/lib/canvas/tool-workflows.ts`.


## 65. The image upscaler is a run, and a tool workflow takes exactly one item

**Decision** `POST /v1/images/upscale` is deleted. The canvas's 放大 button uploads the source image
and submits a run of `image-esrgan-upscale` (`inputs: {upscale_model, resolution}`, `media: {image:
[id]}`) like every other image action. `GET /api/upscale/workflows` is deleted too: `/api/workflows`
now carries each workflow's loader-enriched `parameters`, so a client reads the whole catalogue in one
request and decides for itself which entries are upscalers. All four tool workflows declare
`accepts` with `min: 1, max: 1` for the media kind they consume.

**Why the route had to go** It was the last image route that existed only for one button. It resolved
a workflow by id, refused anything outside `category: "upscale"`, and parsed a multipart body — three
things `POST /api/runs` already does, with an id that a reload can resume. The category check was the
only thing it added, and that is a UI concern: "is this a button or a model" is a question about the
canvas, not about the workflow.

**Why `/api/upscale/workflows` went with it** It was a Go-side filter (`category == "upscale" &&
type == "image"`) that re-rendered four fields of a workflow row plus its parameters. The parameters
were the only thing `/api/workflows` lacked, and enriching them there costs one map copy per row, so
the second endpoint became a worse copy of the first. The filter moved into the dialog, next to the
button that needs it.

**Why `accepts` matters here** Without it, an upscale with no image is accepted (202) and fails a
minute later inside ComfyUI when the required binding finds nothing — the failure mode #56 exists to
prevent. `min: 1` makes the same mistake a 400 at submission with the workflow's own note. `max: 1`
says what the graph can honour: ESRGAN upscales one image, RIFE one clip, SeedVR2 one clip, the angle
re-render one source.

**Also cleaned** `registry.json` still carried `hidden: true` on those four entries two commits after
the flag was deleted from the struct. Ignored fields that read like behaviour are worse than no
fields.

**Tested** `internal/server/runs_e2e_test.go:TestRunImageUpscaleTakesOneImage` (image reaches the
graph, `upscale_model` reaches its node, no image is a 400),
`frontend/tests/api-image-runs.test.ts` (one upload + one run, nothing on `/v1`, a failed run surfaces its
message). In the browser: the 放大 dialog listed the three ESRGAN models from `/api/workflows`,
submitted a run, and produced a 4096×4096 PNG node.

**Where** `internal/server/routes_generation.go`, `internal/server/routes_admin.go`,
`workflows/registry.json`, `frontend/src/services/api/workflows.ts`,
`frontend/src/services/api/image.ts`,
`frontend/src/components/canvas/canvas-tool-node-panel.tsx`.


## 66. Everything under `workflows/` is English _(the one path it kept was not the author's, see #117)_

**Decision** The graphs, `registry.json` and their defaults contain no Chinese. Chinese for a shipped
workflow lives in `frontend/src/i18n/locales/zh-CN.ts` under `gateway.models.<id>.label`, keyed by the id the
gateway sends (#8 already said this; the registry just had not caught up).

**What was mixed** Three unrelated kinds of Chinese in the directory:

- _Copy we author_: RIFE's `label`, its `multiplier` label and description, and the angle workflow's
  default prompt. This is the actual violation — data we ship, in one language, shown to both UIs.
  `video-rife` gained a `gateway.models` entry so the Chinese UI still says "RIFE 帧插值", and the
  angle default is now English because the canvas overrides it with `canvas.generation.anglePrompt`
  anyway: the default only reaches a caller that sends no prompt at all.
- _ComfyUI node titles_ (`_meta.title`): cosmetic labels the author typed, never read by the gateway
  and never shown by the canvas — the only titles we write are our own (`Gateway Ref 1`, `Gateway
Load 2`). Translated anyway, because a reader opening a shipped workflow should not have to guess
  what "① 单采 SelfLift（日常版参数）" means, and a half-translated file is worse than either.
- _A real path_: `image-qwen21-outpaint.json` names its LoRA `Qwen-功能2.1/Qwen21-图像扩展…safetensors`,
  and `resources.json` installs it at exactly that path. **Left alone** — that string is a
  filename on disk, not copy.

**Cost** A workflow re-imported from an author's file comes back with its Chinese titles; the same
pass has to be applied again. The registry is the part that matters, and it is machine-written.

**Also found** `resources.json` was Chinese-only: pack labels and descriptions render verbatim
in the resource panel, with no key indirection. That is #67; it could not be fixed by editing JSON
alone.

**Where** `workflows/*.json`, `workflows/registry.json`, `frontend/src/i18n/locales/zh-CN.ts`.


## 67. The resource catalogue is English; its Chinese lives beside the app _(one of the two paths was not upstream's, see #117)_

**Decision** `resources.json` carries no Chinese copy — pack `label`/`description`, resource
`label`/`note`/`license` are English. The Chinese sits in
`frontend/src/lib/resource-copy-zh.ts`, keyed by pack/resource id, and
`ResourceCenterPanel` looks it up before falling back to the index text. Vendored third-party content
under `resources/payload/**` is untouched: it is the upstream author's text, not ours.

**Why the index had to change** The panel renders those fields verbatim, so the English UI was showing
Chinese — the one place the "English data, Chinese in the dictionary" rule (#8) was still broken in a
way a reader could see. Translating it also makes the index readable to anyone auditing what gets
downloaded.

**Why a map and not the i18n dictionary** Resource ids contain dots: `qwen3.5_9b_int8_convrot`. With
`keySeparator: "."` such a key is read as a nested path and never resolves, so the natural home for
"Chinese keyed by id" (`gateway.models.<id>`, which works because model ids have no dots) does not fit.
A typed `Record<string, …>` next to it is the same idea with the id treated as an opaque string. The
`resolvedLanguage` check is copied from `server-labels.ts`, so both tables switch language the same
way.

**What is still Chinese, on purpose** Two `target` paths name files the upstream authors published in
Chinese (`loras/Qwen-功能2.1/…`, `loras/Moss_image/KOOK-MOSS-SFT-观澜.safetensors`). They are disk
paths, not copy; translating them would break the install. A test fails the build if any _other_ field
grows Chinese again.

**Tested** `frontend/tests/resource-copy-zh.test.ts`: Chinese for pack/resource/license in `zh-CN`, nothing at
all in `en-US` (so the index text stands), nothing for an unknown id, a dotted id resolving, and the
index itself containing Chinese only in `target`. In the browser: the Add-workflows panel reads in
English with the language set to English and in Chinese with it set to 中文, over the same rows,
including the LoRA whose path stays Chinese.

**Where** `resources.json`, `frontend/src/lib/resource-copy-zh.ts`,
`frontend/src/components/settings/resource-center-panel.tsx`.


## 68. There is no `/v1/models`; a workflow reports the ids it answers to

**Decision** `GET /v1/models` is deleted. `GET /api/workflows` gained a `models` array per row —
`{id, label, baseModel, baseModelLabel, imageInputs}` — built by the same expansion `ResolveModel`
accepts. The canvas syncs from it (`hooks/use-local-server-sync.ts` → `lib/server-models.ts`) and
decides what the picker offers.

**Why the endpoint had to go** It was the last route whose only job was to present, and it presented
the wrong shape: an OpenAI envelope around a _workflow_ list, with `object: "model"`, `owned_by` and a
`metadata` bag holding what the workflow really is. Everything in it was a fact about a workflow, so it
belongs on the workflow row.

**Why the ids could not just be dropped** The tempting simplification — "a model id is just the
workflow id" — is wrong for two graphs. Z-Image and Krea2 have selectable base models, each combination
has its own spelling (`img-zit-int8`, `img-k2t-int8`), and only `ModelIDFor` knows how to build it and
only `ResolveModel` knows how to read it back. A client that invented the spelling would be guessing at
a gateway rule. So the list moved, it did not disappear: `models` is the gateway reporting the names it
will answer to.

**What stayed in the client** Three decisions, none of which is a fact about a workflow: a workflow
whose `type` the canvas cannot render is not a model; a workflow the canvas drives from a button
(`frontend/src/lib/canvas/tool-workflows.ts`) is not a model; a disabled (`enabled: false`) or unavailable workflow
is not offered. `lib/gateway-capability.ts` went with the endpoint — it existed to guess a capability
from a name or a metadata field, and the workflow's own `type` is the answer.

**Cost** One more request than a list of names would need, and the client has to do the flattening. In
exchange there is one endpoint describing workflows, and the picker is testable without a browser: the
mapping is a pure function (`tests/gateway-models.test.ts`, 11 cases).

**Tested** Go: `TestWorkflowsReportTheirModelIds` (a row carries `models`, `enabled`, `availability`),
`TestWorkflowsReportOneIdPerBaseModel` (two installed base models → three ids, each naming its file),
`TestWorkflowVisibilityToggles` (a hidden workflow stays in the list as `enabled: false`; filtering is
the client's). Canvas: `tests/gateway-models.test.ts`. In the browser: `/v1/models` answers 404, the
channel holds the same 17 models as before with their `workflowId` / `baseModel` / `imageInputs`, the
base-model sub-dropdown still lists `默认底模 / z_image_bf16 / int8`, and a generation run through it
returned three images.

**Where** `internal/server/routes_admin.go`, `internal/server/e2e_test.go`,
`frontend/src/services/api/workflows.ts`,
`frontend/src/hooks/use-local-server-sync.ts`,
`frontend/src/lib/server-models.ts`, `frontend/src/services/api/image.ts`
(`fetchChannelModels`).


## 69. `/v1` is gone

**Decision** The gateway has no `/v1/...` route. `POST /api/runs` is the only way to produce media;
`GET /api/workflows` describes what can run; the prompt services and the two in-flight helpers
(`/api/previews/{id}`, `/api/progress/{id}`) are everything else.

**What was deleted** Nine routes and the code that existed to translate into them:
`POST /v1/images/generations`, `POST /v1/images/edits`, `POST /v1/videos`, `POST /v1/videos/upscale`,
`GET /v1/videos/{id}`, `GET /v1/videos/{id}/content`, `POST /v1/videos/{id}/cancel`,
`POST /v1/audio/speech`, `GET /v1/tasks/{id}`. With them went the request readers nothing else used:
`requireModel`, `parseParams`, `imageFiles`, `matchesImageField`'s multipart role, `uploadFiles`,
`orderedVideoFiles`, `orderedVideoRefs`, `orderedAudioRefs`, `toUploadResults`, `mediaNames`,
`firstMediaName`, `queuedPayload`, `imageResponse`, `runImageWorkflow`, `waitRun`, `runFailure`,
`runResultBuilder` (no caller ever passed one), and three files of adapter tests.

**What replaced each of them** Nothing: every caller was already moved. The canvas's image, video,
audio, upscale, interpolate and angle actions all submit runs, and the audio "blocking call" contract
was the last thing that needed an adapter — the run id answers it.

**The bug the deletion flushed out** All three media modules decided "is this the gateway?" by the
model's _name_: `<type>_WORKFLOW` regexes (`image-`, `video-`, `audio-`). A base-model variant is
`img-zit-int8`, which matches none of them, so selecting the int8 base model would have sent the
request to `/v1/images/generations` — a route that no longer exists. The channel is the only thing that
decides which contract a request speaks, so the three predicates are now `isLocalGatewayUrl(baseUrl)`.

**What the canvas still had, and lost** The `/v1`-shaped request builders
(`/images/generations`, `/v1/videos/{id}`, `/audio/speech`) once stayed on the theory that another
channel might speak OpenAI. #71 removed the second channel, so those builders had no caller and went
with them: the gateway's `/api/runs` is the only path any node takes.

**Cost** The gateway can no longer serve a client that speaks OpenAI. That was the goal: it never spoke
it honestly — one route was `/v1/images/upscale`, another took a `params` JSON string, and every media
rule was a branch keyed to a workflow id.

**Tested** `make check` and `make test-race`; the two audio adapter tests became
`audio_runs_e2e_test.go` (caption + lyrics as ordinary inputs, ComfyUI's own error code on failure);
`video_fixture_test.go` kept only the shared fixture and multipart helper. In the browser: a fresh
page load syncs its models, generates an image, and lists the workflows with no request to `/v1`.

**Where** `internal/server/routes_generation.go`, `internal/server/routes_generation.go` (deleted),
`internal/server/runs.go`, `internal/server/server.go`, `internal/server/helpers.go`,
`canvas/web/src/services/api/{image,video,audio}.ts`, `docs/protocol.md`, `docs/server.md`,
`README.md`.


## 71. There is one channel, and it is the gateway the page came from

**Decision** The canvas has exactly one model channel. Its address is the gateway that served the page
(`frontend/src/constant/app-mode.ts`), its model list is whatever `GET /api/workflows` reports, and the channel editor
keeps only two things: a name and a per-model capability override. "Add a channel", "choose a provider"
and the address field are gone.

**Why** A channel was a cloud provider: an address, an API key, a model list typed in by hand. This build
talks to one gateway and to nothing else, so the list could only ever hold one entry whose fields were all
either fixed or derivable — and a second entry would be a way to point the canvas at something that is not
this gateway, which is the one thing the local-only rule forbids. The capability override survives because
it is the only field with information the gateway does not have: a workflow whose `type` is not what the
user wants it to be.

**Cost** Pointing the canvas at another gateway is a `dist/config.js` / `START.sh` job
(`LOCAL_COMFYLOFT_SERVER_URL`), not a settings-screen job. A saved config from a build with channels is repaired
on read: the first channel that points at this gateway wins, the rest are dropped, and a backup of the
original blob is left in `localStorage` under `…:pre-local-only-backup`.

**Where** `frontend/src/constant/app-mode.ts`,
`frontend/src/stores/use-config-store.ts` (`merge`),
`canvas/web/src/components/settings/channel-editor-drawer.tsx`,
`frontend/src/components/layout/client-root-init.tsx`.

**Tested** `npm run check`, `npx vitest run` (the config-store merge cases), and in the browser: a cleared
config syncs the gateway's workflow list, the editor shows one channel, and its address field does not
exist.


## 72. The gateway address has no `/v1`

**Decision** `LOCAL_GATEWAY_BASE_URL` is the gateway's **root** (`http://host:8190`), and
`start.sh`/`config.js` inject it that way. A trailing `/v1` is still accepted on input and stripped
in exactly one place (`gatewayRoot`), so an older `config.js` or a stored channel keeps working.

**Why it was still there** The base URL was written when the gateway spoke OpenAI's paths, and
deleting the routes did not touch it: the value was carried around with `/v1` on the end and each
caller stripped it again before using it — `gatewayProtocolRoot`, `local-session`, `resources`,
`canvas-system-status`, two plugin-host fetches, plus the config store's own normalization. Six strips
for a suffix nothing needed.

**What replaced them** One function, `gatewayRoot(url)` in `frontend/src/constant/app-mode.ts`, applied where the
address enters the app (the injected value and a persisted channel). The call sites now use the value
directly, which is what makes "there is no `/v1`" true rather than maintained by convention.

**Kept deliberately, then removed** `buildApiUrl` appended `/v1` for the prompt-API endpoint. It was
the last caller of the canvas's chat path, which had no gateway endpoint behind it; decision 73 gave
that path a real endpoint (`POST /api/prompts/chat`) and `buildApiUrl` went with the client it served.
The model server's own `/v1/chat/completions` is now reached only by the gateway, from the base URL
the settings hold.

**Cost** A hand-written channel entry that points at a path like `https://host/openai/v1` loses the
suffix. Nothing in this build talks to such an endpoint: the gateway and the prompt API are configured
separately.

**Tested** `make check`, `npm run check`, `npx vitest run`. In the browser, with a cleared config:
17 models sync from `http://127.0.0.1:8190`, the stored channel address has no `/v1`, and a recorded
network capture shows every gateway request on `/api/...` with no `/v1` path anywhere.

**Where** `frontend/src/constant/app-mode.ts`, `start.sh`,
`canvas/web/src/services/api/{runs,resources}.ts`,
`frontend/src/components/canvas/canvas-system-status.tsx`,
`canvas/web/src/pages/canvas/hooks/use-plugin-host.tsx`,
`frontend/src/stores/use-config-store.ts`. (The `lib/local-session.ts` this list used to
name went with the session tracker, and the prompt route went when prompts became the agent's socket.)


## 75. Prompts are served by AlayaCore, and one instance belongs to one person

**Status** Implemented, and the wire moved: #82 made the conversation a socket, so the `POST /api/prompts/chat`
this entry planned does not exist. Read the rest as the shape; `internal/server/routes_agent.go` is the wire.

**Decision** One request → one `alayacore --rawio` process → one event stream → process released. Nothing
outlives a request; no panel keeps an agent alive. No dual backend and no fallback: a second path would be two
configuration stories for one feature.

**Tenancy is the security model** One instance serves one person and uses one config directory
(`AGENT_CONFIG_PATH`, default `os.UserConfigDir()/comfyloft-server/alayacore`). The config path, the skill
container and the tool list are gateway settings, never fields of a request — a request that could name its own
`--config-path` would pick whose files to read, and one that could name its own tool list would undo the single
switch that decides whether the agent may run commands. Serving a second user would need real identity, not a
shared secret: `GATEWAY_TOKEN` was injected into the page, so anyone who could open the canvas could read it,
which is why #110 removed it.

**Why this is not over-engineering here** AlayaCore is part of this project the way ComfyUI is: nothing to
install. It takes a base URL, a key, a model and four `/api/prompts/*` recipes out of the canvas, and a spawn
reaches `SM session ready` in ~30 ms — cheaper than keeping one warm.

**Cost** Process-level failures (spawn, crash, hang, stderr-only errors), a `message_version` dependency, and
more tokens per request: the agent's own system prompt, plus one step when a skill has to be read.

**Cancel and lifetime** Cancel belongs to the agent, which is the process that knows what a half-finished step
means, so the gateway adds no timeout and no reaper. The process is bound to no window, so there is no idle
agent to reap and no TTL.

**Still open** Where the H3 wording lives: an Agent Skill read with `read_file` (one extra step, and read access)
or `--system` assembled at spawn (one step, no file access) — the answer waits on a measured comparison. The
agent's settings page, when it comes, must write through `CI model_sync`, never by parsing `model.conf`: that
file's format belongs to AlayaCore.

**Where** `internal/agent/{spawn,wire,run,sessions}.go`, `internal/server/routes_agent.go`, `internal/ws`.


## 77. Regenerating an image answers in that node; a variant is a node you make

**Decision** `nodeRegenerateBehavior` is gone. Pressing generate on a node that already holds a result
replaces that result, always. Nothing is created beside it, and the old image is not quietly fed back in
as a reference. The "原图" leading reference (`canvas.references.source`, `leadingNode`) went with it,
and so did `Radio` in `frontend/src/components/kit/choice.tsx`, which had no caller left.

**Why** The setting offered two answers to one button: _overwrite_ meant "re-roll this one", _new node_
meant "keep this, and make another one conditioned on it" — it created the sibling **and** inserted the
old image into the request as a reference. So the same press meant two different things depending on a
preferences toggle, and the meaning leaked into the result: with the default, pressing generate twice
gave you two images, the second one not a re-roll but an edit of the first.

**Both real intents already have explicit routes.** A variant conditioned on an image is a new node with
that image picked in 参考内容 (`requestEdit`); a variant of a _prompt_ is a config node pressed twice,
since the config node keeps the prompt and never reuses a result node. Neither needed the toggle — the
automatic path was the manual path, performed silently on the user's behalf.

**Where a reference actually comes from** An image node's references are **connections**
(`buildNodeMentionReferences(node, nodes, connections)`); picking one in 参考内容 is that connection
being made (`project.tsx`, the picker appends `{fromNodeId, toNodeId}`). The `@` mention is a different
thing and lives elsewhere: the config node's 组装提示词 composer writes `@[node:…]` into the text, and
double-clicking a text node gives a textarea with an `@` menu. An image node's prompt box is a plain
textarea — there is no `@` there, and saying otherwise would send people looking for a menu that is not
in that panel.

**Cost, stated plainly** Pressing generate on a finished image destroys it. To keep it, 复制 the node
first, or make the new node before generating. This is the trade the decision buys: the button does one
thing, and the thing it does is visible in the node you pressed.

**Tested** `npm run check` (i18n 1049/1031, no dead keys, exports clean), `npx vitest run`. In the
browser against `:8191`: an image node with content and no references showed only the add button in
参考内容 (the "原图" chip is gone), pressing 生成 kept the node count at 26 and replaced that node's image
through `image-z-image-turbo` — a plain generation, no edit workflow, so no source image was sent — and
the preferences page no longer lists the option.

**The sediment, and where it went** A persisted blob keeps whatever it was written with, and the store's
merge spread it over the defaults — so every field deleted from `AiConfig` (`promptEndpoints`,
`reasoningEffort`, `nodeRegenerateBehavior`, and the `promptCloud*` / `channelMode` / `apiFormat` /
`videoInterpolation` names before them) stayed in state and was written out again on the next change.
`use-config-store.ts` now drops those names at the merge, from one list, with the reason attached.
Nothing reads them and the values need no migration: the setting they describe is gone.


## 78. A mask belongs to the node that shows it

**Decision** The mask annotation node carries the mask the workflow consumes: `metadata.mask` holds
the storage key of the file that goes out as `media.mask` — binary for the inpaint workflows, the
drawn-over picture for the ones that accept that. Its own picture stays the mask painted over the
source, because that is what a person needs to see. Inpaint runs take the mask from whichever connected
node carries one; `submit()` opens the mask editor only when no connected node does, so wiring a source
and a mask node by hand works exactly like a run the editor made.

**Why not the result node's saved references** `buildImageGenerationMetadata` already records the
references a run used, so an inpaint could re-run from `metadata.references`. That was the first attempt
and it is wrong in two ways. It is a string, not a thing the canvas shows: `collectImageStorageKeys`
only counts objects with a `storageKey`, so the binary mask was treated as garbage and deleted, and the
run then fell back to the connected picture — a blue-tinted photograph in the `media.mask` slot, which
inpaints nothing and reports nothing. And it makes the connections a second, silently overridden
answer, so re-wiring a different mask would be ignored.

**What the binding buys** The file is part of a node, so a storage cleanup keeps it; the request is
whatever is connected, so #77 still holds and a mask can be swapped by re-wiring; and pressing generate
on an input of a run repeats the run because that is what the graph says, not because a hidden string
was found.

**The cost** Mask nodes made before this have no binding, and their binary mask is gone — deleted by
the cleanup that caused the bug. Pressing generate with one connected now opens the editor instead of
sending a picture where a mask belongs: one honest re-mark, and that node is fixed for good.

**Tested** `image-qwen21` on `:8191`, three runs over the same source. The editor's run uploaded mask
`7b985050…` (31,835 B). Re-running on the build that resolved saved references sent the tint instead
(`81e7d561…`, 1.48 MB) — the bug, reproduced. With the mask bound to the node, re-running pressed
generate, opened no editor, kept the node count at 30, and uploaded `7b985050…` again, byte-identical.


## 79. A reference makes it one answer per press; only text-to-image draws

**Decision** An image run with references generates exactly one image, whatever 画布生图张数 says. Only
a run with nothing to condition on uses that setting. The settings chip stops showing a count it will
not use when the node has references.

**Why** A reference is the user being specific — this picture, this mask, this region. Asking for three
answers to a specific question turns the node into a batch that looks exactly like a text-to-image batch
while meaning something else, and the three are stacked in a node nobody asked to be a batch. Without a
reference there is no提问 to be specific about: that is the draw, and repeating it inside one run is
what the count is for. Dissatisfied with an edit? Press again — the node it overwrites is the one being
looked at (docs/decisions.md #77).

**What this fixes** The mask editor has always forced `count: "1"`, so the same inpaint made 1 image
through the editor and 3 through a hand-wired node. Now both are 1, and the rule is one sentence instead
of two paths.

**Tested** `image-qwen21` inpaint with two references on `:8191`: the run fetched only `outputs/0`, one
artifact, with the bound mask (`7b985050…`). The count could not be observed on the other side of the
rule in this environment — a Z-Image text-to-image run with 画布生图张数 = 3 also fetched only
`outputs/0`, so the workflows here return a single artifact per run regardless of `count`. The
no-reference path is the same expression it was before this change.


## 80. An agent's life belongs to the client that opened it

**Decision** A connected agent is one process per client-chosen name, held until the client ends it.
Nothing expires. Opening it again under the same name is idempotent: the same name returns the same
process, which is how a reloaded page finds the agent — and the conversation — it left. The conversation
route requires a name and writes into that process without ever spending it (see #82 for the transport
that carries it). The nameless one-shot route that once sat beside it is gone (#83).

**Why** A conversation is the point of this process: an agent that forgot what it had done while the
user was thinking would be worse than no agent. An idle timer cannot know the difference between "the
user gave up" and "the user is reading a video that takes six minutes", and it took the history away in
both cases. So the only thing that ends an agent is the user ending the conversation — an act, and never a
connection that merely stopped being read (#100).

**The cost, stated plainly** A tab that is closed by the browser rather than the user leaves its process
behind, and a gateway that is killed takes the map with it. Both are accepted: the first is the price of
a turn that is not killed by a reload, and the second is why the canvas has to say "已断开" rather than
pretend the agent is still there. The delete route is the one way out, and it is the client's job to
call it.

**The key is the client's, not the gateway's** The name is whatever the client files the process under;
the canvas passes its own id. The gateway does not know what a canvas is — it files processes under
strings, which is the same dumbness it keeps everywhere else. A string that changes means a new agent,
and that is the whole of the semantics.

**One turn at a time** Two streams reading one stdout would each take half the frames and split an
answer between them, so a session serialises its turns. This replaced a `Take`/`Touch`/`idleSession`
state machine — a session was previously consumed by its one question, and "does this request spend the
connection" was a branch in the route. Both are gone; a question now spends nothing because there is
nothing to spend.

**What a turn ends on** `SM task in_progress: false`, measured against a real tool round: AlayaCore runs
built-in tools itself, so `AF` (the call, in two frames — name then arguments) and `UF` (the result) both
arrive inside one task, and the task ends once. The gateway relays all three as `tool_call` and
`tool_result` events and answers none of them. That measurement is also why there is no reader goroutine
fanning out to subscribers: the agent only speaks when spoken to, so the read loop stays in the request.

**A socket going away is not a cancelled turn** A page that leaves mid-answer no longer sends `CI cancel`:
the turn is the canvas's, and the answer it was producing is worth having when the page comes back. The
frames that arrive while nobody is reading are added to the session's transcript and dropped from the wire,
so the page that reconnects is shown them. Only a process that ends before its turn does returns `ErrGone`,
and that releases the session.

**Tested** On `:8191` with a real AlayaCore: `connect` twice with one name returned one pid; two
questions on that session both answered ("收到", then "还在") from the same process; the tool round
(prompt → `AF`/`AF`/`UF` → answer) streamed as `tool_call`/`tool_result`/`delta` with one `done`.
The e2e tests state the idempotency, the second turn and the tool relay against a fake agent.


## 82. The conversation is a socket; a shortcut stays a POST

**Decision** The agent is one WebSocket per session, at `GET /api/agent/socket/{session}`, both directions
as messages: prompts, settings commands, `cancel`, `close` up; the agent's own frames down.
`POST /api/agent/connect`, `/api/agent/chat` and `DELETE /api/agent/session/{id}` are gone. So is
`GET /api/agent/once`: a second route for a shorter lifetime was a second mechanism for the same thing,
and the lifetime is the client's to decide (see #83).

**Why this and not SSE** Three shapes of SSE were proposed and each one added a concept instead of
removing one: a stream per turn needed "when does a turn end" and "which request owns the stream"; a
stream per turn with injection needed a lock; one downstream plus N upstream POSTs needed status codes
for "queued" and a separate lifetime for the downstream. The third would have worked (it is the
WebSocket topology expressed in HTTP), but the sequence itself was the argument: a transport that needs
a new shape for every requirement is the wrong transport. The agent is a bidirectional stream; so is a
socket. See #80 for the lifetime this carries.

**No dependency** `go.mod` still has no `require`. `internal/ws` is ~250 lines: the handshake accepted
instead of asked for, masked frames read, unmasked written, fragmentation reassembled, ping answered.
`internal/comfy` already spoke the same framing as a client, and the tests drive the new server with
that client — an independent implementation rather than the server's own reflection.

**One transport** The one-shot was a POST returning `text/event-stream`, which is the natural shape for
one request and one stream — but it meant two streaming mechanisms for one feature: two client readers,
two framing formats, and a question ("why are these different?") whose only answer was "one of them is a
single answer". Moving it cost one route and the SSE machinery it had needed (`startEventStream`, the
multipart body, the file-to-data-URL helpers that existed only to fill that body — images now travel as
the data URLs the canvas already holds). #83 finished the job by deleting the route itself, because a
session's lifetime is the client's to decide, not the route's to declare.

**What it cost** `curl -N` no longer watches anything; `websocat` does. Two things had to be fixed
to make the upgrade possible at all, and both were silent bugs: `statusRecorder` in `internal/httpx`
wrapped the response writer without forwarding `Hijack`, so every upgrade failed with a 400, and without
forwarding `Flush` — which meant the SSE that `/api/agent/once` still uses had _never_ actually flushed:
every event sat in the response buffer until the handler returned. The first event of a one-shot answer
now arrives at 0.03s instead of at the end.

**Origin** A handshake is a `GET` that becomes a write channel the moment it is accepted, so `Guard`
now treats an upgrade as a write and applies the cross-site check it applies to POSTs. Without that, the
one route that speaks to a canvas's agent would have been open to any page the user had loaded.

**One watcher, one reader** The pump that reads the agent's stdout belongs to the session, not to a
socket: it starts with the process and runs until the process ends. A socket attaches as the watcher and
detaches when it goes away; the pump keeps reading and dropping. This is not decoration — a read blocked
in a syscall cannot be cancelled, so a reader that lived and died with a socket would be stuck holding
half a frame when the user reloaded the page, and the next socket would corrupt the stream.

**Tested** Against a real AlayaCore on `:8191`, in a browser: the panel opened the socket
(`socket open … spawned=true`); a prompt answered "收到" and a follow-up "刚才让你回复什么" answered from
history; `@` on a node sent `【画布引用】` with that node's id and prompt, and the agent answered "茶壶";
the model select sent `model_set` and the display became `qwen3.8-flash`; `结束对话` logged
`released … reason=closed by the client`; a page reload reattached with `spawned=false` and the agent
still remembered "新开". Dragging the panel moved it and left the canvas viewport untouched; a wheel over
it did not zoom. The Go tests cover the same ground without a model: idempotent open, one watcher per
name, second turn on one socket, tool relay, `close` releasing, a dropped socket keeping the agent, a
killed process reporting itself, and the one-shot never reaching a conversation.


## 83. One session per surface, and the model is the session's

**Decision** Every agent use is a session: one process, one socket, one name chosen by the client — the
canvas panel's is `canvas`, a node panel's is `node:<id>`. A session is created by pressing connect in
that panel, announces its own model list, is told which model it is on, and answers on it. Nothing about
a session is stored in the application: `agentSession` and the `agent` blob are gone from the config
store, and there is no per-node model field either. The canvas panel's session lives until it is closed;
a node panel's is released **the moment its answer ends** — not when the panel closes — and asking again
means pressing connect again, which is what makes one panel one turn. `GET /api/agent/once` is deleted
with the last of the nameless one-question processes.

**Why** The application had been keeping a mirror of state the agent already owns — which models exist,
which one is in effect, how hard it is thinking — in a single global slot. One slot for many processes
can only be wrong: the first node to connect made every other node think it was connected, and choosing
a model for one node changed the model everywhere. Every bug in this area was the same bug: two owners
for one fact. A session's own process is the owner, and the client only ever reads back what it says.

**Why this is the simple shape, not the big one** The processes are small and there can be as many as
there are panels open. Refusing to start one per panel is what produced the shared slot in the first
place; the alternative — one agent shared by every node — is not cheaper, it is a different and wrong
product. A node holds no process between answers — the release is part of the answer, so nothing at all is
running for a node nobody is asking. The canvas's own agent is the one thing that outlives its socket,
because the user asked for that.

**What it fixes** Pressing connect on a second node now shows connect, because that node has asked
nothing of anyone yet; the model select in each panel shows _that session's_ model; and text generation
asks the session of the node whose button was pressed, not a new node's name.

**Tested** In a browser against a real AlayaCore: two config nodes in text mode, the first connected
(`socket open session=node:config-1793445940295-nk65u spawned=true`, model list shown, button became
send) while the second still read 未连接 / 连接; pressing send on the first logged
`socket in session=node:config-…`, the answer landed in a new text node, and the gateway logged
`released session=node:config-… reason=close` with the button back to 连接 and no `alayacore` process
left running. The client tests hold the
other half: a session's model does not leak into another's, and asking for words opens no second socket.


## 84. A session's tools are its own, and the workspace is how a call says so

**Decision** A session's agent is spawned with `--config-path` pointing at a directory of its own,
`<DATA_DIR>/agent/<sanitised-session>-<hash8>`, holding a copy of the operator's `model.conf` and
`runtime.conf` plus an `mcp.conf` that points its tool calls at `http://<COMFYLOFT_SERVER_HOST>:<COMFYLOFT_SERVER_PORT>/mcp/<workspace>`
(see #87 for why it is that address and not loopback).
The workspace name is derived from the session name, so `POST /mcp/{workspace}` finds the session that is
asking by scanning the sessions that exist rather than through a registry beside them. The directory is
removed with the process, and every leftover is removed at startup. The endpoint speaks `initialize`,
`tools/list` and `tools/call` (notifications are `202`) and, for now, offers one tool, `ping`. A call is
then **not answered by the gateway**: it is published down the session's socket as a `tool` event, and the
canvas — the only thing that knows what a node is — replies with `{"toolResult":…}` on the same socket,
which becomes the tool's answer to the agent. Tool names are unprefixed: AlayaCore namespaces them under
the server, so `ping` is the model's `canvas_ping` and arrives back here as `ping`.

**Why MCP at all** Anything the agent does that AlayaCore cannot do itself — make a node, wire an edge,
start a generation — has to reach the gateway, which is the process that holds the socket to the canvas.
AlayaCore's only way to learn a tool exists is `mcp.conf` in its config directory, so the gateway serves
that tool itself instead of inventing a second channel.

**Why the identity is a directory** An MCP call carries nothing but its arguments. The alternative ways
to know who is asking are both wrong: guessing the session with a turn in flight breaks the moment two
panels ask at once, and adding a session field to every tool's arguments makes the model carry something
that is not its business. A path segment written by the gateway, into a file the gateway chose, cannot be
got wrong by the client — and it is a name that says what it is.

**Why a config directory per session, rather than one shared** `model_set` is persisted by AlayaCore into
`runtime.conf`, so a shared directory would turn "the model this session runs on" into the default for
every later session — the same kind of second owner that #83 removed from the client. The copy also means
the agent writes nowhere near the operator's configuration.

**Tested** Against a real AlayaCore on `:8191`, with a WebSocket client standing in for the page: on
connect it read its own `mcp.conf` and logged `MCP servers initialized: 1 servers, 1 tools loaded`; the
agent called `canvas_ping`, the gateway published
`{"type":"tool","callId":"tool-1","name":"ping","arguments":{}}` on the session's socket, the client
answered `{"toolResult":{"callId":"tool-1","text":"pong from the page"}}`, the POST that had been holding
the agent's turn returned it, and the agent's answer was "pong from the page". Closing the conversation
removed `data/agent/probe-mcp-7ed10748` with it. The name the model sees was measured, not assumed — the
first version offered `canvas_ping` and the model was shown `canvas_canvas_ping`. `mcp_test.go` holds the
rest: the handshake and tool list, a call run by the canvas and answered with what it said, a tool the
canvas called a failure, a session nobody is watching, a name the gateway never advertised, a notification
accepted with no body, and a session's directory built for it and removed with it.


## 85. A tool runs in the page, once, for whichever agent asked

**Decision** The canvas answers the gateway's `tool` events itself: one hook mounted where the nodes are
(`useCanvasAgentTools`), subscribed to **every** session's events (`onAnyAgentEvent`) rather than to the
canvas panel's name, and replying `{"toolResult":{…}}` on the session the call arrived on. The vocabulary
starts read-only — `ping` (how much is on the canvas) and `list_nodes` (every node with the id a later tool
can act on, and every connection), the second written as one line per node.

**Why every session and not just the panel's** The canvas is one, and a node's agent asking to see it is
the same question as the panel's asking. Subscribing per name would have to be done for sessions that do
not exist yet — a node's session exists only after its connect is pressed — and would then need a rule
saying which agents have hands. One subscription for the page, answering on the name it was given, has no
such rule: whatever agent asks, the page is what runs it.

**Why read-only to begin with** Reading is the only thing that cannot be wrong in a way the user has to
undo, and it proves the whole pipe — agent decides, gateway routes, page answers, agent reads — with real
canvas state. Anything that changes the canvas comes after, through the same functions the buttons call,
so a tool can never be a second way to do something.

**Tested** In a browser against a real AlayaCore on `:8191`, on a canvas with 38 nodes and 29 connections:
opening 画布助手 connected the session, a prompt asking for `canvas_list_nodes` made the agent call it,
the gateway logged `tool answered session=canvas callId=tool-1 isError=false` in 3ms, and AlayaCore logged
`<< UF {"output":[{"type":"text","text":"38 nodes, 29 connections\n- text-1793432616807-5rz7o (text)
\"文本\" at (689, 247)\n…"}]}`; the panel's answer named both counts and the shapes it had read. A second
turn and a page reload repeated it (`callId=tool-2`). The node titles that disagree with their prompts are
the canvas's own data — a title is a snapshot taken when the node was made.


## 86. A tool makes a node exactly the way the button does

**Decision** `create_node` calls the same function the canvas's own 文本 / 图片 / 视频 buttons call, with the
same consequences: the node lands in the middle of the view (a tool that states a position gets its
top-left corner there, which is the coordinate `list_nodes` reports), it is selected, and for the types
whose button opens a panel the panel opens. A `prompt` becomes a text node's `content` and every other
node's `prompt` — the field that node's own panel edits. The answer names the new node's id and position.

**Why** The agent must look like a hand the user cannot see, not like a second, quieter way to change the
canvas: whatever appears has to appear where he is looking, selected, with the panel he would have got by
pressing the button. Anything else — building the node in a corner, skipping the selection, writing
metadata the panel would not have written — makes the canvas a different surface depending on who asked,
and the user would have to learn which one he is looking at.

**What it refuses** Groups (structure, not content) and plugin nodes (the user's own extensions): a tool
that could make anything the registry knows would be a tool that makes things nobody asked for. The
refusal names what it can make.

**Tested** In a browser against a real AlayaCore on `:8191`: "用 canvas_create_node 在画布中央新建一个文本节点，
内容是「第二只手写的字」" → `<< AF {"name":"canvas_create_node"}`, then
`{"input":{"prompt":"第二只手写的字","type":"text"}}`, `tool answered … isError=false`, and
`<< UF "created text-1793522100580-liw89 (text) at (1541, 438)"`. The node appeared in the middle of the
viewport with the text already in it, selected, with the selection toolbar over it — visible in a
screenshot taken right after — and the panel showed one step, `调用 canvas_create_node`, and the id.


## 87. The tool URL is the address the gateway actually listens on

**Decision** `mcp.conf` names the workspace at the gateway's **bind** address — `COMFYLOFT_SERVER_HOST:COMFYLOFT_SERVER_PORT`,
not `127.0.0.1:<port>` — with a wildcard bind (`0.0.0.0`, `::`) replaced by loopback, since a wildcard has
no address of its own to dial and loopback is what it reaches.

**Why** The agent runs on the same machine as the gateway, but "same machine" is not "loopback": a gateway
bound to `192.168.3.232:8190` does not answer on `127.0.0.1:8190` at all. Handed that URL, AlayaCore's MCP
client simply cannot connect — it reports `0 servers` in its own output, the agent has no tools, and the
only place the failure is visible is the agent's own log. This was found the way it should have been found
earlier: on a real setup whose gateway binds a LAN address, while every test of ours ran on `127.0.0.1`,
where the wrong URL happens to be right.

**Tested** `TestMCPURLIsAnAddressTheAgentCanDial` pins the four shapes (loopback, LAN, wildcard, IPv6) and
the generated file. A gateway bound to `192.168.3.232:8192` wrote
`url: http://192.168.3.232:8192/mcp/probe-lan-8a8315a4` and its agent logged
`MCP servers initialized: 1 servers, 3 tools loaded`; with the old `127.0.0.1` URL the same setup cannot
connect at all (`curl http://127.0.0.1:8192/` → connection refused).


## 88. A tool answers with content, and the gateway only carries it

**Decision** A tool's result is a **content array in the protocol's own shape** — `text`, `image` and `audio`
(each with `data` and `mimeType`), `resource` (`mimeType` + `blob`, which is how a film travels because the
protocol has no video block of its own), `resource_link`. The page produces the blocks, the session carries
them as raw JSON, and the gateway puts them in `tools/call` unchanged: it does not resize, transcode,
truncate, cap, or turn one kind of block into another. `read_node(nodeId)` is the tool that uses this: it
answers with the node's own words and media, not with a description of them.

**Why raw, and why nothing is inspected** The blocks are self-describing — a block says what it is, and
`mimeType` says what the bytes are — so every layer between the canvas and the model would be guessing if it
looked inside. AlayaCore already knows what to do with each kind (`internal/mcp/tool_adapter.go` maps them to
image/audio/video parts, `internal/llm/providers/openai.go` promotes a tool result's media into a follow-up
user message because an OpenAI `tool` message holds only a string, and `media_fit.go` shrinks what is too
large to send). A gateway that "helpfully" downscaled a picture, sent only a video's first frame or rewrote a
sound as prose would be deciding how much of the canvas the agent is allowed to see — and would break as soon
as a later protocol revision added a block type, which a raw carrier simply forwards.

**What it costs, and why that is the user's call** A 1024² picture is ~1.3 MB of base64 on the socket and in
the conversation; a film is more. That is what looking at the real thing costs, and it is charged to whoever
asked for it (the agent, once per read), not paid preventively by every call.

**Tested** In a browser against a real AlayaCore and a vision model, on a canvas holding two nodes whose
prompt was "a red ceramic teapot on a wooden table, soft window light": `canvas_list_nodes`, then two
`canvas_read_node` calls in one turn; each result was `[{"type":"text","text":"a red ceramic teapot…"},
{"type":"image","uri":"data:image/png;base64,…"}]` (1.27 and 1.30 M runes) and the agent answered that the
first pot has water droplets on the lid and body, the second does not, spout left and ring handle right, wood
grain with wear marks, diffuse window light from the left — details that are in the pixels and nowhere in the
canvas's text. `TestMCPCarriesTheBlocksThePageProduced` holds the carrier property: text, image and resource
blocks come out of `tools/call` byte-for-byte as the page sent them.


## 89. Generating is the button, not a second way to run

**Decision** `generate(nodeId)` calls the same `handleGenerateNode` the node's own panel calls, with the mode
that panel would use — a content node generates what it is, a config node generates the kind its composer is
set to — and the words the node already holds. It is not awaited: it answers at once that the button was
pressed, and the node shows its own progress and holds the result. A group has nothing to generate and is
refused.

**Why not awaited** A picture takes minutes and a film longer. The tool's job is to start the work, not to be
the progress bar for it: an agent holding a tool call open for five minutes blocks its own turn, and the place
the user is watching is the node.

**Why it is allowed at all** The agent may ask before pressing — that is a decision about the conversation —
but if the user says do it, doing it cannot be something only a human hand can reach. A canvas the agent can
build but not run is a canvas where every resulting step is still the user's.

**Tested** In a browser against a real AlayaCore: "用 canvas_create_node 建一个图片节点，prompt 是「a brass
compass on a marble table」，然后立刻用 canvas_generate 对它按下生成" →
`<< AF {"name":"canvas_create_node"}` → `created image-1793524968642-jq17f (image) at (1541, 438)` →
`<< AF {"name":"canvas_generate"}` with `{"nodeId":"image-1793524968642-jq17f"}` → `tool answered … isError=false`
with `pressed generate on image-1793524968642-jq17f (image)`, and the gateway straight after logged
`POST /api/runs 202` and the run in the queue (`image-z-image-turbo running`). The node count went 39 → 40 and
the new node sits on the canvas with its prompt.


## 90. The transcript follows the newest message only while the reader is at the bottom; `@` points at a node

**Decision** The agent panel keeps itself at the newest message only while the reader is at the bottom. A
wheel up stops the follow at once; being at the bottom again resumes it, and the position is re-read on every
message rather than kept as a flag that can drift from where the reader actually is. Typing `@` no longer
opens a list of node names: it puts the canvas into the same "click a node" state a reference's `+` uses, and
the node the user clicks becomes the citation, its title replacing the `@` in the draft.

**Why** An answer that streams while the user scrolls up is an answer they cannot read: the follow turns a
gesture into a tug of war. The list of names was a second, worse copy of the canvas — the nodes are already on
screen, with their pictures and their layout, and picking one is pointing at it. Both are the same rule as
everything else here: the surface shows what is there, and the user aims at the thing itself.

**Tested** In a browser, on a real answer long enough to overflow (1279px of transcript in a 290px box):
while it streamed the panel stayed at the bottom (`gap 0`); after a wheel up and a scroll to the top, two more
messages grew it to 1360px with `scrollTop` still 0 and `gap 1070` — the reader was not dragged down; after
scrolling back to the end, the next message put it at 1145 of 1435 with `gap 0` again. `@` in the composer
showed "点击一个节点来引用 · ESC 取消", clicking the teapot node put `@a brass compass on a marble table` in the
draft, and the prompt the gateway logged carried `【画布引用】- image-1793524968642-jq17f (image) …`.


## 91. Changing a prompt and running it again are the manual path, so the agent gets both

**Decision** `set_prompt(nodeId, prompt)` writes the prompt where the node's own prompt panel writes it: a node
that already holds a result keeps the words in `composerContent` (typing must not throw the result away), a
node that holds none keeps them in `prompt`. The question "does this node hold a result" is one function,
`holdsResult`, asked by both the panel and the tool. Generating afterwards is `generate` on that same node,
which replaces the result in place (#77) — nothing is created beside it. A variant remains what it is manually:
a new node fed through the reference bar, i.e. `create_node` plus a connection.

**Why** Before this the agent's only way to answer "draw this differently" was `create_node` + `generate`, so
every request produced a sibling — the shape #77 deliberately removed from the manual button because it made
one press mean two things. An agent that offers only the removed route is a second, worse product: the user's
hand and the agent's hand would do different things to the same canvas. Both intents are legitimate and both
have explicit routes; which one is meant is the user's sentence, not the tool's choice.

**Tested** In a browser against a real AlayaCore: "把 image-1793524968642-jq17f 这个节点的提示词改成「a rusty
copper kettle on a dark stone shelf, candle light」，然后在同一个节点上重新生成，不要新建节点" →
`canvas_set_prompt` → `canvas_generate` → `POST /api/runs 202` → the run succeeded in that node (3 images, the
count the canvas is set to), the node's prompt box showed the new words, its picture became the copper kettle
by candlelight, and the canvas still had **40 nodes** — the same 40 as before. The agent then called
`read_node` and reported "已直接在原节点上触发生成（没有新建节点）".


## 92. A connection is a drag, so the agent gets the same call

**Decision** `connect(fromNodeId, toNodeId)` adds one connection through the same function a drag adds it with
(`addConnection`, which `connectNodes` now also calls): the canvas's own `normalizeConnection` decides the
direction and whether the pair may be connected at all, and an existing connection is never added twice. The
tool starts from the source handle, because a tool states its two nodes in order; a drag states a gesture, so
it says which handle it came from. What a connection means is unchanged: it is how one node's content becomes
another's input — the picture connected into a config node is what makes the next generation a variant of it.

**Why** The variant route (#77) is a connection, and without it the agent could only ever make things from
nothing: it could not build the "keep this, make another one conditioned on it" gesture the canvas offers. Two
implementations of "may these connect" would eventually disagree, so the drag and the tool share one.

**Tested** In a browser against a real AlayaCore: "新建一个图片配置节点，把铜壶那张图
image-1793524968642-jq17f 连到它上面，然后在配置节点上生成一张以它为参考的变体" → `create_node` →
`created config-1793527710406-y2raf (config) at (1927, 438)`, `connect` →
`connected image-1793524968642-jq17f -> config-1793527710406-y2raf`, `generate` on the config node → the
config node's panel showed 参考图 1 张 with the kettle in it, the run went out and succeeded with one artifact,
and the canvas went from 40 nodes / 29 connections to 42 / 31 — a new image node holding the variant.


## 93. A pick is a way of typing, so it gives the caret back

**Decision** Choosing a node with `@` puts the focus back in the composer with the caret just after the label it
inserted; cancelling (escape, or the banner) leaves the `@` as typed and puts the caret back after it. The node's
own mousedown no longer moves the focus while a pick is in progress: picking is typing somewhere else, and the
caret belongs to the box that asked.

**Why** Without it the click ends the sentence: the caret stayed wherever the click left it, the next thing
typed went nowhere, and the user had to click into the box and find the end of the line again. The pick exists
to save typing, not to interrupt it.

**Tested** In a browser: typing "看看 @" then clicking the kettle node left `看看 @a rusty copper kettle on a
dark  ` in the box, `document.activeElement` a TEXTAREA, and `selectionStart` 37 — the end of what was
inserted. Escaping a pick left `看看 @ 再看 @` untouched with the caret at 9, still in the box.


## 94. The agent panel is the user's window: it opens from the corner it sits in, and it resizes

**Decision** The button that opens the agent panel is a round button in the canvas's bottom-right corner — where
the panel itself opens — not one of the small icons in the top bar. The panel can be resized by dragging either
of its corners: the bottom-right one, and the top-left one, which also moves the panel so that the opposite
corner stays where it was (a panel in its default corner is pinned by its right and bottom edges, so pulling the
top-left there needs no move at all). Both are clamped to 320×280 at the least and to the canvas (minus a 16px
margin) at the most. The
size is not persisted, for the same reason the position is not (#83's list of things that are not the canvas's):
a window's shape belongs to the window. The open button is shown only while the panel is closed, because when it
is open it covers that corner and carries its own close button.

**Why** The panel is the one surface that is not the canvas: it is a card you move, read in and put away, so it
should behave like one — and a card that can only be the size it was born at cannot hold a long answer or a
transcript you want to scan. The opening button belongs to the panel, so it lives where the panel appears; in the
top bar it was a small icon among other small icons, next to the sidebar's own collapse control, and it read as
part of the canvas's chrome rather than as "the assistant is over there".

**Tested** In a browser: the button rendered at (1653, 670) in a 1717×734 canvas — bottom-right — and clicking it
opened the panel; closing the panel showed the button again in the same corner. Dragging the new corner grip
took the panel from 380×480 to 536×446, and a drag towards the top-left clamped it at 320×360 (the minimum
width), with the size in the panel's own inline style rather than the class list.


## 95. A popup over the canvas has to say so twice: the marker, and the height

**Decision** A dropdown opened from inside the canvas carries `data-canvas-no-zoom` (so the canvas does not read
the click on an option as a click on its background), stops pointer events, **and** sets a z-index above the
canvas's own chrome — `z-[1500]` for the agent panel's two selects, whose card sits at `z-95`. That is the same
recipe `model-picker` uses (`z-[1200]`), and the marker-only version was not enough.

**Why** The first fix was the marker alone, and it was incomplete in a way only a person could see: radix renders
the popup in a portal at the document root with the component's own `z-50`, so the dropdown opened _underneath_
the panel that owns the trigger. Nothing threw, the accessibility tree listed the options, and a synthetic click
aimed at the element still changed the model — so it looked fixed. A real mouse click lands on whatever is on
top, which was the panel. A floating layer over the canvas is therefore two things, not one: told apart from the
canvas, and above it.

**Tested** In a browser, with `elementFromPoint` at the centre of an option: before, the option measured
`z-50` against a card at `z-95`; after, `z-1500` and the option is the topmost element at its own centre. Clicking
它 changed the panel to `Test / qwen3.8-27b` and the gateway logged `command="model_set"`; the level select
showed 不思考/普通思考/深度思考, and picking 不思考 logged `command="reasoning_level_set"`.


## 96. `@` needs no space in front of it

**Decision** Any `@` that lands at the caret in the composer asks for a node pick. The earlier rule — only after
whitespace, so that `foo@bar` would not trigger — is gone.

**Why** The rule was Latin typography imposed on a Chinese box: Chinese does not put a space between words, so
the natural way to cite a node is `看看@那个茶壶`, which did nothing at all, and the "fix" the rule asked of the
user was to type a space that then travelled into the prompt. The case it was protecting against — an address
being typed in an agent's message — is rare here and costs one escape: a cancelled pick leaves the `@` exactly as
typed. A gesture that refuses to start on the input it was made for is worse than one that starts too eagerly.

**Tested** In a browser: the draft `看看@` (no space before the `@`) showed "点击一个节点来引用 · ESC 取消";
clicking the kettle node replaced it with `看看@a rusty copper kettle on a dark  `, focus back in the textarea at
the end of what was inserted.


## 97. The system menu was four questions in one trench coat

**Decision** The hamburger at the top-left is gone. 我的资产 and 我的画布 became round buttons beside the
side-panel toggle, where the two "where is my stuff" questions are one click away instead of two. 导出当前画布
became a button in the bottom dock, right after 上传资产. 删除当前画布 joined the canvas menu behind the title,
next to 新建画布 and 我的画布. Everything the menu held now has a second home: 新建/重命名/切换 were already in
the title menu, 撤销/重做 were already in the dock.

**Why** One menu was answering four unrelated questions — where am I, where are my things, what is this canvas
doing, can I undo that — with the same three dividers. A menu is a place to put what has nowhere else to go;
once 导入 sat in the dock and 导出 sat only in a menu, the menu was a hiding place, not a home. Deleting it
costs nothing that is not already within one click of where it belongs, and removes a concept (a menu that
owns no subject) rather than adding one.

**Tested** In a browser (1717×734): the top-left renders 收起面板 / 我的资产 / 我的画布 as three buttons in one
row; the dock lists … 上传资产 / 导出当前画布 …, and `导出当前画布` was present in the accessibility tree next to
`上传资产`. The title menu reads 无限画布 1 (42 个节点) / 重命名 / 新建画布 / 我的画布 / **删除当前画布** (red).
A grep for `打开画布菜单` in the accessibility tree returns nothing: no hamburger is left.


## 98. The side panel is a board over the canvas, not a column beside it

**Decision** `CanvasSidePanel` is no longer a flex sibling that the canvas is laid out next to. It lives
inside the canvas `<section>` as `absolute left-0 top-16 bottom-0`, slides out with `translateX(-width)` and
`opacity: 0`, and turns `pointer-events` off while it is away. It is shut by default (`canvas-side-panel-open`
must say `1`), and the same top-left button opens and closes it. With the reflow gone, the store lost
`panelMounted`/`panelClosing` and the component lost the two-frame "render at 0, then flip" hack that existed
only because a CSS transition cannot run on first paint. Chrome that used to be pushed aside by the column now
steps over the board: `useSidePanelInset(gap)` — 20 for the zoom dock, 24 for the minimap, 300 for the bottom
dock.

**Why** The panel was reflowing the canvas: opening it moved every node on screen, so a person looking for a
node in the list lost the view they were looking at. A list of what is on the canvas is a way of _looking_, and
looking should not move the thing you are looking at. The floating board keeps the function and drops the
consequence.

**Amended by #195** It no longer slides out sideways: it opens and closes by height, growing down from the
column's top edge. Everything else here stands — it is still a board over the canvas, still shut by default,
still the same top-left button.

The bottom dock's `left: 300` was **not** room for the side panel, which is what this change first assumed: it
is the width the zoom dock and minimap occupy in the bottom-left corner. Changing it to 16 made the dock
overlap the zoom dock as soon as the board was wide, which the browser showed immediately. It is
`useSidePanelInset(300)` now: still 300 from the canvas's left edge when the board is shut, 300 further right
when it is open — the same pixels as before, without the canvas ever moving.

**Tested** In a browser (1717×734, 42 nodes). The board sits at (0, 64), 280×670, bottom flush with the canvas.
Its first node's screen rect read `left=-53` with the board open, after closing it, after a resize to 360, and
after a reload — the canvas did not move once. Closing it put the aside at `left=-361` with
`pointer-events: none`; the zoom dock moved 380 → 20, and the bottom dock 660 → 300, both without touching the
canvas. `elementFromPoint(120, 300)` returned a button inside the aside, and `(900, 600)` returned the canvas,
so the board takes the pointer it covers. A clean storage (all three keys removed, reload) opened with the board
shut and width 280 and wrote nothing until it was toggled; after opening it, a reload kept it open.


## 99. The memory readout is ComfyUI's, or it is nothing

**Decision** `/api/system/stats` no longer samples the gateway's own host. It asks ComfyUI's
`/system_stats` what its machine has — `ram_total`/`ram_free` and, per device, `vram_total`/`vram_free` —
and reports that as `gpu` and `ram`, with `available: true`. When ComfyUI cannot be asked, or answers
without a device, `available` is false and the panel renders nothing at all. `internal/sysinfo` lost its
`nvidia-smi` shell-out and its `/proc/meminfo` reader and is now only the shape plus the translation.
`/api/system/free-memory` measures the freed memory from ComfyUI's own figures for the same reason.

**Why** The gateway and ComfyUI are usually _not_ the same machine — here the gateway runs on a 14 GB box
with no NVIDIA GPU at all, while ComfyUI is a 5080 with 16 GB of VRAM and 94 GB of RAM on another host.
The panel was printing the gateway host's numbers under the heading "VRAM" and "memory", so it read
`显存 --` and `内存 6/14G` while the machine doing the work had 15.6 GB of VRAM. A number about the wrong
machine is worse than a blank: it invites you to wait for memory that is not the memory that ran out.
ComfyUI already knows the answer about itself, so the fix needs no new protocol and no IP comparison
between gateway and ComfyUI — the question is simply asked in the right place.

The `utilization` and `temperature` fields are gone: ComfyUI does not report them, and they were the only
numbers the local sampler had that ComfyUI lacks. The panel shows a device's name and its memory, which
is what it can be told.

**Tested** Against the real pair (`gateway :8191` → `comfy 192.168.3.233:8188`), the endpoint returned
`available: true`, `gpu[0] = cuda:0 NVIDIA GeForce RTX 5080, 821 / 15933 MB`, `ram = 22.1 / 93.6 GB` —
figures that cannot have come from the gateway host (14 GB, no GPU). In a browser, the bar read
`显存 0.5/15.6G · 内存 20.0/93.6G`, and its dialog listed the 5080 by name with no load or temperature
line. Pointed at a gateway whose ComfyUI is unreachable (`:8192` → `:8198`), the same bar showed only the
account buttons: no readout, no zeros. `POST /api/system/free-memory` there returned
`503 comfy_unreachable`. Go: `TestSystemStatsReportComfysMachine`,
`TestSystemStatsAreAbsentWhenComfyReportsNoDevices`, `TestSystemStatsAreAbsentWhenComfyIsGone`, and the
`sysinfo.FromComfy` unit tests (units, `nil` for no device, index fallback).


## 100. The conversation is a file, and the agent belongs to the canvas

**Decision** Every agent session is spawned with `alayacore --session <file>`, one file per session name,
inside the canvas that owns it: `<CANVAS_ROOT>/<id>/session.alaya`. The file is what outlives the process —
it is the record a new process replays before it says `session ready`.

The **process belongs to the canvas**, and a socket is only a reader of it. It is started by the first
connection and released by an act: `{"close":true}`, `DELETE /api/agent/session/{id}`, deleting the canvas,
or the process dying. A socket that goes away — a reload, a panel closed and reopened, a second tab, a
dropped connection — releases nothing and cancels nothing, so a turn in flight keeps running with nobody
reading it, and its words are in the conversation when a page comes back.

A connection is shown the conversation from the session's own **transcript**
(`internal/agent/history.go`): the frames the agent has sent, folded the way the session file is folded —
`UX`/`UF` as they arrived, `AF` joined from the two frames a call is said in, `Ax` tokens merged into the
`AX` the message would have carried. It is seeded with the startup replay of a new process and appended to
as the agent speaks, so "what has been said" has one answer whether the process was just started or has been
running for an hour. The panel draws `history` by **replacing** its messages, not appending, and it is told
whether a turn is in flight (`turn`) because a replayed conversation and a turn that has not spoken yet look
identical: every message in both is finished.

The canvas panel's session name is `canvas:<canvasId>` — it was the bare `"canvas"` for every canvas, one
conversation shared by all of them.

**Why the file** The panel kept its transcript in `useState`, so a reload showed an empty panel while the
agent, in a process that had survived the reload, still remembered everything: a blank screen answering from
invisible context. That was the worst of both worlds — worse than either side forgetting. AlayaCore already
keeps a conversation when told where to put it and replays it on start; what was missing was a file to write
to.

**Why the process is not the socket's** This entry used to say the opposite — "the process lives exactly as
long as its socket" — because a *new* process replaying the file was the only way a connection could be shown
a conversation at all. That made a socket the owner of an agent, and the price was paid by the user: closing
the panel or reloading the page killed a running turn mid-sentence and said nothing about it. Measured, on
`V100 Home / Generic model` (a 24 s first token at 101 k tokens of context): a turn was waiting on the
model, the panel was closed and reopened 63 s later, and the answer never came — the sentence that announced
a tool call stayed the last thing on screen, and the panel then showed a wait nothing could end, because the
turn it was waiting for had died with the socket (the number restarted at the reopen, 190 s of it).
The transcript is what removes the trade: a live process can be asked what it has said, so a new connection
no longer needs a new process. The old rule survives where it is right — a *node panel* is released with its
panel (#83), because a node nobody is asking has no conversation to keep.

**Why the frames and not the events** `UX` and `UF` carry pictures and films as data URLs, and a block the
gateway does not understand is still content the conversation holds. Keeping the wire form means nothing is
dropped on the way in, and a later decoder that learns to draw a video block finds it already recorded
(#88 is the same rule on the tool path). The translation to events stays in `replayed()`, shared with the
startup replay, so a conversation drawn after a reload cannot drift from the one that was watched happen.
The server's own `tool` events are not frames and are never kept: replaying one would run a tool twice.

**Tested** Go, against a fake agent that speaks the same wire: `TestASocketGoingAwayKeepsTheAgent` (a prompt,
the socket closed, one spawn — and the next connection is given `user,tool_call,tool_result,delta`, the call
joined from its two frames); `TestAReloadInTheMiddleOfATurnKeepsIt` (a two-second turn, the socket closed at
300 ms, the new connection told `running: true`, and the answer arriving on it); `TestTranscriptFolds…`,
`TestTranscriptKeepsWhatWasSaidWhenTheTurnIsCut` and `TestTranscriptKeepsAToolResultWhole` (the folding, and
a media result kept byte for byte); `TestSessionKeepsTheConversationWithNobodyWatching`;
`TestSocketCloseReleasesTheAgent` and `TestDeletingACanvasTakesItsConversationWithIt` (the two acts that still
end one). In a browser, the sequence above is the reproduction: the same canvas, the panel closed and
reopened, the agent still there with its 50 MB conversation — and before this, the turn it was running gone.
`make check`, `make test-race`, `npm run check`, `npx vitest run` green.



## 101. A replayed citation shows the words, not the block

**Decision** The block the canvas puts in front of a cited prompt — `【画布引用】` and one line per node —
now has a home of its own, `frontend/src/lib/canvas/agent-references.ts`, and that module can take it off again
(`withoutReferences`). The panel uses the first half when sending and the second half when it draws a
user message replayed from the agent's session file.

**Why** What is sent and what was typed are different strings, and until now only the sent one could
survive a reload. So a message that read `@补全背景 描述一下这张图片的背景。` came back as:

```
[Canvas references]
- lPiENyy6iXVTwtTVDzd7M (image) 补全背景: 补全背景

@补全背景 描述一下这张图片的背景。
```

The block is plumbing for the agent — `@补全背景` means nothing to it without the node's id — and it is
not something anybody typed. The stripper recognises the marker in **either language**, because a
conversation written in Chinese can be read back by an English UI, and it only cuts where the block
actually ends (marker, then a blank line): a prompt that merely starts with those characters keeps every
word.

**Tested** Unit tests pair the two directions against each other: what `referenceBlock` builds,
`withoutReferences` removes, in both languages and across a language switch; a marker without its blank
line is left alone; a prompt without a block is returned unchanged. In a browser: the session file was
edited to carry exactly the block from the report, the page was reloaded, and the panel drew
`@补全背景 描述一下这张图片的背景。`.


## 102. `editCanvasRatio` was UI state wearing a workflow input's clothes

**Decision** The image settings popover no longer writes `editCanvasRatio`. Which ratio pill is lit is read
back from `editCanvasSize` — the workflow's own input — through the same table that wrote it
(`canvasRatioOf`). A format 2 → 3 migration deletes the key from nodes that already carry it.

**Why** Every edit run from a node whose params held that key failed with

```
unknown input "editCanvasRatio"; workflow image-qwen21 accepts: background, cfg, count, …
editCanvasSize, layout, …
```

The key was never a workflow input: it was "which pill did I click" parked next to the real inputs and
shipped with them. The gateway is right to refuse it — an input it does not know is either a typo or a
version skew, and guessing which would be worse than saying so. The fix belongs on the side that invented
the key.

Deriving it beats keeping it somewhere else: the pill _is_ the size, so a second field can only drift from
the first. Old canvases are repaired on load rather than left to fail, which is what the migration is for.

**Tested** `tests/persist-migration.test.ts`: a version-2 blob whose node params hold
`{editCanvasRatio, editCanvasSize, resolution, seed}` reads back as
`{editCanvasSize, resolution, seed}`, and a node with nothing stored is untouched.


## 103. Deleting a canvas forgets its conversation

**Decision** `DELETE /api/agent/session/{session}` releases the process if one is running, removes the
session file and the session's workspace, and answers `{ok, removed}`. The canvas calls it for each canvas
it deletes — from the canvas menu and from the multi-select dialog — with the name it already owns
(`canvas:<canvasId>`), fire and forget. The server does it too, on `DELETE /api/canvases/{id}`, because a
conversation file lives inside the directory that route removes and a process still running would put it
back: the client's call is the fast path, and the server's is the one that cannot be forgotten (#100).

**Why** A conversation now outlives the page, which is the point, but a canvas does not outlive the canvas.
Without this, every deleted canvas left a file in `DATA_DIR/agent/sessions/` that nothing would ever read
again — the user's words, kept forever, for a canvas that no longer exists. Only the canvas knows when a
conversation is over: the gateway sees names, not canvases.

Closing the panel is deliberately _not_ this. A closed panel is a conversation waiting to be reopened; a
deleted canvas is a conversation with nobody left to have it.

**Tested** `TestDeletingASessionForgetsTheConversation`: prompt, wait for the turn, confirm the file exists,
`DELETE`, confirm it is gone and that the next connection replays nothing. In a browser: a scratch canvas
was opened with its panel (workspace created), given a session file, then deleted through the canvas menu
and its confirmation — the gateway logged
`DELETE /api/agent/session/canvas%3APrivX2hRZQHWmyUJmmsP6 200`, and both the file and the workspace were
gone while the other canvas's conversation was untouched.


## 104. The transcript is the agent's, and only a conversation keeps a file

**Decision** Two things that were the same mistake:

1. The panel no longer writes a message when the user presses send. A user message is drawn from the agent's
   own echo (`UX`, which it sends live as well as on replay), and the assistant's message starts at the
   first delta instead of being created empty beforehand. The panel holds no message the agent did not
   report.
2. A session file is created only when the client asks for one: `GET /api/agent/socket/{name}?history=1`.
   The canvas panel asks; a node's panel does not, so a one-shot question leaves nothing on disk.

**Why** (1) The submit handler drew the typed text itself, and the replay drew the agent's copy — two copies
of the same message, which is why they could disagree (the typed `@补全背景 …` versus the stored
`[Canvas references] …` block). Stripping the block on replay patched the symptom and left both copies in
place. One owner removes the class: what is on screen is what the agent says was said, live and replayed,
and the citation block is stripped in one place because there is only one place.

(2) A node's agent is asked one question at a time — reverse-prompt, text generation — and writes the
answer into the node. Giving it a session file left one file per node in the data directory with nothing to
ever read or delete it, and it would carry an earlier question into the next answer. Whether a name is a
conversation is a property of the surface, and the surface is the client, so the client says so in the
socket URL. The gateway keeps filing processes under opaque names.

_(The second half is superseded by #280: the node panels are gone, and the name decides.)_


**Tested** Gateway: `TestSocketRelaysTheUsersWordsOnce` (a prompt produces exactly one `user` event, with the
words as sent) and `TestOneShotSessionKeepsNoFile` (a socket without the flag prompts and answers, and
`sessionFile("node:n1")` does not exist). In a browser against a real AlayaCore: after a reload the replayed
conversation still drew, and a new turn showed the typed sentence once — with the answer appearing under it
as it streamed — while nothing was added by the submit handler.


## 105. Sending is never blocked, and the queue is visible

**Decision** The panel no longer refuses to send while a turn is in flight, and it shows how many messages are
waiting in the agent's queue above the input: `2 条消息已排队,会在当前步骤之后一起插入`. The gateway relays
AlayaCore's `SM steering` frames as `{type:"steering", phase:"queued"|"delivered"}`; the panel adds one per
`queued` and **zeroes** on `delivered`. The "End conversation" button in the header is gone, and with it
`canvas.agent.end`.

**Why** AlayaCore has its own queue. A message sent into a running task is inserted between the agent's steps
— that is in the gateway's own reading loop, which explicitly may not assume one prompt equals one answer —
so a send button that goes dead for the length of a three-hundred-word answer is the panel inventing a
limitation the agent does not have.

But queueing invisibly is its own problem: the message is accepted and then nothing happens for a while, which
looks exactly like a message that was lost. AlayaCore already announces both ends of the queue
(`phase: queued` when it takes the message, `phase: delivered` when it works it in), so the panel says so,
where the message was sent from.

The number is counted from the `queued` frames, and the frame that clears it is the one that arrives once.
AlayaCore inserts a whole batch at the same time and says `delivered` **once** for it — measured with three
messages sent into one running task: `queued`, `queued`, `queued`, `delivered`. Decrementing on delivery (the
first version) therefore left a queue on screen that no longer existed, which is the one thing worse than not
showing it at all: the message looks stuck. The panel zeroes instead.

The End conversation button promised something that stopped being true when conversations moved into session
files: it closed the socket and released the process, and the next open replayed the conversation anyway. A
button that claims to end a conversation and does not is worse than no button — closing the panel is the only
"leave" the panel has, and deleting the canvas is the only end.

**Tested** Gateway: `TestSocketRelaysTheSteeringQueue` (the two phases arrive in order). In a browser against a
real AlayaCore: a 300-word request was sent, the send button stayed enabled while it streamed, a second
message was accepted mid-answer — the line above the input read `1 条消息已排队,会在当前步骤之后插入` and then
disappeared when delivered — and both messages and both answers ended up in the transcript in order. The
gateway log shows the pair:
`<< SM {"type":"steering","data":{"phase":"queued"…` then `…"phase":"delivered"}`. The header now lists only
`关闭` and `发送`.


## 106. A mention in a message is a link to its node

**Decision** `@title` inside a message in the agent panel is drawn in the accent colour and clicked like a row
in the side panel: the canvas moves to that node and selects it. Which node a mention means comes from the
message itself — `referenceEntries` reads the ids back out of the citation block the canvas wrote — and, for a
message that cited nothing (an answer that names a node), from the canvas's current titles.

**Why** The visible text of a cited message says `@补全背景`; only the block says which node that is, and the
block is stripped before display. Reading it first and keeping the pairs on the message is what makes the
mention a reference rather than a word that looks like one. The action is `focusNode`, the same one the side
panel's rows call, so "jump to that node" means one thing in the canvas.

A title containing the block's own separator (`: `) loses its tail when read back — the id is never lost, so
the link still points at the right node; only the token that gets coloured is shorter. That is the cost of
keeping a format that reads well for the agent, and it was not worth a second markup.

**Tested** `frontend/tests/agent-references.test.ts` round-trips the block: what `referenceBlock` writes,
`referenceEntries` reads, including the colon case. In a browser: cited an audio node with the panel's `@`
picker, sent the message, and the mention drew in the accent colour inside otherwise plain text; pressing
"reset view" moved the canvas to `translate(858.5px, 367px)`, and clicking the mention put it back at
`translate(-827.5px, -173px)` — the same transform a side-panel click produces — with the node selected.

---


## 107. A route nobody calls is not an API

**Decision** Twelve routes are gone: `GET /api/tasks`, `GET /api/tasks/{id}`, `GET /api/setup/status`,
`POST /api/setup/model-alias`, `POST /api/resources/packs/{id}/main-model`, `POST /api/requests/{id}/cancel`,
`GET /api/session/status`, `GET /api/previews/{promptId}`, `GET /api/progress/{requestId}`,
`GET /api/workflows/{id}`, `DELETE /api/workflows/{id}` and `GET /api/uploads`.

**Why** Every one of them was reachable and none of them had a caller: the canvas, the plugins, `start.sh`
and the tests never asked for them, so they were a surface maintained for a client that does not exist —
the exact thing [`protocol.md`](protocol.md) argues against ("every compatibility branch we do not need is
code we would maintain forever"). They are also where the tree kept its dead weight: `task.PublicTask`,
`upload.List`, `registry.Remove` + `writeRegistry`'s sibling, `resource.SetMainModel`,
`generate.Hub.GetByRequest`, `Server.requests` with `withCancel`/`cancelRequest`, and the session
`activeTasks` count were used by these handlers and by nothing else. `POST /api/requests/{id}/cancel` was
not merely unused: nothing ever registered a cancel function, so it could only answer `cancelled: false`.

What each one duplicated, and what answers the same question now:

| Removed | The client already does this |
| --- | --- |
| `GET /api/tasks[/{id}]` | `GET /api/runs` — one projection of a run, on the route the canvas uses |
| `GET /api/previews/{promptId}`, `GET /api/progress/{requestId}` | the run's own `preview` and `progress` fields |
| `GET /api/setup/status` | `GET /api/resources/status`, which embeds the scan's result |
| `POST /api/setup/model-alias` | `POST /api/resources/replacement` (the same alias write, from the panel) |
| `POST /api/resources/packs/{id}/main-model` | nothing — the panel stopped offering the picker (decisions #37) |
| `GET`/`DELETE /api/workflows/{id}` | `GET /api/workflows` and `POST /api/workflows/{id}/visibility` |
| `GET /api/uploads` | upload ids travel in the run that references them |
| `GET /api/session/status` | nothing — the tracker behind it had no other reader, so it went too |

**Cost** The main-model override store (`internal/store/preferences.go`) still loads and is still read by
the registry and the resource status, but after this its write path has no production caller — the panel
cannot set an override, so "already using a chosen model" can only come from a file edited by hand. Either
the feature comes back with a picker or the store goes; that is a product decision, not this one (the same
one #37 left open). The session tracker this route reported went with it.

**Tested** `make check` and `make test-race`. Each deleted path answers `404 not_found` from the mux's
catch-all rather than a handler's error, while `/health`, `/api/workflows`, `/api/workflows/{id}/schema`,
`/api/runs`, `/api/resources/status`, `/api/loras` and the `/api/agent/socket/...` upgrade answered as
before (the upgrade relaying a real agent's `models` and `history` frames). In a browser against that
build, the canvas loaded its 42 nodes and the complete request log was `/api/workflows`,
`/api/resources/status`, `/api/skin-unlocks`, `/api/system/stats` and `/api/session/{open,heartbeat}` —
every one `200`, and not a single `404`: the client really did not call any of the twelve. (Those three
session posts were the last of it; the same page now makes no request to them at all.)
`TestSetupReportsToolWorkflowProblems` kept its scan assertions and lost the HTTP half that pointed at the
deleted route; `TestTaskNotFoundShape` went with the route it tested.

---


## 108. The conversation is the socket, so the one-shot run has no caller

**Decision** `agent.Run`, `readTurn`, `withAgent` and `finish` are gone, with the three tests that drove
them. Reading an agent now has exactly one shape: a session (`Sessions.Connect`) whose pump feeds the
socket's watcher.

**Why** `Run` spawned a process, wrote one request, read until the turn ended and released — the shape of
`POST /api/agent/chat`, which was deleted when prompts became the socket's (#82). After that the only
caller was `run_test.go`: golangci's `unused` stayed quiet because the test counted as a caller, and the
suite looked green on a route that no longer exists. `turnStep` is what both paths actually shared, and it
stayed — `Session.pump` is now its only caller, which is the honest count.

**Cost** The tests could not simply be deleted with the code: `turnStep` and `writeRequest` are live (the
pump and `Session.Send`), and they were only ever exercised through `Run`. They were ported instead:
`internal/agent/session_test.go` opens a real session against the same fake agent and asserts the same
three things through it — the answer arrives as deltas with `done` as a bare marker, the agent's `api_key`
and `base_url` never reach an event, and a command's `CO` (ok or rejected) is relayed without a `UE` being
flushed. One test is new: a detached watcher makes the pump drop events rather than fail.

**How verified** `make check` and `make test-race`. The ported tests run the live path
(`Connect` → `Watch` → `Send` → events), so a regression in the translation fails the suite exactly where
it would fail in a browser.

---


## 110. There is no token, because the client that would send it cannot keep one

**Decision** `GATEWAY_TOKEN`, the `X-Gateway-Token` branch in `Guard`, and the variable's row in
`gateway.md`/`README.md` are gone. The startup warning stays, and says what it knows: a bind that is not
loopback means anyone who can reach the port can run workflows, read their artifacts and drive a canvas's
agent.

**Why** The token protected `/api/*` and nothing else, which is not where the risk is: `/mcp/{workspace}`
was never inside that prefix, and that is the route that makes the canvas *do* things. It was also
unsendable by the only client — the canvas speaks `Authorization: Bearer local` and has nowhere to read
`X-Gateway-Token` from — so setting the variable turned every request into a 401 and the UI into a wall of
"missing a valid gateway token". A protection that breaks the product when enabled and omits the dangerous
route when it works is worse than an honest absence, especially with #19 and #75 leaning on it.

What actually protects the gateway is unchanged and is one rule: a **browser** may write only from an
allowed origin, which is what stops a random page from driving the gateway through the user's session.
Nothing protects it from a non-browser client that can reach the port, and `gateway.md` now says so in a
section of its own — including what such a client gets (`POST /api/runs`, the artifacts under
`data/outputs`, and `/api/agent/socket/{name}`, which spawns AlayaCore with `read_file` enabled). The one
dangerous write with its own lock is `POST /api/resources/install` (`INSTALL_INTO_COMFY`), fail-closed.

**Cost** An operator who wants to expose the port to an untrusted network has no built-in answer. The
documented one is an SSH tunnel or a reverse proxy that terminates authentication; a token in the page
would not have been that answer either. `GATEWAY_TOKEN` in an existing `.env` is now ignored.

**Tested** `make check`, `make test-race`; the two `httpx` tests that existed for the token went with it
(one of them still asserted `/v1/*`, a surface deleted in #69). Against the rebuilt binary on `:8192`,
`/api/workflows` answers `200` with and without the header even with `GATEWAY_TOKEN` set in its
environment, while a cross-site `POST /api/resources/refresh` still gets `403` from the origin guard.


## 111. A session's name becomes a file name, so the readable part is capped

**Decision** `agentWorkspaceKey` cuts its readable prefix at 40 bytes and appends an 8-hex and a `-`:
49 bytes at most, whatever the client typed.

**Why** The key is both a directory under `DATA_DIR/agent/workspaces/` and the path segment of the MCP URL,
so it has to survive a file name and a URL. The cap was already written — `if safe.Len() >= 40 { break }`
— but the `break` sat inside the `switch` that chose between "copy the rune" and "write a dash", so it
left the switch and the loop kept appending: a long name produced a key as long as the name. Staticcheck's
SA4011 named it; the fix is to test the length before writing.

**Cost** A canvas id longer than 40 characters is recognisable only by its first 40 and its hash, which is
what the hash is for. Nothing reads the prefix back.

**Tested** `internal/server/agent_workspace_test.go`: a 500-character name yields a key of at most 49 bytes
with an 8-hex suffix, deterministically; two names that agree for their first 499 characters still differ;
and a name carrying `/`, `:`, `*`, `?` and CJK becomes dashes without starting with a dot.

---


## 112. A spawn is not worth the whole gateway's lock

**Decision** `Sessions.Connect` looks the name up, spawns **outside** the mutex, and files the result under
the lock with a second check. Losing that race releases the process it started and answers with the
session that exists. The session's own startup state gained an `RWMutex` (`snapshot`), because a second
connection now reads it while the pump writes it.

**Why** `Connect` held the sessions lock across the spawn **and** across `readStartup`, which waits for the
agent's `session ready` — i.e. until the model list is loaded, which on a real AlayaCore is seconds. The
same mutex is what `List()` takes, and `List()` is on every MCP tool call's path (`sessionForWorkspace`),
so one canvas opening its panel froze tool calls for every other panel and blocked every other connect.
The old comment claimed the cost was "a handful of milliseconds"; the `TestListDoesNotWaitForASpawn` test
that now guards it holds a fake agent at `ready` for a second, and `List` must still return inside 200 ms.

**Cost** Two connects for one name can each spawn a process; one is released immediately. That is a wasted
spawn on a race that needs two sockets to open in the same milliseconds, against a global stall on a
routine one — and the observable contract ("one session per name") is unchanged, which
`TestConcurrentConnectsFileOneSession` states.

**The race this exposed** The startup broadcast was documented as needing no lock ("only the pump changes
it"), but `Connect` read it for a *second* caller while that pump was writing. `-race` never saw it because
no test connected twice; `TestConnectWhileATurnStreamsReadsTheState` does, and the guard is now a lock
rather than a comment.

---


## 113. A vendored pack is checked against its own imports

**Decision** `internal/resource/payload_imports_test.go` walks every pack under
`resources/payload/custom_nodes`, resolves every relative import (`from ..pkg.mod import …`) against the
files that are actually shipped, and fails `make check` when one names something absent. Host modules
(`ComfyUI`, `folder_paths`, `comfy`, `nodes`, …) are excluded, and a bare `from . import name` is skipped —
there is no module path in it to resolve.

**Why** The SeedVR2 pack was vendored without `src/data/`, so `src/core/generation_utils.py` raised
`ModuleNotFoundError` before registering a node, and `video-seedvr2-upscale` could never load. The
symptom appears far from the cause — ComfyUI says `IMPORT FAILED` in its own log, the gateway reports a
missing node class, the panel shows a workflow that cannot run — and the first written diagnosis blamed
the *installed* copy, which reinstalling from this repository cannot fix. Nothing in the suite looked at
the payload's internal consistency, so the tree could ship a pack that Python could not import.

**Cost** A pack that imports a module another custom node provides at runtime would be reported. None does
today (601 imports resolved when this was written), and the exclusion list is where such a case would go —
one line, with the reason.

**The mistake this made, and the second check** Restoring the files needed a syntax check, and the only
one available without torch is `python3 -m py_compile` — which left four `__pycache__/*.pyc` files behind,
and those were committed with the sources they came from. `TestVendoredPacksContainNoBytecode` now fails on
any `__pycache__` or `.pyc` under `resources/payload`, and `.gitignore` covers both. A vendored pack is
source; bytecode is machine-specific and stale the moment the source moves.

**Tested** With `src/data/` present the check passes and reports 601 imports; moving the directory aside
makes it fail with exactly the two imports `generation_utils.py` needs. Planting a `__pycache__` directory
makes the bytecode check fail by name. The restored files are the upstream
2.5.24 tree (`area_resize`, `divisible_crop`, `na_resize`, `side_resize`), byte-identical to it, and
`python3 -m py_compile` accepts them — importing them for real needs torch, so the compile check is as far
as this repository can go without ComfyUI's interpreter.

---


## 115. The three gates that could not see, and what they see now

**Decision** The frontend's checks grew three teeth:

1. **`tsc` covers `tests/`** (`tsconfig.json`'s `include`), with `noUnusedLocals` and `noUnusedParameters`
   on for `src` as well. Dead locals are now a compile error, and a test that drifts from the types it
   exercises fails `npm run check`.
2. **`check-exports.cjs` counts a test as a reader of nothing.** A reference from `tests/` no longer makes
   an export "used": exports used only by tests are a failure, and the three that legitimately are
   (`modelsOf`, `ApiError`, `readApiErrorMessage`) are listed in `TEST_ONLY` with a reason each. This is
   the same blind spot that kept `agent.Run` alive in Go (#108) — a test importing a function is evidence
   that the function is *tested*, not that anything calls it.
3. **`check-i18n.cjs` no longer lets one template exempt a namespace.** It reads the literal candidates out
   of a template's expressions (`${mode === "image" ? "editImage" : mode}` yields `image`, `editImage`,
   `text`, `editText`) and marks only those; a segment that comes from data has to be declared in
   `DYNAMIC_PREFIXES`, either with the values it can take or with a reason why they cannot be enumerated.
   An undeclared dynamic prefix fails the check, which is what keeps the next blind spot from opening
   silently.

**Why** Each of the three was expensive in the same way: the suite was green while the tree carried code
and copy that nothing reached. Thirteen i18n keys lived under `canvas.promptPanel` because one template
argument marked the whole namespace as used; thirty-one unused locals (mostly `video.ts`'s cloud-era
shapes) were invisible because nothing asked; and the dead-export rule was satisfied by tests.

**Cost** `DYNAMIC_PREFIXES` is a list a human maintains — twelve entries today, each with the reason it
cannot be resolved. When one is added, the reason is the review. Tests are now type-checked, so a fixture
that uses a field a type no longer has fails the build instead of passing silently (ten such drifts were
found the moment the include changed).

**Tested in both directions** Adding an orphan key under `canvas.promptPanel` fails the check (1 dead key);
adding a template with an undeclared prefix fails it ("没有声明的动态 key 拼接: canvas.someNewNamespace");
turning `include` on surfaced ten real type errors in the test files, all fixed. `npm run check` and
`npx vitest run` (133 cases) are green, and the payload-import gate from #113 covers the fourth blind spot
(vendored packs).

---


## 116. Startup repairs what a kill left behind, and every knob is documented

**Decision** Three gaps found by walking the tree against its own documents:

1. `COMFY_FRONTEND_DIR` is gone. It was read, trimmed, made absolute — and never used by anything.
2. `PUBLIC_BASE_URL` is now actually read from the environment. `gateway.md` had documented it since the
   port, but only `WithPublicBaseURL` (a test option) could set it, so the documented knob did nothing.
3. Every variable the code reads is in `gateway.md`'s table: `COMFY_RETRY_ATTEMPTS`,
   `COMFY_RETRY_DELAY_MS`, `CLEANUP_INTERVAL_MS`, `MAX_IMAGE_COUNT` and `MAX_WORKFLOW_BYTES` were read by
   the gateway and documented nowhere — findable only by reading `config.go`.

**Startup hygiene, in the same pass** Two kinds of file accumulated in `DATA_DIR` with nothing to remove
them:

- **Directories from the layout before #100** (`DATA_DIR/agent/canvas-7aa15835/`): one config copy per
  session, named by the session alone. `clearAgentWorkspaces` only cleared the current `workspaces/`
  subtree, so these sat there forever. It now removes every directory under `agent/` except `workspaces`
  and `sessions` — conversations are still never touched.
- **`util.WriteFileAtomic` leftovers** (`tasks.json.1793441001953777902.tmp`): a kill between the write
  and the rename leaves one behind, and this tree had five. `util.SweepTempFiles(dir)` removes files
  matching `<name>.<nanoseconds>.tmp` directly in `DATA_DIR` and `OUTPUT_DIR` at startup — only files, only
  that shape, so a broad `*.tmp` delete never happens in a directory of user data.

**Why startup, not a janitor** Both facts are only true when nothing is running: no session exists yet, and
no atomic write is in flight. Doing it in `server.New` costs two `ReadDir`s and cannot race.

**Cost** A `.tmp` file an operator deliberately put in `DATA_DIR` with that exact name would be removed. It
would also be indistinguishable from the leftovers, which is why the pattern is that narrow.

**Tested** `internal/util/util_test.go` (the sweep takes the two leftovers, leaves `tasks.json`,
`notes.tmp`, `output.png`, a `.bak` and a *directory* that matches the pattern);
`internal/server/agent_workspace_test.go` (the legacy directory and `workspaces/` go, `sessions/` and
`tasks.json` stay). End to end on `:8191`: a planted `setup-status.json.<nanos>.tmp` and
`agent/canvas-legacy01/` were gone after the restart, `data/agent/` held only `sessions/`, and `/health`
answered.


## 117. One of the two Chinese paths was not the author's after all _(the other path is gone too)_

**Decision** `image-qwen21-outpaint.json` loads its LoRA as `qwen-image-2.1-outpaint-v2.safetensors`, and
`resources.json` installs it at `loras/qwen-image-2.1-outpaint-v2.safetensors`. The
`loras/Qwen-功能2.1/Qwen21-图像扩展…` path is gone, directory and all.

**Why #66 and #67 were wrong about it** Both kept that path on the stated grounds that it is "a filename
on disk, not copy" and "a file the upstream authors published in Chinese". The first half is true — the
graph resolves `lora_name` literally, and whatever it says has to exist. The second half is false, and the
index said so itself: all three sources it lists (ausboss on ModelScope and AIFastHub, bozoyan on
ModelScope) publish `qwen-image-2.1-outpaint-v2.safetensors`, ASCII. The Chinese folder and the `Qwen21-图像
扩展` prefix were the local filing habit of the machine the graph was drawn on, and the installer faithfully
reproduced the rename. `KOOK-MOSS-SFT-观澜.safetensors` is the one that really is upstream's name — its
ModelScope dataset URL is percent-encoded 观澜 — and it stays.

**What the old path was costing** A `/` separator frozen into the graph, while `folder_paths.recursive_search`
builds names with `os.path.relpath`. On Windows that same directory lists as `Qwen-功能2.1\Qwen21-…`, so the
string the graph carries would not resolve there. Nothing else read the path: the index, the graph and one
parser fixture were its only mentions.

**Why now and not later** No user has installed this yet, and the file on disk was already byte-identical
under both names (sha256 `3611a5cc…`, the hash the index declares). Later this would be a rename on every
machine or a 152 MiB re-download.

**Tested** `make check` (gofmt, `go vet`, `go test . ./internal/...`) passes. The LoRA still reaches the
workflow's dropdown: `internal/generate/lora.go` compiles the filter with `(?i)`, so
`Qwen21|qwen_image_2.1|Qwen-Image-2.1` matches the new name through its last alternative.
`frontend/tests/resource-copy-zh.test.ts` passes and now has one Chinese `target` to police instead of two — it
caught the first draft of the new index `note`, which had quoted the old folder name.

**Where** `workflows/image-qwen21-outpaint.json`, `resources.json`, #66, #67.


## 118. The H3 pack stops being the one we cannot check

**Decision** Every resource in the `h3` pack now carries a `sha256`, and
`h3_lightx2v_8step_lora` installs as `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` — the
name its two sources publish, without the `768p` a local hand had inserted.

**Why the pack had none** Thirteen entries — the H3 text encoder, both VAEs, two LoRAs, and the whole VDN
stage — were declared with a `size` and no hash. The files were already on the reference machine before
the catalogue described them, so the entry recorded what was observed, not what would be downloaded:
`downloadFile` skips verification when `expectedSha` is empty, and a note was the only thing asserting
that the renamed LoRA was the same artifact. That is the one shape a catalogue must not have — an install
that reports success without ever comparing bytes.

**How the hashes were obtained without downloading 40 GB** Both hosts publish the digest of the stored
object, so a `HEAD` is enough:

- **Hugging Face (and `hf-mirror`)** — `x-linked-etag` on the `resolve/main/...` response *is* the
  sha256 of the LFS object, and `x-linked-size` its length.
- **ModelScope** — `GET /api/v1/models/<repo>/repo/files?Revision=master&Recursive=true` returns
  `Sha256` and `Size` per file, LFS or not.

All thirteen were then checked against the files already on disk: **13/13 match**, including the two
`adapters/*/adapter_spec.json` files the index had been writing as `adapter_config.json`, which is now
proof rather than a claim in a note. A full sweep of the catalogue — every resource that declares a hash
and is installed — reports 43 files, 180.9 GiB, zero mismatches.

**Why the rename went with it** The old `target` carried a `768p` its own `sources` do not, so the
installer renamed on every download and the note had to explain why. `x-linked-size: 1956193000` matching
the local file's size, and the hash matching byte for byte, is what the rename was asserting; with the
target equal to the published name the assertion is no longer needed. `video-h3-ref2va-drama.json` and
the Chinese note in `resource-copy-zh.ts` carried the old spelling and were updated with it.

**Cost** The hashes pin the catalog to the current revision of `Comfy-Org/MiniMax-H3`, `OpenVDN/vdn-minimax-h3`
and `akatz-ai/MiniMax-H3-Character-Swap-LoRA`. If any of them replaces a file in place, the install fails
its checksum instead of silently installing something else — the intended failure, but it means the index
has to be updated when upstream moves. And a hash can only be added this way for a host that publishes
one; a source that offers neither header still needs the bytes downloaded once.

**Where** `resources.json`, `workflows/video-h3-ref2va-drama-vdn.json`,
`frontend/src/lib/resource-copy-zh.ts`.


## 121. Every vendored pack says which commit it is, and which files we changed

**Decision** Each of the eleven node entries carries `upstream` (the repository) and — for the ten that are
vendored — `pinnedCommit`. Three of them also carry `localPatches`, a list of files that are not what
upstream published. `Resource` gained the three fields so the facts survive the index→cache rewrite and
reach `/api/resources/status` instead of sitting in the JSON unread.

**Why it was missing** The catalogue described where to download a pack from, but the packs are not
downloaded: they are copied from `resources/payload`. So the index described the wrong thing about half of
its own node entries, and "which version are we frozen on" had no answer anywhere — the repositories publish
no tags (`lquesada` and `kijai` return empty tag lists), and nothing recorded a commit.

**How the pins were found, without downloading the packs again** A blobless clone per repository
(`--filter=blob:none --no-checkout`) keeps trees and commits and skips file contents. `git ls-tree -r
<commit>` then yields the complete blob manifest of a commit, which is comparable to `git hash-object` over
the vendored directory — no blob fetched, no API quota spent. Candidate commits were limited to those
before 2026-10-30, the date the packs were committed here, because a copy cannot come from the future.

| pack | pinned | upstream commit date |
|---|---|---|
| `comfyui-kjnodes` | `d7641533d663` | 2026-10-10 |
| `ComfyUI-VideoHelperSuite` | `4d907bee61e9` | 2026-09-01 |
| `ComfyUI-Inpaint-CropAndStitch` | `e2727a26c0a0` | 2026-10-18 |
| `ComfyUI-qwenmultiangle` | `bf8d032a36f1` | 2026-09-12 |
| `ComfyUI-VDN-H3` | `7271c648d7c2` | 2026-09-07 |
| `ComfyUI-YCNodes-MiniMax-H3` | `efbe83f69ffa` | 2026-09-15 |
| `comfyui-SelfLift` | `835c3cf79194` | 2026-09-19 |
| `ComfyUI-SolAttn_triton` | `dfc2e31a41af` | 2026-08-22 |
| `minimax-h3-audio-t8` | `5bb623978d0e` | 2026-08-26 |
| `ComfyUI-SeedVR2_VideoUpscaler` | `4490bd1f482e` | 2025-12-24 |

**What the comparison turned up** Two things that were not known before this pass:

1. **Three files differ only by line endings.** `ComfyUI-Inpaint-CropAndStitch/__init__.py` and two files in
   `ComfyUI-YCNodes-MiniMax-H3` are CRLF upstream and LF here, because `.gitattributes` says `* text=auto`
   and normalises on commit. The content is upstream's; only the blob differs.
2. **Four files are ours, not upstream's, and no commit ever published them.** `ComfyUI-SolAttn_triton`
   changes two node defaults (`sink_conditioning` → `exact_kv`, `dense_blocks` → `0-5`) and resolves
   `_forward` on the class at call time "so sampling-scoped patches such as TE-Speed's MiniMaxH3 runtime
   forward remain in the chain"; `ComfyUI-SeedVR2_VideoUpscaler` swaps `allow_tf32` for the newer
   `fp32_precision` API; `minimax-h3-audio-t8` passes three extra arguments to `final_layer`
   (`sigma_v`, `sample_sigmas`, the two shifts). #113 recorded that the SeedVR2 files *restored* were
   byte-identical to upstream, which is still true — but the tree as a whole was never pristine, and
   nothing said so.

**Why it changes the download question** "Replace the vendored packs with downloads" was being argued from
principle, because nobody could measure the difference. It is now measurable: switching to upstream would
drop those four fixes. That does not make vendoring right — it makes the trade-off explicit, which is what
`localPatches` is for.

**Cost** A pin is only useful while upstream keeps the commit. If a repository is deleted or force-pushed
past it, the SHA stops resolving. `frame_interpolation_node` had no pin when this was written — it is
downloaded rather than vendored, so there was no frozen copy to read a commit off — and has since been
pinned to `26545cc2dd95`, the commit `main` pointed at. All nine node URLs name a commit; see #126.

**Tested** `make check`, `tsc --noEmit` and the canvas suite (133 tests) pass; `gofmt` clean after the struct
change.

**Where** `resources.json`, `internal/resource/resource.go`.


## 126. The node packs are no longer bundled

**Decision** `resources/payload` is gone. All nine node resources install by downloading the
`archive/<pinnedCommit>.zip` their entry names, the catalogue's `size` now describes that download rather
than a directory in this repository, and the "the pre-extracted folder is copied with the pack" wording is
gone from the index and from the Chinese table.

**Why** Two reasons, and one of them was us:

1. **The vendored copies were not what upstream ships.** They were hand-trimmed — `ComfyUI-Inpaint-CropAndStitch`
   kept 7 of 50 files, `minimax-h3-audio-t8` kept 416 of 1,570 — so "the tree we tested" and "the tree a
   user gets" were never the same tree, for no reason anybody asked for. Once the packs are downloaded that
   difference disappears on its own.
2. **The imports gate existed to catch our own vendoring mistakes.** `TestVendoredPacksImportOnlyWhatTheyShip`
   was written because the SeedVR2 pack lost `src/data/` on the way into git (#113). Downloading upstream's
   own tree removes that failure mode, so a second gate that verifies downloaded trees would be protecting
   against a risk we just deleted — upstream's archive is the tree its author runs.

**The bug this exposed, which had to be fixed first** `extractZip` keeps the wrapper directory every GitHub
archive contains, while install state is read from `custom_nodes/<target name>`. Only
`ComfyUI-Frame-Interpolation` had ever taken the download path, and it landed as
`ComfyUI-Frame-Interpolation-main` — so the panel could never see it as installed and every click on
Install would download it again, silently. Shipping nine packs down that path would have made the bug the
normal case.

`extractNodeArchive` now unpacks to a staging directory and copies the wrapper's *contents* onto the target
name, and the download path skips when the target already exists (the bundled path always did). The new
`TestExtractNodeArchiveDropsTheWrapperDirectory` pins both halves: the files arrive, the wrapper does not.

**Cost** Installing a node pack now needs the network and depends on GitHub being reachable — models already
did, and node packs have no mirror. What lands is upstream's full tree: Inpaint brings its 20 test images,
audio-t8 its 1,570 files. That is 43 MB across nine packs, against 11 MB of hand-trimmed copies, and the
extra weight is the price of not shipping a tree we edited by accident.

**The first attempt broke a size, and the audit caught it** Rewriting nine `size` fields line by line
walked past `frame_interpolation_node`, which had no `size` field at all, and wrote its archive size onto
the next entry — `esrgan_x2plus`, whose 67 MB download became 16.8 MB. The check that found it compares
every declared `size` against the file on disk for installed resources, and every changed `size` against
the previous revision; both are now part of how this file gets edited. `esrgan_x2plus` is back to
67,061,725 and `frame_interpolation_node` finally has the size it never had.

**Tested** `make check`, `tsc --noEmit`, 132 canvas tests, and the integrity pass (13 registry entries, 49
resources, no dangling references, every workflow's graph present). The install path itself is best proven
by the panel: the packs were deleted from the reference machine's `custom_nodes` so the next Install click
exercises the new code.

**Where** `internal/resource/jobs.go`, `internal/resource/install_extract_test.go` (new),
`resources.json`, `frontend/src/lib/resource-copy-zh.ts`, `resources/payload/` (deleted).


## 129. The file is `resources.json`, not `catalogue.json`

**Decision** Renamed. The index had just been moved out of `resources/` and given the name `catalogue.json`;
the name was wrong and this corrects it before anything could depend on it.

**Why "catalogue" was a bad name** It came from prose — #67 calls the thing *the resource catalogue* — and a
word that reads well in a sentence does not automatically read well as a filename. "Catalogue" suggests a
browsable collection of products; this file is a list of things that must exist on a machine before a
workflow can run, with the URL, the hash and the destination for each. It also reads as the British
spelling of a word software rarely uses at all.

**Why `resources.json`** It is the word the rest of the project already uses for exactly this: the panel is
the resource centre, the route is `/api/resources`, the Go type is `Resource`, and the payload field on a
workflow row is called `resources`. Beside `workflows/` at the root it also states the split in one line —
`workflows/` is what can run, `resources.json` is what has to be there for it to run.

**Cost** One commit, twenty-one replacements, and three places that are not strings: the index path,
`config.hasMarker` (which identifies the asset root), and the canvas test that reads the file to enforce
"English everywhere except `target`". No install or layout behaviour changed.

**Tested** `gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 132 canvas tests. A tree-wide grep for
`catalogue` now returns only the entries above, which are prose.

**Where** `resources.json` (moved), `internal/resource/`, `internal/config/`, `frontend/`,
`README.md`, `docs/server.md`, `docs/known-issues.md`.


## 130. A pack's dependencies are derived from its graphs, not written down three times

**Decision** `resources.json` no longer says which files a pack needs. A pack is an id, a label, a description, a
list of workflow ids and a list of *alternates*; everything else is read off the workflows' graphs. `schema` is 2,
and `resources`, `optionalResources` and `workflowDependencies` are gone.

**Why the hand-written lists had to go** They were three descriptions of one fact, and all three had drifted:

- **Six packs declared every resource optional** — `resources == optionalResources`, so `required =
  resources − optionalResources` was empty: the panel showed "已齐全" for MOSS, H3, Z-Image and upscale *with
  every weight deleted*, and because `total` was 0 the row had no checkbox, so the pack could not be installed
  from the panel at all. A pack that says it is complete and cannot be installed is worse than one that says
  nothing.
- **Eight of the nine node packs had no entry point.** Only `frame_interpolation_node` appeared in any pack;
  `qwenmultiangle`, `inpaint_cropandstitch`, `kjnodes` and all five H3 packs were installable only by hand while
  their workflows were offered in the canvas — true in the initial import too (`925ce37`), so never a regression,
  just a hole nobody's list closed.
- **The tables missed real dependencies**: no pack listed `kjnodes` for the H3 workflows that run
  `ModelPreviewOverrideKJ`, `video-h3-*` omitted all five packs its graphs need, and the Outpaint LoRA was listed
  for `image-qwen21` (whose default graph is *edit*) only because someone remembered the variant.

**What "derived" means** A graph names files through loader inputs and nodes through `class_type`. The catalogue
knows which resource owns a target (`loras/Moss_image/…` matched as a whole target, not a file name, because two
LoRAs can share a name in different folders) and which classes a pack provides. Two shapes needed care:
`ApplyVDNH3Advanced.vdn_checkpoint` names a *directory* (`stage-dmd-step-250`) and is matched as a prefix, and a
loader class can be owned by a node pack (`SelfLiftH3Sampler`, `ApplyVDNH3Advanced`, `LoraLoaderBypassModelOnly`),
so the class lookup runs for loader nodes too. Variants are unioned: outpaint's LoRA is a dependency of the
workflow even though the default mode never loads it.

**What the pack row now says** Required is the intersection over the pack's workflows — a file every one of them
loads; optional is everything else the pack can install, including alternates no graph names (the second precision
of a base model, the other two RealESRGAN checkpoints). H3 therefore requires 20 items, five of them node packs;
MOSS requires three and offers four. A pack with no workflows — `core` — requires nothing, which is what makes it
informational.

**A data correction that fell out of the audit** `provides` is not "every class this pack registers", it is "every
class our graphs need from this pack": `h3_audio_t8_node` claimed classes no graph of ours uses, and a pack that
claims more than it provides hides a missing pack behind a satisfied check.

**Where** `internal/resource/resource.go` (`Index`), `resources.json`, `internal/resource/catalogue_test.go`.

## 131. `core` stops being a pack

**Decision** The `core` pack is gone from `resources.json`. The panel now lists seven packs, all of them
things that download.

**Why** It was a row whose only content was the sentence "此包没有需要下载的资源" — a bundle declared to
contain nothing, in a drawer whose job is to list what to download. Since #130 a pack's contents are read
off its workflows, so `core` could never have said anything else: it has no workflows and no resources, and
no future edit would make it informative. The fact it was trying to state — the binary, the canvas bundle
and the base graphs ship with the installer — belongs in the README, where it now says it in one line.

**What went with it** The `noResources` branch in `packState` (unreachable once no pack can be empty), the
`noResources` string in both locales, the `core` row of the Chinese copy table, and the pack-fixture id in
the index validation test. Nothing consults `core` by id — the "is everything ready" summary counts packs,
and it now counts seven.

**Tested** `gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 132 canvas tests. The panel's
remaining states are `planned`, `ready` and `missing N`; a pack offering only alternates and no workflows
still renders as a green row with an install checkbox.

**Where** `resources.json`, `internal/resource/status.go`,
`canvas/web/src/{components/settings/resource-center-panel.tsx,
i18n/locales/{en-US,zh-CN}.ts,lib/resource-copy-zh.ts}`, `frontend/tests/resource-copy-zh.test.ts`,
`README.md`.


## 132. A node pack that is on disk but not loaded is not "missing"

**Decision** A node item now carries `needsRestart` when its directory exists but ComfyUI does not report the
classes it declares. The panel shows it as `待重启` instead of `缺`, explains why in one line, and offers no
download for it. `needsRestart` counts are also on the pack row and the per-workflow rows, and those items are
excluded from `missingSize` and from every install list.

**Why** ComfyUI imports `custom_nodes/` once, at startup. Install a pack while it is running and the directory is
correct, the classes are absent, and the panel said `缺 6` — so the user downloaded again and read
`directory already exists, skipping`. Both statements were true and together they were useless: the panel could
not tell "not installed" apart from "installed, not loaded yet", which are one restart and zero downloads apart.

**What it looks like** The directory check runs after the class check fails, so a healthy pack still reports
`matchedBy: classes`; only the broken-looking case consults the filesystem. The hint names the missing classes,
because the same symptom has a second cause — a python dependency that failed to import — and after a restart
that list is the difference between "restart again" and "install the dependency".

**Limits** The gateway cannot restart ComfyUI: this build of `--enable-manager` has no reboot route (`POST
/manager/reboot` → 405, `GET` → 404), so the panel tells the user to restart and refresh rather than pretending
to do it. A half-extracted pack would also read as `待重启`; restarting is the honest first answer to that too.

**Tested** Against the live ComfyUI on this machine, with seven packs installed while it was running: `interp`
→ `missing 2, needsRestart 2, missingSize 0`, `h3` → `missing 6, needsRestart 6`, and every other pack `missing 0`.
`gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 132 canvas tests.

**Where** `internal/resource/{resource.go,status.go}`,
`canvas/web/src/{services/api/resources.ts,components/settings/resource-center-panel.tsx,
i18n/locales/{en-US,zh-CN}.ts}`.


## 133. The tick means "and also download this", so it says so

**Decision** The optional section is called `可选版本` / "Optional versions", its checkbox carries a tooltip that
states what ticking it does, a pack's own checkbox is disabled when the pack has nothing left to download, and
"install selected" no longer re-sends packs that are only waiting for a ComfyUI restart.

**Why** The section holds exactly the `alternates` of #130 — resources no workflow names — because everything a
workflow does need is already listed inside that workflow's row. So a tick and a dot side by side in one pack
looked like two strengths of the same statement, when they are two different sentences: the dot means "this
workflow loads it, so installing the workflow gets it", the tick means "nothing needs it, tick it if you want
it". The user asked what the difference was; a control whose meaning is not on screen is a control that will be
misread.

**Also fixed while there** A pack whose remaining gaps were all `needsRestart` still had an enabled checkbox,
and ticking it built an install list that the server then rejected as empty. That checkbox is now disabled by
the same rule that hides the pack's install button, and its tooltip explains that the files are already on disk.

**Tested** `tsc --noEmit`, 132 canvas tests, and the pack rows against the live status payload: five packs
disabled (nothing left to download), `h3` and `interp` disabled for the restart reason, everything else as before.

**Where** `canvas/web/src/{components/settings/resource-center-panel.tsx,i18n/locales/{en-US,zh-CN}.ts}`.


## 134. A blocked mode does not hide the workflow

**Decision** Availability is decided by the graph a workflow *opens with*. A variant's own gaps are collected
into `availability.modeProblems` instead of `problems`, shown against that mode, and never take the workflow off
the model list. The canvas marks such a mode as `（缺节点）` and refuses to switch to it.

**Why** `image-qwen21` has four modes sharing one entry: edit, t2i, inpaint, outpaint. Inpaint wants
Inpaint-CropAndStitch; the pack was not installed, so the scan — which unioned every variant's problems and
called the entry unavailable — dropped Qwen Image from the image-model picker entirely, while edit and
text-to-image were runnable. The same shape hid nothing else, which is why it survived: only one workflow in the
registry has variants.

The panel showed the same pack as green at the same time, because its required/optional split (see #130) counts
inpaint's node pack as optional. Two screens disagreeing about one pack is the bug; the fix is to make the
workflow's own graph the unit of availability, and to let a mode carry its own verdict.

**What is unchanged** A single-graph workflow with a missing node is still unavailable (`image-qwen21-angle` needs
`QwenMultiangleCameraNode` and stays out of the picker), and the missing node is still counted in the scan's
`missing.nodes` — the totals do not quietly lose it.

**Tested** `TestScanKeepsAWorkflowWhoseVariantModeIsBlocked` builds a registry entry whose `inpaint` variant loads
an unknown node and asserts the entry stays available, that `modeProblems["inpaint"]` is reported, and that the
node still appears in `missing.nodes`. Against the live gateway: `image-qwen21` → `available: true,
modeProblems: {inpaint: 2}`, every other workflow unchanged. `gofmt`, `go vet`, `go test ./internal/...`,
`tsc --noEmit`, 132 canvas tests.

**Where** `internal/setup/{scan.go,setup.go,scan_test.go}`, `internal/resource/{resource.go,status.go}`,
`canvas/web/src/{services/api/{resources,workflows}.ts,lib/server-models.ts,stores/use-config-store.ts,
components/image-settings-panel.tsx,components/canvas/canvas-image-settings-popover.tsx,
components/settings/resource-center-panel.tsx,i18n/locales/{en-US,zh-CN}.ts}`.


## 135. "Install this pack" installs the pack

**Decision** A pack's *required* set is now everything at least one of its workflows loads — including a
bake's inputs, which are described in `resources.json` rather than in a graph. `optional` is only what no graph
names at all: a second precision, another upscale checkpoint. The pack's install button sends the required set
plus whatever alternates were ticked, and "#130's intersection rule" is retired.

**Why** The intersection said "required = what every workflow shares", which made the per-mode dependencies
optional — Qwen's inpaint node pack, its multi-angle node pack, its outpaint LoRA, MOSS's per-workflow base
models. Two consequences, both reported by the user before the second one was understood:

- the pack header read "已就绪" while inpaint could not run, because `missing` counted only the intersection;
- "安装此包" shipped required-plus-ticked-alternates and therefore never installed those files. Nothing in the
  UI could add them: they have no checkbox (they are not alternates) and their only other route is the
  per-workflow "安装此工作流" button on the row that needs them. The user installed the Qwen pack, saw it turn
  green, and found inpaint blocked — correctly angry that a pack the panel had described as missing was not
  installed by the button that says it installs it.

**What a pack reads as now** `qwen21` 7 required / 0 optional, `h3` 21 / 0, `moss` 7 / 0, `music` 3 required
and 4 alternates (other precisions and text encoders, 44 GiB — the reason alternates are not installed by
default), `upscale` 1 / 2, `zimage` 3 / 1.

**Also** The bake case needed one more rule: `packResourceSplit` and the installer now close the derived set
over each resource's `requires`, because a bake artifact's inputs (`moss_image_base_bf16`) are as necessary as
anything a loader names and are written down outside the graph. `moss_image_base_bf16` was listed as an
alternate by #130 and no longer is.

**Tested** Live payload from a spare port: `qwen21 requiredIds = [inpaint_cropandstitch, kjnodes,
qwen21_outpaint_lora, qwen3vl_8b_int8_convrot, qwen_image_2.1_turbo_int8_convrot, qwen_image_2.1_vae_bf16,
qwenmultiangle]`, `optionalIds = []`, and every pack reporting `present == total`. `gofmt`, `go vet`,
`go test ./internal/...`, `tsc --noEmit`, 132 canvas tests.

**Where** `internal/resource/{status.go,derive.go}`, `resources.json`,
`frontend/src/components/settings/resource-center-panel.tsx`.


## 136. The brush ring was behind the dialog it lives in

**Decision** The mask editor's brush ring moved from `z-[1100]` to `z-[1500]`, and the canvas only hides the
native cursor while that ring is actually rendered — otherwise it shows `cursor-crosshair`. A new test keeps both
rules: every portalled overlay declared by a component that renders a dialog or drawer must outrank the dialog,
and `cursor-none` may only appear in the same expression as the ring it stands in for.

**Why** The ring *is* the cursor: the canvas sets `cursor-none` and paints a circle through a portal at the
pointer's position. At 1100 it sat below the dialog (1300/1301) and was therefore invisible, so the user painted
with no cursor at all — blind drawing, reported as "看不到光标". The number was correct when the dialog was antd's
Modal (z-index 1000) and was never revisited when the app moved to Radix and the overlay stack was renumbered.
Nothing failed loudly: a buried ring throws no error, and the only symptom is the one thing the feature cannot do
without.

**Why the second rule** A ring that fails to render must degrade to something usable. Hiding the real cursor is a
promise that a substitute is on screen; keeping that promise conditional means a future regression costs a
crosshair instead of the feature.

**Tested** `frontend/tests/overlay-z-index.test.ts` reads the sources: it takes the highest z-index in
`kit/dialog.tsx` + `kit/drawer.tsx` as the floor and fails for any `fixed z-[n]` portal in a file that renders a
`<Dialog`/`<Drawer`. Reverting the ring to 1100 fails with the file and line named, restoring it passes. The
canvas's own portals (context menu at 80, @-mention list at 120) are out of scope on purpose — the canvas is
behind the dialog, so those can never be opened from inside one. `tsc --noEmit`, 134 canvas tests.

**Where** `frontend/src/components/canvas/canvas-node-mask-edit-dialog.tsx`,
`frontend/tests/overlay-z-index.test.ts` (new).


## 138. The project is Comfy Loft

**Decision** The project is called **Comfy Loft**. The gateway code keeps its module name `comfyloft-server`
(that is the binary, not the product), and the repository slug is being renamed by the owner separately.

**Why "Comfy" stays and the second word changed** "Comfy" is the searchable half: this is an abstraction layer
over ComfyUI, and users look for that word. What it may not do is claim to be a ComfyUI *component* — `bench` and
`dock` were the two candidates that failed that test, and both failures were measured rather than guessed:

- `ComfyBench` is already two projects, one of them literally a benchmark paper ("ComfyBench: Benchmarking
  LLM-based Agents…"). In a technical name, `bench` reads as *benchmark* and nothing else, which is a claim this
  project is not making.
- `ComfyDock` is an existing product (`comfygit-ai`) that manages ComfyUI environments — adjacent enough that the
  collision would be a real one, not a coinsidence of string.
- `comfyloft` returned **zero** repositories on GitHub.

A loft is the working space the thing is: one open room where images, video and audio are made — the
"multimedia workbench" idea without a generic word in the name.

**What the name says in the README** `# Comfy Loft`, then one line: images, video and audio made on your own
machine, no cloud API, no vendor account, no per-image bill. The upstream credit is untouched and still names
both repositories and keeps the MIT text at `frontend/LICENSE`; renaming is not a claim of authorship.

**Stale documentation fixed in the same pass** — the three statements this project was carrying that were no
longer true:

- `main.go` described the gateway as "OpenAI-compatible". There is no `/v1` route left; the README has said so
  for a while ("the gateway serves no `/v1/...` at all — that belongs to the model provider AlayaCore talks to"),
  and the package comment disagreed with it.
- `docs/server.md` listed the runtime assets as `workflows/`, `resources/`, `prompts/`. `resources/` became
  `resources.json` at the root in #129.
- The README said "generate images and videos"; the music pack has been shipping audio since the music pack landed.

**Left alone, on purpose** `canvas/` still carries upstream's strings: the plugin ids and directory
(`plugins/infinite-canvas/`, `@infinite-canvas/plugin-sdk`), the plugin skills documentation, and the
default *board* title (`无限画布 {{count}}` / "Infinite Canvas {{count}}") and export file name. Those are
upstream contract and document names, not this project's name; the browser tab already says `无界工作台`
(`canvas/web/index.html`), which is the one place the product introduces itself. Changing any of them is a
separate decision with its own consequences, not a rename.

**Tested** `gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 134 canvas tests. A grep for
`Infinite Canvas`/`ComfyUI Local` now finds nothing outside `canvas/` (upstream strings) and this log.

**Where** `README.md`, `docs/server.md`, `main.go`.


## 141. The credits section names the origin and the licence, and stops there

**Decision** `README.md` opens with a short Credits block and nothing more: this is a fork of
`1314521gjy/ComfyUI-Local-Infinite-Canvas`, itself a modified copy of `basketikun/infinite-canvas`; both are MIT,
their copyright notices and licence texts are kept verbatim at `frontend/LICENSE`, and this project is MIT too; then
one sentence saying both halves have been rewritten since, so nothing is compatible upstream. No tables, no counts,
no inventory of what was added or removed.

**Why** That section exists for the licence obligations: say where the code came from, keep their notices, state
ours. Everything else in the earlier draft was a status report — accurate when written, wrong within a month, and
not what a reader wants above the fold. The single compatibility sentence stays because it is also licence-adjacent:
it tells a reader that upstream work may not be merged here.

**The measurement I had to withdraw** An earlier version of this entry carried a table comparing `canvas/web/src`
and `internal/` against this repository's **own first commit** — 22 of 182 files byte-identical in the canvas, 12 of
102 in the gateway, +13,138/−15,007 and +11,077/−5,984 lines. The canvas half measures the right thing: that tree
was imported from the fork. The gateway half does not. By the time of that first commit the gateway was already Go,
so those numbers describe our own service evolving, not the distance to the project we forked — upstream shipped
`comfyloft-server/` in JavaScript. There is no line-for-line comparison to make, and the honest version is the
sentence the README now carries.

**What the licence file needed** Checking the claim "their copyright notices are kept verbatim" showed it was
false: `frontend/LICENSE` carried only `Copyright (c) 2026 basketikun`. The fork the canvas came from has its own
`Copyright (c) 2026 1314521gjy`, so both lines are now in that file, with the MIT body unchanged. A README that
claims a licence file says something it does not is worse than one that says nothing.

**Tested** `git diff` on `frontend/LICENSE` (one line added), README reads in ten lines, and the language rule still
holds — a Chinese check over the file returns the one pre-existing protocol example.

**Where** `README.md`, `frontend/LICENSE`, `docs/decisions.md`.


## 146. The project's machine identity is `comfyloft`

**Decision** Every identifier a machine reads is one word: the Go module is `comfyloft`, the web package
is `comfyloft`, the plugin SDK is `@comfyloft/plugin-sdk`, the browser keys are `comfyloft:*`, the
databases are `comfyloft` and `comfyloft-plugins`, the export marker is `app: "comfyloft"` and the JSX
sentinel is `Symbol.for("comfyloft.jsx.fragment")`. What humans read is unchanged: **Comfy Loft**.

**Why one word, after #138 chose the hyphen** A hyphen is harmless in a filename and harmful everywhere
a machine wants the name as a token. Environment variables cannot contain one, so the hyphenated form
forces `COMFY_LOFT_CANVAS` — three words, one of them wrong — where `COMFYLOFT_CANVAS` is just the name.
The same shape repeats for binary names, domains and anything typed from memory or spoken aloud. #138
had already measured the one-word handle when it picked the name: `comfyloft` returned zero repositories
on GitHub. It kept the hyphen only because the product name was written that way, which is a display
question, not an identifier one.

**Why now and not later** Cost of the change is entirely in the contracts (`@comfy-loft/plugin-sdk`, the
browser keys, the export marker) and it is at its lowest point today: seven official plugins in this
repository, no third-party plugin, and the standing judgement (#151) that this stage has no data worth a
compatibility shim. After a third-party plugin imports the old scope, the same change becomes a breaking
release.

**What stayed, on purpose**

- **The display name `Comfy Loft`** — README heading, window title, plugin descriptions. Two words read
  better than one, and this is the only place the product speaks as a name.
- **The gateway binary `comfyloft-server`** and the config directory `~/.config/comfyloft-server/alayacore`
  (#138: "that is the binary, not the product"). The binary is named for what it faces; the config
  directory holds the operator's hand-written `model.conf` with a real API key in it, and moving it would
  make an agent silently lose its models.
- **`comfy-loft:asset_store`** — the one-time exit for the deleted asset library  reads that
  exact key because that is what the old build wrote. Renaming it would have broken the only path that
  rescues that data.

**What it costs** The old `comfy-loft:*` localStorage entries and the `comfy-loft` / `comfy-loft-plugins`
databases are orphaned, not deleted — the next load starts empty, which is the accepted trade. Nothing
in the app reads them again. Zips exported by an older build still import: the importer never validated
`app`, which is the one place the old name was left to survive. If that orphaned data ever has to be
rescued, the pattern already exists in `legacy-asset-store.ts`.

**Tested** `make check`, `npm run check` (i18n, exports, prettier, `tsc`), 143 canvas tests, `make build`,
`make web`, and one official plugin (`sticky-note`) installed against `@comfyloft/plugin-sdk` and built
with esbuild. In a browser: the app boots to an empty canvas, writes `comfyloft:canvas_store` and
`comfyloft:plugin_store` into a database named `comfyloft`, stores `comfyloft:theme_store` and
`comfyloft:ai_config_store` in localStorage, leaves the old `comfy-loft` databases and keys untouched, and
logs no console errors.

**Where** `go.mod`, 61 Go files' import paths, `canvas/plugins/canvas/{sdk,html,markdown,panorama,registry,sticky-note,svg,template}/**`,
`canvas/web/{package.json,package-lock.json,src/{i18n/index.ts,lib/canvas/canvas-export.ts,services/localforage-databases.ts,stores/**,types/canvas-export.ts}}`,
`docs/server.md`.


## 147. The MCP edge is a bridge process, not a URL

**Decision** AlayaCore reaches the canvas tools through `bin/comfyloft-mcp`, a second small binary that speaks
JSON-RPC on stdin/stdout and forwards each call to the server on a **loopback-only** listener. The session is in no
address: the server spawns AlayaCore with `COMFYLOFT_MCP` and `COMFYLOFT_SESSION` in its environment, AlayaCore hands
that environment to the bridge it starts, and the bridge puts the session in `X-Comfyloft-Session`. `mcp.conf` is one
static file for every session, and the agent's configuration lives in one directory,
`~/.config/comfyloft-server/alayacore/` — **amended by #245**, which dropped the `<host>` segment this entry
put there.

**Why the names are one word** `COMFYLOFT_*` and `X-Comfyloft-*`, not `COMFY_LOFT_*`: an environment variable cannot
contain a hyphen, so the hyphenated spelling would force three words with one of them wrong (#146's argument, and
these are the first identifiers written since it was made).

**Why the URL had to carry identity, and why it no longer does** MCP carries no identity of its own and the bridge is
configured with one URL per server, so with an HTTP-only endpoint the URL was the only place left:
`/mcp/<sanitised-session>-<sha1[:4]>`. That derivation was a chain of its own — sanitising is lossy, so two sessions
could collide, so a hash was appended, so the URL carried the session id while being unreadable and
unguessable-but-not-secret. AlayaCore supports stdio servers, which deletes the chain at the root: identity is a file
descriptor's parent's environment, not a string in a path.

**What the loopback listener is for** The old route sat on the main mux, served on whatever `COMFYLOFT_SERVER_HOST`
names — a tool that creates nodes and starts generations, reachable from the network with no token. The bridge
endpoint is now a second listener bound to `127.0.0.1` on an ephemeral port, known only to the processes it was
written into, and the custom header means a browser cannot reach it cross-site without a CORS preflight this server
never answers.

**Two binaries, and the rule that went with them** `make build` produces `comfyloft-server` and `comfyloft-mcp`. The
old "one self-contained binary" rule is retired: it was never true of the *release* (the bundle, `workflows/`,
`resources.json` and AlayaCore were always beside it), and with two binaries a mixed install is possible — so the
bridge sends `X-Comfyloft-Bridge` and the server refuses a version it does not speak, naming which half to rebuild.
What the rule was protecting still holds: both are static, cgo-free, and need no runtime.

**One config directory** (written here as per host — #245 removed the `<host>` segment for the reason it removed the
bind address: the models are the operator's, and the path is not identity). `mcp.conf` names the address the agent
dials, and a machine reachable at two addresses gets its answer from `AGENT_CONFIG_PATH` in the unit file instead of
from the path. Inside it, nothing is per session: `model.conf` is the operator's, and `mcp.conf` is written on every
start — its `command` is an absolute path that moves with the release directory, and a stale one fails as
`handshake: EOF`, which names the symptom and not the cause.

**Where** `cmd/comfyloft-mcp/`, `internal/mcpstdio/`, `internal/server/{mcp_server.go,agent_config.go}`,
`internal/agent/spawn.go`.

## 148. There is no plugin mechanism; a node type is a built-in

**Decision** The plugin system is gone — loader, runtime, store, manager dialog, the SDK and its eight
packages, the `public/plugins` directory, the per-plugin IndexedDB database, the event bus the runtime
handed out, and the "节点插件" button. The one node that was actually reachable, the LoRA card, is now a
built-in node (`CanvasNodeType.Lora`) rendered by `frontend/src/components/canvas/nodes/lora-node.tsx`. The
`CanvasPluginDefinition` shape survives as `frontend/src/types/canvas-node.ts`, because it was always the description
of a node and the registry is what built-ins use.

**Why** The mechanism bought two things: a third-party author could add a node without this repository,
and a node could be replaced without rebuilding the app. Neither was ever used. The evidence is the whole
history: no canvas this machine ever saved contained a node type outside the built-in enum; the tracked
plugin manifest never listed anything but the two hand-written `.js` cards; and the eight SDK packages
had only ever been touched by rename commits. What it cost was real — a `fetch` + `eval` loader, a
persisted store, a manager dialog with install/uninstall/update, a version contract, a manifest written by
a build script into a tracked file, an IndexedDB database per plugin, a curated `runtime` object standing
in for the imports a plugin could have had, and no type checking or `check-i18n` coverage inside anything
that was evaluated.

**What "add a feature" means now** A new kind of card is a built-in node, and the cost is the honest one:
one file with its components, one entry in `BUILTIN_DEFINITIONS`, one `CanvasNodeType` member with its
`NODE_SPECS` row, its strings in both dictionaries, and a branch in `renderNodePanel` if it has a panel.
Adding one is a rebuild — for a project that runs from source, that is `make build`.

**The two cards, resolved separately** The LoRA card was converted because it was the only UI that could
choose a LoRA at all: the native side consumes a `lora` resource (`canvas-node-generation.ts` →
`params.loras` → `internal/generate/lora.go`), and nothing else produced one. The ComfyUI-parameters card
was deleted outright: its own source had retired it from the create menu ("与自由卡片重复…保留运行时以兼容
已有节点"), and there were no such nodes to be compatible with.

**What a canvas written by an older build looks like** A node type this build does not have renders as
"Unknown node" (`MissingNodeContent`) instead of a plugin-missing message. That is the honest fallback now:
there is nothing to install that would bring the type back.

**Left on disk, unread** `comfyloft-plugins` (the old IndexedDB database) and any `comfy-loft:plugin_store`
key are not deleted and not read; the storage panel stops reporting the plugin database, because nothing
writes to it (#147 chose the same for the pre-rename keys).

**Tested** `npm run check` (i18n, exports, prettier, `tsc`), 143 canvas tests, `make check`, `make build`,
`make web`, and in a browser: the 节点插件 button is gone, the dock's LoRA button creates the node, its
panel lists the LoRAs the gateway reports (`GET /api/loras`, with the model-pack-internal file filtered
out), picking one updates the card and the node's `params.loras`, and the console stays clean.

**Where** deleted: `canvas/plugins/**`, `canvas/web/public/plugins/**`,
`canvas/web/src/{lib/canvas/{plugin-loader.ts,plugin-runtime.ts,plugin-node-context.ts,canvas-event-bus.ts},stores/canvas/use-plugin-store.ts,components/canvas/canvas-plugin-manager-modal.tsx,pages/canvas/hooks/use-plugin-host.tsx,types/canvas-plugin.ts}`.
Added: `canvas/web/src/{components/canvas/nodes/lora-node.tsx,types/canvas-node.ts,services/api/loras.ts}`.
Touched: `frontend/src/lib/canvas/node-registry.ts`, `frontend/src/components/canvas/nodes/builtin-nodes.tsx`, `frontend/src/components/canvas/canvas-node.tsx`, `frontend/src/pages/canvas/project.tsx`, `canvas-toolbar.tsx`,
`frontend/src/components/canvas/canvas-create-menus.tsx`, `frontend/src/components/canvas/canvas-top-bar.tsx`, `frontend/src/components/layout/user-status-actions.tsx`,
`services/{localforage-databases,local-storage-usage}.ts`, `vite.config.ts`, `vite-env.d.ts`,
`frontend/src/constant/canvas.ts`, `frontend/src/types/canvas.ts`, `frontend/src/services/api/video.ts`, `i18n/locales/*`,
`internal/server/routes_mcp.go`, `scripts/check-exports.cjs`, `docs/known-issues.md`, `README.md`,
`.gitignore`.


## 151. There are no users yet, so the compatibility layers go

**Decision** The one-time exits and the old-data adopters are deleted, not kept one release longer.
This is #151's "when to delete this" arriving early, plus the two places in the server that did the
same job for files instead of browser storage.

**Why** A compatibility layer costs nothing to *keep* and everything to *maintain*: it is a second
input format, a second failure mode and a second set of tests, all of them describing data that only
exists because someone was already using the app. Nobody is. There is no installed base, no stored
library, no `model.conf` from an earlier layout. What would have been "one release, then delete" is
just delete.

**Deleted** `canvas/src/lib/canvas/legacy-asset-store.ts`, `components/layout/legacy-assets-banner.tsx`,
`tests/legacy-asset-store.test.ts`, the `canvas.legacyAssets.*` strings in both dictionaries, the
`legacy` root in `sweepUnusedCanvasFiles`, the two `TEST_ONLY` waivers those modules needed —
exactly the list the compatibility work wrote for itself. In the gateway: `adoptLegacyAgentConfig` (the copy of a
`model.conf` written before the per-host split), `clearLegacyAgentState` (the sweep of older
per-session directories under `data/agent/`), `config.LegacyAgentConfigDir`, and the two calls in
`server.New`. Startup now does one thing to the agent's config: it writes the static `mcp.conf` (#147).

**Deliberately not deleted** `internal/task`'s `File`/`URL`/`MimeType`/`Bytes` mirror of the first
output and `internal/store`'s version-1 pack map are not old data on disk — they are part of the shape
the canvas reads *today*. Removing either means changing routes and frontend together, which belongs
to #152 and later, not to a sweep. `canvas-persist.ts`'s format migrations stay for the same reason
they are useless: the file itself is replaced wholesale when the canvas becomes a directory.

**Tested** `make check`, `go build ./...`, `npm run check` (i18n, exports, prettier, `tsc`), and the
canvas suite — 129 tests, down from 143, every one of the 14 removed being a test of the code removed
above.

**Where** `canvas/src/{lib/canvas/{legacy-asset-store.ts,canvas-file-cleanup.ts},components/layout/legacy-assets-banner.tsx,layouts/user-layout.tsx,i18n/locales/*}`,
`canvas/{tests/legacy-asset-store.test.ts,scripts/check-exports.cjs}`,
`internal/{server/{agent_config.go,server.go},config/config.go}`.


## 152. A canvas is a directory, and the gateway owns it

**Decision** The workspace gets a root of its own — `CANVAS_ROOT`, default `<root>/canvases` — and one
directory per canvas:

```
<CANVAS_ROOT>/<id>/canvas.meta.json   id, title, createdAt, updatedAt, rev
<CANVAS_ROOT>/<id>/canvas.json        the document
<CANVAS_ROOT>/<id>/files/             the media
```

Five endpoints serve it: `GET/POST /api/canvases`, `GET/PUT/DELETE /api/canvases/{id}`. The id is
sixteen hex characters generated by the store, and it is the directory name.

**Why a directory and not a row** Because the thing has two kinds of content with different lifetimes:
a small document written on every keystroke, and large media written once. A file per document gets
the atomic rename for free; a table would need transactions to do the same. It also makes "back up
your work" a sentence with no exceptions — copy the directory, or zip it, and the canvas is whole.

**Why its own root, not under `data/`** `data/` is the gateway's bookkeeping: tasks, uploads, locks,
preference files. It is disposable and rewritten on start. The canvases are the user's work, and a
variable that moves the bookkeeping must not move the work with it. Hence `CANVAS_ROOT` beside
`DATA_DIR` in the config rather than `DATA_DIR/canvases`; a test pins that moving one does not move
the other.

**The gateway does not read `canvas.json`** It checks two things — that the bytes are a JSON object,
and that they are under 16 MiB, the size at which the author has inlined media that belongs in
`files/`. Everything else is stored verbatim. A gateway that understood nodes would need a release
every time a node type was added, which is the coupling #148 spent an entry removing.

**Writes are renamed into place and versioned** Every write goes through a temporary file in the
destination directory and is renamed over the target, so a reader never sees half a document and a
failed write leaves no debris (tested). Every write also bumps `rev`, and `PUT` takes `If-Match`; a
stale one is refused with `409` and the current summary in `details.current`. This is what lets the
browser stop being the truth: it becomes a cache with a save queue, and a save that races another one
loses visibly instead of overwriting silently.

**Deliberately absent** No trash directory for a canvas: a canvas nobody wants back is the common case (a
node is the different case — it moves into the canvas's own trash, #327). No file listing yet — the
`files/` directory exists and is created with the canvas, but runs and uploads still write into
`data/outputs`; pointing them here is #153, and it is where `/api/canvases/{id}/files/{name}` arrives.
No agent session inside the canvas directory yet, same reason.

**Tested** `internal/canvas` (15 tests: the layout a create writes, ordering, rev conflict including
"the refused write did not land", ids that are not ours refused before a path is built, non-object and
oversized documents, delete twice, no temporary files left behind, a meta that belongs to another
directory, an unreadable meta skipped by `List` but reported by `Read`), six route tests over HTTP, the
whole `make check`, and `docs/server.md` now documents the layout, the five endpoints and the rev.

**Where** `internal/canvas/{canvas.go,canvas_test.go}` (new), `internal/server/{routes_canvas.go,canvas_e2e_test.go}`
(new), `internal/server/{server.go,routes_admin.go,e2e_test.go}`, `internal/config/{config.go,config_test.go}`,
`docs/server.md`, `README.md`, `.env.example`, `.gitignore`.


## 153. There is no API key, because there is nothing to authenticate to

**Decision** `apiKey` is gone: the field on `AiConfig` and on `ModelChannel`, the two `"local"` defaults,
the four call sites that hard-wrote it, the three gates that refused a run without it, and the
`Authorization: Bearer …` header that four requests sent. The gateway's CORS no longer lists
`Authorization` as an allowed header, because nothing sends one.

**Where it came from** #71 deleted the cloud-provider concept — one channel, and it is the gateway the
page came from — and removed the address field from the channel editor. The key survived that entry for
one reason: the request layer still built an `Authorization` header, so the config had to hold
*something* to put in it. That something was the literal string `"local"`, in every default, in the
channel editor's save path, and in the model-sync hook.

**Why it was never a secret, and never checked** `git grep Authorization internal/` answers with one
line: the CORS allow-list. No handler reads the header, no middleware validates it, and the gateway
serves a `Bearer local` exactly like no header at all. Meanwhile three code paths asked the user to
configure a key that had no input field: `app-config-modal.tsx`'s "is this channel ready",
`assertAudioConfig` and `assertVideoConfig`. The first was reachable only on a config whose
`apiKey.trim()` was empty — which the defaults made impossible, so the check was dead weight that
still carried two translation strings.

**What is left of #71's repair path** `use-config-store`'s `merge` used to snapshot the whole persisted
blob to `localStorage` under `…:pre-local-only-backup` and then keep only the channel that pointed at
this gateway. That existed for saved configs written by the provider-era build, which cannot exist
(#151). It is deleted; `merge` now merges over the defaults and normalizes the channels, nothing else.

**Why this mattered for the next step** The plan for #152's frontend half was to move preferences to
disk. Carrying `apiKey` through that move would have put a fake secret in `settings.json` and added a
"never echo it back" rule to an endpoint that holds nothing worth hiding. Deleting it first makes the
settings endpoint a plain settings endpoint.

**Tested** `npm run check` (i18n 918/904 keys, 171 modules, prettier, `tsc`), 129 canvas tests, `make check`,
`make web`. `model-selection.test.ts` lost the case that rotated a key — its real subject was that a
saved task keeps the model it was made with, and that still has a test.

**In the browser** The canvas loads, and the settings dialog's 网关 tab reports
`本地 ComfyUI · 本地网关 · 11 个模型 · http://127.0.0.1:8190`: the model list arrives from a
header-less `GET /api/workflows`, which is the path this entry changed most. An image node is created and
the console stays empty. No generation was re-run for this entry: the removed header was ignored by the
gateway, and the run and upload request shapes are covered by `frontend/tests/api-runs.test.ts`.

**Where** `frontend/src/stores/use-config-store.ts`, `services/api/{runs,workflows,image,audio,video}.ts`,
`hooks/use-local-server-sync.ts`, `components/settings/{app-config-modal,channel-editor-drawer}.tsx`,
`frontend/src/components/layout/client-root-init.tsx`, `i18n/locales/*`, `frontend/tests/model-selection.test.ts`,
`internal/httpx/middleware.go`.


## 154. The canvas store is a cache, and one queue writes it

**Decision** `use-canvas-store` no longer stores a document anywhere. It holds two things: `canvases`
— the list the gateway reports, metadata only — and `projects`, the documents this session has opened.
Every write goes through `frontend/src/lib/canvas/save-queue.ts`:

- **coalesced** — a 400 ms debounce, so dragging a node is one save rather than sixty, and the save
  carries the state at flush time rather than the state that queued it;
- **serialized per canvas** — a save that starts while another is in flight marks the canvas dirty and
  runs when the first finishes, because two saves racing would hand the gateway a stale `If-Match`;
- **versioned** — `If-Match: <rev>`, so a save made against a version that has moved on is refused
  instead of overwriting whatever arrived in between;
- **honest about failure** — a network error is retried on a backoff and keeps the canvas dirty; a 409
  adopts the new rev, retries, and tells the user their edits replaced someone else's; a 404 stops,
  drops the canvas from the list and says so, because retrying a deleted canvas is an infinite loop
  (found in the browser, not in a test: an old tab sat there answering 404 every few seconds).

**Deleted with it** `stores/canvas/canvas-persist.ts` (the format versions and every `backfill*`
migration between 0 and 3), `lib/persist-recovery.ts`, `components/layout/storage-recovery-banner.tsx`,
`stores/use-storage-recovery-store.ts`, `lib/localforage-storage.ts`, `canvas-file-cleanup.ts`,
`cleanupUnusedImages` / `cleanupUnusedMedia`, the two `*_generation_logs` object stores nothing had
written to for several releases, and `defaultTitleKeyFor` with the list of default title keys:
recognising a stored title as a translated default was migration work, and the migration is gone.

**Why the media sweep could not stay** It walked every project to decide which `storageKey`s were
alive, and the store no longer holds every project — only the ones you opened. A sweep that sees one
canvas would delete the media of the rest, which is the one failure this design cannot tolerate. It
comes back when the gateway owns `files/` (#155): a string scan of `canvas.json` for `files/<name>`
finds the references without understanding a single node.

**What the UI lost, and why that is correct** The canvas card and the switcher showed a node count.
A count lives inside the document, and the list deliberately carries no document — so the count is
gone rather than fetched per card. `deletedProjects` (id + deletedAt tombstones) is gone too: a delete
is a delete (#152). `hydrated` became `ready`, which is what it now means: the first list has arrived.

**One browser preference left, for one entry** "Which canvas was I in" is device state, not workspace
state, and `frontend/src/lib/canvas/last-canvas.ts` keeps it in `localStorage` under `comfyloft:last_canvas`. It
moves to `/api/settings` in #155 with the theme, the language and the panel widths.

**A CORS bug this found** `If-Match` was not in the gateway's `Access-Control-Allow-Headers`, so every
save failed its preflight and surfaced as `TypeError: Failed to fetch` — the sweep in #153 had removed
`Authorization` from that list and nothing had taken its place. The header is allowed now, for the
reason the comment beside it gives.

**Tested** `npm run check` (i18n 917/903, 168 modules, prettier, `tsc`), 127 canvas tests including
13 for the queue (coalescing, flush-time snapshot, no overlapping saves, conflict retry and give-up,
transient-failure backoff, a new edit overtaking a retry, `flushAll`, `forget`, and a deleted canvas
reported once and never retried), `make check`, `make verify-static`, `make web`.

**In the browser, against a real gateway and the real ComfyUI** `/` created a canvas and a directory
appeared under `CANVAS_ROOT`; adding a text node produced `PUT 200` and the node was in `canvas.json`;
a reload brought the node back from disk; the canvas list showed what the gateway has; renaming in the
list wrote the title into `canvas.meta.json` and advanced the `rev`; deleting removed the directory and
shrank the list; the console stayed empty. The stale-id path was exercised by accident and behaved:
a tab left on a canvas that no longer existed got `404`, went to `/`, and created a new one.

**Where** `canvas/src/{services/api/canvases.ts,lib/canvas/{save-queue.ts,last-canvas.ts},stores/canvas/use-canvas-store.ts}`
(new/rewritten), `pages/canvas/{entry.tsx,project.tsx}`, `components/{canvas/{canvas-manager-dialog,canvas-project-card,canvas-top-bar,canvas-delete-projects-dialog}.tsx,layout/{user-layout,client-root-init}.tsx}`,
`services/{file-storage,image-storage}.ts`, `i18n/locales/*`,
`tests/canvas-save-queue.test.ts`, `scripts/check-exports.cjs`, `internal/httpx/middleware.go`.


## 155. Preferences live with the workspace, and the browser stores nothing

**Decision** The last thing the canvas kept in the browser — its preferences — lives in `data/settings.json`, served
as one document: `GET /api/settings` returns the whole thing (`{}` until something is saved) and `PUT /api/settings`
replaces it with `{settings: {...}}`. The server checks two things — a JSON object under 1 MiB — and never reads a
key; the shape belongs to the canvas, the division #152 drew for a canvas document. There are no per-key endpoints: a
partial update needs a merge, and a merge is where preferences quietly lose keys.

Every `localStorage` key and the last IndexedDB database are gone — theme, `ai_config_store` and its pre-local-only
backup, locale, the side panel's width/open/node-view, `last_canvas`, the resource setup flag and the image
quick-tools key — all of them now fields inside that one document.

**Why** #154 made the canvas a directory and left the preferences behind, which produced the oddest state this app
had: the same workspace, on the phone in the next room, opened English and light with the right canvases in it.
Preferences are the workspace's, not the browser's.

**Why a first-paint file, and why the server writes it** A document that only arrives over HTTP cannot be applied
before the first frame, so every dark workspace opened white for a moment and every English one opened in Chinese.
The bundle is static, so the one thing a page can read synchronously is a script tag: `start.sh` used to write
`dist/config.js` with the address, and the server now writes it — on every start and after every settings save — with
the address *and* the document. That also fixed something nobody had noticed: `index.html` had an inline script
reading `localStorage["infinite-canvas:theme_store"]`, a key nothing has written since they were renamed, so the first
paint had been guessing for several releases. `AppProviders` now applies the theme in a `useLayoutEffect`, before the
paint rather than after it.

**Superseded in part by #220** The script is no longer a file written into the bundle: it is a route (`GET
/config.js`) computed from `data/settings.json`, and `RUNTIME_CONFIG_PATH` only writes a copy for a canvas a static
host publishes.

**Why there is no request at startup** The document is already in `config.js`, so `load()` is the fallback for an
operator who serves no first-paint file, and the store **refuses to save until it has a document from one of the
two**. Without that guard, a server run without `RUNTIME_CONFIG_PATH` would replace the workspace's preferences with
this build's defaults on the first keystroke.

**Cost, named** Two people sharing one server share the theme, the language and "the canvas I was in". For a local
workbench that is the point; for anything else it is a decision to make again.

**Where** `internal/server/routes_settings.go`, `internal/settings/`, `frontend/src/stores/`,
`frontend/src/components/layout/app-providers.tsx`.

## 156. Media belongs to the canvas, and the gateway stops keeping scratch space

**Decision** A run and an upload are canvas-scoped, and their bytes live in the canvas directory:

```
POST /api/canvases/{id}/runs          submit into that canvas
POST /api/canvases/{id}/uploads       one media file into that canvas
GET  /api/canvases/{id}/files/{name}  any file of that canvas, upload or artifact
```

`data/outputs`, `data/uploads` and `uploads.json` are gone. `config.OutputDir` is gone. A node names its
media as `files/<name>` — the same string in the document, in the export zip and in the URL — and the
browser resolves it against the canvas it is showing.

**Why** #152 made the canvas a directory and #155 gave it its preferences; the media was the last thing
still living somewhere else, and it lived in *two* other places at once: artifacts in the gateway's
scratch directory, uploads in `data/uploads` plus an index, and the browser's own copy of whatever a
node displayed. Three copies of one picture, with the canvas naming none of them. Now the canvas names
all of them, and `cp -r canvases/` is a complete backup — which it was not before, since the images a
canvas showed lived in `data/outputs` and in one browser profile.

**The collector returns, and this is why it can** #154 had to delete the media sweep: it walked every
canvas in the store, and the store only holds the ones you opened, so running it would have deleted the
media of the rest. The files now sit next to the document, so the sweep asks each canvas directly: the
document is scanned for `files/<name>` strings (a reference is a string; understanding nodes was never
required), the canvas's run history adds its artifacts and upload inputs, and anything else older than
**24 hours** is deleted. The grace window covers the gap between a run writing a file and the client
putting it in a node; a task record expiring does not delete anything, because the canvas, not the run,
owns the file.

**ComfyUI's input directory stops growing** The gateway used to push every upload under a name with a
fresh random suffix, so each process restart that touched a reference image left another copy in
ComfyUI's `input/`, and nothing on either side ever collected them. The push name is now derived from
the canvas and the upload (`upload.ComfyNameFor`), and the request already carried `overwrite=true`, so
a re-push replaces one file instead of adding one. The in-memory push cache is an optimization again
rather than the only thing preventing duplicates.

**What the frontend lost** `localforage` (uninstalled), `services/localforage-databases.ts`, the
IndexedDB media and preview stores, the client-side thumbnail generator (`createImageThumbnail`), and
the blob-URL bookkeeping in `file-storage.ts` / `image-storage.ts`. Those two modules keep their names
and their exported functions — `resolveImageUrl` still answers "what goes in an `img src`" — but the
answer is now a URL on the gateway. A node's `metadata.content` holds the reference, not the URL, and
the store strips resolved URLs on the way to disk so a document can never carry this host's address.

**Tested** `internal/canvas` (reference scan, sweep with grace and references, path validation),
`internal/upload` (save/get/kind/oversize/unknown canvas/derived ComfyUI name), the task store (outputs
into a canvas, pruning that no longer deletes media), the e2e suites (uploads and runs through
`/api/canvases/{id}/…`, artifacts fetched back over HTTP, cross-canvas reads refused, unknown canvas
refused), `npm run check`, 127 canvas tests, `make check`, `make verify-static`, `make web`.

**In the browser and against the real gateway** An upload landed in `<canvas>/files/up-*.png` and came
back byte-identical with `Cache-Control: private, max-age=31536000, immutable`; a real generation through
ComfyUI (`image-moss-sft-int8-8step`) wrote its 919 KB artifact into the same directory and reported
`/api/canvases/<id>/files/task_*.png`; a file of another canvas is a 404; the canvas page loaded with an
empty console.

**Where** `internal/canvas/{files.go,files_test.go}` (new), `internal/upload/{upload.go,upload_test.go}`,
`internal/task/task.go`, `internal/server/{routes_runs.go,routes_canvas.go,routes_generation.go,runs.go,server.go,e2e_test.go,canvas_e2e_test.go,*_runs_e2e_test.go}`,
`internal/config/config.go`, `canvas/src/services/{canvas-files.ts (new),file-storage.ts,image-storage.ts}`,
`frontend/src/stores/canvas/use-canvas-store.ts`, `canvas/src/lib/canvas/{canvas-export.ts,canvas-node-factory.ts,image-thumbnail.ts}`,
`canvas/src/components/canvas/canvas-manager-dialog.tsx`, `frontend/src/pages/canvas/project.tsx`,
`canvas/src/i18n/locales/*`, `frontend/package.json`, `docs/server.md`.


## 157. The gateway's liveness is learnt from the traffic, not probed

**Decision** The heartbeat is gone. `services/api/server-status.ts` no longer has a timer, a
`GET /health` probe, or a reload: a gateway request that fails at the network layer marks the gateway
down, **any** response from it marks it up, and the banner follows. `/health` stays as an endpoint —
what it answers (ComfyUI's reachability, workflow counts) is a question for an operator with `curl`.

**What the old loop did** After the first failure it probed `/health` every 2s, and when the probe
answered it cleared the banner and reloaded the page 600ms later. It cost nothing while healthy (the
probe only ran while down), so this is not a performance entry; it is an entry about a mechanism that
had stopped being the only way to know either thing.

**Why the probe was unnecessary** Recovery was already in the traffic: the model list is fetched every
8 seconds and the system chip every 5, and the first of those to succeed is the same news, a few seconds
later and for free. The probe's only real contribution was making the banner disappear up to ~6 seconds
sooner.

**Why the reload was worse than useless** Its stated reason was that model lists, resource status and
in-flight requests had gone stale while disconnected. The polls now refresh all of that on their own
(#153 made the model list self-syncing), so what the reload still did was throw away what the tab held:
the undo stack, the selection, the node being dragged. A page that reloads itself because the backend
came back is a page that interrupts the person using it.

**The new rule, in one line** Reachability is derived from requests we make anyway: `noteGatewayError`
on a network failure, `noteGatewayResponse` on any answer — including a 4xx, because a 400 from the
gateway is a gateway that is answering. The synchronous hook that used to call `markGatewayUp()` after
its own fetch no longer has to, because its fetch goes through the HTTP layer like everything else.

**Tested** `npm run check`, 127 canvas tests (the API tests mock the status module, which gained the
`noteGatewayResponse` export they now stub), `make web`. In the browser: the gateway was killed under an
open canvas — the banner appeared with its new wording within one poll — and brought back: the banner
cleared on the next poll, `window.__noReload` survived (no reload), and the new build logged **zero**
`GET /health` requests across the whole cycle.

**Where** `canvas/src/services/api/{server-status.ts,http.ts}`, `frontend/src/hooks/use-local-server-sync.ts`,
`canvas/src/i18n/locales/*`, `canvas/tests/api-*.test.ts` (the stubs).


## 158. A tab that is out of date says so instead of winning

**Decision** A save that names a version older than the one on disk is **refused and handed to the
person**, never retried over it. And a tab checks whether it is still current when it comes back into
focus, so the mistake is caught at the moment it is made rather than at the next save.

**The scenario** One person, one workspace, no collaboration — and two tabs of the same canvas, because
a link was opened twice or the session was restored. Both hold a copy. A save replaces the whole
document (#152), so the second tab to save erased the first one's work, and the only trace was a toast
that said "changed elsewhere, saving this version" *after* the damage.

**Why the retry was the bug** The queue's conflict path adopted the new `rev` and retried, on the
reasoning that the content on screen was still unsaved and losing it would be worse. That reasoning is
right about *not discarding* the edit and wrong about the retry: with whole-document saves, a retry is
an overwrite. `rev` stops two saves from interleaving; it cannot stop one document replacing another,
because the gateway is not allowed to know what a node is.

**What the tab checks, and when** On `focus` and on `visibilitychange` → visible, the canvas page asks
for its own entry (`GET /api/canvases/{id}`, metadata only) and compares `rev` with the one it last saw.
Switching to a tab is exactly the moment the person is about to continue working in a stale buffer, so
it is the moment worth one request. No `BroadcastChannel`, no cross-tab protocol: the gateway already
holds the answer, and the check works across browsers and machines too.

**What the dialog offers** "Keep this" saves over the other copy — the one save in the app that names no
version, and only after the person was shown what it replaces. "Use the disk copy" reloads the page: the
nodes, the undo stack and the selection are all derived from the document read at load, and a reload is
how all three are made to agree with the file. That is the one reload in this app that somebody asked for
(#157 removed the automatic one).

**Not built, on purpose** No editing lock, no read-only second tab, no takeover, no polling leader. Those
solve *co-existing* tabs, which this workspace does not have; the requirement is a failsafe for a
mistake, and a failsafe that asks one question is smaller than one that forbids a layout.

**Tested** The queue's conflict tests now assert the opposite of before: one attempt, no retry, no save
on the other copy's version, and a later edit does not silently start overwriting again. `npm run check`,
127 canvas tests, `make check`, `make web`.

**In the browser** Two tabs on one canvas; a save from the first (`PUT` with its rev); focus moved to the
second — the dialog appeared by itself, naming when the disk copy was written — and "keep this" advanced
the `rev` with a forced save and closed the dialog with a toast. Nothing was overwritten before the
answer.

**Where** `frontend/src/lib/canvas/save-queue.ts`, `frontend/src/stores/canvas/use-canvas-store.ts`,
`frontend/src/components/canvas/canvas-conflict-dialog.tsx` (new), `frontend/src/pages/canvas/project.tsx`,
`canvas/src/i18n/locales/*`, `frontend/tests/canvas-save-queue.test.ts`.


## 159. The frontend is `frontend/`, and the build target says so

**Decision** `canvas/` is now `frontend/`, and the npm targets are `make frontend`, `frontend-deps`,
`frontend-check`, `frontend-clean` (they were `web`, `web-deps`, `web-check`, `web-clean`).

**Why** Two directories one letter apart, and the letter pointed the wrong way: `canvas/` was the app
and `canvases/` is the work. Every reader had to work out which was which — in the `Makefile`, in
`start.sh`, in the `.gitignore`, in this file. The frontend is not a canvas; the workspace is a set of
them.

`canvas/` was upstream's layout, kept because it was where the app lived. With `web/`
gone (#148) and the app no longer named after what it edits, the name was the last thing tying the
markup directory to the domain. `cmd/`, `internal/`, `frontend/` reads as one repository.

**What it cost** A `git mv` and seven references: the `Makefile` (its `WEB_DIR`/`WEB_STAMP` variables
became `FRONTEND_*`), `start.sh` (three paths and two hints), `.gitignore` (three build-output lines),
`README.md` (the tree and four paths), `docs/server.md` (one), and the two places that tell a reader
what to run next (`internal/server/runtime_config.go`'s comment and `frontend/public/config.js`).

**Not renamed** The `CANVAS_ROOT` variable, the `canvases/<id>/` layout and "back up your canvases" —
those name the workspace, which is what a canvas is. `make frontend` still says "build the canvas
bundle" in its help text, because that is what it builds.

**Tested** `make frontend` (a fresh build into `frontend/dist`), `make frontend-check`, `npm run check`,
127 canvas tests, `make check`, `make verify-static`, and `./start.sh`: the page, `config.js` and the API
all answer, and the canvas loads in the browser with nothing in the console.


## 160. The newest connection reads the agent, and an empty turn is a failure

**Decision** `Session.Watch` hands the session to the newest connection and tells the one it replaced
(`closed`), instead of refusing the newcomer. And a prompt turn that ends without a single word is an
error, not an empty answer.

**The report** A text node's agent wrote nothing at all, and the log showed `state closed`.

**What was actually happening** The agent was fine: the same prompt over the same socket streams
reasoning, then deltas, then `done`. The failure was in who is allowed to read a session. `Watch`
accepted one sink and refused every later one with "这个画布在另一个连接里已经打开了" — so a second tab
on the same canvas (and there were seven open while this was investigated) got an `error` instead of the
model list, the ask rejected, and `askOnceAgentSession`'s `finally` closed a session it had never been
able to use. That close is the `state closed` in the log, which is *normal* for a node's one-shot ask:
connect, ask once, close.

**Why the refusal was wrong** The rule exists so deltas are never split between two readers, and that
part stays: exactly one sink receives them. But refusing the *newest* connection protects a socket
nobody is looking at, and the tab it strands is the one in front of the person. Now the new connection
takes over, and the old one hears `closed` — which is also true, so it can reconnect and say so.

A handover cannot be undone by a late close: `Watch` returns a stop function, and only the watcher that
still owns the session may clear it (a generation counter, since a func value cannot be compared).

**Why an empty turn had to become visible** When a turn ended with nothing — which is what a closed
session looks like from the other side — the node was written with the empty string and marked
successful, so the canvas showed a blank text node and no reason. `requestPromptChat` now throws
instead, and the node's own error path (a toast and `NODE_STATUS_ERROR`) says what happened.

**Tested** The gateway's old `TestSocketIsOnePerCanvas` (which asserted the refusal) is replaced by
`TestTheNewestSocketTakesTheSessionOver`: the second connection gets the model list, receives the
answer, and the first one is told `closed`. `requestPromptChat` gained a test for the empty turn. Then
`make check`, 128 canvas tests, `npm run check`, `make frontend`.

**In the browser and over the socket** With the real agent: a second socket on one session name is
accepted, the first is told `closed`, and the second received 942 text events and `done` for the same
prompt that had produced nothing.

**Where** `internal/agent/sessions.go`, `internal/server/routes_agent.go`,
`internal/server/agent_e2e_test.go`, `internal/agent/session_test.go`, `frontend/src/i18n/locales/*`.


## 161. A run goes into the canvas, and one function is the only place that says where

**Decision** Every URL the canvas submits a run or an upload to is built by one function,
`canvasApiUrl()` in `frontend/src/services/api/runs.ts`, which cannot be called without an open canvas.
And the tests that pin those URLs now name the canvas, instead of pinning a path that nothing external
checked.

**The report** The generate button answered `Not found: POST /api/runs`.

**What was actually happening** #156 deleted `POST /api/runs` and `POST /api/uploads` and gave every run a
canvas. The gateway was right; the browser was calling a route that no longer existed, because
`createRun` and `uploadMedia` still posted to the old two paths and nothing on either side compared its
address with the other's router.

**Why both test suites were green** They answer different questions and neither one is "do these two
agree?". The gateway tests post to the routes the gateway serves, so they track the router by
construction. The canvas tests stub `fetch`, so they agree with whatever the client sends, and a perfectly
exact assertion of the wrong string is still green: `api-runs.test.ts` did assert its URLs in full, which
pins the client but cannot know the gateway. The other two routed their stubs by suffix
(`url.endsWith("/api/runs")`, `endsWith("/api/uploads")`), so even a client-side change of the path's
prefix would have slipped past them. Only a real browser click crossed the seam, and that is where it
broke.

**The fix** `canvasApiUrl()` reads the canvas being edited and refuses to build a URL without one — the
`apiErrors.noCanvas` message, not a request built from an empty id. Both calls go through it, so the
canvas-scoping is stated once. A run that does not belong to a canvas is not a thing the protocol has
(#156), so the helper is also where that rule is enforced on the client side.

**Two smaller misses from the same sweep**

- `frontend/src/lib/canvas/canvas-export.ts` built the zip path with an **escaped** interpolation:
  `` `projects/\${project.id}/files/\${name}` ``. The archive therefore had one literal directory named
  `${project.id}` holding every file of every canvas — export "worked", and an import could not put a name
  back where a document's reference expects it. Fixed to a real template literal.
- The three tests that answer a run now open a canvas first (`setActiveCanvas`) and name the canvas in
  every URL they assert or stub; `api-runs.test.ts` still asserts them in full.

**Still weak, and left alone** Suffix matching survives in the video and upscale stubs, because the calls
they exercise are the ones whose shape did not change. Worse, `api-image-runs.test.ts` keeps a stub
branch for `url.includes("/outputs/0")` — a route that no longer exists — so its artifact download falls
through to the run-status fallback. The test passes because it asserts the data-URL prefix, not the bytes:
it would not notice a download that returned the run's JSON. Nothing in this sweep touched it; it is
recorded here rather than left to be rediscovered.

**The guard that was written and thrown away** A `routes_contract_test.go` scanned the frontend sources for
`/api/...` strings and checked each against the gateway's route table. It was deleted: with
`httpRequest(url, { method: "POST" })` it can read the path but not reliably the method, and it did not
catch the bug it was written for. What would work is the client consuming a machine-readable route list —
a route table the gateway publishes, or a module generated at build time — because then the two sides read
the same data instead of one guessing about the other. That is not built.

**Tested** `make check`, `make verify-static`, `npm run check`, the canvas suite, `make frontend`, and the
two routes over `curl` (a `202` from `POST /api/canvases/{id}/runs`, a `200` from the artifact's file URL).
Not clicked in a browser yet: the generate path from the node itself.

**Where** `frontend/src/services/api/runs.ts`, `frontend/src/lib/canvas/canvas-export.ts`,
`frontend/tests/api-runs.test.ts`, `frontend/tests/api-video-runs.test.ts`,
`frontend/tests/api-image-runs.test.ts`.


## 162. A stub that matches a URL's suffix cannot fail

**Decision** The canvas tests that answer a run route their stubs by the **whole** URL and answer `404` to
anything else, and the assertions name the whole URL too. `api-image-runs.test.ts` is the case that made
this worth doing: it kept a stub branch for `/outputs/0` — a route #156 deleted — so its artifact download fell
through to the run-status fallback and the test read a run's JSON as if it were a PNG.

**Why** #161 recorded that weakness and left it. A stub matched by suffix (`url.endsWith("/runs")`) accepts a
request sent to the wrong place: it is written from the client's point of view, so it agrees with the client
whatever the client does, and the case passes on an address no gateway serves. A `404` for anything unlisted
turns that into a failure in the one place that is cheap to fix.

**What changed** `api-image-runs.test.ts` and `api-video-runs.test.ts` gained a `ROOT`, a named upload id
(an upload's id is its file name, per #156, not `upl_1`), and a stub that routes the four addresses the action
actually uses: the canvas's uploads, the canvas's runs, the run's status, and the artifact as a file of that
canvas. The first case asserts the whole list of calls, in order. The interpolate case stopped overriding
`fetch` for one call and now declares its own upload response, so its media id is a video's name rather than a
lie about an image.

**Cost** A new call added to an action makes an existing case fail until the stub knows that address. That is
the point, but it is friction, and it is why the stub lives next to the cases rather than in a shared helper.

**Tested** `npx vitest run` (17 files, 136 tests), `npm run check`, `make check`. The upscale case now fails if
the artifact is fetched from anywhere but `GET /api/canvases/{id}/files/{name}`.

**Where** `frontend/tests/api-image-runs.test.ts`, `frontend/tests/api-video-runs.test.ts`.


## 163. A citation is an id, and two nodes may share a name

**Decision** A citation in the agent panel is a node id plus the label the message shows. When the label is a
name another citation in the same draft already uses, it gets an ordinal (`图片`, `图片 2`), and the block the
prompt carries records both: `- <id> (<kind>) <label>: <prompt>`. A mention in the transcript is read back as
pairs and the click follows the id; the canvas's current titles are only a fallback for a sentence that cited
nothing.

**The report** Two `@` mentions that read the same, pointing at two different nodes, both jumped to the first
one.

**What was actually happening** `withMentions` collected `message.mentions` and then every node on the canvas,
and deduped **by title**, keeping the first. With two citations of `图片` the second was dropped before the
text was even scanned, so both occurrences matched the one survivor and focused its node. The dedupe was not
the only problem, it was the visible one: the code treated a name as an identity, and names are not unique
here. A node's title is the translation of its type by default (`canvas.nodeTypes.image`), so a canvas with
five images has five nodes called `图片` — the case the panel was built for is the case that broke.

**Why it read as working** #106 tested the block with two nodes that had different titles. Everything about
the mapping was correct except the part nothing exercised: that the token is not the identity.

**The fix** Three small pieces, in the module that already owned the format:

- `citationLabel(base, taken)` hands out the name, or the name with the first free ordinal, so the token a
  message shows is unique inside that message.
- `mentionSegments(text, citations, nodes)` cuts a message into plain runs and links, taking each link's id
  from the message's citations in order. A transcript written before labels were unique — two identical
  tokens, two ids — is read one citation per occurrence, which is the most two identical words can support.
- The panel keeps `{id, label}` for each citation, writes the label into the draft, and describes the node to
  the agent with the same label. It also cites `nodeTitle(node, t)` rather than the stored `title` snapshot, so
  a canvas created in Chinese and read in English cites the words on the screen.

**What it buys beyond the click** The agent reads `图片 2` with an id beside it, so a tool call can name the
second image instead of "the image" — the same ambiguity was in the prompt, not only in the link.

**Cost** The block's third field is the token, not always the node's name; a node whose title contains the
block's own `: ` still loses its tail when read back (#106's cost, unchanged). And the draft now reads
`@图片 2` where the user might have expected their node's name — true, and unavoidable while two nodes answer
to that name.

**Tested** `frontend/tests/agent-references.test.ts`: `citationLabel` numbering, two citations that read the same
resolving to two ids, a legacy transcript with identical tokens, a citation beating a node of the same name,
the longest label winning (`图片 10` before `图片 1`), and an `@` that names nothing staying text. Gates:
`npx vitest run`, `npm run check`, `make check`, `make frontend`.

**In the browser** A canvas with two text nodes, both called `文本`. `@` → pick the first → draft reads
`@文本`; `@` → pick the second → the draft reads `@文本 @文本 2`, and the block sent with it has two lines with
two different ids. The answer came back with two links — `@文本` and `@文本 2` — and clicking the first
selected `text-aaaa-1`, clicking the second selected `text-bbbb-2`. The agent also read them apart by itself:
it made two `canvas_read_node` calls and wrote its answer as a table of `text-aaaa-1 (文本)` against
`text-bbbb-2 (文本 2)`, which is the label doing its second job.

**Where** `frontend/src/lib/canvas/agent-references.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/tests/agent-references.test.ts`.


## 164. A replaced socket reconnects, and it does not release the agent

**Decision** Only the connection that is still reading a session may release it, and a browser told `closed`
reopens on its next send instead of writing into a socket another tab now owns.

**What broke** #160 lets the newest connection read a session and tells the one it replaced. Two things around
that handover were wrong, and both ended in a conversation that looked alive and was not.

On the gateway, the replaced connection's handler ended with `session.Cancel()` and
`sessions.Close(...)` — unconditionally. So when the tab that lost the session was closed (the ordinary end of
a socket nobody is reading), it released the process the *newer* tab was using. That tab's next question went
into a pipe that was gone.

In the browser, `closed` only changed the label in the header. The socket and its session entry stayed, so the
next send went to a socket whose events now belong to another tab: no answer, no error, no end of turn, and a
panel stuck on "thinking" for ever. `openAgentSession` had the same shape from the other side — a live entry
whose socket was closing was handed back as if it were connected, because its `opening` promise had already
resolved.

**The fix** `Session.Watch` returns whether the connection detaching was still the reader, and only then does
the handler cancel and release; the call is idempotent, so the early returns and the `defer` cannot release
twice. The client treats `closed` as the end of *this socket*: it drops the entry, closes the socket, and the
next send opens a new connection — which takes the session back. `openAgentSession` refuses to return an entry
whose socket is not open or opening. Submitting a message now checks whether it was written and says so when
it was not.

**Cost** A replaced tab that sends again steals the session back from the tab it lost it to, so two tabs can
alternate rather than one being permanently second class. That is the price of "the newest connection reads
the session" being the only rule; the alternative was a refusal, which #160 already rejected.

**Tested** `TestTheReplacedSocketDoesNotTakeTheAgentWithIt` (Go, e2e): two sockets, the first closed, the
second still answered by the same process — it fails without the fix with EOF on the second socket.
`TestTheNewestSocketTakesTheSessionOver` still passes. Frontend gates: `npx vitest run`, `npm run check`.

**In the browser** Two tabs on one canvas, both open the panel. Tab B becomes the reader (the gateway logs
`spawned=false`, so it is the same process) and tab A shows "未连接" with its transcript intact. Sending from
tab A reconnects and answers "我还在。"; the gateway logs a third `socket open` with `spawned=false` and no
`released` line, which is the fix: closing the replaced socket no longer ends the conversation.

**Where** `internal/agent/sessions.go`, `internal/server/routes_agent.go`, `frontend/src/services/api/agent.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `internal/server/agent_e2e_test.go`.


## 165. A save that ran out of retries waits for the next edit

**Decision** A save whose retry schedule is spent stops; the next edit is what starts a new one.

**What broke** The save queue's "try again" path armed the debounce from the failure handler, and the
settle step re-armed it whenever the canvas was still dirty. With the retry schedule spent, nothing cleared
the flag, so a document the gateway kept refusing was re-sent every 400 ms for as long as the tab lived. The
new test counted 153 attempts where the schedule allows three, and `onError` fired with each one.

**The fix** An entry remembers that its retry schedule is spent. `settle` does not re-arm a spent entry; a new
edit (which is new information) calls `schedule`, which clears the flag and starts a fresh schedule.

**Cost** A permanent failure now needs a user action to be retried at all. That is what the comment always
said and the code did not do; the alternative is a loop that fills the console and gains nothing.

**Tested** `canvas-save-queue.test.ts`: "stops once the retry schedule runs out, and a new edit starts it
again" — 3 attempts, 3 errors, still dirty, and a fourth attempt after a new edit.

**Where** `frontend/src/lib/canvas/save-queue.ts`, `frontend/tests/canvas-save-queue.test.ts`.


## 166. Preferences are written one at a time

**Decision** One settings document on the wire at a time, in the order it was edited.

**What broke** The settings document is replaced whole, and `save()` set its `pending` flag and awaited the
request. A change arriving while that request was in flight started a second one, and two whole documents in
flight can land out of order — the older one winning. It needs a slow gateway and a quick edit to happen, and
then preferences look like they did not change.

**The fix** One write on the wire at a time. A change that arrives during a write is written by the next
request, in order; a failure is retried by the next change rather than from the write's own end.

**Cost** A save queued behind a slow request waits for it. The debounce is what kept this rare, and the
alternative is a lost edit rather than a late one.

**Where** `frontend/src/stores/use-settings-store.ts`.


## 167. The upload ceiling is the one that was configured

**Decision** The multipart parser reads `MAX_UPLOAD_BYTES` from the configuration; it has no ceiling of its own.

**What broke** `MAX_UPLOAD_BYTES` is documented as the per-file limit, but the multipart parser capped every
file at 50 MiB of its own: the knob could be lowered and not raised, and a deployment that raised it got
"uploaded file is too large" from the parser before the upload store saw the request.

**The fix** The ceiling travels from the configuration into `ParseMultipart` (through `httpx.Ctx`), and zero
still means the package default for callers that have no configuration.

**Cost** One more field on `Ctx`, and the parser no longer has an opinion of its own — which is the point.

**Tested** `TestParseMultipartHonoursAConfiguredCeiling`: a limit below the file size refuses it, a limit above
accepts it.

**Where** `internal/httpx/form.go`, `internal/httpx/httpx.go`, `internal/server/server.go`.


## 168. Shutdown stops the task cleaner instead of waiting for its next tick

**Decision** Shutdown signals the cleaner and then waits for it: `stop` and `done` are two channels.

**What broke** The cleaner took one channel and closed it itself on the way out, and the shutdown path waited
on that same channel. There was nothing that could tell it to stop, so with `TASK_RETENTION_DAYS` set a
Ctrl-C blocked until the next cleanup tick — an hour by default. Measured on the built binary: six seconds
after SIGTERM it was still running.

**The fix** Two channels: `stop` is closed by the shutdown path, `done` is closed by the loop.

**Cost** One more argument to a ten-line function.

**Tested/measured** The fixed binary exits immediately on SIGTERM with `TASK_RETENTION_DAYS=1`; the previous
build was still running six seconds later.

**Where** `cmd/comfyloft-server/main.go`.


## 169. A file that could not be added says so, and media too big to hand over is not sent

**Decision** An add that fails reports it, and a tool result larger than one socket message is refused in
favour of its size.

**What broke** Two silent failures around media. Dropping, pasting or picking a file ran the upload with no
failure path: a gateway that was down left the rejection in the console and nothing on the canvas. And
`read_node` inlined a node's media as base64 with no bound — the gateway closes a socket that sends a message
over 8 MiB, so reading back a large clip ended the whole agent conversation.

**The fix** Every ingress path reports a failure with a toast (one new key, both languages). `read_node` refuses
to inline more than 5 MiB of base64 and answers with the file's size instead — the file stays on the canvas,
which is where the user can open it.

**Cost** A 6 MB picture cannot be handed to the agent at all. The alternative is a socket that dies, which
loses the whole conversation rather than one read.

**Where** `frontend/src/pages/canvas/hooks/use-content-ingress.ts`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`, `frontend/src/i18n/locales/*.ts`.


## 170. The default language is English

**Decision** A workspace that has never chosen a language opens in `en-US`, and `en-US` is also the
dictionary fallback: a key the Chinese dictionary is missing renders its English sentence rather than the
other way round. A workspace that has chosen a language keeps it — the preference is `locale` in
`data/settings.json` (#155), read before the first paint.

**Why** The project's written language is English (README, "Language"), so the product's own default should
not be the one language its documentation is not in. It also puts the `fallbackLng` on the side with the
larger dictionary: an untranslated string is then an English sentence in a Chinese screen, which is the
failure the check script reports (§#41), rather than Chinese text in an English one.

**What did not change** The Chinese labels for workflow metadata (`gateway.models`, `gateway.variants`) —
`chinese()` asks the `zh-CN` dictionary by name (#20), so it does not depend on which language is being read.
The Chinese copy the resource panel keeps beside itself (#67), the model-facing Chinese in
`internal/prompt` (#9), and the protocol values such as `文生视频(T2VA)` are untouched: they are data, not
UI copy.

**Cost** An operator who wanted Chinese by default now says so once per workspace, and the first screen of a
fresh install is English. Existing workspaces are unaffected — their `locale` was written the first time
anyone switched the language, and the read is what runs first.

**Tested** `npm run check` (i18n keys still agree: 905 / 891), `npx vitest run` (146 — no test depended on the
Chinese default; the ones that need a language name it), `npx tsc --noEmit`. In the browser: a gateway on a
temporary data directory (so the workspace really has no `locale`) served the bundle on a fresh tab —
`document.documentElement.lang` is `en-US`, the first canvas is created as "Canvas 1", and the toolbar reads
"Canvas elements" / "No nodes on this canvas" with the switcher offering `中`. A workspace that has chosen a
language keeps it, because `bootLocale()` reads the saved document first.

**Where** `frontend/src/i18n/index.ts`, `frontend/index.html`, `frontend/scripts/check-i18n.cjs`,
`docs/decisions.md` #20 and #41 (their wording no longer rests on the fallback being Chinese).


## 171. A file's name is the document's, so an import keeps it

**Decision** Restoring an exported canvas writes every file under the name the document already uses
(`files/<name>`), through one route that takes the name from the URL — `PUT /api/canvases/{id}/files/{name}` —
and the document is then stored exactly as it came out of the zip. Nothing is renamed and nothing is rewritten.

**What was wrong** Import went through the upload route. That route names files itself (`up-<8 hex>.<ext>`,
unique inside a canvas, chosen by the gateway so a client cannot collide with, or walk out of, a directory),
so every imported file came back under a different name, and the document had to be repaired afterwards by
replacing `files/<old>` with `files/<new>` — over the whole JSON, as text. Two costs came with that: the
document briefly named files that did not exist, and the rename was a string substitution over a document the
gateway is not supposed to understand.

**Why it was wrong, more precisely** An export already is the canvas directory: `projects/<id>/files/<name>`,
named by the document. The only thing an import has to change is the canvas id, because directory names are
ids and the exported one still exists. A file name is not an id — it is the reference the document holds — so
preserving it is the whole job. The "gateway picks file names" rule belongs to *new* bytes (an upload, a run's
artifact), where no name exists yet.

**What else had to agree** The export carried the in-memory project, whose `metadata.content` is the absolute
URL an `<img>` needs, so a zip contained `http://127.0.0.1:8190/api/canvases/…` — the exact thing #152 forbids
in a document, and the reason an imported canvas displayed the *exporting* workspace's URLs until the next save
stripped them. The document is now built in one place (`frontend/src/lib/canvas/canvas-document.ts`) by both the save queue
and the export, and a zip carries no id, no rev and no URL.

**Cost** The gateway now accepts bytes at a name a client chose, guarded by the same name validation the read
route uses. A name that is taken is refused (`409`) rather than overwritten: a file's URL is its own ETag
(`immutable`), so overwriting one would leave every cache that has seen it showing the old bytes. Import is
unaffected — it always writes into a canvas it just created — but a "restore over an existing canvas" is not
something this route can do, and is not something the canvas offers.

**Tested** Go: `TestWriteFileKeepsTheNameAndRefusesATakenOne` (store) and
`TestAFileCanBeWrittenUnderANameTheDocumentUses` (route: write, read back the same bytes, second write 409,
escaping name 400, unknown canvas 404). Frontend: `frontend/tests/canvas-document.test.ts` — media named by reference,
nodes without metadata untouched, and only the five document fields in the result. Gates: `make check`,
`go test -race`, `npm run check`, `npx vitest run`.

**In the browser** Exported a canvas holding an image, deleted it, imported the zip: the canvas came back with
the same node, the file in `files/` kept the name the document names (`files/import-test.png`, no `up-` copy),
the bytes were identical, and `canvas.json` on disk contains no `http` at all. (The archive itself has since
become one canvas per zip — `manifest.json`, `canvas.json`, `files/` — see #172.)

**Superseded in part by #172** The route this entry introduced (`PUT /api/canvases/{id}/files/{name}`) is gone:
the gateway unpacks the archive itself now, so no client ever writes a file at a chosen name. What stays is the
finding — a file's name is the document's, and an import must not rewrite it.

**Where** `internal/canvas/files.go`, `internal/canvas/canvas.go`, `internal/server/routes_canvas.go`,
`frontend/src/services/canvas-files.ts`, `frontend/src/lib/canvas/canvas-document.ts`,
`frontend/src/lib/canvas/canvas-export.ts`, `frontend/src/stores/canvas/use-canvas-store.ts`.


## 172. One canvas, one zip, and the gateway unpacks it

**Decision** An export is one canvas: a zip holding `canvas.json` (the document), `manifest.json` (format and
title) and `files/<name>` (its media). An import is that zip POSTed to `/api/canvases/import`, and the gateway
creates a canvas, unpacks the archive into it and answers with the canvas. No id, no rev and no URL travel in
the archive, and the files keep the names the document uses.

**Why one canvas per archive** The previous format packed *several* canvases into one zip
(`projects.json` + `projects/<id>/files/…`), because the canvas list had a "export selected" button. That is a
batch format for a product whose unit is a canvas: it made the import dialog ask the gateway for N canvases, it
made "what does this file on disk belong to" answerable only by reading a JSON index, and it is why the word
"projects" leaked into a workspace that has only canvases. A zip that is exactly one canvas directory is also
the thing a person can unzip by hand and read.

**Why the gateway unpacks it** The client used to unzip (`fflate`) and PUT each file, and before that it wrote
the bytes back into IndexedDB — import has always been "put these bytes where the document says they are". Once
the media moved into the canvas directory (#156) the only write route named files itself, so the client had to
collect the new names and rewrite the document (#171). With the archive in one request the operation is what it
always was: unpack into the canvas. The client keeps no archive parser, and three consequences come with that:

- **The title comes from the manifest.** It is not part of the document (the gateway owns titles), so the
  archive has to say it somewhere.
- **The id is new.** The zip carries none; the exported canvas usually still exists in the same workspace, and
  a canvas id is a directory name.
- **Limits have to exist**, because this is user input: the body and the unpacked bytes are bounded by
  `MAX_IMPORT_BYTES` (8 GiB by default — a canvas archive carries every clip it shows), an archive holds at
  most 20 000 entries, and a `..` segment in an entry name is refused *before* cleaning — `files/../x.png`
  cleans to `x.png`, which no longer looks like a traversal.

**Cost** A failed import can leave nothing behind but also cannot be resumed: it is one request, so it is
either the canvas or an error (the canvas is deleted if a file fails to write). Old archives — the multi-canvas
format — are refused with a message saying to export them again, rather than carried forever. And unpacking
user archives is the one place this gateway parses a container it did not produce: `archive/zip` only, with the
rules above, no symlinks and no modes taken from the archive.

**Tested** Go: `TestImportingAnArchiveRestoresTheCanvasAsItWasExported` (document, title, file bytes and name),
`TestAnArchiveThatIsNotOneCanvasIsRefused` (old format, no document, `..` entry, not a zip — and no canvas left
behind), `TestAnImportPastTheLimitIsRefusedAndLeavesNothing` (413 with a 32-byte ceiling). Frontend:
`frontend/tests/canvas-document.test.ts` still pins the document that goes into `canvas.json`. Gates: `make check`,
`go test -race`, `npm run check`, `npx vitest run`.

**In the browser** Exported a canvas holding an image: the zip holds `manifest.json`, `canvas.json`,
`files/import-test.png`. Deleted the canvas, imported the zip: one request, the canvas came back with the same
node and title, the file kept its name and its bytes, and `canvas.json` on disk contains no `http`.

**Where** `internal/server/canvas_import.go`, `internal/server/routes_canvas.go`, `internal/canvas/files.go`,
`internal/canvas/canvas.go`, `internal/config/config.go`, `frontend/src/lib/canvas/canvas-export.ts`,
`frontend/src/services/api/canvases.ts`, `frontend/src/stores/canvas/use-canvas-store.ts`, `frontend/src/types/canvas-export.ts`,
`frontend/src/lib/canvas/canvas-document.ts`.


## 173. A generated file is the file the run wrote

**Decision** When a run finishes, the node references the artifacts where the run put them: `files/<name>`
inside the canvas, which is exactly the name `canvas.json` stores. Nothing is downloaded and nothing is
uploaded; the only thing read back is the media's own shape (a picture's size, a clip's duration), and a
browser reads that from the URL.

**What it replaced** Every generation ended with a round trip that made a second copy: the gateway wrote
`files/task_<id>.png`, the browser fetched it, turned it into a data URL, and posted it to
`/api/canvases/{id}/uploads` — which named it `up-<8 hex>.png` — and the node referenced *that*. Two files per
artifact (measured: three 1.0 MB images, three `task_*` and three `up-*` with identical sizes, document
pointing at the last three), one wasted transfer per artifact, and a document whose names depended on a second
write succeeding.

**Why it was there** `uploadImage` / `uploadMediaFile` is the canvas's one primitive for "put these bytes in
the canvas and give me a reference", written when the browser owned the media (IndexedDB) and every picture
had to be stored by the page. Generation was built on it before #156 moved media into the canvas directory;
after #156 the run was already writing the file, so the upload had become a copy of a copy. It stayed because
it worked — the same reason the import did (#172).

**What it changes for the user** One file per artifact instead of two, and a generation that finishes when its
last file is written rather than after a second upload. The names in the document are the run's
(`task_<id>[-n].<ext>`), so a canvas and its runs agree on what a file is called. The collector is unaffected:
a run record and the document are both roots, and once the document names the file it is the document that
keeps it alive.

**What it does not touch** Bytes the browser itself produces still go through the upload route, because they
have no name yet: a dropped or pasted file, a crop, a split piece, a painted mask, a captured video frame.
Reference media for a run is uploaded the same way — it is the user's file, not a run's output.

**Cost** A node's `content` is the run's own name, so an artifact keeps the run's spelling (`task_<uuid>.png`)
rather than a short one. Nothing renames files, which is the point.

**Tested** `frontend/tests/api-runs.test.ts` (a run's outputs become the document's names and the gateway's URLs),
`frontend/tests/api-image-runs.test.ts` (an upscale run's artifact is referenced, not fetched — the call list stops
at the run's status), `frontend/tests/api-video-runs.test.ts` (a clip's reference carries its size and duration, and the
artifact is never fetched). Gates: `npm run check`, `npx vitest run`.

**In the browser** Generated three 1024×1024 images from the canvas: `canvases/<id>/files/` held exactly three
`task_*.png` files and no `up-*`; the document referenced `files/task_*.png` in order with real dimensions and
byte counts; the images rendered; a reload rendered them again from the same names. The canvas was deleted
afterwards.

**And the shims went with it** Two branches existed only for documents written while the browser owned the
media: `resolveMetadataReferences` resolved `image:` keys, and `hydrateCanvasImages` uploaded a node's inline
`data:` picture on load, so that opening an old canvas rewrote it. Nothing this build writes has either shape
(the workspace was checked), so both are gone: an inline picture is shown as it is and left alone, which is
honest for a document no build can produce any more. `canvas-export.ts` lost the same dead fallback.

**Where** `frontend/src/lib/canvas/generated-media.ts` (new), `frontend/src/services/api/{runs,image,video,audio}.ts`,
`frontend/src/pages/canvas/hooks/{use-generation-runs,use-image-editors,use-video-editors}.ts`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/services/{image-storage,file-storage}.ts`,
`frontend/src/lib/canvas/canvas-generation-helpers.ts`.


## 174. A reference is named, not copied

**Decision** A run's media map takes the file a reference already is. A node's picture, a mask, an upscale
source, a reference clip — if it is a canvas file, its name goes into the request (`media: {image:
["task_<id>.png"]}`) and the run reads it from the same canvas. An upload happens only when the reference has
no file yet: a paste, a crop, a split piece, a data URL.

**What it replaced** Every reference was converted to a data URL and posted to `/uploads` before the run, so a
generation with one reference stored a second copy of it under an `up-<8 hex>` name — and again on the next
generation from the same node, once per run. The same bytes, once per attempt.

**Why it was there** The upload route is the canvas's "give these bytes a name" primitive, and it was the only
way media entered a run when the browser held the pictures. Since #156 a run's media is looked up *by name in
the canvas it belongs to* (`uploads.Get(canvasID, id)` reads `files/<name>`), so a name that already exists is
all a run needs. Nothing in the request changes shape: the id was already a file name.

**Cost** A reference whose file was collected (or deleted by hand) now fails as `upload_not_found` naming the
file, instead of silently being re-uploaded from whatever the page still had in memory. That is the honest
answer either way — the node was showing a picture whose file is gone — and the message names the file that is
missing.

**Tested** `frontend/tests/api-image-runs.test.ts`: a source with a `storageKey` produces exactly two calls (submit,
poll) and `media: {image: ["up-abcdef12.png"]}`, while a source with none still uploads first. Gates:
`npm run check`, `npx vitest run`.

**In the browser** Generated one picture, then upscaled it from the image toolbar: the canvas grew by one file
(the upscale's own output) and no `up-*` copy of the source appeared — the run's record shows
`media: {image: ["task_afa1632b-….png"]}`, the file the node was already showing.

**Where** `frontend/src/services/canvas-files.ts` (`mediaIdOf`), `frontend/src/services/api/image.ts`,
`frontend/src/services/api/video.ts`.


## 175. A cancellation is a value, not a sentence

**Decision** Every service rethrows a request the caller cancelled *as itself* (`throwIfCanceled`) before it
wraps an error into a sentence for the user, and the canvas decides "the person pressed stop" by the error's
name (`AbortError`). The agent's socket refuses an aborted turn the same way, instead of rejecting with a
translated sentence.

**What was wrong** `isGenerationCanceled` compared `error.message` against `i18n.t("common.requestCanceled")`
while the wrapping services produced `apiText("requestCanceled")` — a different dictionary key that happens to
hold the same words today. Change either string and stopping a generation would be reported as a failure and
paint the node red. The agent path was already wrong in a second way: an aborted turn rejected with the generic
"request failed" message, so a text node cancelled mid-answer showed an error and kept it.

**Cost** Two message constants (`apiErrors.requestCanceled`, `common.requestCanceled`) still exist, for display;
neither is load-bearing for control flow now.

**Tested** `frontend/tests/api-runs.test.ts`, `frontend/tests/api-video-runs.test.ts` and the generation hooks' own cases all
assert on `name === "AbortError"` paths; `npm run check` and `npx vitest run`.

**Where** `frontend/src/services/api/http.ts` (`throwIfCanceled`), `frontend/src/services/api/{image,video,audio,runs,agent}.ts`,
`frontend/src/lib/canvas/canvas-generation-helpers.ts`.


## 176. A dialog with no safe default cannot be dismissed

**Decision** The conflict dialog has no close button, its backdrop does nothing, and Escape does nothing. The
two buttons — load the disk copy, or keep this one — are the only ways out. `kit/dialog` grew
`escapeClosable` for it; the other dialogs are unchanged.

**What was wrong** `onClose` was wired to "use the disk copy", which is `window.location.reload()`. So a stray
Escape, or a click outside, silently answered "throw my changes away and reload" — the one answer that loses
work, chosen by accident. The close button sat in the header offering the same thing.

**Cost** A person who does not want to choose must reload the browser tab by hand (which is the same answer, but
deliberate), or pick one. That is the point: this dialog only exists because a decision is required.

**Tested** In the browser: two tabs on one canvas, both edited, the second save answered 409 → the dialog
appeared with only its two buttons; Escape left it on screen; "keep this one" saved this tab's document (rev
moved, the other tab's node replaced) and closed it.

**Where** `frontend/src/components/kit/dialog.tsx`, `frontend/src/components/canvas/canvas-conflict-dialog.tsx`.


## 177. The last save before a page leaves is sent with keepalive, when it fits

**Decision** The flush that runs on `pagehide` (`flushAll` for canvases, `flush()` for settings) asks the
transport to keep the request alive across the navigation. `http.ts` honours that only for a body under 60 kB —
Chrome's budget for in-flight keepalive bodies is 64 KiB and it *rejects* a request over it, so a bigger
document is sent as an ordinary request instead of a request that cannot exist.

**Why** A debounced save started as the page unloads is the one write that can be lost: the request is issued
and the document goes away under it. Keepalive is what tells the browser to deliver it anyway. The size line is
the part that has to be honest — a canvas document is usually a few kilobytes, and a document that inlined
media (16 MiB is the store's ceiling) can never travel this way.

**Cost** Two code paths to reason about (kept and not kept), and a threshold that a browser could change. The
alternative was pretending: `keepalive: true` on a 2 MB body fails the fetch, which is worse than a normal
request that usually still arrives.

**Tested** `frontend/tests/canvas-save-queue.test.ts`: `flushAll` marks its saves `keepalive`, a debounced save does not.

**Where** `frontend/src/services/api/http.ts`, `frontend/src/services/api/{canvases,settings}.ts`,
`frontend/src/lib/canvas/save-queue.ts`, `frontend/src/stores/{canvas/use-canvas-store,use-settings-store}.ts`.


## 178. A canvas's conversation is a file in the canvas

**Decision** The agent's conversation for a canvas is `<CANVAS_ROOT>/<id>/session.alaya`, handed to AlayaCore
as `--session`. The gateway reads exactly one thing out of a session name — the `canvas:` prefix and the id
after it (`frontend/src/services/api/agent.ts` is the other side of that contract) — and puts the file there.
A name that is not a canvas keeps no file: a node panel's question is one question, and its answer belongs to
the node. Nothing is migrated: no release has users, so there is no arrangement worth carrying.

**Why** A conversation is part of the canvas. Inside the directory it is deleted with the canvas, copied with
it, and found where somebody looking at the canvas would look. Before this it was `data/agent/sessions/
<session>-<hash>.session`, named after a session rather than a canvas: the UI had to remember to call
`DELETE /api/agent/session/...` before deleting a canvas, and every other way of deleting one (the API, a
script, a hand) left a file that nothing could attribute, on a disk nobody sweeps. Two such files were already
sitting in this workspace, for canvases deleted weeks ago. A file whose owner is a directory needs no second
lifetime rule.

**Cost** The conversation is not in an export. That is deliberate — a zip is the document and the media its
nodes point at — but it does mean a canvas that travels arrives without what was said about it. And the
gateway now knows the `canvas:` prefix exists, which the session registry otherwise does not: the alternative
was a second copy of the id in the socket URL, free to disagree with the name.

**Tested** `internal/canvas`: `TestSessionPathIsInsideTheCanvas` (the path is inside the canvas, asking for it
creates nothing, a missing canvas has none, deleting the canvas deletes the file). `internal/server`:
`TestSessionFileIsTheCanvasesOwn`, `TestDeletingACanvasTakesItsConversationWithIt` (a real socket, a real
conversation, one `DELETE /api/canvases/{id}`), `TestOneShotSessionKeepsNoFile`. By hand: the conversation of
the one canvas in this workspace was moved into `canvases/349b70cf4764/session.alaya` and the agent replayed
it on the next connection.

**Where** `internal/canvas/canvas.go` (`AgentSessionName`, `SessionPath`, `ValidID`),
`internal/server/agent_conversations.go`, `internal/server/{agent_config,routes_agent}.go`,
`frontend/src/services/api/agent.ts`, `docs/server.md`.


## 179. An image is stored, or it fails — never kept as an address

**Decision** `uploadImage` has one path: a `File`/`Blob` is stored as a canvas file, and a string is downloaded
first and then stored. The branch that returned `{url: input, bytes: 0}` when a remote URL could not be
downloaded but could be displayed is gone, and so is `IMAGE_REMOTE_LOAD_TIMEOUT_MS`.

**Why** That branch wrote an absolute `http://…` into the document, which is exactly what #152 removed and what
#174 replaced with a name the canvas serves. It was also unreachable in practice — every caller hands over a
`File`, a paste, a crop or a data URL — so it was a second way to produce a reference, kept alive by nothing but
the possibility of it. What it claimed to support cannot work: a URL this build cannot download is a node that
draws nothing after a reload, and a picture only the current browser can show is the blob era coming back.

**Cost** A URL behind an address this machine cannot reach fails loudly at the point of the node that wanted it.
That is the honest answer, and it is the same answer #174 gives for a canvas file that is no longer there.

**Tested** `frontend/tests/image-storage.test.ts`: a URL whose download fails rejects, with an `Image` stub that *would*
load, so the old branch would have resolved — the test fails against the previous code (`promise resolved instead
of rejecting`) and passes now.

**Where** `frontend/src/services/image-storage.ts`, `frontend/tests/image-storage.test.ts`.


## 180. One run is one picture, and a node holds one result

**Decision** Generating several candidates at once is gone, on both sides. A run produces one artifact
(`Runner.RunImage` returns the first image file, like `RunVideo`/`RunAudio` do for theirs), the gateway no
longer accepts `count`/`n` as inputs (`semanticInputs`, the typed `InputSpec`, `InputLimits.MaxCount`,
`MAX_IMAGE_COUNT`, the `BuildContext.Count` plumbing, and the four `count → batch_size` bindings in
`registry.json`), and a node holds one picture: `metadata.images[]`/`primaryImageId`/`count` are gone from
the document, so the node's own `content`/`storageKey`/`naturalWidth`/`naturalHeight`/`bytes`/`mimeType`
*are* the picture. All the UI that existed to manage a group went with it: the expand/collapse badges on the
card and in the side panel, the group thumbnails, set-primary, duplicate, download-per-image, per-image
retry and delete, the count control in the image settings popover and in preferences, and the words for
them in both locales.

**Why** A node was two things at once — an artifact and a set of artifacts — and every surface that pointed
at a node had to ask which one it meant: the agent's `read_node` could only reach the selected picture, a
reference taken from the node depended on `primaryImageId`, and "you can see it but you cannot say which"
is not a state a canvas should have. The feature also bought nothing in exchange: three images in one run
is one batch through the same GPU, so it costs three times the time of one and returns nothing sooner.
Candidates are a canvas question anyway — a text node and three image nodes fed from it is the same
comparison, with each picture a node somebody can point at (#181's other half).

**Cost** Comparing candidates is now several nodes rather than one click, and the text-node batch UI
(`texts[]`, "N texts") survives as the last of the pattern — it is unreachable from the UI (text generation
writes one text) and is the next thing to collapse into `content`. An old document that holds `images[]`
renders its `content`, which is the picture that was primary; the other files become unreferenced and the
startup collector sweeps them after its grace window.

**Tested** `make check` (the removal reaches `inputs_test.go`, `bindings_test.go`, `config_test.go`,
`runs_e2e_test.go`: `TestRunImageProducesOnePicture` asserts one output named `<run>.png`), `CGO_ENABLED=1
go test -race`, `npm run check` (i18n 893/879 keys — 11 dead keys removed), `npx vitest run`. In the
browser: a fresh canvas, an image node generated once, no group badge, no count control anywhere.

**Where** `internal/workflow/{inputs,bindings}.go`, `internal/generate/runner.go`, `internal/config/config.go`,
`workflows/registry.json`, `internal/server/routes_runs.go`, `frontend/src/lib/canvas/{canvas-node-factory,
canvas-generation-helpers,generated-media,canvas-document}.ts`, `frontend/src/pages/canvas/{project.tsx,
hooks/use-generation-runs.ts}`, `frontend/src/components/canvas/{canvas-node,canvas-side-panel,
canvas-image-settings-popover,canvas-node-hover-toolbar}.tsx`, `frontend/src/components/image-settings-panel.tsx`,
`frontend/src/stores/use-config-store.ts`, both locales.


## 181. The start script rebuilds a bundle older than its sources

**Decision** `./start.sh` compares `frontend/dist/index.html` with `frontend/src`, `frontend/public`,
`index.html`, `vite.config.ts`, `package.json` and `package-lock.json`, and runs `make frontend` when the bundle
is missing or older — before the gateway starts, so the gateway's write of `dist/config.js` still lands in the
file the browser reads first. In 46b1b08.

**Why** The rule was "the bundle is build output, so remember to run `make frontend`", and forgetting it is
invisible: the page loads, the old code runs, and a fix looks like it did nothing. That is not a rule worth
remembering; it is a rule that punishes remembering nothing. The build takes two seconds.

**Cost** Every start touches the filesystem, and a source tree whose mtime moved without its content changing
rebuilds a bundle that did not need it. Both are cheaper than a stale page.


## 182. The agent can delete a node, and point at one

**Decision** Two more MCP tools, both run by the page with the functions the user's own controls call:
`delete_node` is the Delete key (the node, and every connection that touched it), `focus_node` is a click
on a row of the side panel (the node is selected, and the view animates to it). Focus selects; there is no
select-without-moving.

**Why** The agent could build and never clean up. A wrong turn left nodes the user had to find and remove
by hand, and `create_node` puts a node in the middle of the view, so a canvas the agent filled up is a
canvas the user can no longer see. Naming a node in words — "the third image" — is exactly what the ids
`list_nodes` reports exist to avoid.

**Cost** `focus_node` moves the viewport the user is working in; the description says so, and it is the
only way an agent can point at something. Deleting takes an id, so a wrong id removes the wrong node — it
is one history step, the same Ctrl+Z as a deletion by hand, and like the Delete key it does not cancel a
generation already running in that node.

**Tested** `make check`, `go test -race`, `make verify-static`, `npm run check`, `npx vitest run`.
`TestMCPHandshakeIsEnoughToDiscoverTheTools` pins the nine names in order. In the browser (a `/tmp/verify`
copy on 8191/3001, the canvas agent connected, the real `comfyloft-mcp` bridge fed one call at a time into
`tools/call`): `create_node` twice, `connect`, `focus_node` — the view moved from the reset position
`translate(1131.6px, 738.8px)` to `translate(1261.6px, 718.8px)` and the node carried the selected class —
then `delete_node` on an unknown id (an `isError` answer naming it), `delete_node` on the image node
("deleted … and 1 connection that touched it"), `list_nodes` agreeing (1 node, 0 connections), the saved
`canvas.json` agreeing, and Undo bringing the node back / Redo removing it again.

**Where** `internal/server/routes_mcp.go`, `internal/server/mcp_test.go`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`, `frontend/src/pages/canvas/project.tsx`.


## 183. The agent is told to connect rather than copy

**Decision** Every spawn carries one `--system` line of the gateway's own (`canvasInstructions` in
`agent_instructions.go`, passed as `SpawnOptions.System`): the canvas is nodes and connections; before
making a node, use what is already there and connect it, because two copies are two things to keep in
step; and the viewport is the user's, so `focus_node` points at something instead of narrating. The two
descriptions that carry the same choice — `create_node` and `connect` — say it in one clause each.

**Why** A copy is a fork. Two text nodes with the same words drift apart the moment either is edited, and
two pictures with the same prompt are two generations to pay for and two results to tell apart, while a
connection keeps one source of truth — the canvas's own idea of reuse, which the user's gestures already
express. The agent had no reason to prefer it: it had a tool to make nodes and a tool to wire them, and no
sentence about which one applies. A tool description cannot say it (it explains one tool, not the choice
between two), and a skill is activated by reading it, which is precisely what has not happened at the
agent's first canvas move.

**Cost** A paragraph in every session's context, including a node panel's one-question agent that never
touches the canvas, and it is a default and not a guarantee: a model may still copy. The text is the
gateway's own and an operator cannot remove it (they can still add to it through `model.conf`), which is
the price of a rule the canvas tools do not work well without.

**Tested** `make check`, `go test -race`, `make verify-static`, `npm run check`, `npx vitest run`.
`TestArgsCarryTheSystemPrompt` pins the flag mapping, `TestAgentSpawnCarriesTheCanvasRule` pins that every
spawn carries the text. In the browser, with the real agent on the test instance: the startup frame
reported `MCP servers initialized: 1 servers, 9 tools loaded`, the process started and reached ready with
the flag in place, and asking "when you need what a node holds somewhere else on this canvas, do you
connect it or copy it, and why?" answered "I connect it rather than copy it, because a connection keeps a
single source of truth on the canvas — the source node's content flows directly to where it's needed, so
there's nothing to keep in step and no ambiguity about which version you meant".

**Where** `internal/server/agent_instructions.go`, `internal/server/routes_agent.go`,
`internal/server/routes_mcp.go`, `internal/agent/spawn.go`, `internal/agent/args_test.go`,
`internal/server/mcp_test.go`, `docs/server.md`.


## 184. The agent can move a node

**Decision** `move_node(nodeId, position)` puts one node's top-left corner where the tool says — the same
space `list_nodes` and `create_node` speak — and changes nothing else about the node. It is the page's
own end-of-drag outcome: a node whose centre now sits inside a group becomes a member of it, and one moved
out of a group stops being one.

**Why** The previous tool could make nodes where the view was looking and point at one, and nothing could
tidy the result: a row of nodes the agent made sits on top of the canvas the user was working in, and the
only way to separate them was to drag each one by hand.

**Cost** No collision test and no snapping: the corner stated is the corner the node gets, so a tool can
place two nodes on top of each other, and the drag's own "snap into the group" is not repeated. The user
can undo it — a move is a history entry like any other edit.

**Tested** `make check`, `go test -race`, `make verify-static`, `npm run check`, `npx vitest run`.
`TestMCPHandshakeIsEnoughToDiscoverTheTools` pins the ten names in order. In the browser (a `/tmp/verify`
copy on 8191/3001, its own `AGENT_CONFIG_PATH`, the real bridge fed one `tools/call` at a time): the
startup frame reported `10 tools loaded`; `move_node` moved an image node to `(640, -260)` — `list_nodes`
and the DOM transform (`translate(640px, -260px)`) and the saved `canvas.json` all agreed — a call with no
`position` answered `move_node needs a position: {x, y} in canvas coordinates` as an error, an unknown id
answered with the node lookup's own message, moving the node onto an empty group node set
`metadata.groupId` to it, and moving it back out cleared it.


## 185. The prompt box holds the user's words; the request is composed when it is sent

**Decision** Connecting a text node to an image (or video, or audio) node no longer copies its words into
that node's prompt box. The box holds only what the user typed. The connected text reaches the model where
it is an input: at send time, appended to the box as a labelled block (`【Text 1】\n…`, #78's labelling).
Nothing composed is stored back into a node — an in-place run keeps `prompt` as the user's words and
records the request in `sentPrompt`, which the panel shows on demand ("Sent 29 chars · show"). Generate is
enabled when there is anything to send: words in the box, or a text node connected to it.

**Why** Three mechanisms were adding the same sentence: the panel copied a connected text into the box, the
request appended every connected text, and an in-place run wrote the composed prompt back into the node —
which the panel then showed, and which the next run appended to again (the block grew by one per press). A
copy in the box is also the wrong idea about the line on the canvas: if the words appear in the box, the
connection is decoration, and editing them there forks them away from the text node the user is keeping.
The box is the node's own content, the connection is an input, and the disclosure is the honest place to
say that the two differ.

**Cost** An image node with an empty box made by a text node sends `【Text 1】…` to a model that did not need
the label — the label exists because there can be several texts, and dropping it for the single case would
be a second rule. The box is no longer a place to edit a copy of the connected text: editing happens in the
text node, which is the point. A document written before this keeps whatever a run used to write into its
`prompt`; nothing migrates it, so the box has to be cleared once by hand — the node's own title is left
alone in that case rather than being renamed after a request nobody typed.

**Tested** `npm run check` (i18n 897/883), `npx vitest run` (156, including five new cases in
`frontend/tests/canvas-generation-context.test.ts`: appended once after the box's words, whole request when the box
is empty, still appended when the box repeats the words, one block per text in connection order, nothing
when no text is connected), `make check`, `go test -race`. In the browser (a `/tmp/verify` copy on
8191/3001 with its own `AGENT_CONFIG_PATH`): `create_node` text + image, `connect` — the image node's box
stayed empty (`prompt` absent in `canvas.json`), References showed 1, Generate was enabled, and pressing it
submitted exactly `【Text 1】\na red ceramic teapot` (read back from the run's own request) and produced a
picture; the saved node then held `prompt: ""`, `sentPrompt: "【Text 1】\na red ceramic teapot"`, `title:
"Image"` (not renamed), and the panel offered "Sent 29 chars · show".

**Where** `frontend/src/components/canvas/canvas-node-prompt-panel.tsx`,
`frontend/src/pages/canvas/hooks/use-generation-runs.ts`,
`frontend/src/components/canvas/canvas-node-generation.ts` (unchanged by this: it already appended),
`frontend/tests/canvas-generation-context.test.ts`.


## 186. The agent's history can be thrown away

**Decision** The agent panel's header carries one more button (`canvas.agent.clearHistory`): it asks first,
then hands the session to `DELETE /api/agent/session/{session}` — the route that releases the agent and
deletes its session file — and reopens the socket. The next connection spawns a new AlayaCore, which finds
no session file and starts a new one; the transcript is drawn from the agent's own replayed history, so an
empty history is an empty panel.

**Why** A conversation is a working surface with a limit: a long one costs tokens on every turn and carries
mistakes into the next answer, and the only way to start over was to delete the canvas. The gateway already
had the half that matters — release the process, then remove the file, in that order, so nothing is left
writing what was just deleted (#183's route) — and the panel already redraws itself from `history`.

**Cost** Clearing mid-answer stops the turn (the release cancels it), which is what the confirmation is
for. The conversation is gone for good: no archive, no undo. A canvas that is never cleared keeps growing,
and one that is cleared leaves nothing behind to explain the nodes it made — the nodes are still there, and
that is the half that survives.

**Tested** `npm run check` (i18n 897/883: four new keys, none dead), `npx vitest run`, `make check`.
In the browser (a `/tmp/verify` copy, its own `AGENT_CONFIG_PATH`, the real agent): one exchange
(`X`→`ok`) left `canvas.json` and a 715-byte `session.alaya` next to it; pressing the button, confirming,
answered `DELETE /api/agent/session/canvas%3A…` 200, released the old process (`pid=374053`) and spawned a
new one (`pid=374193`), the file was gone, and the panel showed its empty state with no messages while the
canvas kept its two nodes and its picture. The next message wrote a fresh file whose first entry was that
new message, and the answer did not mention the earlier turn.


## 187. Clearing the history waits for an idle agent, and the gateway is what decides

**Decision** Clearing is refused while a turn is in flight, at both ends. The panel disables the button
(with a label that says why, `canvas.agent.clearHistoryBusy`), and the gateway refuses the request itself:
`Session.Busy` is set when a prompt is written and cleared where the turn ends, so
`DELETE /api/agent/session/{session}` answers `409 agent_busy` and changes nothing — no release, no
removal. The client asks *before* it closes its socket, so a refusal leaves the conversation exactly as it
was and the panel keeps working; only a delete that happened closes the socket and reopens a session.

**Why** Mid-turn, the words being written are the next entry of the file the button deletes — and the file
may not even exist yet, because the agent writes it as the turn ends: a delete now would remove nothing and
the turn would put the conversation back a second later. Releasing the session also cancels the turn,
which is a different act from forgetting a conversation and not one anybody asked for by pressing "clear
history". A client-side guard alone is not enough: the panel's idea of "busy" is its own state, and a
second tab, a reload, or a stale page would each have their own; the process's turn is the fact.

**Cost** A long answer has to finish (or be stopped) before the history can go. A refused delete is a
message in the transcript rather than a silent no-op, and the canvas-deletion path still closes its socket
either way (the directory is going away, so the process must not outlive it).

**Tested** `make check`, `go test -race`, `npm run check` (i18n 898/884), `npx vitest run`.
`TestDeletingABusySessionIsRefused`: a prompt the fake agent answers slowly, `DELETE` 300 ms in answers
`409 agent_busy`, the session file and the process are both untouched, and the same request after `done`
answers 200 and removes the file. In the browser (a `/tmp/verify` copy, the real agent): idle the header
read `Clear history`; one message in, it read `The agent is working — stop it or wait for it to finish` and
was `[disabled]` at +2 s and at +27 s while the answer streamed, and a direct `DELETE` against the gateway
at that moment answered `409 {"code":"agent_busy","message":"the agent is in the middle of a turn: stop it,
or wait for it to finish"}`; after `done` the button read `Clear history` again, and pressing it —
confirm, then `DELETE … 200`, release, new pid — left the file gone and the panel on its empty state.

**Where** `internal/agent/sessions.go` (`Session.Busy`, `Sessions.Busy`, `Send`, `pump`),
`internal/server/routes_agent.go`, `internal/server/agent_e2e_test.go`,
`frontend/src/services/api/agent.ts`, `frontend/src/components/canvas/canvas-agent-panel.tsx`, both
locales.


## 189. The bridge is found beside the gateway, on PATH, or nowhere honest

**Decision** `mcpBridgePath` looks for `comfyloft-mcp` in the order the agent's own binary is found
(`agent.findBinary`): `MCP_BIN`, then beside the gateway's executable, then `PATH`, and only then the bare
name. The startup warning that the bridge is missing asks `bridgeExists`, which treats a path as a file and
a bare name as something to look up — the same way the spawn will.

**Why** A gateway started with `go run` lives in a temporary directory that holds no bridge, and the
`mcp.conf` it wrote named a path inside that directory: every agent session after the run ended failed with
`handshake: EOF`, and the path in the file explained nothing. The beside-the-binary rule is right for a
release directory and wrong for every other way of starting this thing.

**Cost** A `PATH` hit can be a different build from the gateway's own; the bridge checks the protocol
version it speaks in every call (`X-Comfyloft-Bridge`), so a mixed pair says so instead of misbehaving.

**Tested** `go test ./internal/server/ -run TestBridgePath`: a `PATH` holding a bridge is found by a test
binary that has none beside it (which is what `go run` looks like), and `MCP_BIN` still wins. The existing
MCP tests (which go through `writeMCPConf`) still pass.

**Where** `internal/server/agent_config.go`, `internal/server/agent_config_test.go`.


## 191. The left column: one width, three stacked boxes

**Amended by #195** The middle box holds two lists now — the canvases in the workspace and the nodes in this
one — behind a switch at its top, and the height it opens to is `CANVAS_COLUMN_HEIGHT`, the same three
numbers this entry declares. The widths, the gutters and the one-client-of-the-number rule are unchanged.

**Decision** The bar at the top left, the side panel and the zoom dock are one column — same width, same
left edge, same radius, same shadow — and they are *stacked*: the bar on top, the panel under it, the dock
at its foot. The panel's bottom edge *is* the dock's height plus the two gaps (`CANVAS_ABOVE_DOCK_BOTTOM`),
so opening the panel shortens the panel and moves nothing else. The canvas name sits at the right end of the
bar (`ml-auto`), so the column has one left edge *and* one right edge. It answers a hover by dimming, with
no box and no underline: a 10% white pill on a translucent bar reads as a border, and the name is the bar's
title before it is a button. The divider that used to stand in front of the name is
gone with the move: it separated the name from the icons it sat against, and at the far end there is nothing
to separate.

The width is the panel's `width` in `use-canvas-side-panel-store` (280 to start, 220–480), so the drag
handle on its right edge resizes the whole column. `useCanvasChromeWidth()` hands it over as a CSS length,
`min(<width>px, calc(100vw - 300px))`: the same clamp for all three, so a window too narrow for the column
and the bar on the right shrinks them together instead of squeezing one. The drag starts from the width on
screen rather than the stored one, so the clamp cannot leave a dead zone under the cursor.

`CANVAS_CHROME_GUTTER`, `CANVAS_CHROME_GAP`, `CANVAS_ZOOM_DOCK_HEIGHT` and
`CANVAS_TOP_BAR_ROW` live in the same module as that hook, because the panel's bottom is the dock's
height plus two gaps: a panel that guessed would overlap the dock or leave a hole that moves with the
window.

The minimap hangs off the compass button that opens it: the same left edge, the column's width, and its
bottom on `CANVAS_ABOVE_DOCK_BOTTOM`, so it appears directly above the dock the way a menu appears above its
trigger. It used to be pushed out of the panel's way and sized 240×160, which left it floating in the middle
of the board at a width of its own — a third version of this entry, from the same two screenshots. Its box is
a clamped CSS length, so the map is drawn from the box it *measured* (`ResizeObserver`), not from a constant:
the only thing that knows what a `min()` came out as is the element.

`useSidePanelInset` — the step-over rule — is gone with it: nothing on the board sits beside the panel any
more.

**Why** Three boxes on one edge at three widths read as three unrelated panels. And the first version of
this got the stacking wrong: it kept the old rule that pushes the dock out of the panel's way (`left =
width + gap`), which on a 740px-wide window left the bottom-left corner empty and put a full-width dock in
the middle of the board. That is a staircase, not a column — the screenshot that came back showed it, and
this entry is the second version.

**Cost** The bar at the top, the dock and the minimap now take the panel's width, so a wide panel makes them
wide: at 480 the bar has slack and the dock's slider stretches, and the minimap is a wide letterbox rather
than a map-sized square. Below `100vw - 300px` the column stops shrinking the way it was dragged: the boxes
stay equal, but they are narrower than the stored number until the window grows or the panel is dragged in.

**Tested** `npm run check`, `npx vitest run`, `make check`. In the browser (`/tmp/verify`, 8191/3001),
measured with `getBoundingClientRect`, three window sizes: 573px viewport with 348 stored — bar, panel and
dock all 12 → 285 (273 wide, clamped), right bar 297 → 561 inside the window; 709px viewport with 480
stored — all three 12 → 421 (409 wide, clamped), right bar intact; a 740px viewport at 348 — all three
12 → 360 (348, unclamped), the panel ending at 574 with the dock at 582 → 638, so one 8px gap, and the dock
sitting in the bottom-left corner. The minimap measured 12 → 360 at 348 (348×160), its bottom on the panel's
(534) and 8px above the dock, and a click at its centre moved the viewport rect (120,80) → (118,30), so the
hit-testing follows the measured box. Dark and light, panel open and shut, minimap open with the panel open
and shut.

**Where** `frontend/src/stores/canvas/use-canvas-side-panel-store.ts`,
`frontend/src/components/canvas/canvas-side-panel.tsx`,
`frontend/src/components/canvas/canvas-top-bar.tsx`,
`frontend/src/components/canvas/canvas-zoom-controls.tsx`,
`frontend/src/components/canvas/canvas-mini-map.tsx`,
`frontend/src/components/canvas/canvas-refresh-shell.tsx`.


## 192. Canvas content goes under the chrome, and only popovers go over it

**Decision** The board has one layering order, and it is about what a thing *is*, not what it is attached
to:

| z | what |
| --- | --- |
| 0 | the stage (nodes, node-internal chrome: its own `z` values are local to the transformed layer) |
| 40 | the selection lasso |
| 45 | the node hover toolbar and the selection's group/sync bar |
| 50 | the top bar, the zoom dock |
| 58 | a generating node's charge ring |
| 60 | the side panel |
| 70 | the minimap — a popover on the dock button, and the one thing above the panel |
| 80–120 | context menus, create menus, the hover preview, the mention list |
| 1200 | a node's image / video / audio settings popover — a canvas layer, the last one below the frame |
| 1300–1301 | dialogs (`kit/dialog.tsx`): overlay, then frame |
| 1400–1401 | confirmations (`kit/confirm.tsx`) |
| 1500 | everything portalled *out* of a popup: select lists, menus, tooltips, the brush ring |
| 3000 | the gateway reconnect banner |

The rule that makes the table usable: **a layer the user opens from another layer has to outrank it.** A
list portalled to `body` is a sibling of the dialog that opened it, not a child, so it cannot inherit the
dialog's number — which is why 1500 is one number shared by every portalled popup instead of a choice per
call site (#194). The 1200 row is the exception that proves it: those three popovers are opened from a node
panel and never from a dialog, and a sweep of every `<Dialog` in the tree found no portal below 1300 inside
one — the prompt editor's dialog is a textarea and a reference bar.

The two node toolbars were at 70 and the lasso at 65, so a node slid under the side panel while its white
toolbar stayed on top of it: a tool floating in the middle of the panel, attached to nothing.

**Why** A node's toolbar is part of the node — it is the node's own affordances, drawn one gap above it. The
panel is a board laid *over* the canvas, so anything that belongs to the canvas is under it, and a toolbar
that outranks it is the layering telling the user something untrue. The same rule puts the toolbars under the
top bar and the dock: chrome is the frame, and the frame wins.

**Why the minimap is the exception** It is not part of the canvas and not part of the column either — it is a
popover opened by the compass button, and it sits exactly where the panel is when the panel is open. Under
the panel it would look like a button that does nothing.

**Cost** A node parked under the panel loses its toolbar with it: to use the toolbar you bring the node back
into view. Nothing else changes hands.

**Tested** In the browser (`/tmp/verify`, 8191/3001), a text node created at the panel's edge and left
selected: `getComputedStyle` says panel 60, toolbar 45, and at a point inside both `elementFromPoint` returns
the panel, while a point on the toolbar's free half still returns the toolbar. The selection bar and the
lasso share that parent and those two numbers.

**Where** `frontend/src/components/canvas/canvas-node-toolbar.tsx`,
`frontend/src/components/canvas/canvas-selection-toolbar.tsx`.


## 194. A dropdown's list outranks the dialog that opened it

**Decision** The listbox in `kit/select-primitive` sets `z-[1500]`, and no caller passes a layer of its own any
more: `model-picker` (both pickers), `kit/select` and `agent-settings-controls` lost theirs. 1500 is the app's one
floating-layer number — above dialogs (overlay 1300, frame 1301), above the canvas panel (60) and its menus
(80–120), shared with tooltips and `kit/floating` menus.

**Why** The list is portalled to `body`, so it is a *sibling* of the dialog that opened it, not a child. The two
default-model pickers in the Preferences window passed `z-[1200]`, and `cn` is tailwind-merge, so that number
replaced the primitive's: with the overlay at 1300 and the frame at 1301, opening a picker drew its options
behind the window, under a 45%-black scrim. The trigger flipped to open, nothing was visible or clickable, and
the report was "the default image and video models cannot be chosen". Every other select in the app was fine
because `kit/select` carried 1500 itself — which is exactly why only those two were broken, and why the number
belongs to the primitive: a caller cannot know what layer it will be opened from, and this one went stale the
moment the dialog's own numbers moved to 1300/1301.

**Cost** A dropdown opened from a dialog now paints over a confirm dialog (1400/1401) if one opens while it is
open. Nothing opens a confirm from inside an open listbox — selecting an option closes it.

**Tested** In the browser (`/tmp/verify`, 8191/3001, its own data directory): `bsk` opened Preferences, clicked the
default image model, saw the list render its six options, and choosing "MOSS Balanced fast 8-step" changed the
trigger from "Z-Image Turbo" to that label — the list is above the dialog and takes the click. The video picker's
list opened with the four H3 workflows. `tailwind-merge` resolves both callers' class lists to `z-[1500]`
(checked directly), the built bundle contains no `z-[1200]`, and `tsc --noEmit`, `npm run check`, the 155 tests
and `npm run build` all pass.

**Where** `frontend/src/components/kit/select-primitive.tsx`, `frontend/src/components/kit/select.tsx`,
`frontend/src/components/model-picker.tsx`, `frontend/src/components/canvas/agent-settings-controls.tsx`.


## 195. The left column has two lists, and the panel opens downward

**Decision** The workspace's canvases and this canvas's nodes are two sections of one left column
(`CanvasSidePanel`), one at a time, behind a switch at the top; the section is stored
(`canvas-side-panel-section`) beside the width and the open flag. The 1000×760 `canvas-manager-dialog`, its card
and its one-boolean store are gone.

- **Both lists stay mounted**, the inactive one `hidden`: switching back finds its search box, filter and
  selection where they were — cheaper and more honest than lifting seven pieces of list state into a store.
- **A row, not a card** — title, updated time, a tick for the canvas you are in, and a `⋯` menu with export /
  rename / delete. At 220–480px, three 12px glyphs is all that fits .
- **Delete all became select-all**: one button that deletes a whole workspace in a 280px column is a trap, and
  the same place is still reached through the same confirmation.
- **It opens by height from its top edge** (`height: 0 → calc(100dvh - 140px)`), content pinned to full height
  so the reveal clips it. A `translateX` keeps the list's top edge still and slides the box *through* it; `scaleY`
  squashes every row on the way down; `height` costs nothing outside the box because the panel floats over the
  canvas (#98). This replaces #98's sideways slide, by request.
- **Nothing paints while it is shut**: at `height: 0` the box's own border still drew 1.6px across the canvas, and
  `overflow: hidden` cannot clip a border — so it leaves with `visibility: hidden` on a transition delayed by the
  animation's duration (zero on the way in, or there would be nothing to grow), and `inert` covers the collapsing
  frames.
- **The elements list's search reads the words a node holds** (`nodeWords()` in `node-prompt-field.ts`). It
  searched `content`, which for a picture is a file name — so "png" matched every image — and missed
  `composerContent`, the box the panel actually shows. A search that finds nothing now says "no nodes match", not
  "no nodes on this canvas".

**Why** The window was the last surface that had to be summoned and dismissed, and the only list living outside
the column that exists for lists. Its two questions are not one question — "which canvas am I in" is a place,
"which node is this" is a thing — so one *surface* with two sections keeps both one click away. Replacing the
elements list instead (the first shape of the request) was the thing not to do: it is the only name-based
navigation on a board bigger than the window, the only multi-select export, and its hover preview is how four
similar pictures are told apart.

**Cost** Titles truncate where they wrapped, deleting everything is two clicks instead of one, `height` relayouts
rows for 240ms during the reveal, and the section is a stored preference: a second browser opening the same
workspace starts on Elements.

**Amended by #198** Picking a canvas no longer switches the column to Elements: the board behind changes, and
watching it change is how a pick is checked.

**Where** `frontend/src/components/canvas/canvas-side-panel{,-canvases,-elements,-parts}.tsx`,
`frontend/src/stores/canvas/use-canvas-side-panel-store.ts`, `frontend/src/lib/canvas/node-prompt-field.ts`,
`frontend/src/components/canvas/canvas-top-bar.tsx`.


## 196. The canvas menu holds this canvas's commands

**Decision** The menu on the canvas's name is about the canvas on screen and nothing else: the four sections it
already had (New, Edit, View, then export current canvas and clear canvas), and no workspace commands. Its list
of every canvas is gone, and so are **Rename**, **New canvas** and **Delete current canvas**. Switching happens
by clicking a row in the left column; renaming and creating and deleting are the `⋯` menu on a row of that list,
which is also where the count and the selection are (`canvas-side-panel-canvases.tsx`, #195).

Two consequences moved with them:

- **Deleting the canvas you are standing on** was the one workspace command with consequences the list could not
  see: it forgot the canvas as "the last one opened" and told the gateway to drop its agent conversation. That
  handling now lives in `canvas-delete-projects-dialog.tsx`, which is the only thing that deletes canvases and
  already had half of it. Deleting the current canvas still navigates away — to `/canvas`, which the router
  resolves to whatever the root route would open next.
- **The title stopped being an editor.** The top bar's inline rename (a draft, an `autoFocus` input, a
  pointerdown-outside listener) is gone; renaming is the row's input, which already existed and already saves
  through `renameCanvas`.

**Why** A menu labelled with one canvas's name that then offers to rename it, replace it or leave it is a menu
whose scope you have to read item by item. The name identifies a canvas; the list of canvases is a different
place, and since #195 it is a place rather than a popup — the one surface in the app meant for "which canvas?".
This is the same split as the column's two sections: the workspace's commands live with the workspace's list, the
canvas's commands live on the canvas. It also removes a second implementation of rename, which is the one that
had drifted (the bar's editor had no failure path and saved on blur; the row's has Enter/Escape).

**Cost** Reaching the canvas list from a shut column is two clicks through the column's switch instead of one
through a top-bar button (that button is gone too, #197). Renaming a canvas now requires opening the column, and
deleting one is two gestures (row menu → Delete, or select → Delete).

**Tested** In the browser (`/tmp/verify`, 8191/3011, its own data directory): the menu opened from the title
holds exactly the four sections and 18 items — Text, Image, Video, Group, LoRA card, Upload files, Undo, Redo,
Center focus, Delete selected, Select, Move, Dots, Lines, Blank, Image info, Export current canvas, Clear canvas
— with no canvas names, no Rename, no New canvas and no Delete. The title is no longer an input: clicking it opens
that menu. `npm run check` (i18n 823/809; `canvas.switchProject`, `canvas.deleteCurrent`,
`canvas.deleteCurrentTitle`, `canvas.deleteCurrentDescription` and `canvas.projects` are gone,
`canvas.menu.title` is new), `npx vitest run`, `npm run build`.

**Where** `frontend/src/components/canvas/canvas-top-bar.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/components/canvas/canvas-delete-projects-dialog.tsx`, both locales.


## 197. One button opens the column, and its icon is the geometry

**Decision** The top bar's left column has one button. The grid button beside the panel toggle — "My Canvases",
which opened the column on its canvas list — is deleted, and so is the store's `openSection`, which existed only
for it. The toggle opens the column on whichever list it was left on, and the switch inside picks the other.

The icon changed with it, from `PanelLeftClose`/`PanelLeftOpen` to `PanelTopClose`/`PanelTopOpen`. The old pair
draws an arrow pointing left, which described the sideways slide the panel stopped doing in #195: its top edge is
the hinge, so it folds *up* into the bar and unfolds *down* from it, and the icon should say so.

**Why** Two buttons that open the same box on two different tabs is one control too many, and the wrong half of
the pair wins depending on which mode you are in — with the column shut, both of them open it, so which one you
press decides which list you get. The section is remembered, so the one button is enough: the list you use is the
list you get back.

**Cost** The canvas list is one click further when the column is shut on the elements section. This is the same
cost #196 records, and it is the price of one column with one way in.

**Tested** In the browser: the top bar's left bar holds the panel toggle and the title, nothing between them; the
toggle's SVG class is `lucide-panel-top-close` open and `lucide-panel-top-open` shut, with the tooltips "Collapse
panel" / "Expand panel". `npm run check` (i18n: `canvas.projects` removed, no dead keys), `npx vitest run`,
`npm run build`.

**Where** `frontend/src/components/canvas/canvas-top-bar.tsx`,
`frontend/src/stores/canvas/use-canvas-side-panel-store.ts`, both locales.


## 198. The canvas list does not move under the pointer

**Decision** The rows of the canvases list are ordered by when each canvas was **created**, newest first, and
picking one changes only which row is highlighted. The comparator is `byCreatedAtDesc`, which replaces
`byUpdatedAtDesc` (the same instant-vs-text parse, reading `createdAt` instead).

**Why** The list sorts itself by `updatedAt` from the gateway, and every edit — including the autosave of the
canvas you are looking at — bumps that, so the row under the cursor kept jumping to the top: you go to click the
second canvas in the list and it is now the first. A list that reorders itself while you use it is a list you can
misclick, and "recently worked on" is a property of *your* session, not of the canvas — the ordering hint the rows
already carry is the updated time printed under the title, which is enough.

**Cost** A canvas you just edited does not move to the top, so "the one I was working on" is found by reading the
times rather than by looking at the first row. Creating a canvas still inserts at the top, because creation is an
explicit act and the new canvas is where you are taken.

**Tested** `frontend/tests/last-canvas.test.ts` gained "the last write does not move a canvas", which sorts two canvases
whose `updatedAt` contradicts their `createdAt` (156 tests). In the browser: with two canvases, clicking the
second row changed the route and the highlighted row and left the row order `[Canvas 2, Canvas 1]` exactly as it
was.

**Where** `frontend/src/lib/canvas/last-canvas.ts`,
`frontend/src/components/canvas/canvas-side-panel-canvases.tsx`, `frontend/tests/last-canvas.test.ts`.


## 199. The list's header row has a height of its own

**Decision** Both lists in the column draw their header through one component, `PanelHeaderRow` — 32px of fixed
height, contents centred inside it — instead of a `div` whose height came from whatever was in it.

**Why** The row's contents change while it is being used, and they are not the same height as each other: the
type filter's "All" box is `h-7` (28px), the ghost buttons beside it are 24, the count is 16, and pressing
**Select** takes the "All" box away. So the row was 28px with the box and 24px without it, and everything below
it — the search box, every row — moved four pixels down and up again with each press. That is the flinch the
report described. It is also why the two sections' rows are now the same: the canvases list's row was built from
28px icon buttons, so switching tabs moved the list by the difference.

Keeping the "All" box mounted and hiding it was the other way to stop the movement, and it is worse: it leaves an
80px hole in a row that select mode needs for nothing, and it fixes only that one control, not the count, not the
next thing added, and not the difference between the two sections.

**Cost** The row is 32px where it used to be 24–28, so the list starts four pixels lower. A future control taller
than the row would overflow it rather than stretch it — the row is the fixed thing, and the fix for that is to
raise the number in one place, which is also the point.

**Tested** In the browser (`/tmp/verify`, 8191/3011, its own data directory), measured with `getBoundingClientRect`:
the elements list's visible header row is 32px and its search box sits at y=154 in all three states — before
pressing Select, in select mode with the "All" box gone, and after cancelling — and the canvases list's header is
also 32px at y=111, so switching tabs no longer moves the list either. The "All" box itself measures 28px, which
is the four-pixel difference the report was seeing. `npm run check`, `npx vitest run`, `npm run build`.

**Where** `frontend/src/components/canvas/canvas-side-panel-parts.tsx`,
`frontend/src/components/canvas/canvas-side-panel-elements.tsx`,
`frontend/src/components/canvas/canvas-side-panel-canvases.tsx`.


## 200. A rename has a button that finishes it

**Decision** The row that turns into a field in the canvases list carries a tick and a cross beside the input.
The tick commits, the cross throws the edit away, and Enter and Escape still do exactly what they did — the
tick and the cross are the same two actions, drawn. An empty field disables the tick.

**Why** Enter was the only way to finish a rename, and nothing on screen said so. The menu says **Rename**, the
row becomes a field, and then the one way out of it is a key on a keyboard the user is not looking at. A
control that can only be finished by a shortcut is a control most people will abandon, having already typed
the new name.

**Why a cross as well** Because Escape was the other invisible key. Without it, a user who cleared the field —
the state the tick refuses — has no visible way to say "never mind" and only the escape hatch they were never
told about, so the row would sit there as a field forever.

**Why an empty field is refused rather than taken as a cancel** `renameCanvas` already trims and returns on
nothing, so committing it would close the editor having changed nothing, which reads as "it worked" while the
canvas still has the old name. The tick is disabled in that state and Enter does nothing either, so the two
agree; the name is one cross away, and a name is not something to lose to a stray select-all.

**Why the row's height is pinned in the same change** The editor is a 32px input where the display row is a
title and a date, so entering rename made the row 8px shorter and pulled the rows under it up with it — the
same flinch #199 removed from the header row, one row lower down. `h-13` (52px) is the height the row already
had in every other mode it can be in, now stated instead of inferred.

**Cost** 52px is a number in the markup, and a row asked to hold more than that would overflow rather than
grow — the fix is the number, in one place, which is the point. Two more tab stops in a rename, and a green
the rows do not otherwise use, borrowed from `Text`'s success tone so it is not a new one.

**Tested** In the browser (`/tmp/verify`, 8191/3011, its own data directory), both themes. Renaming **Beta**
through the tick and reading `GET /api/canvases` → the canvas answers `Gamma`, so the click really saves;
typing "Discard me" and clicking the cross leaves `Gamma` and writes nothing; clearing the field reports
`button "Confirm rename" [disabled]`; Enter from the field still commits (`Gamma two`) and Escape still leaves.
The list holds still: the current row measured 65 device pixels at ratio 1.25 — 52 CSS px — both before the
editor opened and while another row was in it (it was 44px, 55 device pixels, with the editor open before this
change). `npm run check` (zh 825 / en 811 keys), `npx vitest run`, `npm run build`.

**Where** `frontend/src/components/canvas/canvas-side-panel-canvases.tsx`,
`frontend/src/i18n/locales/zh-CN.ts`, `frontend/src/i18n/locales/en-US.ts`.


## 201. The agent's models are edited through the agent, and the key stays on the gateway

**Decision** The preferences window has an **Agent models** section: one row per model the agent announces (name,
protocol, what it points at, its key as six dots), a pencil and a cross, and **Add model** opening a form (name,
model id, URL, protocol, API key). Every change goes to the agent as its own `:model_sync` carrying the whole
list, which the gateway completes before the agent sees it.

**Why through the agent** `model.conf` is AlayaCore's file, and #75's rule stands: the format (`protocol_type`,
`reasoning_0/1/2`, `serial_tool_calls`, …) belongs to the agent, so the editor writes through the command plane
rather than parsing and re-emitting that file from Go.

**Why the gateway completes the list** `:model_sync` replaces *every* model and rewrites the file from what it was
given, while `SM model_list` carries every key in cleartext and the gateway strips them (#75's whitelist).
Forwarded as-is, removing one model would delete every key on the machine, plus every `reasoning_N` block beside
them. So the gateway keeps each announced entry **whole** (`modelObject`, the raw JSON), the canvas says which ids
stay and what changed, and `Session.mergeModelSync` rebuilds the rest — which is also why a field AlayaCore adds
tomorrow survives a round trip through a page that has never heard of it. Ids are rewritten to the models'
positions, because that is what `:model_sync` assigns and what the canvas's later `model_set` must use. An empty
key field means "keep the stored one": the page cannot see the key, so it is in no position to mean it away, while
a typed key is how one is rotated.

**Why the other sessions are told** `model.conf` is one file for the host and every agent process reads it into
its own memory at startup, so a list written through this window would leave another session's picker offering a
deleted model and missing an added one until that process was replaced. `Sessions.ModelSync` hands the list it is
about to write to every other session; their `active` model is their own and is left alone.

**Why the write is atomic, and whose job that is** AlayaCore's: `modelManager.writeConfigFile` goes through
`internal/atomicfile` — sibling temp file, fsync, rename — so a reader sees the old list or the new one, and an
interrupted write cannot truncate the only copy of a key. The gateway never writes that file; the one it does
write, `mcp.conf`, is installed the same way.

**Why the log redactor learned a second spelling** This is the first frame the gateway itself writes that carries
a *complete* list, keys included. `redactKeys` matched `"api_key":"…"` — a field in a frame — while `:model_sync`'s
argument is that list as a JSON **string**, so its keys are escaped (`\"api_key\":\"…\"`) and went into the
transcript in cleartext. Found by pointing the transcript at a canary key and grepping it
(`TestRedactKeysReachesInsideAnArgument`).

**Why a dialog rather than five inputs under the list** Inline was the first shape and it read as a row of inputs
nobody reads: a model is a small document. The list stays a list; the form appears when there is a form to fill.

**Cost** One session per open preferences window (the list is the agent's, so it must be asked), and the list is
as fresh as that session's start — a `model.conf` edited outside the app is invisible until the window is
reopened. A rejection leaves the other sessions holding a list slightly ahead of the file until their next start,
and the rejection is shown in the agent's own words. Six dots say a key exists, never that it is the right one.

**Measured** With a two-model fixture on an isolated `:8191`: adding wrote a third entry with its key; editing
renamed the first and left its `api_key`, `max_tokens` and `reasoning_1` in place; retyping only the second model's
key changed only that key; deleting the middle model left the other two intact; the panel's picker offered the
model added a moment earlier with no reload. `stat -c %i` reported a different inode after an edit — a rename,
not a truncate — and no `.tmp-*` file was left. Canary: a `model.conf` whose two keys exist nowhere else, a real
AlayaCore, 8 frames / 1175 bytes captured across a set, an edit-less list write, an add and a prompt — no canary in
any of them, nor in any HTTP route the page can reach, nor in the gateway's own log.

**Where** `internal/agent/{models,events,run}.go` (`Session.mergeModelSync`, `Sessions.ModelSync`),
`internal/server/routes_agent.go`, `frontend/src/components/settings/agent-model{s-section,-dialog}.tsx`,
`frontend/src/lib/agent-models.ts`.


## 202. The workflow list has one frame, not three

**Decision** Only the top level of the resource panel is drawn as a frame. A pack is still a bordered card; the
workflows inside it are filled blocks — emerald while the workflow is in the model picker, plain while it is
hidden — and the resources inside a workflow are rows divided by a hairline on that same fill. `ResourceCard`
and the inline "run this yourself" command block lost their borders the same way, keeping a fill. The pulsing
emerald ring on an enabled workflow (`workflow-active`, a `box-shadow` animation that drew a second border) is
gone, together with its keyframes.

**Why** The panel was a column of boxes inside boxes: pack card, workflow card inside it, resource surface inside
that, each with its own 1px outline and the innermost one the smallest of the three — so the loudest frames were
the ones carrying the least. Three outlines around fifteen rows of text also made the list hard to scan: what a
row *belonged* to was stated in three places at once. One frame plus fills says the same thing with fewer marks,
and the frame that remains is the one that groups the most.

**Cost** The enabled/hidden distinction now rests on a fill rather than an outline, so it is weaker in a
screenshot printed in greyscale — the `Enabled` / `Hidden` label and the muted name still carry it, and 40% of
`emerald-950` in the dark theme keeps it legible on the screen. The extent of an expanded workflow is implied by
the edge of its fill instead of drawn; nothing marks the group when the tints are turned off by a display filter.

**Tested** `npm run check` (zh 845 / en 831 keys, no dead ones, exports clean, prettier, `tsc --noEmit`),
`npx vitest run` (22 files, 165 tests), `npm run build`. In the browser (`/tmp/verify`, gateway 8191 and canvas
3011 on its own data directory, the real `resources.json` index so the packs and their rows are the ones the
report was about) in dark and light, collapsed and expanded, with one workflow enabled and one hidden: the pack
card is the only frame: the collapsed list of seven packs, the expanded pack, the expanded workflow with its four
resource rows and a hidden workflow beside two enabled ones were screenshotted before and after and compared.

**Where** `frontend/src/components/settings/resource-center-panel.tsx`, `frontend/src/styles/globals.css`.


## 203. A prompt is said once: the box or the text node, never both

**Decision** The always-on canvas prompt gains a fourth rule — *a node's own prompt is the user's words; a text node
connected to it is an input, and its words are added to that prompt when the node generates; so when a text node
already holds what a node needs, leave that node's own prompt empty and connect it* — and `connect`'s description
gains the mechanism rather than the policy: "a text node's words are added to the target's own prompt when it
generates, so a target that already says them in its own prompt would say them twice". The agent's own `connect` and
`set_prompt` answers then name the state, in the reply that made it: `… already says text-…'s words in its own
prompt, so generating it would send them twice — clear it with set_prompt ""`. One helper computes that
(`repeatedConnectedText`, in the module that already knows what feeds a node) and two call sites ask it.

**Why** Because the agent re-made the bug #185 removed from the UI. Canvas `3df8b7a65088` holds the evidence:
`read_node` + `list_nodes` (one text node), three `create_node` calls carrying `"prompt": "宫崎骏吉卜力风格插画：一片
纯净茂密的森林全景"` — the text node's words, copied in at creation — three `connect`, three `generate`. The saved
nodes keep both halves: `prompt` is those words and `sentPrompt` is `宫崎…\n\n【Text 1】\n宫崎…`, so every picture was
asked for the same thing twice. It was not doubt that made it copy: its reasoning says "That's fine—since the text
node is connected to the image node, the content will flow through the connection", so it believed the copy was
harmless. #185 decided this exact rule and its Where list named only frontend files: the UI stopped copying, and the
half of the system that *writes* through tools was never told.

**Why not a skill** A skill is activated by reading it, and this agent read nothing: its first move was a tool call.
The rule has to be true from the first token, which is what `canvasInstructions` is for (#183, #184);
`h3-prompt-writing` is the opposite case — deep reference for one task and no other.

**Why a note and not a refusal, and not a silent rewrite** The canvas allows this state: a user can drag a text node
into a node whose box already says the same words, and #185's test deliberately keeps that composition "still
appended when the box repeats the words". A tool that refused would be a second policy dressed as a tool, and one
that cleared the box would be the canvas guessing intent. The note is the honest third option: the connection is
made, and the agent is told what it built while it can still undo it. `create_node` and `generate` were left alone on
purpose — a new node has no connections, so the mistake cannot be created there, and a third copy of the same
sentence is sediment.

**Cost** Discouraged, not impossible: a model that ignores the note still sends the doubled request, and the user
sees it in the box. The check is exact after trimming — an input whose words merely appear inside a longer prompt is
not flagged — so a copy that reworded the words as it copied it is missed, which is the right way round: the other
direction would fire on correct work. Two answers are one clause longer.

**Where** `frontend/src/components/canvas/canvas-node-generation.ts` (`repeatedConnectedText`),
`frontend/src/lib/canvas/canvas-agent-tools.ts` (`connect`, `set_prompt`),
`internal/server/agent_instructions.go`, `internal/server/mcp_test.go`, `frontend/tests/canvas-generation-context.test.ts`.


## 204. The viewport follows what the answer is about

**Decision** The viewport rule in `canvasInstructions` now names three triggers — *the node that changed, the
node the user asked about, the one they could not find* — and one limit: "One node per answer is enough."

**Why** The old sentence said "something that changed or is out of sight", which is the agent's own edits only.
A question about a node is neither: asked what the second picture looks like, an agent that answers in words
leaves the user hunting for it on a board bigger than the window, and `focus_node`'s own description ("use it
to show them something that changed or is out of sight") repeated the same gap, so neither place could teach
it. Brought up by the user, and it is the mirror of #203: the prompt said what the agent may not do and not
what it should.

**Cost** The viewport is the one thing a tool moves that the user did not ask to move, so an agent that focuses
on every mention takes the user's place away mid-work: the one-node-per-answer limit is that price, and it is
in the rule rather than in the tool because the tool cannot see an answer's shape. A node already in view is
still focused — the agent has no way to know where the user is looking, and selecting it is the other half of
the gesture.

**Tested** In the browser with the real agent (the run above): turn one ended with `canvas_focus_node` on the
node being reported — "selected image-… and moved the view to it" — and the screenshot shows the board centred
on it. In turn two the same agent declined to focus again ("The node is already visible (I focused on it
earlier). I'll just reply."), so the limit held without a second sentence. `make check`,
`TestAgentSpawnCarriesTheCanvasRule` (which pins the new trigger's wording), `npm run check`, `npx vitest run`.

**Where** `internal/server/agent_instructions.go`, `internal/server/mcp_test.go`, `docs/server.md`.


## 205. A connection's id is not a timestamp

**Decision** `addConnection` — the one function a drag, the reference bar and the agent's `connect` all end
up in — names a connection with `nanoid()`, not `conn-${Date.now()}`. The other places that make one
(`createConnectedNode`, `selectNodeReference`, `duplicateNode`, the paste path) already did.

**Why** The agent wires several nodes in one batch, so three `connect` calls finish inside the same
millisecond, and a timestamp is not unique at that resolution: `canvases/3df8b7a65088/canvas.json` holds
three connections that all carry `conn-1793651086334`. The id is not cosmetic — it is what selecting,
highlighting and deleting go by (`deleteConnection` filters on it, `relatedHighlight` collects it, React uses
it as the key), so deleting one of those three connections would have removed all three, and clicking one
would have lit up the others. Found while verifying #203, which makes the agent wire text into image nodes.

**Cost** An id is no longer readable as a timestamp, which nothing ever read.

**Tested** On a `/tmp/verify` copy (8191/3011, its own data directory and `AGENT_CONFIG_PATH`): a canvas
seeded with one text node and three empty image nodes, and one message asking the agent to wire all three —
three `canvas_connect` calls answered in one batch (three `UF` frames at 20:47:21.049–.067) — then the saved
`canvas.json` held three connections with three distinct ids (`XNyw9uV2g0qVsKpK6xVjL`,
`8s_-1Jsq57ZSS_Zb6Liro`, `4uuoCxPREuq_dFLde1dcR`), where before the change the same gesture produced one id
three times. `tsc --noEmit`, `prettier --check`, `npx vitest run` (22 files, 169 tests), `npm run build`,
`make check`, `go test -race`.

**Where** `frontend/src/pages/canvas/project.tsx`.


## 206. `connect` carries an example of both directions

**Decision** The description of `connect` gained two sentences naming the two orders as the thing they mean:
"the words into the picture: `fromNodeId` is the text node, `toNodeId` is the image node. The other order is
real too — a picture into a text node is a reference that text node reads." Nothing else changed: the tool's
answers, the canvas's rules and the arguments keep the shape they had.

**Why** The table described one example and it was a picture into a config node, which is not what an agent
does all day — since #203 the common wiring is a text node's words into a picture, and that had no shape to
copy. A throwaway run showed the cost: asked to wire three pictures and a text node, an agent answered
`fromNodeId: image-…, toNodeId: text-…` and reasoned "the user said 把这三张图都接上这个 Text 节点, so the image
is the source" — it parsed an ambiguous sentence literally, and the words available to it never said which
order produces which relation.

**Why not in the answer, which was the first plan** Because a sentence that agrees with what the agent already
believes does not get read: the #203 note works by contradicting a judgement ("would send them twice"), and
"text-y now takes image-x" would only confirm the direction it had just chosen. The strongest branch of that
plan — "image-x holds nothing to send yet, so text-y gains no input" — describes a state the agent created a
moment earlier and already knows, so it reads as a status report. Three branches and a noun table for that is
not worth the noise on a tool called several times per turn.

**Cost** One more sentence in every `tools/list`. A wrong direction is still accepted and not flagged: a
picture that never receives the words is not an error the canvas can recognise — image into text is a real
wiring (the reverse-prompt flow builds exactly that) — and the human-visible signal is the panel's Generate,
which #185 disables when a node has nothing to send.

**Tested** `make check` (the new assertions in `TestAgentSpawnCarriesTheCanvasRule` pin both example clauses,
and the existing one pins "say them twice"), `go test ./internal/server/`. Not exercised in a browser: no code
path changed, only the text of a description, and the example is read by the model rather than run by the page.

**Where** `internal/server/routes_mcp.go`, `internal/server/mcp_test.go`.


## 207. The agent window is part of the canvas document

**Decision** `CanvasDocument` gained `agent: { open, position, size }`. The agent panel's open state and
the place and size the user dragged or resized it to are saved in `canvas.json` beside the viewport,
written through the same save queue, and restored when the canvas opens. The in-memory zustand store is
keyed by canvas id, so one canvas's window cannot appear on another.

**Why** The panel sits *on* the canvas, but how it was left is how the person left the *canvas*: reopening
a project should show the conversation where it was, not a closed button in the corner. The viewport has
always worked this way, and a resize or a collapse is the same kind of fact — "this is the arrangement I
was working in". A session-only value meant a reload lost the arrangement, and switching canvases carried
the last canvas's geometry across.

**Why not the history / export separately** The viewport is not in undo either: moving the board is not an
edit to its content, and undoing a node move must not also un-maximise the panel. The field travels in
`canvas.json`, so an export carries it, and `documentOf` is still the one place that decides what the
document is.

**Cost** `canvas.json` has one more field. A document written before this change has no `agent`; it reads
back as closed at the default corner, which is what those canvases did before. A remembered pixel position
may be outside a smaller browser window, so drawing clamps it into the canvas, but the stored value is kept
as written. Geometry is debounced 500 ms (open/closed is written at once), and `pagehide` runs the pending
write before the page goes, so the debounce is a save-rate choice rather than a hole a refresh falls into.

**Tested** `npm run test` (`frontend/tests/canvas-document.test.ts` pins the field in the document and
`frontend/tests/canvas-agent-window.test.ts` pins per-canvas isolation, restore-once and the old-document default),
`tsc --noEmit`, `node scripts/check-exports.cjs`. Not exercised in a browser in this change.

**Where** `frontend/src/types/canvas.ts`, `frontend/src/services/api/canvases.ts`,
`frontend/src/lib/canvas/canvas-document.ts`, `frontend/src/stores/canvas/use-canvas-agent-store.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/tests/canvas-document.test.ts`, `frontend/tests/canvas-agent-window.test.ts`.


## 208. A save's version check and its write are one step

**Decision** `canvas.Store.Write` takes `Store.writeMu` for the read-check-write, so the rev a save is
compared against cannot move between the comparison and the rename that follows it.

**Why** The check was a plain read: two saves that named the same rev both read it, both matched, and both
wrote — the later rename winning, and the earlier caller told its document had been stored under a rev that
no longer describes it. That is a lost edit with no conflict reported, which is the one outcome `If-Match`
exists to prevent. Measured on the unguarded code with eight goroutines writing against one rev: five were
answered 200 and three 409, so four of the five "successes" never reached the disk.

**Cost** One mutex for every canvas. A save is a few milliseconds of local I/O and the queue already
serialises per canvas, so the contention is theoretical. `Create` and `Delete` do not take it: they touch a
directory nobody else names.

**Tested** `TestTwoSavesAgainstOneRevHaveExactlyOneWinner` in `internal/canvas/canvas_test.go` — eight
goroutines, one winner, seven conflicts, and the surviving document is a whole one. It fails without the lock
(5 winners) and passes with it; `go test -race` on the package is clean.

**Where** `internal/canvas/canvas.go`, `internal/canvas/canvas_test.go`.


## 209. The document that carried duplicate connection ids was repaired where it lives

**Decision** `canvases/3df8b7a65088/canvas.json` — the one document in this workspace that held two
connections with one id — was rewritten once with distinct ids: a one-off edit of the file, not a step in the
product. The read path does nothing about it — no normalisation, no migration branch, no compatibility field.
#205 already made every new id unique (`nanoid()` in `addConnection`), so nothing mints a duplicate again.

**Why the data and not the reader** #205's own evidence pointed at a live bug — clicking one of those two
connections lit both (one click, two paths at `stroke-width="3"`), and deleting either removed both — and the
temptation is to repair it on load, which also fixes any zip exported before the change. But this project has
no installed base and no released version: there are no old documents, no old exports, and nothing in the
world that a migration would be run against. A reader that repairs what it reads is then permanent code for a
case that cannot occur — the same reflex that produces version-0 formats nobody dares remove. One document was
wrong; one document was fixed.

**Cost** If a duplicate ever turns up again — a hand-edited `canvas.json`, a zip from an unrecoverable
build — the fix is an edit of the file, not a restart, and the symptom is visible (two connections
highlighting together) rather than silent. That is a worse day than a read-time repair would give, and it is
the correct trade for a tree with no users.

**Tested** Not a code change: the document was rewritten and re-read (`GET /api/canvases/3df8b7a65088`), the
four DOM ids are distinct, and one click now lights one path.

**Where** `canvases/3df8b7a65088/canvas.json` (not tracked), `frontend/src/pages/canvas/project.tsx` (#205).


## 210. An import skips directory entries

**Decision** `importArchive` (`internal/server/canvas_import.go`) ignores a zip entry that is a directory.
Everything else about the archive is unchanged: `canvas.json`, `manifest.json` and `files/<name>`, with `..`
still refused before the name is cleaned.

**Why** `files/` is what every zip tool writes for a folder — `zip -r`, Finder's Archive Utility, Explorer —
so the ordinary way of moving an export (unzip it, zip it again) produced an archive this gateway refused with
`422 import_unexpected_entry`, naming an entry that carries no bytes at all.

**Cost** A directory entry is no longer an error. Nothing was ever restored from one, and an archive whose
`files/` entry is a directory with contents still fails on those contents only if they are not
`files/<valid name>`.

**Tested** `TestAnImportAcceptsTheDirectoryEntriesARezipAdds` builds the same archive `zip -r` produces; the
live gateway was checked both ways — `422 import_unexpected_entry` before, `200` and a fetchable file after.

**Where** `internal/server/canvas_import.go`, `internal/server/canvas_e2e_test.go`.


## 211. A run that panics fails its task, not the gateway

**Decision** `task.Store.pump` calls the run through `runGuarded`, which recovers a panic and turns it into
that task's error. The queue records the failure and starts the next task.

**Why** Go has no per-goroutine recovery: an unrecovered panic in the worker goroutine takes the process down —
every canvas, every other run, and the queue with it. The run is the one place here that executes code shaped
by data (a graph from `workflows/`, its parameters, ComfyUI's answer), so it is the one place worth guarding;
`httpx.Recover` already does the same for a request.

**Cost** A panic no longer crashes the process, so a deterministic bug becomes a run that always fails instead
of a stack trace at startup. The log line names the task and the panic value; the stack is not printed, which
is the one thing a developer would want — `debug.Stack()` is the obvious next step if that turns out to
matter.

**Tested** `TestAPanickingRunFailsItsTaskAndTheQueueCarriesOn`: the first task fails with "the run panicked",
the second one queued behind it completes.

**Where** `internal/task/task.go`, `internal/task/task_test.go`.


## 212. A WebSocket write has a deadline

**Decision** `ws.Conn.writeFrame` sets a 30-second write deadline on the underlying connection before every
write.

**Why** A write to a peer that stopped reading — a suspended tab, a network that went away without a FIN —
blocks in the kernel once the send window fills, and nothing on this side can interrupt it. The write holds the
connection's mutex, so the keep-alive ping that would have noticed cannot go out either, and the writer (the
agent's pump, under the session's lock) waits with it: one dead tab could hold a whole session's routes. The
deadline turns "blocked for ever" into an error, and an error shuts the connection down, which wakes the
reader and detaches the session.

**Cost** A frame that cannot be delivered in 30 seconds closes the socket instead of waiting. The largest
frame this socket carries is an 8 MiB message bound, and the client is a browser on the same machine or the
LAN, so 30 seconds is generous by an order of magnitude.

**Tested** The package's existing tests (handshake, frames, ping/pong, close) pass with it; `go test -race`
on `internal/ws` and `internal/server` is clean. Not reproduced against a stalled peer: a blocked socket is
not something a unit test can build without a fake transport.

**Where** `internal/ws/ws.go`.


## 213. An export asks whether the file is there before zipping it

**Decision** `exportCanvas` and `exportCanvasNodes` (`frontend/src/lib/canvas/canvas-export.ts`) go through
`fetchFileBlob`, which returns null on a non-2xx response instead of the body.

**Why** `fetch` resolves for a 404 as readily as for a 200, so the old `(await fetch(url)).blob()` zipped the
gateway's error envelope, and an import then restored that JSON under a `.png` name — a canvas whose picture
is a sentence. A file can genuinely be missing: the sweep has a 24-hour grace (#156), a task record can
outlive its canvas, and a canvas can be exported from a copy whose `files/` was edited by hand.

**Cost** An export silently carries fewer files. That is the same information the missing node will show on
screen (a broken reference) rather than a corrupt one it cannot explain.

**Tested** `tsc --noEmit` and the existing suites. The behaviour is not covered by a test: the module calls
`saveAs` and the browser's download machinery, which vitest does not run.

**Where** `frontend/src/lib/canvas/canvas-export.ts`.


## 214. An answer stops listening for its abort when the turn ends

**Decision** `askAgentSession` (`frontend/src/services/api/agent.ts`) removes its `abort` listener in the
`finally` that already detaches the event listener, and refuses a request whose signal is already aborted.

**Why** The listener was added with `{ once: true }` and never removed on the success path, so it outlived the
turn it belonged to. A caller that reuses one `AbortController` for several questions — the shape the node
panels use — accumulated one listener per answer, and an abort later on cancelled whatever the agent was doing
*then*, not the turn the caller meant to stop. An already-aborted signal was the mirror failure: `addEventListener`
never fires on it, so the ask waited for an answer to a question nobody was going to cancel.

**Cost** Nothing measurable; one closure per turn.

**Tested** `tsc --noEmit` and the existing suites (179 tests). Not covered by a test: the module owns a
module-level `WebSocket` map and the failure is a listener that is not there, which a unit test would have to
reach through the socket.

**Where** `frontend/src/services/api/agent.ts`.


## 215. The H3 rewrite is not asked for an output language

**Decision** The instruction `optimizePrompt` sends for a video node no longer carries a `输出语言：…` clause.
The image one (`optimizeImagePrompt`) keeps it.

**Why** It could not be honoured. The H3 guides say the rewrite sections are written in English and that
dialogue, lyrics and on-screen text are carried inside `<d>` verbatim, in their original language
(`prompts/skills/h3-prompt-writing/references/ref-en.txt`, `base-en.txt` §4.4). So the clause asked the agent
to do the one thing the format forbids, on every click, and the agent — correctly — followed the skill. For an
image model it is a real choice: a Chinese prompt is what a Chinese reader wants to edit, and nothing forbids
it there.

**Cost** A video prompt still comes back in English, with the user's Chinese dialogue inside it. That is the
format, not a choice this project makes; `promptOptimizeLanguage` (no control on screen, default `zh`) now
affects image prompts only.

**Tested** `npm run check` (tsc, i18n, exports, prettier), `npx vitest run`, `npm run build`; the built bundle
carries the H3 instruction without the clause. Not exercised against an agent: the change is one template
string, and what the agent does with it is the skill's business.

**Where** `frontend/src/components/canvas/canvas-node-prompt-panel.tsx`.


## 216. A comment about Chinese data is still a comment

**Decision** Five doc comments that quoted a Chinese string in the middle of an English sentence are
rewritten in English: the citation module's header and `referenceEntries` (`agent-references.ts`),
`node-title.ts`'s header, `sent-prompt-disclosure.tsx`'s header, `channelName`'s doc comment
(`use-config-store.ts`), and one inline comment in `canvas-agent-panel.tsx`.

**Why** #17 asks for everything written for a human to be English, and #9's exception is for *data* — a value
a model or ComfyUI reads. A comment that quotes `图片` is neither: it is prose, and the string it quotes is
already defined a few lines away (`MARKERS`, the i18n dictionary, `titleKey`). The result was a rule with an
asterisk nobody could check: the four comments sat in an exception list, so "no Chinese in the source except
data" was true only if comments counted as data.

**Cost** Saying "the default title for the type" instead of naming it is one turn of the screw less vivid.
The source now has 60 Chinese lines in six files, every one of them a value: the catalogue map, the agent's
instructions, the MOSS prefix, `MARKERS`, the `PromptOptimizeMode` union, one endonym.

**Tested** `npm run check` (tsc, i18n, exports, prettier), `npx vitest run`, `npm run build`. A scan for
CJK in `frontend/src` outside the two dictionaries reports those 60 lines and nothing else.

**Where** `frontend/src/lib/canvas/agent-references.ts`,
`frontend/src/components/canvas/sent-prompt-disclosure.tsx`,
`frontend/src/stores/use-config-store.ts`, `frontend/src/components/canvas/canvas-agent-panel.tsx`.


## 217. An editor exports a picture it decoded in CORS mode

**Decision** `loadDrawableImage` (`frontend/src/lib/canvas/canvas-image-data.ts`) decodes a picture with
`crossOrigin="anonymous"` and, if a response does not answer the CORS request, fetches the same bytes and
decodes them through a `blob:` URL instead. The mask editor composites its source through it, and so do crop
and split.

**Why** `canvas.toDataURL()` throws `SecurityError: Tainted canvases may not be exported` the moment a canvas
has drawn bytes from another origin, and the two origins are structural: the bundle is served on `:3000` and
the gateway holding the files on `:8190` (`start.sh`). InPaint's Generate and Export both died on it, because
the overlay they send as the second reference *is* the picture with the mask drawn over it — the export was
never about the mask, it was about the source underneath. The taint is a property of how the bytes arrived,
not of the pixels, so the fix belongs at the load: `crossOrigin` makes the browser ask for the image in CORS
mode, and the gateway already answers that (its middleware allows the canvas's own host, `httpx.CORS`). The
blob fallback covers a deployment that answers the headers on `fetch` but not on a subresource; a source that
is already `data:` or `blob:` is this document's own and skips both.

**Cost** One more decode per edit, as a separate cache entry from the `<img>` on screen. It is not on the
click: the load starts when the dialog opens, so Generate awaits a download that already happened. A gateway
that answers no CORS at all now reports "Failed to read image" instead of throwing from a click handler.

**Tested** `npm run check` (tsc, i18n, exports, prettier), `npx vitest run`, `npm run build`. Not exercised
against a tainted canvas in a browser: jsdom's canvas does not taint, so the argument rests on the headers
`internal/httpx/middleware.go` sets and on the same attribute already used for cross-origin video
(`canvas-video-frame.ts`, `camera-orbit-widget.ts`).

**Where** `frontend/src/lib/canvas/canvas-image-data.ts`,
`frontend/src/components/canvas/canvas-node-mask-edit-dialog.tsx`,
`frontend/src/pages/canvas/hooks/use-image-editors.ts`.


## 218. A node's `content` is the URL it is shown from, and `storageKey` is the reference

**Decision** `imageMetadata`, `videoMetadata` and `audioMetadata` (`canvas-node-factory.ts`) put the URL a
file is served at into `metadata.content` and keep `files/<name>` in `metadata.storageKey`. `documentOf` was
already swapping them back, so nothing on disk changed.

**Why** These three functions were the only place writing the reference into `content`, and every reader of
`content` treats it as something an `<img>` can load: the lightbox in `project.tsx` (`previewContent`), the
hover preview, the mask, crop, outpaint and angle dialogs, and `pickImageSource`'s `originalUrl` once a node
is magnified past the preview's size. A node made in this session therefore pointed at `files/<name>`, which
under `/canvas/<id>` is a 404 — so the picture appeared in its node (that path resolves the reference itself,
`previewUrlFor`) and was broken in every view that did not: click to enlarge failed, and so did zooming in far
enough to leave the preview. A reload fixed it because loading a canvas is what resolves `content`
(`hydrateCanvasImages`), which is the shape this entry makes unnecessary to rely on.

**Cost** An absolute URL lives in memory for as long as the canvas is open. It reaches neither `canvas.json`
nor an export zip: `documentOf` replaces it with `storageKey` before either is written, and #152's rule — a
document that carries no host, port or canvas id — still holds. A file with no derivable URL keeps the
reference, which is no worse than before.

**Tested** `frontend/tests/canvas-node-metadata.test.ts` (the URL in `content`, the reference back in the
document, the fallback for a file without a URL), `npm run check`, `npx vitest run`, `npm run build`.

**Where** `frontend/src/lib/canvas/canvas-node-factory.ts`, `frontend/src/lib/canvas/canvas-document.ts`.


## 219. The gateway serves the canvas bundle, from its own origin

**Decision** `WEB_DIR` names a canvas bundle and `GET /` serves it: a file under that directory, or its
`index.html` for a path that names no file (a client-side route). `start.sh` starts one process instead of
two, `frontend/dist` is what it points at, and `make run` does the same from source. The first-paint file
carries a gateway address only when the operator names one (`PUBLIC_BASE_URL`); the frontend otherwise uses
the origin it was loaded from.

**Why** The canvas was a second process — `vite preview` on `:3000`, gateway on `:8190` — and that cost more
than a second window. `vite` is a development dependency, so a release could not ship at all without
shipping a build tool. Every picture was cross-origin, and `canvas.toDataURL()` refuses a canvas that has
drawn one, so InPaint, crop and split could not export what they drew (#217 patched the symptom).
`CORS_ORIGINS` had to be kept per address, with `*` refused and a "same host name" rule to paper over the
usual single-machine case. And the frontend had to *guess* the gateway's address and carry it into the
page, which is wrong for a LAN name, a phone, or a reverse proxy — the page it came from is the only answer
none of those can get wrong. Serving bytes is not knowing what a node is: `/api/*` remains the whole
protocol, and `canvas.Store`'s boundary is untouched.

**Cost** The gateway now owns two things it did not: a cache policy, and the failure mode where the bundle
is stale. `/assets/*` carries a content hash and is served `immutable`; everything else is `no-store`,
because a cached `index.html` outlives an upgrade and asks for chunks that are gone — a white page a reload
cannot fix, since the reload is what reads the cache. A missing asset answers 404, never the page, for the
same reason. There is no compression: the wire is loopback or a LAN, which is the argument the bundle's own
chunking already makes. A `go:embed` build (one file to ship) is not done: it would make `make build` depend
on npm, and reading the directory keeps "copy a new `dist/` over the old one" working without a restart. One
of its two blockers is already gone: nothing is written into the bundle any more (#220).

**Tested** `internal/server/web_test.go` (root and a client route answer with the page, a hashed asset is
`immutable`, `config.js` and the page are `no-store`, a missing asset and an unknown `/api/*` path stay 404
JSON, no bundle means the old 404, and no request serves a file outside the bundle), the two first-paint
tests (an address when `PUBLIC_BASE_URL` names one, none when the gateway serves the canvas),
`frontend/tests/server-origin.test.ts` (the page's origin is the answer in a browser, a named address
wins over it, loopback outside one), `go test ./internal/...`, `npm run check`, `npx vitest run`,
`npm run build`. Smoke-tested by hand: the gateway
served the built bundle on a spare port and answered `/`, `/canvas/<id>`, `/assets/*`, `/config.js` and
`/api/nope` as above; `npm run dev` proxied `/api/canvases` through vite to a gateway. Not exercised in a
browser against a real ComfyUI.

**Where** `internal/server/web.go`, `internal/server/web_test.go`, `internal/config/config.go` (`WEB_DIR`,
`PUBLIC_BASE_URL` explicitness), `internal/server/runtime_config.go`, `internal/server/routes_admin.go`,
`frontend/src/constant/app-mode.ts`, `frontend/vite.config.ts`, `start.sh`, `Makefile`, `README.md`,
`docs/server.md`.


## 220. The first paint is computed from the settings document, not copied into the bundle

**Decision** `GET /config.js` is a route: it renders `data/settings.json` — plus a gateway address when
`PUBLIC_BASE_URL` names one — into the script the page loads before its bundle, with `ETag`/`304` so a
repeat load costs a header. `RUNTIME_CONFIG_PATH` becomes opt-in: nothing is written anywhere unless the
operator names a file, for a canvas a static host publishes with no gateway in the request path.

**Why** The file existed because nothing could answer `/config.js` — a static server owned the bundle, so
writing the document into `frontend/dist` was the only way to get a synchronous read (#155). That premise
ended with #219. Keeping the file meant a second writer of one truth, and every failure mode of a copy: a
write that failed only logged a warning and left the page opening light and English; `make frontend`
replaced the file with the template; a `dist` copied to another machine carried this machine's settings,
model list and last canvas id; and the write needed the installation to be writable, which rules out a
read-only deployment and the single embedded binary #219 lists as future work. A route cannot be stale,
cannot fail to be written, and needs no write access. The document had also grown: `settings.config` holds
the whole `AiConfig` — channels and their models, synced from `/api/workflows` — so the file was carrying
several kilobytes of model metadata into a build artifact because it mirrored the store instead of
projecting it.

**Cost** The first paint now waits for the gateway to answer — a round trip on loopback, and the gateway was
already the only thing serving the page, so nothing new can be missing. The body is stored by the browser
under `no-cache` and revalidated by `ETag`; it is the same document `/api/settings` already hands out, so it
is not a new exposure. A canvas published by a static host must name `RUNTIME_CONFIG_PATH`, or it opens with
defaults and picks the preferences up over HTTP (which is also what the template in `frontend/public/`
means, and what `npm start` gets). `frontend/dist/config.js` still exists in a build — `public/` is copied
into it — but the gateway never serves it: the literal route outranks the `GET /` subtree, and a test holds
that.

**Tested** `internal/server/settings_e2e_test.go`: the script is the live document (an empty one at start,
a save visible on the next request with no file involved), the assignment the frontend expects, the
address only when named, `ETag`/`304` and a new `ETag` after a save, and the opt-in file written only when
asked — plus nothing appearing in `WEB_DIR`. `internal/server/web_test.go` holds the route against the
template in the bundle. `go test ./internal/...`, `make check`, `npm run check`, `npx vitest run`,
`npm run build`, `make build`.

**Where** `internal/server/runtime_config.go`, `internal/server/routes_admin.go`,
`internal/server/routes_settings.go`, `internal/server/server.go`, `internal/config/config.go`
(`RuntimeConfigPath`), `start.sh`, `Makefile`, `frontend/index.html`, `frontend/public/config.js`,
`frontend/src/constant/runtime-config.ts`, `docs/server.md`, `README.md`.


## 221. A message is a list of parts, drawn in the order the frames arrived

**Decision** The panel's transcript is built by one reducer, `transcriptEvent`, and a message is a **list of
parts** — text, reasoning, a tool call — appended as the frames arrive and never moved. The tool list that
hung off a message is gone, and with it the block that drew every call above every sentence. Message ids
come from a counter, not a timestamp, padded so that sorting them as strings is the order they arrived in.

**Why** A `text` field plus a `tools` array cannot say *where* in a message a call happened, so the renderer
had to choose — and it chose the top. A real transcript shows what that costs: in
`data/agent/sessions/canvas-d35c56e43bf8-3de3706a.session` two `canvas_read_node` calls sit between the
reasoning that decided to make them and the paragraph that reads their output, and the panel drew both calls
before both sentences. The frames already carry the order; only the shape lost it.

The same question one level up is which bubble a frame belongs to, and the answer is the end of the list and
nothing else: a message that arrives takes the end, and text and calls keep going into the answer that is at
the end — if what is at the end is not an answer, they open one below it. That is why the panel reaches back
into no earlier bubble. Scheduling is not this side's business: a message said mid-answer is echoed by the
agent when the agent says it, drawn where it lands, and the answer goes on underneath. What the person typed
is not drawn at all — it appears when the echo arrives (#104), so there is still one copy of it.

**Cost** One more module and one indirection: the panel no longer builds messages inline. An answer that is
echoed over mid-turn reads as two bubbles with that message between them, where it used to be one bubble with
later words written above them. A message can now be several paragraphs, so each run of text is read for `@`
mentions on its own — two citations with the same label on either side of a call resolve to the first of them
twice, which is the fallback a transcript written before labels were unique already got (#163).

**Tested** `frontend/tests/agent-transcript.test.ts`: a call keeps its place between two sentences; the
order of several calls and the sentences between them; ids unique and sorting in arrival order; one step for
the two frames of a call; a message echoed mid-answer taken at the end with the answer continuing below it;
history replacing rather than appending; a frame that says nothing opening nothing. Replayed through the
reducer, the session file above produced `user → [reasoning, tool, tool, reasoning, text] → user →
[reasoning, tool, tool, reasoning, text]`, where the panel had drawn `[tool, tool, text]` with both reasonings
dropped. `npx vitest run`, `npm run check`, `npm run build`.

**Where** `frontend/src/lib/canvas/agent-transcript.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/tests/agent-transcript.test.ts`.


## 222. A tool step says how it ended, reasoning is folded, and the agent's notices are drawn

**Decision** Three things the panel did not say before, all of them about what a frame means rather than what
it is:

1. A tool step carries a state — running, ok, failed — and draws a coloured mark after its name: a spinner
   while the call is out, a green tick when the result said it worked, a red cross when it said it did not,
   and a grey dash for a step a stopped turn never answered. The verdict is the UF frame's own `is_error`,
   which the gateway now relays as `isError` instead of dropping.
2. Reasoning is drawn, folded away: one `思考` line per reasoning block that opens on a click and stays
   open. It used to be accumulated into a field nothing rendered.
3. The agent's **system messages** are drawn. `SM notify` — "Summarizing conversation…", "retrying in 5s
   (retry 1/3)", "prompt deferred until MCP initialization completes" — was collected by nobody and dropped
   on the floor; it is relayed as `notice` and drawn between the bubbles, smaller than either.

**Why** A step without a verdict is a spinner that means nothing: the panel showed `调用 canvas_read_node`
and left the reader to guess whether the call had come back, and after a stop it showed a spinner that would
never stop. The answer was two fields away — UF carries `is_error`, and the gateway's own tool path already
knew the idea (`toolAnswer.IsError`) — so the mark is the frame's verdict and not a guess from the text.

Reasoning is the part that is written but not said: it is what a surprising answer is explained by, and noise
in the common case. Folded, it costs one line; unfolded, it is the whole trace. Dropping it entirely (the
first version) was the one option that helps nobody.

The notices are how the agent says what it is doing to itself while the user waits on a long turn. They are
not in the session file and not errors — a `notify` drawn as an error would be a red line for "summarizing",
which is normal work — so they travel as their own kind and are drawn as their own row.

**Cost** One more event type across the wire, and one more field on `tool_result`. A failed call still shows
no reason of its own: UF's text is the first content item, and a failure's words are in it only when the tool
put them there. A notice is the one thing that does not come back after a reload, because AlayaCore does not
put it in the session file: it is the live stream saying what it is doing at that moment, not something that
was said. That is the agent's file and its call, not a gap to patch here — the rest of the turn (reasoning,
calls, results) is replayed and drawn as it was (#223).

**Tested** `internal/server/agent_e2e_test.go`'s
`TestSocketRelaysTheSystemNoticeAndTheFailure`: the fake agent sends `SM notify`, an `AF`, a UF with
`is_error: true` and a task that ends — the socket relays all three, the failure with `isError`. On the
frontend, `frontend/tests/agent-transcript.test.ts` covers the state of a call that worked, one that failed,
one never answered, and a notice arriving mid-answer. In the browser: not exercised — the marks were checked
by rendering a replayed transcript, not against a live AlayaCore. `go test ./internal/...`, `npx vitest run`, `npm run check`, `npm run build`.

**Where** `internal/agent/events.go` (`IsError`, `systemNotice`), `internal/agent/run.go` (`notify`),
`internal/server/agent_e2e_test.go`, `frontend/src/services/api/agent.ts`,
`frontend/src/lib/canvas/agent-transcript.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx` (`ToolStepLine`, `ReasoningBlock`),
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`.


## 223. The replayed conversation is the frames, relayed as they come

**Decision** `Event.History` is `[]Event` — the replayed frames carried as the events a live turn sends — and
`HistoryEntry` (`{role, text}`) is gone. `replayed()` calls the same parsers a live turn does (`userContent`,
`contentDelta`, `toolCall`, `toolResult`) and passes each frame on as `user` / `delta` / `reasoning` /
`tool_call` / `tool_result`, in the order the agent wrote them. The panel folds that list through
`transcriptEvent`, the same reducer that draws a live turn.

**Why** The session file is AlayaCore's, and it holds the whole turn: the question, the reasoning, every call
and its result, the answer. `replayed()` read only the text of that stream, so a reloaded page drew a
conversation with its thinking and its tool steps cut out — a copy that was cheaper to produce and not what
the agent said. Nothing needed to be summarised or reconstructed: the file is already in order, and reading
only part of it was the whole defect. Relaying the frames also removes a second shape from the wire and a
second renderer from the panel, which is the version that cannot drift: a reload is drawn by the code that
drew it live, from the same frames.

**Cost** `AX`/`AF`/`UF` frames from the startup window now travel to the page as events, so the `history`
message is larger than bare role/text pairs — the tool inputs and outputs a turn carried. A `Uf` preview
(result before it is final) and the textless `AX` marker are still skipped: they are display-only or nothing
said. Notices are not in this list and cannot be: AlayaCore does not write `SM notify` to the file, so what
the agent was doing to its own context at 14:03 is not part of the conversation it replays.

**Tested** `internal/server/agent_e2e_test.go`'s `TestSocketGoingAwayReplaysTheConversation`: the fake agent
writes a turn to its session file — reasoning, a call with arguments, the result, the answer — the socket is
dropped, and the next connection replays `user, reasoning, tool_call, tool_result, delta` in that order, with
the call's arguments intact. `frontend/tests/agent-transcript.test.ts` folds the same list and gets one user
message and one answer carrying its reasoning and its finished call. `go test ./internal/...`, `npx vitest
run`, `npm run check`, `npm run build`.

**Where** `internal/agent/events.go` (`Event.History`, `replayed`), `internal/agent/sessions.go`
(`Connected.History`), `internal/server/routes_agent.go`, `internal/server/agent_e2e_test.go`,
`frontend/src/services/api/agent.ts`, `frontend/src/lib/canvas/agent-transcript.ts`.


## 224. The panel draws the agent's own numbers: how full the context is, and how fast it is going

**Decision** The canvas agent panel shows the agent's telemetry in a small row at the foot of the
conversation — `22K/1M 2.2% | 129.5 tok/s (ttft 0.8s)` — from a new `usage` event carrying SM `task`'s
`context_tokens`, `step_tps` and `ttft_ms`, and from the startup broadcast, which carries the count the
agent restored from its session file. The numbers are written the way AlayaCore's own status bar writes them
(`formatTokenCount` and the two segments in its `internal/adapters/terminal/tui_status.go`), so the panel and
the terminal never disagree about the same session. Nothing is measured, estimated or counted on this side:
the three values are relayed and printed.

**Why** Both facts already existed and neither was shown. `context_tokens` was read only to decide whether a
task had ended, and `step_tps`/`ttft_ms` were dropped with the rest of the payload. Someone waiting two
minutes on a video wants to know whether the model is working or stuck, and how close the conversation is to
the model's ceiling; the agent already answers both, in the frame it sends at every step.

The shape stays the agent's. `step_tps` is end-to-end throughput with latency included — deliberately not a
decode rate, for the reason AlayaCore's `speed-tracking.md` gives — so the panel prints it rather than
recomputing anything from the deltas it happens to see. `ttft_ms` qualifies that figure and rides in
parentheses. A step that produced no output tokens reports no speed, and `0.0 tok/s` on screen would read as
a stalled model, so nothing is drawn for it. The context cell is `used/limit share` only when the model says
how much it holds; a percentage of an unknown limit is not a number worth inventing.

**Cost** One more event type, three fields on it, and one field's worth of state on the session
(`AgentSession.usage`). The row is hidden until the agent has said something, so a fresh conversation shows
no numbers rather than zeros. The restored count arrives only for a session started on a file — a box opened
on nothing has nothing to report until its first step ends. The format is fixed English-ish by nature
(`tok/s`, `ttft`): it is the agent's own vocabulary, and translating it would put the panel and the terminal
at odds over the same number.

**Tested** `internal/agent/session_test.go`'s `TestSessionRelaysTheContextAndTheStepSpeed`: the count the
agent restored rides on the startup broadcast (and carries no step figures), a step frame mid-turn is relayed
as `12.5 tok/s` with a 1200 ms first token, the frame that ends the turn is relayed *before* `done`, and a
step that has counted nothing (`context_tokens: 0`) is not drawn as a zero. `frontend/tests/agent-usage.test.ts`: the token-count format in both units, the share, the count alone when the limit is unknown, the speed
with and without a first-token time, the blank for a step with no output, and the whole line. In the browser:
not exercised against a live AlayaCore — the row was read off a replayed transcript. `go test
./internal/...`, `npx vitest run`, `npm run check`, `npm run build`.

**Where** `internal/agent/events.go` (`usage`, `taskUsage`, `ContextTokens`/`StepTps`/`TtftMs`),
`internal/agent/run.go` (`task`), `internal/agent/session_test.go`,
`frontend/src/lib/canvas/agent-usage.ts`, `frontend/tests/agent-usage.test.ts`,
`frontend/src/services/api/agent.ts` (`AgentUsage`, `adopt`),
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`docs/server.md`.


## 225. A run's end is a message to the agent that asked for it

**Decision** `POST /api/canvases/{id}/runs` takes an optional `askedBy: {session, node}`, filled in by the page when
it submits a run because an agent called `generate`. The run record keeps it (`task.Ask`), and when the run reaches a
terminal status the gateway tells that session what became of it — one sentence naming the node, the files or the
reason — through `agent.Sessions.Tell`, which sends it as a prompt. It therefore arrives the way anything typed into
the panel does: AlayaCore echoes it as a user message, draws it, and answers in a turn of its own.

The store reports a run once (`Store.SetOnFinish`, guarded by a flag that is never serialized), from whichever side
reached a terminal status first: the worker that unwound it, or a cancel that took it out of the queue before a
worker ever saw it.

**Amended by #285** This entry used to describe a third answer to a press — "no run has been reported" after a 15 s
wait, with both outcomes named. A press now has two answers and no clock of its own; the bound on a slow page is the
bridge's 30 s. What stands is the ask, the notice as a debt, and the sentence arriving as a prompt.

A refusal is a failed call rather than a quiet success, because a quiet success leaves the agent waiting for a
message that will never come. "Started" has to mean a run id, not the absence of an error.

**Why** `generate` is answered the moment the run is queued — a picture takes minutes and a tool call is not a
progress bar — so the agent's turn usually ends with the work still going. The tool's own answer once said only "the
node shows its own progress": the agent that started a two-minute video waited for a message that never came, and
the user said "it's done" by hand. That is the whole defect.

Two shapes were rejected. Keeping the pairing in the page — the promise `generateNode` returns, and a send when it
settles — is a hundred lines shorter and dies on the one occasion this exists for: reload the tab, or leave the
canvas and come back, and the run goes on while the memory of who asked goes with the page. Deriving it at the
gateway from the tool call is a timing heuristic: the call knows the session and the node but not the run (the
page's own button creates that), so "the next run on this canvas" would attribute a user's own generation to an
agent that happened to be idle.

It is sent as a *user* message rather than a frame of its own, because the conversation belongs to the agent and a
finished run is the kind of thing a person tells it. Anything else would need AlayaCore to grow a frame.

**Cost** One optional field on the run body, threaded from the tool handler through `handleGenerateNode` and the
four generation modes to each API helper, plus one hook on the task store and a callback the other way for "a run
exists". What this serves is the canvas conversation: a node panel's agent is one-shot, so its session is released
with its answer and a run it started reports into the log. A session that is gone when the run ends hears nothing,
and the log says so — the message is not queued for the next process. The ask is a *name*, which is what lets it
survive a reload and also what lets it outlive a conversation cleared mid-run, whose successor under the same name
would be told about a run it never asked for. A text node's generate is not a run, so it is not reported, and the
tool's answer says so instead of promising a message. The expectation is set by the system prompt ("Do not wait for
it and do not poll the node", #326) and by the answer's fact about the run it started — "you will be sent a message"
— which is the other half: an agent told nothing waits, and an agent told too little polls.

**Where** `internal/task/task.go` (`Ask`, `SetOnFinish`, `finishedLocked`, `finish`), `internal/server/run_notice.go`,
`internal/server/routes_{runs,mcp}.go`, `internal/agent/sessions.go` (`Tell`),
`frontend/src/services/api/{runs,image,audio,video}.ts`,
`frontend/src/pages/canvas/hooks/{use-canvas-agent-tools,use-generation-runs}.ts`. Tests:
`TestTheEndOfARunIsReported`, `TestACancelledRunIsReportedOnce`, `TestTellSendsTheWordsAsAPrompt`,
`TestTellReportsASessionThatIsGone`, `TestARunFinishingTellsTheAgentThatAskedForIt`,
`TestARunNobodyAskedAboutTellsNoOne`.


## 226. The start script rebuilds the binaries too, not only the bundle

**Decision** `./start.sh` runs `make build` when `bin/comfyloft-server` or `bin/comfyloft-mcp` is missing or
older than `cmd/`, `internal/`, `go.mod`, `go.sum` or the `Makefile`. It is the rule #181 already applies to
the canvas bundle, and it replaces the check that only asked whether the gateway binary existed.

**Why** "Is the binary there" answers *has this ever been built*, not *is this the build this tree makes*.
Edit a `.go` file, run `./start.sh`, and the previous binary starts — silently, with the bundle beside it
rebuilt from the new sources. That is the failure #181 was written to end, one half worse: the two sides are
then from different trees, so they can disagree about the protocol instead of both being merely old — a
panel waiting for a `usage` event from a gateway that predates it, with nothing in the log to say so.

**Cost** One `find` per binary per start — the cost #181 already accepted, and Go's build cache makes the
rebuild itself a fraction of a second when it happens at all. The `Makefile` is on the list because the build
recipe is part of what produces the binary; the data files are deliberately not, since `workflows/`,
`resources.json` and `prompts/` are read at run time and nothing is embedded (#219).

A release directory holds neither `cmd/` nor `internal/`, so there is nothing newer to find, the check passes,
and no toolchain is asked for — which is what keeps "a static binary and nothing else" a supported layout.
That is also the case the error message has to serve: a binary missing on a machine with no `go` now says
both halves of it ("missing or older than their sources, and there is no Go toolchain here; run: make build").

**Tested** By hand, against a copy of the script that stops before `exec`: nothing touched → no build;
`touch internal/server/run_notice.go` → "→ building the gateway and the bridge (missing, or older than their
sources)", both rebuilt; immediately again → no build; `bin/` and `frontend/dist/` copied into a directory
with no sources and started under `env -i PATH=/usr/bin:/bin` → starts, no toolchain needed; the same copy
with `bin/comfyloft-mcp` removed → exit 1 with the sentence above. The script is not part of `make check`.

**Where** `start.sh`, `README.md`.


## 227. A node remembers the run that made it: the workflow, and when it finished

**Decision** A node's metadata carries two facts about its own content — `workflow` (the gateway's id for what ran:
`image-z-image-turbo`) and `generatedAt` (the instant that run finished, ISO 8601 UTC, kept verbatim). They are
written when the run's file becomes the node's content, and erased while a picture is being replaced by a new run:
the old one is gone, and the run that made it describes nothing.

The facts ride on the *artifact*, not on each node patch. `Run` already answers both, so `factsOf(run)`
(`frontend/src/services/api/runs.ts`) puts them on what `generatedImage` / `generatedVideo` / `generatedAudio` return, and the
three metadata builders turn them into node fields. Every path from a finished run to a node goes through those two
places: a live run, a batch fill, an in-place regeneration, a resumed poll after a reload, a retry, an inpaint or
upscale child. A picked file, a crop, a mask: no run on the artifact, and the fields are absent.

The tools then say it in one place: `generationClause(metadata)` returns `made 2026-11-03T13:09:19.928Z with
image-z-image-turbo`. `list_nodes` puts it on the node's line before the prompt, `read_node` ends its answer with it,
and the node information dialog shows the same two facts as rows — rendered in the reader's own clock there, because
a person is looking at their own machine and a model is not.

**Why** A node held everything about a picture except what made it and when. `metadata.model` was unreachable through
any tool and held the *pick* (`default::image-z-image-turbo`), which the settings can rename or delete afterwards,
and there was no time anywhere on the node.

The time was recoverable in principle, and every route was worse than writing it down. The run record has it but is
pruned (`TASK_RETENTION_DAYS`, `MAX_STORED_TASKS`) and names only `object: "image"` — no node — so a run cannot be
traced to what it drew. The output file's name carries the run id and its mtime is when it was written: a derivation
through two accidents, and `imageRunId` is cleared when the image lands, so even that link is gone for pictures
(video keeps `videoTaskId`). The canvas's `updatedAt` is the whole document. The node id's leading number is when the
*node* was created, and a node re-run in place keeps its id — a different question. And the agent has no HTTP path to
`/api/runs`: its tools are the canvas ones. So an agent asked "which model drew this, and when" could only guess from
the prompt, and the honest answer was "I cannot tell" — worst exactly where it mattered, on a canvas with a dozen
pictures from three models.

**Cost** One optional field on the two artifact types, two on `CanvasNodeMetadata`, and one `NO_MAKER` patch
(`{workflow: undefined, generatedAt: undefined}`) where a node forgets its maker. The `list_nodes` line grows by
about fifty characters per generated node — accepted, because the alternative is a `read_node` per node, and that
answer carries the picture's bytes.

**What this does not cover** A text node's answer is not a run (its own agent writes it), so it has no `generatedAt`
and keeps `model` alone. Nodes written before this have neither field and their tools say nothing about a maker:
there is no backfill, and inventing one from the filename would put a guess where every other fact here is a record.
The one other way a node's content could change without a run — the user putting their own file into an existing node
— no longer exists (#228), which is also why `model` no longer has to be scrubbed from a clip or a sound a picked
file replaced.

**Where** `frontend/src/services/api/runs.ts` (`factsOf`), `frontend/src/lib/canvas/node-generation-facts.ts`
(`generationClause`), `frontend/src/lib/canvas/{generated-media,canvas-agent-view,canvas-agent-tools}.ts`,
`frontend/src/types/canvas.ts`, `frontend/tests/api-runs.test.ts`.


## 228. A file enters the canvas as a node, never into a node

**Decision** A node is never handed a file. Every file the user brings — dropped, pasted, or chosen in the
picker — becomes a node of its own, made complete in one step: the bytes are uploaded and the node is built
with the media already in it. The per-node upload is gone: the image quick tool `replace`, the empty image
node's upload button, and the clip's and the sound's `替换视频` / `替换音频`. What is left of the picker is
one entry in the canvas menu, and it makes new nodes exactly as a drop does.

**Why** The feature was inherited, not decided: it came in with the initial import, and no entry in this
file ever argued for it. What it did was put a new file into a node that already held one, so every claim
that node made about its content had to be scrubbed — `model`, `size`, `quality`, `generationType`,
`references`, a `mask` storage key, the run id it was still polling, the preview of a frame being drawn —
and the three branches that did it (image, clip, sound) each scrubbed a different subset. None scrubbed all
of it: an image node replaced by a clip kept `imageMode`, `outpaint`, `layout` and a mask the cleanup then
kept alive forever; a clip replaced by a sound kept `videoTaskId`. The picker also took *any* kind of file
for *any* node, so choosing a video for a sound node silently changed that node's type and left both kinds'
fields on it. Adding `workflow`/`generatedAt` (#227) would have meant a fourth thing to scrub in three
places, which is what surfaced the whole shape.

None of it is needed. What replacement bought was the node's id — its connections, its group, its position
— and that is a *graph* edit, not a content edit. Graph edits are what the agent already does:
`create_node`, `connect`, `move_node`, `delete_node`, `focus_node`. "Use my picture instead, and keep the
wiring" is therefore a thing it can already say, one visible step at a time, and a person can do the same
by hand. What no amount of scrubbing recovers is a node claiming the wrong maker for what it holds — and
that is what this removes: on a canvas where the core is the agent's workflow, the old feature's only
remaining product was the debris the agent would then be told about as fact.

**Cost** Three entry points with their handlers, and `use-content-ingress`'s entire target mechanism
(`uploadTargetRef`, the three replacement branches — about ninety lines), whose file filtering and
staggered placement collapsed into one `addFiles` that the drop and the picker share (a paste is one image
at the centre and was already its own line). Six i18n keys. One image quick tool. The one entry that
still opens the picker is named after what it does — `canvas.toolbar.import`, 导入文件 / Import files — since it
imports files *as nodes*; "upload" named the mechanism and promised a destination there no longer is.

What is lost: a node that is already placed, wired and grouped can no longer take a local file in place —
the file becomes its own node, and the old one is deleted or rewired. If that gesture turns out to be
missed, it should come back as *dropping a file onto a node*: one gesture, one meaning, and only then does
the question "what does the node keep?" have to be answered. A settings blob that still lists the `replace`
quick tool is harmless: `normalizeImageQuickToolIds` returns only the ids it knows, so the stored one drops
out by itself.

**Tested** `npm run check` — the i18n script found exactly the six keys this removes and nothing else;
`npx vitest run` (222, unchanged: no test covered the removed paths); `npm run build`; `make check`. Not
exercised in a browser: the four gestures (drop, paste, menu picker, and the buttons that no longer exist)
were read, not clicked.

**Where** `frontend/src/pages/canvas/hooks/use-content-ingress.ts`,
`frontend/src/components/canvas/canvas-node-toolbar.tsx`,
`frontend/src/components/canvas/canvas-image-toolbar-tools.tsx`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`.


## 229. A node's words are three fields with three meanings, and each question has one function

**Decision** `content` is what a node holds; `prompt` is the words it will be asked next (the ones that made it, for
a node a run made and nobody has retyped since); `composerContent` is what you type when it already holds something,
so typing cannot throw the result away. Three questions, one answer each, in `frontend/src/lib/canvas/node-prompt-field.ts`:
`nodeContentOf` (what it says), `nodePromptOf` (what was asked of it), `promptPatch` (where an instruction goes). The
panel and the agent's `set_prompt` both call `promptPatch`, so they cannot write different fields for the same words.
`holdsResult` is no longer a whitelist of text and image: every content type answers by whether `content` is there.

The agent gets the verb it was missing. `set_text(nodeId, text)` writes a text node's card — what double-clicking does
— and leaves its prompt alone, because rewriting an answer by hand does not make the question untrue. `set_prompt`
keeps writing the question, and on a text node that already says something its answer says so: *that is the question
it will answer next, not its text*.

`list_nodes` names the two kinds of words apart (`content:` / `prompt:`) and collapses a prompt's paragraphs onto one
line, which is what "one line per node" always promised. `read_node` answers with what the node holds — a text node's
card, every text of a batch, the picture itself — not with the prompt that made it. `create_node` stops advertising
`lora`, which it has never been able to make.

**Why** One function with a chain of fallbacks — `composerContent ?? prompt ?? content ?? texts[0]` — answered all
three questions, which is fine exactly as long as no node's content is words. Reading a picture answered with its
prompt and nobody minded, because the picture came along in the same answer. A text node's content *is* words, so the
chain answered "what does this node say" with the question that was asked to make it: the agent could read the prompt
box and never the card, and when asked to change the text it wrote the only field it could see — a card still saying
宫崎骏风格的森林。 over a box saying 宫崎骏风格的森林场景，无文字…. It was not misuse: the tools told one story and the
canvas told another, and the tools won because that is what an agent acts on.

The same chain hid three more of itself. An imported picture has `content` and no `prompt`, so the fallback made
`read_node` answer with `/api/canvases/…/files/a.png` and `list_nodes` print a file path where words were promised —
and #228 had just made imports the common case. A film or a sound holds a result as plainly as a picture, but
`holdsResult` said otherwise, so the next instruction overwrote `prompt` and the words that made it were gone:
artifact protection (#91) applied to pictures only. And a config node's panel wrote `composerContent` while
`set_prompt` wrote `prompt` — both read, so it worked, but "the tool writes where the panel writes" was false there.

**Cost** One new tool (`set_text`), one new module (`frontend/src/lib/canvas/canvas-agent-view.ts`, so the list's format is
testable without a page), and the tool functions moved out of the hook into `frontend/src/lib/canvas/canvas-agent-tools.ts` for the
same reason: they are decisions, not wiring. The panel's `onPromptChange` prop and `handleNodePromptChange` are gone —
one writer for one field.

**What this does not do** It does not make a text node hold one field: a card written by an agent needs a question
standing beside it, and `composerContent` stays because a node that already holds something must be able to take an
instruction without losing it. What goes away is five different stories about which field a word lives in. `prompt`
is a question, not evidence of provenance: editing a card by hand — or with `set_text` — leaves the question those
words no longer answer, because that is still what running the node sends, and a text node has no run behind it, so
#227's maker facts are stamped on media only. That is the line between this and #228: a file entering a node had ten
fields describing bytes that were gone; a hand editing words has none.

The placeholder had to change with it: 「请输入你想要将本段文本修改成什么」 promised a revision the code never did —
generating a text node asks the question again and replaces the card. It now says what the button does (「说你想让它写
什么，生成会替换现有文本」 / "Say what it should write; generating replaces this text"), and editing the words is the
card.

**Where** `frontend/src/lib/canvas/{node-prompt-field,canvas-agent-view,canvas-agent-tools}.ts`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`, `internal/server/{routes_mcp.go,agent_instructions.go}`,
`frontend/tests/node-prompt-field.test.ts`.


## 230. A wire carries what a node holds — never what it was asked

**Decision** A node gives away its content and only its content: `nodeContentOf`, one function, every reader
(wire, reference bar, @ list, side panel, export, agent's citation). A node's prompt is private — read only by
the node itself (its panel, its run, its Info popover) — and it never travels down a wire. No fallback, no
substitution: a node that holds nothing gives nothing.

**Why** The rule is one sentence of the user's, and ten places broke it the same way — `content || prompt`, and
in the @ list `content || composerContent || prompt` — because #229 gave the canvas `nodeContentOf` and then only
taught the agent's tools to use it. What came out was not cosmetic: an empty picture node's prompt arrived as a
`【参考文本】` block inside the downstream request, a text node with no card still counted as a text resource, the
export wrote the question into the `.txt`, and the agent — reading two answers to "where do a text node's words
live" — wrote `set_prompt` and then `set_text` with the same words.

**The trap, stated so it is not re-entered** A run refuses a wire that would carry nothing, and names the node
(`inputsHoldingNothing` / `describeEmptyInputs`), because a wire that carries an empty prompt silently changes
what a picture is made from. `list_nodes` still prints `prompt:` — the agent is the operator's hands, not
another node — while `read_node` answers with content only.

**Cost** `readNodeTextInput` deleted; three exports with a caller each; two i18n keys. No migration: a text node
whose words were only ever in `prompt` now shows an empty card and gives nothing away, which is the strict
reading the user chose over letting the typing box also write the card.

**What this does not do** It does not collapse a text node to one field. The card and the question stay two
fields (#229): a card needs the question it answered to stand beside it, and `composerContent` is what lets a node
holding a result take an instruction without losing it. What changed is who may read which.

**Where** `frontend/src/lib/canvas/node-prompt-field.ts` (`nodeContentOf`),
`frontend/src/components/canvas/canvas-node-generation.ts` (the refusal),
`frontend/src/pages/canvas/project.tsx`, `frontend/src/lib/canvas/canvas-agent-tools.ts`.


## 232. The node definition loses the flags nothing set

**Decision** `CanvasNodeDefinition` drops `interactionToggle`, `forceInteractive`, `transparentBackground`,
`showInCreateMenu`, `hidePanel` and `description`, and `CanvasNodeMetadata` drops `interactive`. What read
them is gone too: the interaction/move gate on content pointer events, the two transparent-border branches,
the two menu filters, the two panel-opening conditions and the description slot in the creation menu.

**Why** An earlier pass left them as "separate debt"; reading them showed they were not debt but *inert*. No built-in
definition ever set any of them, and `metadata.interactive` had no writer anywhere in the tree — so
`supportsInteractionToggle` was always false, `contentInteractive` always true, `pointerEvents` always
`undefined`, `transparentBg` always false, and every `hidePanel`/`showInCreateMenu`/`description` check a
constant. They were the shape of the plugin framework #148 removed, kept as flags nothing could reach: a
branch nothing takes reads like a feature that exists.

**What this does not change** Nothing at runtime, by construction: every condition removed was constant. The
node card renders the same background, border and pointer events; the creation menus list the same entries;
a click opens the same panel.

**Tested** `make check`; `npx vitest run`; `npm run check`; `npm run build`; and one look at a real
canvas in the browser — cards, borders, the two creation menus, clicking a node to open its panel.

**Where** `frontend/src/types/{canvas,canvas-node}.ts`,
`frontend/src/components/canvas/{canvas-node,canvas-create-menus}.tsx`, `frontend/src/pages/canvas/project.tsx`.


## 233. A prompt is read on purpose: `read_prompt`, and out of the list

**Decision** The agent gets `read_prompt {nodeId}`: the words a node will be asked — the prompt its own panel
shows, and the words `set_prompt` writes. `read_node` stays what it is (what the node *holds*), and the two
are named as a pair. `list_nodes` stops printing `prompt:`: a line carries `content:` and nothing else.

**Why** #230 made a prompt private between nodes and #229 taught the tool that wrote it to say which kind of
words it was, but the list still carried every node's prompt on every call. Two costs, neither about privacy
as such:

- **Size.** A canvas of forty nodes sent forty prompts whether or not the question was about prompts, and the
  list is the tool an agent calls most.
- **Attention.** A prompt on the line is a fact the agent did not ask for and may act on, which is how the
  screenshot that started #229 happened — a text node's question read as its body because it was simply
  there. A prompt one call away is a prompt someone wanted.

So the pair is now explicit: `read_node` for what it holds, `read_prompt` for what it will be asked. The
answer says which is which where the two are easiest to confuse — a text node's card is what it says, its
prompt is what it will be asked next — and points at the other tool.

**What this does not buy** Privacy against the agent. It runs as a child process in the project root with
`read_file` enabled (that is how it opens a skill), so `canvases/<id>/canvas.json` is readable and holds every
prompt on the canvas. Removing `prompt:` from the list removes an accidental read, not a possible one; a real
boundary would be a sandbox, which is a separate decision.

**Tested** `npx vitest run` (265: four new for `read_prompt` — the question, the empty answer, a picture's
prompt, a node that is not there; and the list's format test now asserts a prompt is *not* on the line).
`make check`, including the tools/list vocabulary (now twelve names, `read_prompt` after `read_node`) and the
system-prompt assertion, which now requires `canvas_read_prompt`. `npm run check`. `npm run build`. Not
exercised in a browser: what to look for is one live conversation — "这张图当时用的什么提示词" answered from
`read_prompt`, and a canvas of many nodes whose `list_nodes` is shorter than it was.

**Where** `internal/server/{routes_mcp.go,agent_instructions.go,mcp_test.go}`,
`frontend/src/lib/canvas/{canvas-agent-tools,canvas-agent-view}.ts`,
`frontend/tests/{canvas-agent-tools,canvas-agent-view}.test.ts`.


## 234. A watch is not the job: neither end gives up on a run that is still out

**Decision** The gateway stops giving up on a run that is still out, and the second way to re-run a node is
gone. (The browser half of this decision was a retry loop that waited three minutes; #235 replaced it with
making a reload actually re-attach, for all three kinds of content.)

- **Browser ↔ gateway** (`waitForRun`, `frontend/src/services/api/runs.ts`): the watch ends when a read fails, and the node
  keeps the run id so the next open of the canvas re-attaches (#235). What this decision ends here is the
  *other* half: the node no longer treats "could not ask" as "the run failed" by throwing the id away.
- **Gateway ↔ ComfyUI** (`waitForHistory`, `internal/generate/runner.go`): the same rule one layer down. A
  `/history` poll that could not be made is retried until the run's own timeout; a 4xx — ComfyUI saying it
  will not run this — still ends the task at once, because asking again gets the same sentence. When the
  timeout does arrive after an outage, its message says so instead of pretending the render was just slow.
- **`retryNode` is deleted**, with `resolveMetadataReferences`, `sourceNodeReferenceImages`, and the three
  ways in: the hover toolbar's 「重试」, its 「获取任务状态」, and the error banner's button. The banner keeps
  the reason and nothing else. Running a node again is the generate button, which is where running it the
  first time was.

**Why** The user's reading was right and mine was muddled: on "the run is still out" the canvas has exactly
one duty — keep watching. There were two loops, and both of them treated "could not ask" as "the answer is
no":

- One dropped `/history` request ended the task while ComfyUI went on rendering it. That is the expensive one:
  a video's minutes are paid for and nobody collects the clip, and the user is told the run failed when it
  did not.
- The browser ended the watch on one failed poll, so a wifi blip or a busy gateway showed up as 查询失败 with
  a live render behind it.

And the retry button was a second generation path beside `handleGenerateNode` — with its own composition, its
own reference resolution (from what the failed attempt recorded, not from the connections the canvas shows)
and therefore its own drift: it ignored #230's empty-wire refusal and reported nothing to the agent. Deleting
it removes a mechanism, not a convenience: a node that failed is a node to fix and press generate on, and
that is the same button the agent uses.

**What this does not do** A **gateway restart** still loses the run: the job is a goroutine in the gateway,
and a task that was `running` on disk is loaded as `failed` ("the gateway restarted before the task finished",
`internal/task/task.go`). The record keeps its ComfyUI `PromptID`, so re-attaching *there* is possible — that
is a queue-recovery decision, not this one, and it is the only thing left between here and "the run belongs
to nobody but ComfyUI".

**Tested** `make check` (two new: a `/history` outage is waited through and the completed answer still lands;
a 400 ends the task without burning the timeout). `npx vitest run` (268: three new for `waitForRun` — an
unreachable gateway is asked again and the run is picked up, a 404 stops at once, the budget says
`runUnreachable`). `npm run check` (i18n 820/806, both new keys used). `npm run build`. Not exercised in a
browser: the case worth trying is stopping ComfyUI mid-video and starting it again — the node should keep its
progress and finish, not turn red.

**Where** `frontend/src/services/api/runs.ts`, `frontend/src/pages/canvas/hooks/use-generation-runs.ts`,
`frontend/src/lib/canvas/canvas-generation-helpers.ts`,
`frontend/src/components/canvas/{canvas-node,canvas-node-hover-toolbar}.tsx`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`frontend/tests/api-runs.test.ts`, `internal/generate/{runner.go,generate_test.go}`.


## 235. One name for the run, one rule for surviving a reload

**Decision** Five leftovers of the same kind, all of them somewhere between "a run outlives the page" and
"what the node keeps when the page goes away":

- **One field.** `runId` on the node metadata, for every kind of content. It was three —
  `videoTaskId`, `audioRunId`, `imageRunId` — named after the order the three were moved onto the gateway. A
  canvas written before this is read into the one field when it is opened (`adoptLegacyRunIds`), so a run that
  was in flight then is still picked up.
- **One predicate.** `hasResumableRun` — content node, a run id, nothing to show yet — for all three. It used
  to be three predicates, and two of them also demanded `status === "loading"`, so a node in error could never
  re-attach: one failed poll left an audio or image node permanently unable to resume, while video resumed
  whatever its status said.
- **One pass.** The two resume effects (video on one gate, audio and image on another) become one, which
  dispatches to the poller for the kind of content it is, once per opened canvas.
- **One rule for a failed watch.** `failedWatch`: a `RunFailedError` means the gateway answered about the run
  — it failed, so the node says so and lets the id go. Anything else means the question did not get there, so
  the node keeps the id and says it could not confirm the run, and the next open picks the watch up. Before
  this the two pollers threw the id away on *any* error, which is what made "just reload" impossible for
  audio and image.
- **One error type for a failed run.** `VideoTaskFailed` is gone: `waitForVideoRun` used to rewrap
  `RunFailedError` under a video-only name, which is why the rule above would have needed three variants.

Also gone: `clearStaleNodeErrors`, which ran straight after `resetInterruptedGeneration` and turned every
error back to idle — including the "generation was interrupted" message that had just been written. Net
effect: a run that a page refresh killed came back as a silently idle node. A canvas now says what happened,
and an error that was already on the canvas when it was closed is still there when it is opened.

**Why** The user's model was the right one and the code kept contradicting it in small ways: *the run belongs
to the gateway, so refreshing the page is how you re-attach.* Every item above is a place where that was not
true — two of the three kinds could not re-attach at all, the id was destroyed by the failure that most needed
it, and the one message that explained a lost run was deleted on the next line by another function.

The three names were also the reason the rules had drifted: three fields invite three predicates, three
predicates invite three gates, and nothing compares them.

**What this does not do** It does not make a **gateway restart** survivable: the job is a goroutine in the
gateway, and a task that was `running` on disk loads as `failed` ("the gateway restarted before the task
finished"). The record keeps ComfyUI's prompt id, so re-attaching *there* is possible — a queue-recovery
decision, still open.

**Tested** `npx vitest run` (264: `canvas-resumable-runs` now covers the one predicate, the interrupted
message, errors surviving an open, the legacy names being read into `runId`, and `failedWatch` both ways; the
video task contract test now expects `RunFailedError`). `npm run check` (i18n 820/806, `runUnwatched` used).
`npm run build`. `make check`. Not exercised in a browser: the case worth trying is a run left in flight —
close the tab mid-render, open the canvas again, and it should still be watching, for a picture, a clip and a
sound alike.

**Where** `frontend/src/types/canvas.ts`, `frontend/src/lib/canvas/canvas-generation-helpers.ts`,
`frontend/src/services/api/{runs,video}.ts`, `frontend/src/pages/canvas/{project.tsx,hooks/use-generation-runs.ts}`,
`frontend/src/components/canvas/canvas-node-toolbar.tsx`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`frontend/tests/{canvas-resumable-runs,api-runs,api-video-runs,model-selection}.test.ts`.


## 236. A restart costs the progress bar, not the run

**Decision** The gateway picks up the runs it was watching when it stopped.

- **The record survives.** `task.Load` no longer fails a task that was `running` or `queued` *and* has a
  prompt id: nobody submitted nothing, ComfyUI has been rendering it the whole time, and the only thing the
  dead process took with it is the goroutine that was watching. Such a task is marked `Resumed` and left
  alone. A task with no prompt id was never submitted, so it is failed with the reason it already had.
- **Collecting, not resubmitting.** `Runner.Collect` takes a prompt id and does the half of a run that is left:
  wait for `/history`, download the files, hand them back. Nothing is submitted, nothing is paid for twice.
- **Resumed first.** `resumeInterruptedRuns` runs before the server serves anything, so the queue that was
  interrupted is the queue that resumes. It hands the task back by **id** (`Store.Resume`), because `Get` and
  `List` hand out *snapshots*: enqueuing one of those runs the job against a copy — the output file lands in
  the canvas, and the record the canvas reads stays `running` for ever. That is not a hypothetical: the first
  version of this did exactly that, and a video sat finished on disk with the node still saying 等待结果.
- **The canvas says so.** `resumed` is in the run payload, and a node watching a resumed run drops its step
  ring and says 等待结果 / "Awaiting result — reattached after a gateway restart, so there is no progress to
  show". The step count and the preview frames come from ComfyUI's socket bound to the process that
  submitted; without that process there is nothing honest to draw, and a frozen bar reads as "stuck".

**Why** #235 made a *reload* survivable and left the one case that costs real money: restarting the gateway
mid-video. The render keeps going on ComfyUI — the gateway simply stopped watching — so recovering it is one
`/history` call and the download that was going to happen anyway. The alternative (start over) pays for the
same minutes twice and leaves ComfyUI working on a clip nobody will collect.

**What this does not do** No progress for a resumed run, by construction (see above). A task that was *queued*
and not yet submitted is lost by a restart — it never cost GPU time, and pressing generate again is the fix;
that case is why `Resumed` is a per-task fact rather than a global "restart happened". And nothing survives
**ComfyUI** restarting: if its history does not know the prompt, the collect fails and the task says so.

**Tested** `make check` (three new: a submitted task comes back `Resumed` and alive while an unsubmitted one is
failed; `Collect` reattaches and never submits, and fails for a prompt ComfyUI does not know). `npx vitest run`
264. `npm run check` (i18n 822/808). `npm run build`. Not exercised in a real restart: the case worth trying is
a video mid-render, `Ctrl+C` and `./start.sh`, then watching the node say 等待结果 and finish with the clip.

**Where** `internal/task/task.go`, `internal/generate/runner.go`, `internal/server/{server.go,runs.go,routes_runs.go}`,
`frontend/src/types/canvas.ts`, `frontend/src/services/api/{runs,video}.ts`,
`frontend/src/pages/canvas/{project.tsx,hooks/use-generation-runs.ts}`,
`frontend/src/components/canvas/canvas-node.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`internal/task/task_test.go`, `internal/generate/generate_test.go`.

---


## 237. An answer is drawn as the document it is, and a table scrolls in its own box

**Decision** The panel parses the text parts of an **assistant** message as a small Markdown subset into tokens and
draws the tokens with React. A table's cells do not wrap: the table's own box scrolls sideways.

- **Tokens, never HTML.** `frontend/src/lib/markdown.ts` produces `MarkdownBlock[]` / `MarkdownInline[]` and
  `agent-markdown.tsx` maps them to elements; nothing is ever `innerHTML` and no parser was added. The words are a
  model's, quoting files on the canvas, in a page served over plain HTTP — a token tree cannot become a tag or a
  handler, and `<img src=x onerror=…>` is asserted to stay eleven characters of text. The second reason is that a
  citation has to stay a button: `renderText` hands every run of text back to `withMentions`, so formatting and
  citing walk the text together instead of one rewriting what the other produced.
- **The subset is what an answer writes**: headings, paragraphs, fenced code, quotes, rules, lists (nested, loose,
  numbered from whatever the model started on), tables with alignment, and inline code / strong / emphasis /
  strikethrough / links. Not in: images (a picture here is a node), raw HTML, footnotes, math, reference links,
  task boxes. A construct outside the subset is not an error — it stays the characters that arrived, which is also
  what a half-streamed `**` and a stray `|` are, and why an unclosed fence is the code written so far.
- **A soft break is a break.** CommonMark makes a newline a space; here it stays a line break, because that is what
  every reply already drawn under `whitespace-pre-wrap` did. Joining them would reflow the whole history to fix a
  rule nobody asked for.
- **A table is the reason this exists** and must not resize the card: cells are `whitespace-nowrap`, the table is
  `w-max` inside `max-w-full overflow-x-auto thin-scrollbar`, so a wide table scrolls under itself with the
  transcript and the input exactly where they were.
- **Only the assistant's text.** What the user typed is drawn as typed — their asterisks are theirs. Reasoning
  (folded, one line) and errors stay plain: neither is a document.

**Why not a library** Measured in a scratch directory, minified and gzipped: `marked` 14.2 kB plus a sanitiser
(+11.7 kB DOMPurify) and it still produces HTML, so it cannot interleave a citation button; `markdown-it` 40.7 kB and
7 packages, same wall; `react-markdown` + `remark-gfm` 48.6 kB and **93 packages**, exactly what #35's audit removed;
`snarkdown` 1.0 kB and no tables. Handwritten: 0 packages, entry 537.8 → 545.1 kB (160.1 → 164.2 kB gzipped), and the
cost is a file and its tests — the price the rest of this panel already pays.

**What a frame costs** Every delta re-renders, so the cost that matters is per frame. Measured in jsdom with a 4 kB
answer streaming at four characters a frame (absolute numbers are jsdom's and high; the ratios are the point): one
answer streaming 3.2 ms either way; **with ten finished 4 kB answers in the transcript, 73 ms before and 3.5 ms
after**; with forty finished answers it never finished before and is 3.6 ms after. Three things made it flat, none of
them a cache:

- **A finished message is not rebuilt** — `AnswerBody` / `PlainBody` are `memo` and their props are exactly what they
  read (text, the message's citations, the canvas's labels, the accent), all stable once a message is finished.
  Rebuilding every finished answer on every frame is what the 73 ms was.
- **The canvas's labels are mapped once per render** (`citationLabels`), not once per run of text — the old walk
  called the translator for every node on every run: 166 runs × 50 nodes per frame.
- **The citation tables are prepared once per message** (`mentionResolver`): sorting the labels inside the per-run
  scan cost 6.5 µs a run, 1 ms of every frame, and it is the same answer every time.

**Where** `frontend/src/lib/markdown.ts`, `frontend/src/components/canvas/agent-markdown.tsx`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/tests/markdown.test.ts`.


## 238. Stopping is a choice: the queued words can outlive the task

**Decision** A cancel carries AlayaCore's optional `keep_steering` argument, and the panel offers the choice
exactly while there is a queue it would decide about.

- **The word is AlayaCore's and the gateway forwards it.** `Session.Cancel(args string)` writes
  `{"command_id":"cancel","name":"cancel","args":…}`; an empty word is the bare cancel, which is what the
  socket-closed path still sends. The gateway does not translate `keep` into anything — the same rule
  `agent.Request` already states for commands: the pair is forwarded, and what it means is the agent's.
- **The socket already had a field for it.** `socketMessage.Args` was a command's; a cancel now reads it too,
  so one action did not grow a second representation (`cancelArgs`, or worse a second message type).
- **One optional word at the far end**: `commands.CancelArgKeepSteering` = `keep_steering`, declared as
  `Optional(Token(...))` on `cancel` and read by `cancelSteeringFate`. Empty drops the queue and announces
  `steering dropped — the task was canceled before it was delivered`; `keep_steering` leaves it to
  `deliverLeftoverSteering`, which promotes it to the next prompt and reports the batch `delivered`. Only what
  is queued at the instant of the cancel is settled — anything typed after it is a fresh intent. A signal or a
  keystroke carries no argument, so those paths always drop, which is why "stop" cannot silently keep going.
- **The choice is asked at the moment of stopping**, in a dialog, and only when there is a queue to decide
  about: press stop with `steering > 0` and the panel asks 「还有 N 条消息在排队…要一起取消吗?」 with the two
  answers the command has — 保留排队 (`keep_steering`) and 一起取消 (bare). With nothing queued, stopping has
  one answer and the button is it: no dialog over a question with no alternatives.
- **Two answers, not three.** Closing the dialog (X, Esc) sends nothing at all — the turn goes on — but that
  is what closing anything means, not an option the design offers. The earlier version of this put the choice
  on a checkbox in the steering notice, which asked the user to decide *before* they had decided to stop, kept
  a state nobody could see, and had to be reset every time the queue emptied; asking at the moment of the
  press has none of those problems and puts the count in the question.
- **Every other caller keeps the drop.** `cancelAgentSession(name)` with no second argument is what a node's
  one-shot prompt interruption sends, and `release()` on socket close sends `Cancel("")` — neither has a queue
  on screen to speak for.

**Why bother** The panel already showed 「N 条消息已排队」 and then threw those messages away when the stop
button was pressed — the one moment the user is most likely to want either answer, and the two are genuinely
different intents ("stop, I'll retype it" versus "stop this, then do what I just told you"). AlayaCore had
already built the distinction and the panel could not reach it.

**Tested** `make check` (one new: `TestCancelForwardsTheWordThePanelChose` — `keep_steering` reaches the frame,
and a bare cancel carries `"args":""` rather than dropping the field, read from the fake agent's own log).
`npx vitest run` 291. `npm run check` (i18n 824/810). `npm run build`. Not exercised against a real AlayaCore:
the case worth trying is queue two messages into a running turn, tick the box, press stop, and watch them
arrive as the next prompt (`delivered`, which the panel already uses to clear the counter).

**Where** `internal/agent/sessions.go`, `internal/server/routes_agent.go`, `internal/agent/session_test.go`,
`frontend/src/services/api/agent.ts`, `frontend/src/components/canvas/canvas-agent-panel.tsx`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.


## 239. Speech is a hop: the gateway carries one file to the address the page names

**Decision** The agent's prompt can be filled by talking: holding `Ctrl`/`⌘` + `'` (or the backquote above
Tab, #314), or holding the panel's microphone button, records while held and puts the transcript **at the caret**
on release. The server speaks
OpenAI-compatible `POST /v1/audio/transcriptions` (a WAV in, `{"text": …}` out).

**Amended by #246, #252 and #314** The address stopped being the only setting: the model name is a setting, the
credential lives on the server, and both now come from the active profile in `data/speech.json` rather than
travelling in the request. The hop, the WAV, the gesture and the caret are unchanged; #314 added a second key to
the gesture — the backquote, matched in `agent-dictation.ts` — without changing what the gesture does.

**Why the browser cannot make that request** Measured against the server this was built on (audio.cpp, `model=refine`,
Qwen3-ASR-0.6B): it answers **no CORS headers** — `OPTIONS` is a 404 and a `POST` comes back without
`Access-Control-Allow-Origin` — so a page on the gateway's origin can send the request and never read the answer. The
address is also usually `127.0.0.1`, which is true of this machine and no other: a canvas opened on a phone over the
LAN would be asking the phone for a speech server. So the page posts to `/api/speech/transcriptions` and the gateway
posts onward. The address travelled **in the request** rather than from `data/settings.json`, because the gateway
deliberately understands no key in the preferences document (`internal/settings`) and this route had no reason to
become the first exception.

**Why only WAV, and why the encoder is ours** The same server refuses anything that is not a real WAV —
`MediaRecorder` produces webm/opus (Chrome) or mp4 (Safari), both refused by name, and renaming the file does not
help because the bytes are sniffed ("input is Matroska/WebM, not WAV"). So the panel captures raw samples through
the Web Audio graph (`ScriptProcessorNode` — deprecated, and still the shortest path that starts inside the gesture
with no second module) and writes the 44-byte header itself (`frontend/src/lib/wav.ts`). No resampling here: the server was
measured transcribing 24, 44.1 and 48 kHz with the reported duration intact, so the true rate in the header is less
code and less to be wrong about.

**Why `Ctrl`/`⌘` + `'`** A quote is what a person uses to quote speech, and the chord collides with nothing: `Space`
is the canvas's temporary tool, `Shift` alone is additive selection, `Ctrl` alone is the temporary tool and the
multi-select click, and a printable in the chord means it cannot start by accident the way a held modifier can.
`Ctrl+'` types nothing and is bound by no browser; `⌘+'` is Firefox's quick-find on macOS, which is why `Ctrl` comes
first. Repeats are dropped (`event.repeat`) and losing focus ends the recording — the one failure worth code, a held
key whose keyup lands on a page that is not listening.

**Why the caret** Speaking is another way of typing, so it does what typing does: the words go in at the caret,
replacing a selection, and the caret ends after them (`frontend/src/lib/canvas/agent-dictation.ts`, a pure function of the draft
and a range — the only way to test it without a DOM). The range is the box's own selection, which a textarea keeps
while unfocused (exactly the state it is in, since the gesture began on the canvas), with the end of the draft as
the answer for a box never touched. A gesture under 0.2 s of sound is dropped silently rather than sent and refused.

**The language is a hint, measured rather than assumed** `language` follows the interface (`zh`/`en`), which raised
the obvious question — an English interface and a Chinese sentence. Tested on the same server: English audio
transcribed correctly under a `zh`, a `Chinese` and a garbage `English-zh` hint alike, and Japanese audio correctly
under `ja`, `zh`, `en` and auto; the field is advisory on this model ("Recognition language code or label. Omit to
detect language automatically"). A wrong hint does not corrupt an answer, so the interface language is a safe
default and one line to change if a server is ever found where it is not.

**Where** `frontend/src/lib/{wav.ts,canvas/agent-dictation.ts}`, `frontend/src/components/canvas/canvas-agent-panel.tsx`,
`internal/server/routes_speech.go`, `docs/server.md`.


## 240. The binary is `comfyloft-server`, and nothing is called a gateway any more

**Decision** The service is `comfyloft-server`. The binary, the package (`cmd/comfyloft-server`), the
environment (`COMFYLOFT_SERVER_HOST` / `COMFYLOFT_SERVER_PORT` / `COMFYLOFT_SERVER_ROOT`), the per-host agent
configuration directory (`<UserConfigDir>/comfyloft-server/<host>/alayacore`), the Go identifiers, the
frontend identifiers and file names, and the documentation all say **server**. `bin/` is now
`comfyloft-server` and `comfyloft-mcp` — one prefix, two programs, which is what it should have been.

**Why** "Gateway" described one of the five things this process does, and the smallest one. It proxies
ComfyUI's generation; it also serves the canvas bundle (`GET /`), answers `/config.js`, owns the canvases,
uploads and preferences on disk, runs the loopback MCP listener the agent calls back through, and — as of
#239 — carries a WAV to a speech server. A reader who meets "the gateway owns your canvases" has been told
something false by the name. #138 had already drawn the line "that is the binary, not the product" and left
`comfyui-gateway`; that was the right distinction applied to the wrong word.

**No compatibility, on purpose** There are no users, so nothing here keeps the old spelling alive: no aliased
environment variable, no fallback config directory, no shim binary. A single accepted name is the whole point;
a migration path for a thing that has never been released is a permanent second source of truth paid for up
front. This is also why the on-disk agent directory moves rather than being read from both places.

**What was renamed, mechanically** 81 Go files, 78 frontend files, 8 moved files
(`cmd/comfyui-gateway` → `cmd/comfyloft-server`, `docs/server.md` → `docs/server.md`,
`services/api/server-status.ts` → `server-status.ts`, `lib/gateway-{labels,models}.ts` → `server-*.ts`,
`hooks/use-local-server-sync.ts` → `use-local-server-sync.ts`,
`components/layout/server-reconnect-banner.tsx` → `server-reconnect-banner.tsx`, and two test files). Go
identifiers went with the rest: `cfg.GatewayHost` → `cfg.ServerHost`, `newTestGateway` → `newTestServer`,
`LOCAL_GATEWAY_URL` → `LOCAL_SERVER_URL` (the wire name in `config.js` too — one rename, both sides), and a
handful of locals that collided with the new name were given their own rather than a number.

**What keeps the word** HTTP 502 is *Bad Gateway*, and the one string that reports it says so: the apiErrors
key stays `badGateway`, Chinese keeps 「网关错误（502）」, English keeps "Gateway error (502)". That is the
protocol's name for a status, not this program's name. `GATEWAY_TOKEN` survives only inside historical records
that describe a token that no longer exists. No prose in `docs/decisions.md` before this entry was rewritten:
the log records what was decided and in which words, and rewriting "the gateway" out of #1–#239 would be
editing the past to look consistent. What *was* rewritten there is anything a reader follows — the ten
`comfyui-gateway` paths, the `docs/server.md` links and the `GATEWAY_*` variable names — because a pointer to
a file that no longer exists makes the whole log unfollowable .

**Tested** `make check` (19 packages; five test functions needed their two `startMCPServer` results
disambiguated — both were called `gateway` and then `server`, so the blanket rename produced `server, server`),
`npx vitest run` 311, `npm run check` (i18n 836/822 with `server.models` / `server.variants` declared as
dynamic prefixes, 178 modules, prettier, tsc), `npm run build`. The page was then loaded from
`http://127.0.0.1:8190` against the rebuilt binary and the agent socket connected — which is how #241 was
found.

**Where** `cmd/comfyloft-server`, `internal/{config,server,workflow,setup}`, `Makefile`, `start.sh`,
`.env.example`, `docs/{server,protocol,known-issues,decisions}.md`, `README.md`, `frontend/src/**`,
`frontend/{scripts,tests}/**`.


## 241. The server's address is the page's, never the document's

**Decision** `config.baseUrl` and every channel's `baseUrl` are filled from `LOCAL_SERVER_BASE_URL` — the origin
that served the page, or `PUBLIC_BASE_URL` when the operator named one (#220) — and a stored address is
discarded on hydration. It is not a preference any more; it is a fact about where the page came from.

**The bug** Open the canvas at `http://192.168.3.232:8190`, restart the server on `127.0.0.1`, open the page
again: everything still dialled `192.168.3.232`, the agent's socket included —
`ws://192.168.3.232:8190/api/agent/socket/canvas%3A2dfdadcd440f failed: net::ERR_CONNECTION_REFUSED`. The
address was stored in `data/settings.json` when the channel was created, and `createModelChannel` kept what it
found: "The stored address is the server root". That sentence was true when a channel could be a cloud provider
you typed an address into. There is no such channel any more (the tab that added them is gone), and the
server has served the canvas itself since #219 — so the only address a stored one can disagree with is the one
the page is on.

**Why the page wins** It is the one value that cannot be stale: the bundle came from that origin, so the API is
there too. Any other answer is a memory, and memories of a moved server fail in the worst way — the page loads,
the canvas draws, and only the things that talk to the server break, one at a time.

**Tested** `frontend/tests/server-address.test.ts` seeds a settings document that names the old machine and a page that
is on the new one, then asserts that the document's address, every channel's address, the models and the stored
selection are what the store hands out. Verified to fail against the previous code (`×` on both address
assertions, `✓` on the models) so it pins the bug rather than the fix. `npm run check`, `npx vitest run` 314,
`make check`, `npm run build`.

**Where** `frontend/src/stores/use-config-store.ts`, `frontend/tests/server-address.test.ts`.


## 242. A page that cannot have a microphone says so, instead of throwing

**Decision** Before a gesture asks for the microphone, the panel asks whether this page can have one:
`navigator.mediaDevices.getUserMedia` only exists in a **secure context** — https, `localhost`, or an origin
Chrome has been told to trust. When it is missing, the panel shows a sentence naming the address and the two
ways out, and no permission prompt is raised.

**The report** `Cannot read properties of undefined (reading 'getUserMedia')`, from the run documented in #239,
on `http://192.168.3.232:8190/canvas/2dfdadcd440f`. The page was served over plain http from a LAN address, so
the browser had not "denied the microphone" — it never offered the API at all, which is why the error was a
`TypeError` about a missing object rather than a rejected promise. A browser will not give a page a microphone
on an insecure origin, and no code can change that; what code can do is not blame the microphone.

**Why the sentence carries the workaround** The two fixes are both outside the app — trust the origin in
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, or open the canvas over https / from `127.0.0.1` —
so a shorter message ("microphone unavailable") would leave the reader with a feature that is simply gone.
The same check also covers the practical case that follows from it: recording works on the desktop and not on
the phone until the canvas is served over https, which is stated in #239 and is nobody's bug.

**Tested** `npm run check` (i18n 837/823), `npx vitest run` 314, `make check`, `npm run build`. Not testable
here in the only way that matters: the predicate itself is one expression over a browser global, and the
browser is not in this tree — the run that reported the error is the test.

**Where** `frontend/src/lib/pcm-recorder.ts`, `frontend/src/components/canvas/use-hold-to-talk.ts`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.


## 243. The agent's directory belongs to the machine, not to the bind address

**Decision** `<UserConfigDir>/comfyloft-server/<segment>/alayacore` keys `<segment>` by `os.Hostname()`, not by
`COMFYLOFT_SERVER_HOST`. Changing the address the server listens on no longer moves the agent's models, its API
keys or its `runtime.conf`.

**Why** #241 was the same disease one layer down: a stored address outliving the address it named. Here the
address was in a *path*, and the cost was the operator's model list. The trigger was mundane — the microphone
needs a secure context (#242), so `COMFYLOFT_SERVER_HOST` went from `192.168.3.232` to `127.0.0.1`, and the agent
started in a directory that had never been used: no `model.conf`, so AlayaCore wrote its placeholder model
(`Ollama (127.0.0.1) / MiniCPM-V 4.6`, protocol `anthropic` at `http://127.0.0.1:11434`), and the first message
came back `provider stream failed: API error (status 404): 404 page not found` — which is Go's own 404 text,
from a model that was never the user's.

**Why the old reason does not survive** The comment it replaces said one directory per host because `mcp.conf`
names the address an agent dials back to. But `mcp.conf` is rewritten on every start (`writeMCPConf`) for the
address in use, so it is the one file that cannot go stale, and nothing per-address needs to be preserved. What
is preserved here — models, keys — belongs to the operator and has nothing to do with which interface the server
is bound to. Per **machine** the split still earns its keep: two machines sharing one home directory would
otherwise fight over the same `mcp.conf`.

**Tested** `TestAgentDirectoryDoesNotMoveWithTheBindAddress` (loads the config twice, on a LAN address and on
loopback, and requires the same directory while requiring that the bind itself did change, so the test cannot
pass by the variable being ignored) and `TestAgentHostDirIsASafePathSegment` (no separator, colon or space, and
stable). `make check` 19 packages, `npx vitest run` 314, `npm run check`, `npm run build`.

**Where** `internal/config/config.go`, `internal/config/config_test.go`.


## 244. A test server keeps its own agent directory

**Decision** `newTestServer` passes `config.WithAgentConfigPath(<temp dir>)`, and the two helpers that used to
set `AGENT_CONFIG_PATH` in the environment pass the option instead.

**Why** `config.Load` fills `AgentConfigPath` from `<UserConfigDir>` when nothing names one, and `server.New`
writes `mcp.conf` there at startup (`writeMCPConf`). So every `make check` wrote into the developer's home
directory — `~/.config/comfyloft-server/<machine>/alayacore/mcp.conf` — and, once the agent's directory was keyed
by the machine (#243), that also meant a test run could create the directory the *next* real start would use.
A test that writes into the operator's configuration is wrong twice: it is not isolated, and the thing it
writes is the file that tells an agent where to call back to.

**Why the option and not the environment** The environment variable still works for the binaries, but options
are applied *after* the environment when `Load` runs, so a test that sets both would silently keep the
environment's answer. One mechanism, applied last, is easier to reason about than a precedence rule.

**Tested** `rm -rf ~/.config/comfyloft-server` then `make check`: exit 0 and the directory is not recreated.
`npx vitest run` 314, `npm run check`, `npm run build`, `make build`.

**Where** `internal/config/config.go`, `internal/server/e2e_test.go`, `internal/server/{mcp_test,agent_e2e_test}.go`.


## 245. No segment: the agent's configuration is `comfyloft-server/alayacore`

**Decision** `<UserConfigDir>/comfyloft-server/alayacore`, and nothing between the two. #243 replaced the bind
address with the machine name; that is now gone as well.

**The three keys, and what each cost** The directory holds `model.conf` (the operator's models and API keys),
`runtime.conf` (which of them was active) and `mcp.conf` (the address an agent dials back to, rewritten at every
start).

- **The bind address** — lost the models whenever the address moved, which is what happened (#243).
- **The hostname** — the same failure, one order of magnitude rarer: it takes a renamed machine rather than a
  changed port. Rarer is not the same as right.
- **Nothing** — the models are the operator's, and the operator has one set of keys whether the server listens
  on loopback or on the LAN. This is the answer.

**What dropping the segment gives up** Two machines sharing one home directory (an NFS `$HOME`) and running a
server each would write the same `mcp.conf` and fight over it: the last one to start wins, and the other
machine's agent dials a socket that belongs to its neighbour. That is one operator with a shared home, which is
both rare and — unlike the two failures above — something the operator would immediately suspect, since an
`AGENT_CONFIG_PATH` in the unit file is already the normal way to run two servers from one home. A path that
never moves beats a path that defends a setup nobody has.

**Tested** `TestAgentDirectoryDoesNotDependOnWhereTheServerListens` (two loads, a LAN address and loopback, same
directory — while requiring the bind itself to have changed, so it cannot pass by the variable being ignored)
and `TestAgentDirectoryHasNoSegmentOfItsOwn` (the path ends in `comfyloft-server/alayacore`). `make check`
19 packages. The migration on this machine is one `mv`: `~/.config/comfyui-gateway/*/alayacore/model.conf` →
`~/.config/comfyloft-server/alayacore/model.conf`.

**Where** `internal/config/config.go`, `internal/config/config_test.go`.


## 246. The speech server's model and key are settings; the key never leaves the server

**Decision** Three facts about the server at the other end, each where the protocol says nothing: the **address**
(#239), the **model name** (a setting, default `refine`, blank meaning "send no model"), and the **credential** —
stored on this server as `data/speech-key.json` mode `0600` and sent as `Authorization: Bearer` on the request this
server makes. The page can ask whether one is stored, replace it, or clear it; it never receives it. (Those were
two routes, `GET` and `PUT /api/speech/key`; #252 deleted them with the key file, so nothing answering that path
exists today — a reader following it would be following a route that is gone.) A refusal from the speech server keeps its **status** as well as its words: 401, 413 and 429 pass
through as themselves and only a 5xx becomes 502.

**Amended by #252** The address, the model and the key are now one active profile in `data/speech.json`, and the key
file of this entry is no longer read (left on disk, with one log line saying so). The reasoning below is why the key
never entered the preferences document, which is unchanged.

**Why the model had to stop being a constant** Measured against `127.0.0.1:18080` (audio.cpp) and against OpenAI's
OpenAPI spec:

- `POST /v1/audio/transcriptions` is OpenAI's shape, copied by every compatible server, and its
  `CreateTranscriptionRequest` is `required: [file, model]`. audio.cpp agrees and enforces it: no `model` answers
  `500 multipart transcription request requires a 'model' field`, an empty one the same, `model=whisper-1` answers
  `500 unknown model id: whisper-1`.
- The name is a fact about one machine. `GET /v1/models` there lists `refine` (qwen3_asr, offline, rtf 0.36 on a
  second of audio) and `stream` (SenseVoice-Small, rtf 0.04 — and it answered a pure tone with "Okay.", where
  `refine` answered nothing). OpenAI's enum is `whisper-1`, `gpt-transcribe`, `gpt-4o-transcribe`,
  `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, two of them with an announced shutdown date of 2027-02-26. A
  name baked into the build fits one machine and, on that machine, expires.
- So `refine` is a default matching the default address, and blank is honest for the one shape that names nothing
  (`whisper.cpp`'s `/inference`). The empty case is not an error here: a server that wants a model says so in its own
  words, and a name invented by this build would be worse than the silence.

**What is deliberately not a setting** `additionalProperties: false` on OpenAI's request object makes an extra field
an error rather than a shrug (audio.cpp ignores what it does not know — `response_format`, `temperature`, `prompt`
and a `bogus_field` all answered 200). `response_format` defaults to `json`, the only format `gpt-4o-transcribe`
accepts and the only one this build reads, so configuring it would be a way to break dictation. `language` follows
the interface and is advisory (#239). The audio is 16 kHz mono WAV, on the allowed list, and the server resamples for
itself. A field for any of these would be a field that can only be set wrong.

**Why the key is not in the preferences document — measured, not assumed** `data/settings.json` is served whole by
two routes that need no authentication: `GET /config.js`, which the page loads before its bundle so the first frame
is themed (#220), and `GET /api/settings`. It is also, when the operator names `RUNTIME_CONFIG_PATH`, written out as
a file **for a static host with no server in the request path**. A credential there is a credential for every client
that can load the canvas, and a published one for the internet. The rule already existed for the agent's model keys
(`agent.Model` carries `hasKey`, never `api_key`), and the speech key followed it.

**The two costs of that choice** The key cannot be shown, only replaced: a password field that autosaved would write
a half-typed credential on every keystroke, so this is the one control in the window with a Save button, and a blank
field means "keep what is stored" (`apiKeyKeepHint`). And the field cannot be filled from the page's own state, so
the section asks the server once when it opens.

**Where** `internal/server/routes_speech.go`, `internal/store/` (the key file this entry introduced),
`frontend/src/components/settings/`, `docs/server.md`.


## 247. Sweep after #246: two gates the rename left red, a silent error, a map nobody read

**Decision** Four things the sweep found and fixed, and one it did not touch.

**The rename left two gates failing (#240's tail).** `frontend/scripts/check-i18n.cjs` still listed
`ZH_ONLY_PREFIXES = ["gateway.models.", "gateway.variants."]`, so after the rename to `server.*` fourteen keys
(`server.models.*.label`, `server.variants.*`) were reported as "only in zh-CN" and the gate exited 1 — with
the summary line `failed: 0 dead key(s), 0 missing key(s)` printed just above it, which is how it went
unnoticed: the counts read clean and the exit code was not looked at. `check-exports.cjs` still had its
`TEST_ONLY` reason keyed to `src/lib/server-models.ts:modelsOf`, which the rename had moved to
`frontend/src/lib/server-models.ts`, so the same run reported that export as having only a test's caller. Both are
strings in scripts that nothing compiles, and the only thing that can catch them is running the gates —
which is the whole reason `npm run check` is a gate. Fixed, and the two comments that still said
`lib/server-labels.ts` now name `frontend/src/lib/server-labels.ts`.

**An error with nothing to say rendered as an empty message.** `httpx.WriteError` opened with
`message := "Internal error"` and then assigned it on both branches, so `ineffassign` flagged the literal as
dead — and it *was* dead: an error whose `Error()` is `""` (or a `*httpx.Error` with a blank message) reached
the canvas as `{"message":""}`, a blank toast that cannot be told from a broken renderer. The literal is now
the fallback it was always meant to be, with a test over both spellings of a silent error.

**`Hub.promptByRequest` was written and deleted and never read** (`internal/generate/preview.go`) — a map kept
in step with `progressByPrompt` by hand, and one more thing for a future change to keep in step for no reason.
Removed.

**Verified and left as it stands.** `go vet`, `gofmt`, `go test -race ./internal/...` and `golangci-lint`
(errcheck, govet, ineffassign, staticcheck, unused) are clean, the last two having nothing to report but the
`ineffassign` above and two SA5011 false positives in tests that are guarded by `t.Fatal`. No `@ts-ignore`, no
`as any`, no `console.log` in `frontend/src`. No `comfyui-gateway` string anywhere outside `docs/decisions.md`.
The missing timeouts are deliberate and documented where they are: `internal/comfy` puts a deadline on each
request rather than on the client ("that is what allows a 10-minute video job"), `cmd/comfyloft-server` sets
`ReadHeaderTimeout`/`IdleTimeout` and no global write timeout for the same reason. Uploads are bounded twice
(`MaxUploadBytes` per file, `ParseMultipart` stopping at the ceiling rather than spooling).

**Docs brought back in line.** `docs/known-issues.md` #2's list of exported Go symbols with no caller was
stale in two entries — `WithPublicBaseURL` and `OutputPath` are called by tests — and is now eleven, verified
symbol by symbol; it also records why a `deadcode` scan cannot run here (`proxy.golang.org` unreachable).
`README.md` and `docs/server.md` name the new file where they inventory the data directory.

**Tested** `make check` 19 packages, `npx vitest run` 321, `npm run check` (843 zh / 829 en, 178 modules,
prettier and `tsc` clean), `npm run build` 556.94 kB, `make build`.

**Where** `frontend/scripts/{check-i18n,check-exports}.cjs`, `internal/httpx/httpx.go` (+`_test.go`),
`internal/generate/preview.go`, `docs/{known-issues,server}.md`, `README.md`.


## 248. An agent is asked to quit, never killed, and shutdown asks every agent

**Decision** Ending an agent is one `CI` command frame — `{"command_id":"quit","name":"quit","args":""}` — and
nothing else. `Process.Release` sends it, gives the agent `releasePatience` (2 s) to end, sends end of input as
the second request, gives it 2 s more, and then **returns without killing it**. `Sessions.CloseAll` releases
every session in parallel, and `Server.Close` calls it: the shutdown path used to leave agents to the pipes
closing on process exit, which is not a promise anyone had written down.

**Why the command and not a signal** `quit` is AlayaCore's own exit (`docs/commands.md` in its tree: "End the
session. A task that is already running is allowed to finish first"), and a rawio client quits with exactly
this frame. It is also the *only* way out that is not destructive: a socket closing mid-turn is the common case
— the page was closed while the agent was writing a node — and a signal there loses the turn the canvas asked
for, silently. `SIGTERM` and `SIGKILL` were in a draft of this change and were removed: they were a guess about
what a wedged agent needs, and the answer to "it has not finished yet" is to let it finish, not to end it.

**The hang that was there** `Release` closed stdin and then waited for the process with no bound. It is called
from `Sessions.Close`, which is called from three places, two of them on a path where the wait is visible: the
`DELETE /api/agent/session/{session}` handler answers from it, and shutdown reaches it through `Close`. An agent
that did not read its input — wedged, or working — would have hung an HTTP request forever and a stop
indefinitely, and the comment there said the OS would reap it, which it will not: `Wait` blocks. Both waits now
have a bound and a log line when the bound is hit. The trade is explicit: a server that stops on time, and an
agent left to end when its task does.

**What `CloseAll` is for** `Sessions.Close`'s own comment claimed it runs "when the server is shutting down",
and nothing called it there: `Server.Close` closed the MCP listener and stopped. In practice agents ended when
the process exited and their stdin closed — an ordering nobody owned, and one that a wedged agent survives. It
is a line now.

**One frame at a time** `Process.Write` writes a frame and then flushes it, which is two calls, so a `quit`
racing a prompt could put half of each on the agent's stdin. The new `writeMu` holds a frame's bytes together;
the session's own lock is still what orders a *sequence* (a prompt and its images).

**A false alarm, recorded because the sweep reported it** The pid this was chased from — an `alayacore` process
alive for ten hours — turned out to be a hand-started agent on a terminal (`/dev/pts/4`, cmdline `alayacore`,
parent an interactive shell), not a leftover of a server. There was no evidence of the leak it was written up
as, and the entry that claimed one is deleted rather than left standing: a known-issues file that keeps a
problem nobody has seen is the same defect as a comment that lies. The two real gaps above were found while
looking, and they are fixed.

**Tested** `internal/agent/release_test.go`: the frame on the wire is exactly the `quit` command; an agent that
exits on it is reaped and remembered as a clean exit; one that answers neither request is **still alive**
afterwards (the assertion the whole decision is about) and `Release` returns on the bound; `CloseAll` empties
the list and every pid is gone. The test double gained the real agent's answer to `quit` (a `CO` and an
`SM session closed`), which also took the package's tests from 57 s back to 4 s — they had been waiting out the
patience because the double spoke one frame fewer than the real thing. Verified against the real binary by
stopping the server: the agent exits on the frame, logging a clean `exit pid=… err=<nil>`.

**Where** `internal/agent/{spawn.go,sessions.go}` (+`internal/agent/release_test.go`, `internal/agent/session_test.go`'s `fakeAgent`),
`internal/server/server.go`, `docs/known-issues.md`.

**Superseded in part by #250**: the release is end of input and then a kill, and `quit` is not on that path.
`CloseAll` and the per-frame write lock are what remains of this entry, and both stand.


## 249. The model form has every field of the entry, and the reasoning blocks are JSON the user types

**Decision** A model's `model.conf` entry is editable in full from the preferences window. The page is shown
every field but the key — `context_limit`, `max_tokens`, `reasoning_0/1/2`, `reasoning_field`,
`serial_tool_calls` joined the five that were there — and every one of them is a field the merge will replace
(`agent.modelEditorFields`). The three reasoning blocks are edited as **JSON text**, because that is what they
are, and a cleared box sends `null`, which removes the block.

**What was wrong** The form showed five fields and the server replaced four. AlayaCore's entry has twelve:

```
name, protocol_type, base_url, api_key, model_name, context_limit, max_tokens,
reasoning_0, reasoning_1, reasoning_2, reasoning_field, serial_tool_calls
```

So a user whose provider needed a 65536 output cap, a `reasoning_field`, serial tool calls or a per-level
thinking block had to open `~/.config/comfyloft-server/alayacore/model.conf` in an editor — and the next edit
in the UI round-tripped the file through a `model_sync` that kept those values but could never change them.
Measured on the real agent before and after (`alayacore --rawio … < /dev/null`, one startup broadcast):
`{"id":1,…,"context_limit":262144,"max_tokens":65536,"reasoning_1":{"reasoning_effort":"medium"},
"reasoning_2":{"reasoning_effort":"xhigh"},"serial_tool_calls":false}`.

**Why the blocks are text and not named fields** `reasoning_N` is "raw provider-level JSON merged into the
request body at that level" (AlayaCore's own words). OpenAI wants `{"thinking":{"type":"enabled"},
"reasoning_effort":"high"}`; Anthropic wants its own vocabulary inside the same field; a third provider will
want a third. A form of named fields would be a form that can only describe the two providers somebody thought
of, and would have to be rebuilt for the third. The text is the value, and the form's whole contribution is
saying when it does not parse.

**The one place `null` is the answer.** Everywhere else, a field left empty says nothing and the stored value
stands — the `api_key` above all, which the page has never been shown. A reasoning block is different: the form
displayed it, so emptying the box is a decision, and it is sent as `null` and merged away. *Absent* still means
"nothing to say", which is what keeps this honest for a browser running a bundle from before this change: it
does not know these fields exist, so it must not be able to delete them.

**Where the refusal lives** A block that is not a JSON **object** is refused twice: the form keeps Save off and
says which of the two things is wrong (`reasoningError`), and the merge refuses it again with a sentence naming
the field (`model_sync: reasoning_1 must be a JSON object, or empty to remove it`). The second exists because
the first is a browser: the blocks go into a request body as they stand, so a string or an array would be a
request AlayaCore sends malformed, and `model.conf` is not a file to learn that from.

**Numbers as text in the form** `contextLimit` and `maxTokens` are strings in the draft, not numbers: a
half-typed `1` on the way to `1000000` must not become a `NaN` that reads as zero, and a cleared box means zero
— which is what `model.conf` writes for "not set". `InputNumber` gives back `null` for empty, and the draft
converts both ways in one place (`frontend/src/lib/agent-models.ts`).

**Tested** `internal/agent/models_test.go`: the list a canvas sees carries the token caps, the blocks, the
reasoning field and the tool-call mode (and still no `api_key`); an edit replaces every one of them; a cleared
block is removed while the key stays; a page that never mentions a block does not delete it; a block that is a
string, a number or an array is refused by name. `frontend/tests/agent-models.test.ts` (19 tests): the draft
fills every field and shows a block as indented JSON, `null` is sent for a cleared one, an empty
`reasoning_field` is sent as nothing, a cleared cap is `0`, and `reasoningError` separates "not JSON" from "not
an object". Verified live against the real agent's startup frame, above. `make check` 19 packages, `npx vitest
run` 330, `npm run check` (853 zh / 839 en), `npm run build` 560.88 kB.

**Where** `internal/agent/{events.go,models.go}` (+`internal/agent/models_test.go`), `frontend/src/services/api/agent.ts`,
`frontend/src/lib/agent-models.ts`, `frontend/src/components/settings/agent-model-dialog.tsx`,
`frontend/tests/agent-models.test.ts`, `frontend/scripts/check-i18n.cjs` (two hand-resolved keys),
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.


## 250. A release ends input, waits two seconds, and then kills; `quit` is not on that path

**Decision** Ending an agent is two steps: close its stdin, wait `releasePatience` (2 s), and kill it if it is
still there. The `quit` frame #248 sent first is gone from this path. `Sessions.CloseAll` on shutdown and the
per-frame write lock stay as #248 left them.

**Why `quit` had to go** Its semantics are the problem, not its implementation: AlayaCore's `:quit` is "a task
that is already running is allowed to finish first". For an agent with nothing in flight, end of input ends it
in a second and `quit` buys nothing. For an agent with something in flight, `quit` defers to that task — and
the case where a release is *needed* is the case where the task does not finish: a loop, a wedged provider
call, a tool that never returns. So the one command that exists could only help where it was not needed. Its
terminal interface completes the pair by asking a person whether to `cancel` first; there is no person here.

**What end of input is** Measured on the real binary before writing this: a `--rawio` session whose stdin
closes ends by itself — it finishes the current step, writes `SM{"type":"session","data":{"state":"closed"}}`
and exits. Mid-turn and idle alike, about a second. So the first step is not a signal and not a negotiation; it
is the agent's own end of input, and the kill is only for the process that does not take it.

**The trade, said plainly** A kill can cost the tail of a turn in flight, and nothing else: the conversation
file already holds what was written, and the sessions here are short. In exchange a release always ends —
which matters because it is on the request path (`DELETE /api/agent/session/{session}` answers from it) and on
the way out, where an agent that will not end is a server that will not stop. The earlier shape of this — close
stdin and wait forever (#248's predecessor) — had no bound at all; #248's — ask, then leave it running — had a
bound but no ending. This has both, and gives up the tail of one turn to get them.

**Tested** `internal/agent/release_test.go`: an agent that ends on end of input is **not killed** (its exit
status is not a signal) and `Release` returns as soon as it goes; an agent that never reads its input is killed
and `Release` returns within the wait plus the kill; `CloseAll` releases both of two sessions and leaves none
alive. The test double dropped the `quit` answer it had gained in #248, since nothing sends that frame now —
and the package's tests went from 3.9 s to 1.5 s with it.

**Where** `internal/agent/spawn.go` (+`internal/agent/release_test.go`, `internal/agent/session_test.go`), `docs/decisions.md` #248.


## 251. A dictation gesture stops itself at a minute

**Decision** One recording may hold `MAX_SPEECH_SECONDS` (60 s) of sound. At the cap the recorder ends itself,
hands what it has to the hook, and the words still land at the caret; the panel says why the microphone
stopped, in the quiet line rather than the red one, because nothing failed.

**Why a cap at all** The gesture is *held*, so its length is the user's and the window's at once: a pointer
capture that never releases, a key whose keyup the window never hears, a person who walks away mid-sentence.
Today that records until the tab closes and uploads the lot on release — a minute of someone's room in memory
and on the wire. Nothing else enforces this: the server bounds the *upload* (`MaxUploadBytes`, 50 MB ≈ 26
minutes of this format) because that is its business, and it would transcribe a longer file happily. The cap is
about how long a person may hold the button, which only this side knows.

**Why a minute** It is already far longer than a dictated prompt — the gesture is one breath of text, and this
is a paragraph — and it is where the wait stops being free. Measured against the server this build was built
for (rtf ≈ 0.12 on `refine`, 0.04 on `stream`): 30 s → 3.6 s, 60 s → 7.2 s, 120 s → 14.4 s, 300 s → 36 s of
transcription, at 32 kB/s of audio. Seven seconds is a wait a person will sit through after speaking a minute;
fifteen is one they will not, and the failure mode of a lost keyup would then be a long wait for a long
recording nobody asked for.

**Ended, not discarded** The cap is a stop, not a refusal: `finish()` in the recorder remembers its result, so
the cap ends the recording and the later release reads the same samples (a second, empty recording is exactly
the bug this shape avoids). The hook marks the gesture as ended-by-length and the notice is set on the way
through, so the transcript arrives with an explanation next to it.

**Tested** `frontend/tests/agent-dictation.test.ts`: a sample short of the minute is still recording, the
minute ends it at 16/44.1/48 kHz, a zero rate says nothing, and the constant stays in a range a person would
recognise. `npx vitest run` 334, `npm run check` (853 zh / 839 en, 178 modules), `npm run build`. The recorder
itself needs a browser and a microphone, so what is tested is the rule, not the capture — the same line #239
drew.

**Where** `frontend/src/lib/canvas/agent-dictation.ts`, `frontend/src/lib/pcm-recorder.ts`,
`frontend/src/components/canvas/use-hold-to-talk.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/src/i18n/locales/{zh-CN,en-US}.ts`,
`frontend/tests/agent-dictation.test.ts`.


## 252. Speech servers are a list, and the active one is what dictation uses

**Decision** Speech-to-text has more than one server. A list of **profiles** lives in `data/speech.json` (mode
`0600`): a name, an address, a model name and a key each, one of them active, and the active one is where a recording
goes. `GET /api/speech/profiles` answers `{"profiles":[{id,name,url,model,hasKey}],"active":<id>}`, `PUT
/api/speech/profiles` takes the **whole list** back with one entry added, changed, removed or activated, and
`POST /api/speech/transcriptions` names no server at all. This replaces the single `asrUrl`/`asrModel` pair and the
single `data/speech-key.json` of #246, and it retires one sentence of #239: the address no longer travels with the
request.

**Why a list** #246's own words were "the key is one value, not a keyring: this build talks to one speech server" —
and that stopped being true the moment the address, the model and the key became settings. A workspace is used from a
desk with a local audio.cpp on the CPU and from a café with a hosted whisper; one field each means editing all three
between them, or leaving an address pointing at a machine that is not there. Profiles are the shape the agent's models
already have (#249), so the window keeps one list pattern and one dialog pattern instead of two.

**Why the list is the server's** A profile *is* an address **and** a credential, and the preferences document is
served whole by `GET /config.js` to every browser that loads the canvas, and written out as a file for a static host
when the operator names `RUNTIME_CONFIG_PATH` — measured, not assumed (#246). So the key cannot live in it, and a list
with per-profile keys can only live where the keys are. The page is shown `hasKey` and never a key, exactly as
`agent.Model` is. The form's only keys are the ones the user has just typed.

**The five rules that make one list safe to write from two windows** The whole list goes back in the page's order, so
a missing entry is a deleted profile — the same rule `model_sync` takes, and one atomic rename rather than a sequence
of edits that can half-apply. An entry that arrives **without a `key` field says nothing** about the stored key, which
is how a key survives an edit to the address; `""` removes it, and removing one is a checkbox, because a blank field
cannot mean both "keep" and "delete". An **id the server does not have is refused** (`speech_profile_unknown`, 400)
rather than adopted: two pages disagreeing is a reload, not a duplicate. **Ids are the server's to assign** — a page
sends none for a new profile — so no client invents an id another client's list already has. And **the active id is
never 0 while a profile exists**: an id that names nothing becomes the first entry, so deleting the active profile
leaves the microphone working instead of failing with nothing on screen explaining it.

**What the request carries now** `file` and `language`, and nothing else. The model and the credential come from the
active profile, so a form field cannot redirect a recording — the old route forwarded every field the page sent except
`url` and `key`, which meant a `model` field could name a model the user never configured. `language` stays the
page's because it is a fact about one utterance, not about the server.

**Two costs** A profile's address, model and `hasKey` are on the server, so the window reads them when it opens — a
failed read says so, and Add waits for the answer, since a PUT that merges into a list the page has not seen would
delete the profiles it does not know about. And `data/speech-key.json` from #246 is no longer read; it is left alone
rather than deleted (a credential is not this process's to remove) and the log says once that it is dead.

**Where** `internal/store/speech.go`, `internal/util/util.go` (`WriteFileAtomicMode`),
`internal/server/routes_speech.go`, `frontend/src/services/api/speech.ts`, `frontend/src/lib/speech-profiles.ts`,
`frontend/src/components/settings/speech-profile{s-section,-dialog}.tsx`, `frontend/src/stores/use-config-store.ts`.
Tests: `internal/server/routes_speech_test.go` (the recording goes to the active profile, the profile's model and bearer win over the
form's, a blank model sends nothing, no profile is a 400, 401/413/429 pass through while 500 becomes 502,
`speech.json` is `0600` and never in an answer, a keyless entry keeps the stored key and `""` removes it, every bad
id is a 400 that leaves the list untouched), `internal/store/store_test.go` (a hand-edited file with colliding, missing and unusable
entries loads as distinct usable ids), `frontend/tests/api-speech.test.ts`, `frontend/tests/speech-profiles.test.ts`.


## 253. Twelve Go exports nothing could reach are gone, and a gate says so from now on

**Decision** Delete the eleven exported Go symbols `docs/known-issues.md` listed — and the twelfth that surfaced
once they were gone — and add `tools/deadcode` to `make check`, so the question is answered by the gate rather
than by somebody grepping once.

**What went, and the shape of each one.** Ten were public spellings of work the package already did privately, or
a knob nothing turned:

- `comfy.Client.Queue` — a `/queue` reader; a run's progress comes from the hub and the task store, never from
  ComfyUI's queue.
- `config.WithAudioTimeout`, `WithServerPort`, `WithMaxImportBytes` — constructor options from the port, where every
  other option has a caller.
- `httpx.WriteJSONError` — a one-line wrapper over `WriteError`; middleware calls `WriteError`.
- `resource.Manager.DerivedDependencies` — its comment still claimed to be "the single source of truth for a
  workflow's dependency list", which is exactly the kind of sentence that keeps a dead function looking load
  bearing. The list is derived by `entryDeps`, which `packModelIDs` and the scan call.
- `setup.Manager.IsAvailable` — `WorkflowStatus` answers the same question with the problems attached, and is what
  every caller uses.
- `setup.Manager.ModelCandidates` — the wrapper for `modelCandidatesLocked`, which `scan.go` calls directly.
- `store.MainModels.Snapshot` — "for diagnostics" that nobody ran.
- `workflow.NormalizeModelPath` — a second `strings.ReplaceAll(value, "\\", "/")` beside `util.NormalizeSlashes`.
- `workflow.ReadGraphFile` — a public reader beside `Registry.readGraph`, which also rejects UI-format documents and
  is the one the registry uses.
- `workflow.DecodeGraph` — decoded the bytes `ReadGraphFile` had read; with that gone it had no caller at all.

Deleting `ReadGraphFile` is what exposed `DecodeGraph`, which is the argument for the gate in one sentence: the
dead call each other, so a sweep that stops at the obvious ones leaves a smaller ring behind.

**The gate, and what it is not.** `tools/deadcode` parses every `.go` file of the module and reports an exported
declaration whose name appears in no other file **and** which no reachable declaration mentions. That second half
is the whole design: a type is reached structurally, so `store.SpeechProfile` — never written outside its package,
but `Active()`'s answer — is not reported, and `agent.MaxFrameSize`, read only by the code beside it, is not
either. Roots are: a name another file mentions, a method any interface declares (including anonymous ones written
at a call site, plus a short list of the standard library's — `Error`, `MarshalJSON`, `ServeHTTP`…), a test, and
everything a *private* declaration mentions, because `golangci-lint`'s `unused` is what says the private half is
used.

It over-approximates on purpose and the report is therefore always real: the scan is name-keyed rather than
package-keyed (resolving a mention to a package needs type-checking, so one `New` keeps every `New` alive), any
identifier position counts (a selector `x.Foo` for `Foo`, a struct field's name), and test files are live. What it
misses is dead code that shares a name with something live; what it reports cannot be a false alarm.

**Why not `deadcode` or `golangci-lint`'s `unused`.** `deadcode` loads packages through the module proxy, which
this machine cannot reach (`proxy.golang.org` refused, #247's note), and `unused` only looks at unexported names —
the exact blind spot. A 220-line program with seven unit tests is smaller than the vendoring it would take to make
`deadcode` run offline.

**Tested** `tools/deadcode/main_test.go` pins each rule with a small source tree: a function nobody calls is
reported; a caller in another file of the same package counts; a type answered by a live function and a constant a
live function reads are reachable; what a private function answers is reachable; interface methods (module's own,
anonymous, and standard library's) are exempt while an exported interface nobody names is not; tests and the knobs
they drive are live; and two constants in one `const (...)` are two declarations, so one being read does not save
the other. `go run ./tools/deadcode` on the tree: `503 exported declaration(s) in comfyloft, every one reachable
from another file`. `make check` 20 packages (the tool is now vetted and tested with the rest — `PKGS` gained
`./tools/...`), `npx vitest run` 343, `npm run check`, `npm run build`.

**Where** `tools/deadcode/{main.go,main_test.go}`, `Makefile` (`deadcode`, `check`, `PKGS`, `.PHONY`),
`internal/{comfy,config,httpx,resource,setup,store,workflow}/*.go`, `docs/known-issues.md` (entry 2 leaves it),
`docs/server.md`, `README.md`.


## 254. One writer for every write: five copies of temp-file-then-rename became one

**Decision** `internal/canvas`, `internal/settings`, `internal/server` (the first-paint script and `mcp.conf`) and
`internal/store` (already there) all write through `util.WriteFileAtomic` / `util.WriteFileAtomicMode`, and those
are the only two functions in the tree that create a temporary file. The four private copies — `canvas.writeFile`,
`settings.writeFile`, `writeRuntimeFile`, `writeMCPConf` — are now three-line wrappers that add their package's
error text.

**Why it was wrong before.** Four implementations of the same six steps had drifted apart in the ways that matter
and agreed in the ways that do not: `mcp.conf` was written to a *fixed* `mcp.conf.tmp` name, so two writers could
interleave into it (and a `SweepTempFiles` pattern could not collect it either); the other three each had to
repeat the `CreateTemp`-makes-it-0600 correction; and the mode — the one thing a credential file must not get
wrong — existed in four places, one of which was `0o600` and three of which were `0o644` with nothing but a comment
saying why. That is the shape a copy takes before it stops agreeing.

**What the single writer does now.** `os.CreateTemp` for the name (O_EXCL over a counter and a random suffix: the
one thing a `.UnixNano()` name cannot promise is that two writers of the same file never land in the same
nanosecond — and the previous `WriteFileAtomic` had exactly that race), `Chmod` before any byte is written, then
write, close, rename. The name it leaves behind is `.` + the file's base + `.<digits>.tmp`, which is the shape
`SweepTempFiles` already matches, so a killed process still leaves something collected rather than a file per kill.

**What is deliberately still per call site.** The two things that are not the writer's business: whether the
document ends with a newline (`settings.json` does, `canvas.json` does not, and neither is the file layer's opinion)
and the sentence an error carries (`canvas: cannot write …` says where it happened).

**Tested** `internal/util/util_test.go`: the mode survives the rename (`0600` written, `0600` read back), the bytes
are the bytes, a second write replaces the document and leaves the directory holding only the file, the default is
`0644`, and a temporary file in the shape the writer produces is what `SweepTempFiles` collects — with an ordinary
file beside it untouched. `make check` 20 packages including the new dead-export gate, `npx vitest run` 343.

**Where** `internal/util/util.go` (+`internal/util/util_test.go`), `internal/canvas/canvas.go`, `internal/settings/settings.go`,
`internal/server/{runtime_config,agent_config}.go`.


## 255. Both requests that leave this server say where they are going, in the log

**Decision** Two destinations are printed: the **speech server** dictation posts to — at startup, whenever the
active profile changes, and once per recording — and the **model server** a session's turns go to — when the
session starts and whenever the destination changes. Neither line ever contains a credential.

**Why it had to be printed at all.** Both are requests this server makes on the user's behalf to a server the user
configured, and until now neither said where: the speech list was visible only in the preferences window (which
shows an *address*, not which of five profiles is active when the window is closed), and the agent's line was
`agent: connected session=… models=2 active="Fleet / qwen3"` — the model's **name**, which is not the address. So
"it is slow", "it answered nonsense", "it refused with a key error" and "my dictation is silent" all arrived with
nothing in the log to correlate them against. The failure paths did better than the successes: a hop that cannot
connect says `could not reach the speech server at <address>`, and an empty transcript says nothing at all — which
is exactly the case where the address is the answer.

**Why the address had to be looked up, not read.** `SM model` carries `active_id`, `active_name` and
`context_limit`; the `base_url` and `model_name` only ever arrive in `SM model_list`. So `startup.destination()`
resolves the active id against the list it holds, and says so when the id is not in it (`"gone" (its entry is not in
the list)`) rather than looking like "no model". An active model with no `model_name` (`whisper.cpp`'s `/inference`
shape, a local llama.cpp with no alias) prints the address and the protocol only.

**One line per change, not per frame.** The agent restates its state — the same `model` frame can arrive again, and
a canvas saves the model list on every edit — so the pump and `adoptModels` compare `destination()` either side of
the frame and write only when it differs. Measured: re-sending `model_set 2` when two is already active writes
nothing; switching to it writes `agent: session=… sending to "Fake / two" -> …`.

**Where each line lives.** The store owns the speech ones (`Load`, `Replace`), because the file is the answer and the
store is the only thing that reads it — including the case where the file is *absent*, where the line says "no
profile configured, so dictation will say so", which is the sentence a reader needs when the panel refuses. The
route adds the per-recording line just before the hop, because the bytes are there and "which server did that?"
is a per-request question. The agent's lines are in the session (`Connect`, the pump, `adoptModels`), the only
places that see the agent's own frames; `Session` gained the `Log` it was missing.

**What is deliberately not printed.** The `api_key` (`SM model_list` carries every one in cleartext, and a log line
ends up in an issue), and the profile's key — only `with a key`, so "the server wants a credential and mine is
wrong" is still visible.

**Tested** `internal/agent/startup_test.go`: `destination()` is empty before the agent names a model, resolves the
address and model name of the active entry, prints the address alone for a model with no name, says so when the
active id is not in the list, and never carries the key. `internal/agent/session_test.go`: a spawned fake agent logs
`sending to "Fake / one" -> http://127.0.0.1:1/v1, model m, openai` at connect, logs `"Fake / two"` after a
`model_set`, and writes nothing when the destination did not move. `internal/store/store_test.go`: the line for a
configured profile names it, its address, its model and `with a key` but not the key; switching the active profile
prints the new address; re-saving the same list prints nothing; an empty store says nothing is configured. Verified
live: `speech: 1 profile(s) loaded; dictation goes to "Local audio.cpp" -> http://127.0.0.1:18080/v1/audio/transcriptions, model refine, with a key`
and, with no file, `speech: no profile configured, so dictation will say so`. `make check` 20 packages,
`npx vitest run` 345, `npm run check`, `npm run build`.

**Where** `internal/agent/{events.go,sessions.go,models.go}`, `internal/agent/{startup_test.go,session_test.go}`,
`internal/store/speech.go`, `internal/store/store_test.go`, `internal/server/routes_speech.go`, `docs/server.md`.

---


## 256. `input_modalities` is a switch and four boxes, because the file has three states

**Decision** A model's `input_modalities` is edited by one switch — does this model declare anything at all — and,
when it does, four checkboxes: image, video, audio, document. Switch off writes no line, on-and-empty writes `[]`,
and the boxes write the list. The field is stated in every model a page is shown, `null` included, so "not declared"
and "no media" never have to be guessed apart. `null` sent back removes the line; a list replaces it; a field not
mentioned keeps what is stored.

**Why the three states are the whole problem** AlayaCore reads a missing line as *the protocol decides* (an
OpenAI-format endpoint takes image, audio and video; an Anthropic one image and document), `[]` as *declared, no
media*, and a list as itself. A row of checkboxes alone can only say two things, so whichever of the first two it
collapses becomes unreachable — and the worse direction is the silent one: a model whose `[]` travels as an absent
field comes back through `model_sync` as a model that takes everything its protocol carries. AlayaCore keeps those
two apart for the same reason (`json:"input_modalities"` with no `omitempty`, and the key in `fatalParseKeys`), and
this wire follows: `agent.Model.InputModalities` has no `omitempty`, like `serialToolCalls` (#249), so
`"inputModalities":null` is always present and always means "not declared".

**Why there is no `text` box** Text is never filtered — a message is text, and there is no way to send one without it
— so `[]` and `["text"]` are one model in AlayaCore's own words. A box that changes nothing would suggest the
opposite, so the vocabulary offered is the four media words, and a stored `["text"]` is kept spelled as it is: the
dialog edits the four boxes inside the list it was handed and leaves every other word where it was. A sixth word from
a newer AlayaCore travels the same way, which is why the server checks only that the value is an array of strings —
the vocabulary is AlayaCore's, which names a bad word itself when the list is written.

**Why switching on starts empty** The two mistakes are not symmetric. A medium the endpoint does not accept makes it
reject the whole request, and keep rejecting, because the part is in the conversation the agent replays every turn. A
medium it would have accepted is only replaced by a note saying it was not delivered, which the user sees in the
answer and undoes in one click. Pre-ticking the protocol's defaults would put the silent failure on the common path —
most models are text-only — so the boxes start unticked and say what unticked means.

**Cost** Adding a media type to AlayaCore means a word in `INPUT_MEDIA` (`frontend/src/lib/agent-models.ts`) and a
label in each dictionary; until then such a value is preserved but not offered. The switch is one control more than a
checkbox row, and the model list does not summarise what a model declares, so a model quietly receiving notes rather
than images is found by opening it.

**Where** `frontend/src/components/settings/agent-model-dialog.tsx`, `frontend/src/lib/agent-models.ts`,
`internal/agent/models.go`, `internal/agent/models_test.go`.

## 257. The prompt panel has no ✨: rewriting a prompt is the agent's job

**Decision** The two sparkle buttons are gone — 优化提示词/H3 优化 on video nodes and 优化提示词 on image
nodes — with everything only they used: `promptOptimize*` on `CanvasNodeMetadata`, `lib/canvas/prompt-optimize-jobs.ts`,
the `PromptOptimizeMode` type, the eleven dictionary keys they carried (`optimize*`, `originalPrompt*`), the
`promptOptimizeLanguage` setting, and `OriginalPromptDisclosure`. The text node's 反推 stays, because it is a
different job (a picture in, words out) rather than a rewrite of words the user already wrote. `read_prompt` now
ends its answer with what the node is set to run (`n3 is set to run video-h3-frames, 4 s`), because the workflow
id and the duration are the two facts a rewrite depends on and no other tool stated them.

**Why** Both buttons had stopped working, and had been dead since 336e331 (2026-11-01): the button asked on
`node:<id>`'s session, and nothing on a video or image node ever opens one — the panel shows a model picker there,
not 连接 — so `askAgentSession` rejected before it dialled. Pressing ✨ showed `请求失败` in the preview and nothing
else. That refactor renamed `askAgentSession` to `askOnceAgentSession` ("ask, and release either way") and left
`optimizePrompt` assuming a session it never opened; the reverse-prompt button it also touched was safe only because
a text node's own generation opens that session first. Verified before deleting: a probe test calling
`askOnceAgentSession("node:never-opened", …)` rejects without constructing a `WebSocket`.

**Why remove rather than repair** Repairing is one line (`await openAgentSession(config, agentName)` before the
ask), and it was still the wrong one. The H3 button's only real content was a sentence — "把下面这段需求改写成一条
MiniMax H3 视频生成提示词。任务类型：… ；时长：… 秒。" — that duplicated the skill's own vocabulary
(`prompts/skills/h3-prompt-writing/SKILL.md` step 1 is "identify the input mode"), inside the canvas, in Chinese,
with no test. That is exactly the second wording site a whole backend was deleted over. The image button had less
than that: there is no image skill, so it was "rewrite this into a prompt, answer in X" — a sentence a user can say
to the canvas agent, and it attached no facts at all.

**What the agent gets instead** The task type, the duration and the reference media are all reachable from the
canvas: `read_prompt` for the words plus what the node will run, `list_nodes` for the connections, `read_node` for
each reference picture (which answers with the image itself), `set_prompt` to write the rewrite back. What was
missing was the fact the button derived from the picker, so `read_prompt` gained it — one clause, from
`configuredClause` in `node-generation-facts.ts`, the module that already words "made with …". It says what the
*next* run will ask for, which is not what `generationClause` says: change the picker and the two disagree.

**Cost** One click became a conversation, and the agent has to be told which node — the panel it stands in has no
chat of its own on a video or image node. It may also have to ask for the input mode when the workflow id does not
settle it (`video-h3-frames` is I2VA, L2VA or FL2VA depending on the frames that are wired); `frameMode` is derived
by the panel from the references, and the tool reports the id alone rather than guessing. Undo is `git revert`.

**Tested** `npx vitest run` (357: six new — `read_prompt` names the run and stays silent without a picker,
`configuredClause` for a pick, a bare name, no duration and no model, and `requestPromptChat` dialling a session that
was never opened). `make check` (20 packages, 504 exports), `npm run check` (863 zh keys, 849 en, 180 modules,
prettier + tsc), `npm run build` 561.56 kB. The deleted files: `prompt-optimize-jobs.ts` was its only caller, so
`check-exports` drops from 181 modules to 180 with nothing orphaned.

**Where** `frontend/src/components/canvas/canvas-node-prompt-panel.tsx`,
`frontend/src/components/canvas/sent-prompt-disclosure.tsx` (a comment only, see #258),
`frontend/src/lib/canvas/node-generation-facts.ts`, `frontend/src/lib/canvas/canvas-agent-tools.ts`,
`frontend/src/stores/use-config-store.ts`, `frontend/src/types/canvas.ts`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`, `frontend/tests/{canvas-agent-tools,node-generation-facts}.test.ts`,
`docs/server.md` (two paragraphs that still described `internal/prompt` as the home of the H3 instructions).


## 258. The sent-prompt count is characters, and now it is the count it says

**Decision** `SentPromptDisclosure` counts `[...sent].length` — code points — where it counted `sent.length`.

**Why** The label says 字 / chars, and `sent.length` is UTF-16 code units: one emoji, or one of the CJK ideographs
outside the BMP (𠮷, 𰻞), counts as two. The user asked whether it should be bytes instead, because UTF-8 writes a
Chinese character in three of them; it should not. Bytes are not a fact about a prompt: nothing in this pipeline
stops at a byte boundary (the server's transcript truncates at 400 *runes*, `internal/agent/spawn.go`), and the
number would triple as a user switched to Chinese while the text stayed the same length, which is the opposite of
what the count is for. Code points are the unit the rest of this codebase already uses for text length, and they
make the word 字 true.

**Cost** Two characters that are one grapheme (a letter plus a combining accent) still count as two. Grapheme
clusters would need `Intl.Segmenter` for a difference nobody reads this line to see.

**Tested** By reading it: the component renders into JSX and `vitest.config.ts` is `environment: "node"`, so there
is no DOM to assert against — the same gap the rest of this panel has (no component test exists for it). The
expression is a one-liner whose behaviour is the language's; `npx vitest run` and `npm run check` cover the module
loading and the types.

**Where** `frontend/src/components/canvas/sent-prompt-disclosure.tsx`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts` (`sentPrompt`).


## 259. A music run is told how long it may be

**Decision** The audio settings panel has a duration control whenever the selected workflow declares a range for one,
and `requestAudioGeneration` sends that number as `seconds`. The bounds come from the workflow's declaration
(`parameters[].duration`, 4–360 s for `audio-minimax-music-3`), carried on the model entry as `duration: {min, max}`;
the node keeps the value in `metadata.seconds` (where a video's length already lives) and the config field is
`audioSeconds`, defaulting to 60.

**Why it was missing** Nothing on the client ever sent a length, so every song came out at the graph's own
`max_duration: 60` whatever the panel said — the workflow could be told 4 to 360 seconds and only the registry knew
it. Everything downstream was already there: `bindings.duration` reads `ctx.Seconds` into `37:13.max_duration`,
`routes_runs.go` builds `ctx.Seconds` from `inputs.seconds` (falling back to `inputs.duration`), and
`shipped_audio_test.go` pins both the 45-second and the default paths. The gap was one missing input on one request.

**Why the bounds come from the registry rather than a constant** `VIDEO_SECONDS_MIN/MAX` (4–30) are constants because
every video workflow is the same shape of clip; a song is not, and 4–360 is this model's own ceiling, not a fact
about audio. A hardcoded range would need editing when a longer music workflow arrives, and would offer 360 seconds
to a workflow that stops at 30. So `durationOf` in `server-models.ts` reads the declaration once, when the model list
is built, and the slider, the number box and the request all read those bounds. The step is the exception: the
declaration's is 0.04 s (1/25, the latent's grid) and the UI rounds to whole seconds, because this number is an upper
bound the model may finish under.

**Why the declaration is also the switch** A workflow that declares no duration gets no control and is sent no
`seconds` — its binding default answers, and the client does not invent a length for a workflow whose inputs it was
not told about. That is the same rule as the rest of the panel: what the panel shows, the run receives.

**Cost** `defaultConfig.audioSeconds` is `"60"`, a copy of the value the binding writes when the request says
nothing, so the control opens showing what the first run will ask for; if the registry's default changed, the client
would keep sending 60 — visible on the panel before the run, not a silent substitution. A never-touched node has no
`metadata.seconds`, so `read_prompt` reports the workflow without a length until the user picks one (a video node
behaves the same way). The panel and `buildGenerationConfig` read `metadata.seconds` for both `audioSeconds` and
`videoSeconds`, so an audio length lands in `videoSeconds` too and vice versa — each is only read by the kind of node
that owns it.

**Where** `frontend/src/components/audio-settings-panel.tsx`,
`frontend/src/lib/canvas/{server-models.ts,build-generation-config.ts}`,
`frontend/src/services/api/audio.ts`, `frontend/tests/{audio-duration,server-models}.test.ts`.


## 260. The audio panel has no voice and no speed

**Decision** The audio settings panel lost its Voice group (13 OpenAI voice names) and its Speed group (0.75×, 1×,
1.25×, 1.5× and a free number). `audioVoice`, `audioSpeed` and their helpers are gone from the config, the node
metadata, the inheritance list and the locale files.

**Why they went** They reached nothing. `requestAudioGeneration` sent the caption, the lyrics and the container; a
voice and a speed were values the panel collected, stored, inherited and displayed, and no request ever read. They are
leftovers from OpenAI's `/v1/audio/speech`, which this server no longer has (`internal/server/audio_runs_e2e_test.go`
opens with that fact). The one audio workflow the registry holds takes a caption, lyrics, a length and a format; it has
no voice input and no speed input to bind them to.

**What stayed, and why** The format pills stay even though `audio-minimax-music-3` writes only mp3, flac and opus: the
container is sent as chosen and the server answers with a message naming the set it accepts, which is a deliberate rule
(`frontend/src/services/api/audio.ts`) rather than a substitution the node's label would then be wrong about. The lyrics field stays
— it is the run's `lyrics` input — with its label and placeholder narrowed to lyrics, since the "speech workflows" the
old text mentioned are not a thing this server registers.

**Why no migration** There are no users, so there is nothing to upgrade: a document written by an older build of this
tree is not data anyone has. Dead keys in a local document are read by nothing, so they are not a reason for a
`delete` on the hydrate path and a test for it — that branch was written and then removed before this landed.
Migration earns its lines when someone
else's document has to keep working; until then the answer is to fix the shape and let old copies be old. Applied to
the one place the leftovers actually lived: `data/settings.json` carried six keys nothing in `AiConfig` declares —
`audioVoice`, `audioSpeed`, `canvasImageCount`, `count`, `progressRingSkin`, `promptOptimizeLanguage` — and they were
deleted from the file rather than tolerated, so the served `/config.js` now carries none of them (`/data/` is runtime
state, ignored by git, so this is a file edit and not a commit). (The
`asrUrl`/`asrModel` deletes above it are #252's, from a different argument: those two are now owned by the server, so a
copy in the preferences is a second answer to where audio goes.)

**Cost** A future speech workflow has no voice control to inherit; it will get one from its own declaration, the way
the duration control in #259 does. Undo is `git revert`.

**Tested** `npx vitest run`. `npm run check`'s export checker is what forced the helpers out rather than leaving
them orphaned (180 modules, none without a caller).

**Where** `frontend/src/lib/audio-generation.ts`, `frontend/src/components/audio-settings-panel.tsx`,
`frontend/src/components/canvas/canvas-audio-settings-popover.tsx`,
`frontend/src/stores/use-config-store.ts` (type, default, the model list's normaliser), `frontend/src/types/canvas.ts`,
`frontend/src/lib/canvas/{canvas-generation-helpers,canvas-node-factory,node-settings-memory}.ts`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.


## 261. A button's label gives way where the button ends

**Decision** `Button`'s label slot (`span[data-slot="text"]`) is `min-w-0 truncate`, and the three composer
pills — the video, image and audio settings triggers — carry their whole sentence in a `title` as well.

**What was wrong** The video node's settings pill showed `480p · 1:1 · 4s · First & last frame` drawn *past* its
own rounded background, 34 px of text on nothing. The button was capped (`!max-w-[200px]`) and the call site had put
`truncate` on a `span` inside it, which cannot work: `Button` wraps children in a `span[data-slot="text"]`, that
wrapper is a flex item of the button, and a flex item's `min-width: auto` refuses to shrink below its text — so the
wrapper stayed 208 px wide inside a 200 px button, and the inner `truncate` did nothing because an inline box has no
overflow to hide. Nothing in the app noticed: the pill is laid out by flexbox, no test has a layout, and `tsc` and
prettier cannot see a paint that escapes its box.

**Why the kit and not the call site** One call site remembered `truncate` and it silently failed. Put the rule where
the box is: the slot shrinks (`min-w-0`), and the slot ellipsises (`truncate`) — so a `truncate` inside the slot is
harmless and a missing one no longer matters. `Button` already promised `whitespace-nowrap`; a label that cannot wrap
has to have somewhere to go when the button is narrower than it is, and the only alternatives are spilling or
clipping. This is the clipping one, with an ellipsis to say so.

**Why the titles** With the label ellipsised, the sentence is unreadable at a glance — and it is the only place the
resolution, ratio, seconds and mode are shown together. `title` costs nothing and matches what `ModelPicker` already
does for the same reason (`title={optionLabel(current)}`).

**Measured, not assumed** A standalone page with the built stylesheet, the real button classes and the two markups,
rendered in headless Chrome: before, `button=200.0px slot=208.5px spill=+34.1px`; after, `button=200.0px
slot=165.4px spill=-9.0px` with `slotScroll=209` — i.e. the text now ends inside the pill and is clipped with an
ellipsis (the screenshot shows `480p · 1:1 · 4s · First & l…`). The 34 px is the same 34 px counted off the user's
screenshot (`pill fill ends at x≈445, text at x≈479`).

**What else changed on the way** The image popover's trigger computed `qwen ? label : hasReferences ? size : size` —
both branches identical, so `hasReferences` was a prop that changed nothing (`tsc` then refused to let it stay once
the redundant branch went). It is gone from the component and from its one call site. `globals.css` still carries
`.canvas-composer-icon` / `.canvas-composer-tools` rules whose only purpose was to shrink these labels; nothing
renders those classes since the composer was rebuilt, so they are dead CSS rather than the fix — left in place here,
noted for the next sweep.

**Cost** A label that would have been readable at full width is now ellipsised when the button is clamped — which is
what `!max-w-*` asked for. Buttons with an element child that is meant to poke outside their box would be clipped;
none exists (checked: no `absolute` child inside a `Button`).

**Tested** The headless-Chrome measurement above (throwaway, `/tmp/pill.html`), and `Button` is on every screen in the
app: `npx vitest run`, `npm run check` (863/849 keys, 180 modules, prettier, tsc), `npm run build` 561.61 kB,
`make check` (20 packages, 504 exports) all pass afterwards.

**Where** `frontend/src/components/kit/button.tsx`,
`frontend/src/components/canvas/canvas-video-settings-popover.tsx`,
`frontend/src/components/canvas/canvas-image-settings-popover.tsx`,
`frontend/src/components/canvas/canvas-audio-settings-popover.tsx`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`.


## 262. The video node's Edit button is gone

**Decision** The video node's hover toolbar no longer carries an `Edit` item. Removed in 34a8686, with the
`onToggleDialog` prop, the `MessageSquare` import and `common.edit` in both dictionaries.

**Why it read wrong** It opened the prompt panel — which a click on the node body already opens — so it was a
second way to do the one thing a click does. Worse, its label promised an *edit* while its panel's `↑` re-runs
the node and replaces the clip in place: a user pressing "Edit" to look at a finished clip found the thing that
would overwrite it. #263 makes "runs a step" and "answers a prompt" visibly different, which is most of what made
the button necessary-looking.

**Cost** None: nothing referenced it — no test, no agent tool, no shortcut — and clicking the node still opens
the panel.


## 263. A workflow's request contract is on the wire, and a step is a node's model

**Decision** Three things, one idea — *the panel reads what the workflow declares*:

1. `GET /api/workflows` carries the request contract: `accepts` (per media kind, `max: 0` meaning "takes none"),
   `mode` (`text` / `frames` / `reference`), `frameMode`, and `variantContracts` (one per mode) for a workflow with
   variants. These are the fields `PlanMedia` validates against, resolved by the same `variantContractOf` that
   `ResolveForMode` uses, so the panel and the `400` cannot disagree.
2. A workflow the canvas also drives from a button (interpolate, upscale, angle) is **tagged, not dropped** from the
   model list. A node can be one — that is how an interpolation node exists — but `defaultModelOptions` keeps it out
   of the "default model for new nodes" setting, because a default must run from a prompt.
3. A node whose workflow has no `prompt` binding gets a panel built from its contract: the connected media and what
   it still needs (from `accepts`), its knobs (from `parameters`), and no prompt box, no size/second/mode controls.
   Its run sends only those knobs and its media by kind, so nothing is accepted-and-ignored.

**What was wrong** The interpolation node the toolbar's Interpolate button created showed **H3 text-to-video**: its
`metadata.model` was the workflow id `video-rife`, which the model list filtered out, so `resolveModelForCapability`
fell back to the configured default video model. That fallback drew the rest of the lie — a red "text-to-video does
not accept images" warning over a clip that was the thing it ran on, and `720p · 1:1 · 6s · First & last frame` for a
workflow with no size, no seconds and no mode. Two sources of truth were the cause: the registry declared `mode` and
`accepts` for every H3 workflow and none of it reached the client, so the canvas re-derived it from ids
(`video-model-mode.ts`, `isH3T2V`, the invented `videoMode: "interpolate"` that `videoModeLabel` bent back into
"First & last frame").

**Why the contract and not a name list** A name list is what drifted: `video-h3-frames` was spelled in the client to
decide a mode, `video-rife` in a second list to decide visibility, and neither could know about a workflow added
tomorrow. `mode` and `accepts` are already the registry's words — `video-h3-t2v` says `mode: "text"`,
`accepts: {images: {max: 0}}` — so `videoModelModePatch` became a one-line read of `mode` and the tool panel a render
of `accepts` + `parameters`.

**Why not fold H3 into one entry with `variants`** It would work — `ResolveForMode` + `mergeVariantContract` are
exactly that, and `image-qwen21` uses it — but the four H3 workflows are four *ids* in every saved canvas, so folding
them means an alias or a hydrate migration, and the client already gets the same mode switch from `mode` for free.
Two traps found while checking: `mergeVariantContract` does not merge `Parameters` (a variant cannot declare its own
knobs), and `video-h3-character-swap` declared no `mode` — now `"reference"`, its behaviour made explicit.

**What stays hardcoded** The composer's own H3 branches (`isH3T2V`, the frames/reference switch in
`video-settings-panel.tsx`) still recognise `video-h3-*` to decide *which mode options to offer* — a UI question
about one family, not a fact about the run. `accepts.note` is deliberately not on the wire: it is English registry
data, and the panel's copy comes from `i18n` (#66).

**Also** A step writes no settings onto its node: `videoRunMetadata` / `buildImageGenerationMetadata` keep `model` +
`params` + `references` and drop size/seconds/resolution/mode, so a node cannot claim a 720p it was never asked for.

**Where** `internal/workflow/{render,registry}.go`, `workflows/registry.json`,
`frontend/src/services/api/{workflows,video,image}.ts`, `frontend/src/lib/server-models.ts`,
`frontend/src/lib/canvas/{tool-workflows,video-model-mode,video-run-metadata,canvas-node-factory}.ts`,
`frontend/src/components/canvas/canvas-tool-node-panel.tsx`.


## 264. A card that frames a picture is the picture's shape

**Decision** The image node's free-resize toggle is gone. `keepRatio` is now one read of the node
definition — `Boolean(definition?.keepsAspectRatio)` — with the image definition saying `true` exactly as
the video one already did, and the picture is drawn `object-contain` with no branch. Three things went with
it: the three clauses that used to answer "may this card change shape" (an `Image && !freeResize` test, a
bare `Video` test, and the definition), the field itself, and the function shape of the flag — it was a
`(node) => boolean` only because the answer once depended on the node, and now that it does not,
`keepsAspectRatio?: boolean` says the same thing without an argument nothing reads.

**Why** No one decided it. `freeResize` came in with the initial import (`ccfe94b`) and no entry in this
file ever mentioned it — searching `freeResize`, "Lock ratio" and "free resize" found nothing, which is the
same diagnosis #228 made of the per-node `replace`: inherited, not decided. Three pieces of
evidence say the same thing. It was hidden from the first day — `defaultVisible: false`, the only one of
twelve image quick tools a user had to go into the toolbar config to find. It was implemented as
`object-fill`, which stretches the photograph, and this app spends crop, outpaint and mask exactly to avoid
distorting a picture; if the need was "fill this slot", `object-cover` was the mechanism and it was never
the one built. And its own code already treated the picture's shape as the truth: switching the lock back
on recomputed the height from `naturalWidth/naturalHeight` and kept the centre, so free resize was
implemented as a temporary deviation, not a mode.

**The rule that replaces it** A card whose content is a picture or a film is that content's shape: drag its
corner and it scales. A card whose content is words is a reading choice — wide for one line, narrow for a
column — and a group's dashed rect is a layout statement; both are free, as they always were, because
neither has a shape to keep. That is why only the two media types carry `keepsAspectRatio` at all.

**Cost** None that has to be paid, and this is the reason to do it now rather than later. The project is
unreleased, so there is no document outside development that could carry `freeResize`: `grep` over `data/`
and `canvases/` finds none, and nothing has to be migrated or tolerated. A document written by a build
before this one would render its node `object-contain` and snap its next corner drag back to the picture's
ratio, which is the behaviour this entry is asking for anyway. Doing it after the first canvas is saved
would have meant either a migration or a field nobody reads.

**What it simplifies downstream** The agent's `resize_node` (not built yet) loses a branch: there is no
"was this node unlocked?" question, so a card that frames a picture has one degree of freedom and states
one number, and text/audio/group state two. A video never had an escape hatch; now an image does not either,
and the two types read the same everywhere.

**Tested** `npx tsc --noEmit` (deleting the field made every reader a compile error, which is the mechanical
proof that the list was complete), `npm run check` (the i18n check found the four now-dead keys and nothing
else: 866/852 keys, 182 modules, prettier clean), `npx vitest run` (40 files, 374 tests), `npm run build`
(569.02 kB, 1.3 kB smaller). No test pins the drag's ratio: the component's pointer math has no harness, and
the rule it now follows is a field on the definition rather than arithmetic in this file.

**Where** `frontend/src/types/{canvas,canvas-node}.ts`, `frontend/src/components/canvas/canvas-node.tsx`,
`frontend/src/components/canvas/nodes/builtin-nodes.tsx`,
`frontend/src/components/canvas/canvas-image-toolbar-tools.tsx`,
`frontend/src/components/canvas/canvas-node-toolbar.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`.


## 266. The composer asks what a workflow declares, not which workflow it is

**Decision** The five id tests left in the video composer are now reads of the declaration:

- `isH3Text` / `isH3Frames` / `isH3Reference` → the model's `mode` (`text` / `frames` / `reference`), which
  #263 put on the wire; "this workflow is one of a family that has modes" → it declares a `mode` at all.
- The SelfLift fast/quality pills → the workflow declares `transition_step`, the knob that toggle writes
  (`frontend/src/services/api/video.ts`), carried as `selfLift`.
- A locked length ("follow source video") → no binding reads `seconds`, carried as `bindsSeconds`;
  `video-h3-character-swap` is the case: its `videos` binding names `sourceLengthInput`, so the clip decides.
- "This workflow takes no media" — the red warning and the disabled reference bar — → the contract's own
  caps: `images.max + videos.max + audios.max === 0`.
- The mode switch → `videoModelForMode` returns the model whose declared `mode` is the one chosen, instead of
  a table mapping `reference`/`frames`/`text` to `video-h3-ref2va`/`-frames`/`-t2v`.

`durationLocked` stopped being a prop threaded through two components: the panel and the settings pill both
ask `videoFollowsSource(config, model)`, so the control and the sentence about it cannot disagree.

**Why** #263 recorded these as "what stays hardcoded": the client still recognised `video-h3-*` to decide which
controls to offer. Each had the same defect — a workflow added tomorrow is invisible to the rule, and a
workflow removed leaves a branch that quietly does nothing. The SelfLift toggle was worse than invisible: it
writes `transition_step` into the request, so on a workflow that does not declare that knob the value travels
to the server and is ignored. The id test was right about which workflows to offer the toggle for, for the
wrong reason, and that is the kind of rightness that stops being right.

**The three-state read** `bindsSeconds` is a `boolean` on the wire (a listed workflow either binds the request's
seconds or does not) but `boolean | undefined` in the store, because a model the server did not list claims
nothing: an old local selection is then neither locked nor unlocked by the canvas. Same rule as #256 gave the
input kinds.

**What the pills say now** A locked length has two causes and they are not the same sentence: a clip being
edited sets it (a source duration is known, and the row names it) or the workflow fixes its own. `lengthFixed`
is the second, and `lockedDurationLabel` chooses between them from the one fact the panel has.

**Cost** For the shipped registry nothing changes: all four H3 workflows declare a mode, all four declare
`transition_step`, three bind `seconds` and character swap does not. Two edges move for a workflow the operator
added to their own `model.conf` (a Wan i2v, a custom graph): it is offered the frames/reference pills only if it
declares a mode, and it loses the seconds slider if none of its bindings reads `seconds`. Both are the
declaration's answer rather than ours, and the second one deletes a silent no-op — a seconds value that nothing
read was being sent on every run.

**Tested** `npx tsc --noEmit` (removing the id tests left `videoWorkflowId` used only inside its own file, which
the export check then refused), `npm run check` (867/853 keys, 182 modules, prettier clean), `npx vitest run`
(40 files, 377 tests — three new: `bindsSeconds` both ways, `selfLift` only where the knob is declared, a mode
finding its model while an unlisted model claims nothing), `npm run build`, `make check` (deadcode
505). Not checked in a browser: the composer needs a server with the new registry on the other side of it, and
what changed is which branch a control takes, with the shipped registry's declarations unchanged.

**Where** `frontend/src/lib/server-models.ts`, `frontend/src/stores/use-config-store.ts`,
`frontend/src/lib/canvas/video-model-mode.ts`, `frontend/src/components/video-settings-panel.tsx`,
`frontend/src/components/canvas/{canvas-video-settings-popover,canvas-node-prompt-panel}.tsx`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`, `frontend/tests/{server-models,model-selection}.test.ts`.


## 267. A step is a tool, and the mode sent is one the model declares

**Decision** Three fixes, one root: a workflow's *identity* was standing in where what it *declares* was the
answer.

1. **The image mode sent is resolved against the model that will run it.** `imageModeFor(config, model)` — the
   node's choice when the model declares it, else `t2i` when that is declared, else the first mode declared,
   and nothing at all for a workflow with no modes. `requestGeneration` uses it to decide the media roles and
   the outpaint numbers, and the settings pill uses it for the mode it claims to be on.
2. **A step is a tool.** `modelIsStep` is `tool === true || hasPrompt === false`, and the five places that have
   to agree now ask it: the node panel, the image request, the video request, and the two metadata builders.
   `modelTakesPrompt` stays, asking the different question it always asked — whether that step has a text box.
3. **The angle workflow declares its three knobs.** `image-qwen21-angle` binds through
   `from: params.horizontalAngle`, `params.pitchAngle`, `params.cameraDistance`, but declared no parameters —
   and a name is a valid input only when it is a semantic request key, a declared parameter, or a binding
   addressed as `params.<binding key>`. So the names the client sent were refused as `unknown_input`, and the
   binding's own keys were refused too: the knobs had no way in from either side.

**Why** Each one was a silent wrong request, not an untidiness:
- A node keeps its `imageMode` when the model under it changes, so an "inpaint" chosen on Qwen travelled to a
  workflow with one mode and no mask binding. The panel clamped that for its label; the request did not, and
  sent a mask role and padding to a graph that binds neither.
- The angle re-render takes words, so `hasPrompt` was true, so it was treated as a from-prompt model: its panel
  showed no knobs (they were unsettable) and its run went down the from-prompt path, where a step's parameters
  are never sent. A tool that happens to accept words is still a tool.
- With the knobs declared, the step panel renders them from the declaration with no client code — which is the
  same shape as #263: the panel shows what the workflow declares, and the server validates against the same
  declaration.

**Found on the way** The step request dropped the prompt entirely, which was invisible while every step
happened to have no prompt binding. It would have broken the one step that takes words the moment that step
started going down the step path. The step request now carries the prompt exactly where the workflow binds one,
and the step panel shows the box exactly there too.

**Cost** The angle workflow accepts three inputs it used to refuse — a widening of one workflow's surface, by
declaration. No ranges are declared for them, so a knob is unbounded at the API: the graph's own transform
(`int`, `invert10`) is the only judge. A bound belongs in the registry beside the default, and inventing one
here would be a second answer to a question the graph already answers.

A stale `imageMode` is now dropped rather than sent: someone who chose inpaint on Qwen and switched to Z-Image
gets a plain text-to-image run instead of a refusal. That is a silent substitution, and it is the deliberate
one — a request that cannot mean what it says is worse than one that means what the panel has been showing all
along.

**Tested** `go test ./...`, `make check` — `TestShippedAngleWorkflowAcceptsItsKnobs` pins the
declaration from both sides: the three names are accepted, the binding's own key (`horizontal`) is still
refused because nothing reads it, and a word is refused where a number belongs. Frontend: `npx tsc --noEmit`,
`npm run check` (867/853 keys, 183 modules), `npx vitest run` (40 files, 380 tests — `modelIsStep` covering a
tool that takes words, a tool that does not, a composer model and an unlisted one; `imageModeFor` covering a
declared mode, a stale one, an empty one and a workflow with no modes; and an angle step's request carrying the
prompt beside its knobs), `npm run build`.

**Where** `internal/workflow/shipped_angle_test.go`, `workflows/registry.json`,
`frontend/src/lib/canvas/image-mode.ts`, `frontend/src/stores/use-config-store.ts`,
`frontend/src/services/api/{image,video}.ts`, `frontend/src/lib/canvas/{video-run-metadata,canvas-node-factory}.ts`,
`frontend/src/components/canvas/{canvas-node-prompt-panel,canvas-tool-node-panel,canvas-image-settings-popover}.tsx`,
`frontend/tests/{model-selection,api-image-upscale}.test.ts`.


## 268. The mode a stale node falls back to is the one that asks least

**Decision** `imageModeFor` no longer names a fallback mode. When the node's `imageMode` is not one the model
declares, the answer is the declared mode whose contract asks the least — the smallest sum of `minTotal` and
the per-kind minimums — and a family whose modes declare no contracts at all ties at zero and answers with its
first declared mode. This revises the fallback in #267, which spelled out `t2i`.

**Why** The name was the last one in a function that otherwise reads declarations, and it was right only by
accident: `t2i` is what the Qwen family calls "words only", and a video or audio family with modes would have
had no such mode to fall back to. The per-mode contracts are already on the wire (#263), so the fact was
there: the mode that needs nothing is the mode a request cannot be refused for.

**Cost** Two modes that both need nothing tie, and the first declared one wins — deterministic, but chosen by
the server's ordering rather than by meaning. A `defaultMode` field in the registry would say it outright; it
is not worth a wire field until a family actually has two equally-cheap modes and the wrong one matters.

**Tested** `npx vitest run`: the Qwen family still resolves a stale mode to `t2i` because that is what
its contract says (`images.max: 0`), and a two-mode family whose cheapest is `beta` resolves to `beta` — the
second case is the proof that no mode's name is left in the code.

**Where** `frontend/src/lib/canvas/image-mode.ts`, `frontend/tests/model-selection.test.ts`.


## 269. A knob is named by the dictionary, like every other registry string

**Decision** Parameter labels go through `serverParameterLabel(key, fallback)` in `frontend/src/lib/server-labels.ts`, the
same helper shape as `serverModelLabel` and `serverVariantLabel`: the Chinese label comes from
`server.parameters.<key>`, keyed by the identifier the server sends, and the registry's English is the
fallback. Both renderers use it — the step panel's `ParameterControl` and the super-resolve dialog's fields —
and the zh-CN dictionary gained an entry for every `key` the shipped registry declares. `check-i18n` declares
`server.parameters` as a dynamic prefix and as zh-only, like the other two.

**Why** #8 settled this question already: `workflows/registry.json` is data written in English, the dictionary
words it, and an identifier the dictionary does not know falls back to the registry's text so a hand-written
workflow still renders instead of showing a raw key. Parameters were the one family of registry strings that
had skipped it: the step panel printed `Multiplier` and `Horizontal angle` in a Chinese UI, and the
super-resolve dialog printed the same. The alternatives — a `labelKey` in the registry, or dropping `label`
from the wire — would be a second mechanism for a problem #8 answers, and would take away the fallback that
keeps an unknown workflow readable.

**Cost** The Chinese labels are a hand-kept list, and a parameter added to the registry tomorrow ships in
English until someone adds an entry. The check cannot catch that, because the set of parameters is registry
data rather than something the source names — #8's cost, now paid by knobs as well. The English screen is
unchanged, since `chinese()` answers only when the reader's language is zh-CN.

**Tested** `npm run check` (886 zh keys against 853 en, still "the two agree": the block is zh-only by design,
as declared), `npx tsc --noEmit`, `npx vitest run`, `npm run build`. Not checked in a
browser: the labels are text in two components, and what could break is a missing entry, which shows the
registry's English exactly as before.

**Where** `frontend/src/lib/server-labels.ts`, `frontend/src/components/canvas/canvas-tool-node-panel.tsx`,
`frontend/src/components/canvas/canvas-tool-node-panel.tsx`, `frontend/src/i18n/locales/zh-CN.ts`,
`frontend/scripts/check-i18n.cjs`.


## 270. The agent can see a card's box, and set it

**Decision** Two things the agent was blind to:
- `list_nodes` now carries the box — `at (1541, 438), 320×240` — and, when a picture's own pixels are not
  that size, the picture's as well: `(picture 1920×1280)`. Two sizes, because a card is the *shape* of what it
  holds but not its size, and the second one is left out when the two agree.
- `resize_node(nodeId, size: {width, height?})` sets the box, and the top-left corner stays where it is — the
  same corner `move_node` states, so a resize never disturbs a node that was just placed.

A card that frames a picture or a film is that picture's shape (#264), so it has one degree of freedom: the
width, with the height following. A height stated beside it is *checked*, and a pair that disagrees is refused
with the height that fits (1 px of tolerance for the caller's own rounding). A card holding words, a sound or a
group takes both numbers, and one left out keeps the height it has.

Nothing here is new policy re-implemented: the ratio is `nodeRatio`, which was the expression inlined in the
corner drag; whether a card keeps it is the node definition's `keepsAspectRatio`; the floor is `NODE_MIN_SIZE`,
which the drag also used as two local numbers. For a locked card the effective minimum width is
`max(220, ceil(160 × ratio))` — the clamp the drag already applied without ever stating it, now a number the
agent is told.

**Why** With a box on the list and a size to set, laying out a row is arithmetic the model can do, and the tool
carries no new policy. #184 recorded "no collision test and no snapping" as the cost of `move_node`; the answer
was never a collision test, it was the numbers. The alternative — a size argument on `move_node` — merges two
intents into one call, which is the same reason `set_prompt` and `set_text` are two tools.

**Why a refusal and not a clamp** A clamp answers `isError: false` while doing something other than what was
asked, and the caller has to read the sentence to discover it. A refusal is a failed call that carries the fix
(`480 wide is 320 high — state that, or change only the width`), so the second call is the right one.

**Cost** Two things the tool says it cannot do, and both are content requests wearing a size request: a
picture's card cannot be made square (that is a crop or an outpaint, which the user has and the agent does not),
and a film's card cannot be freed from its film's shape (nothing can, since #264). A resize also moves the
node's centre, so its group membership can be stale afterwards without the box being wrong — the drag has the
same gap, and closing it in one path only would make the tool and the gesture disagree about what a resize
leaves behind.

**Tested** `make check`, `go test ./...`,
`TestMCPHandshakeIsEnoughToDiscoverTheTools` (thirteen names, in order), `npx tsc --noEmit`,
`npm run check` (886/853, 183 modules), `npx vitest run` (386 — six new: the width-only resize on a 3:2 card,
the refused contradictory pair, a text card taking both numbers and keeping its height when given one, the
floor refused and named from both sides, a call with no size, and an id the canvas does not hold), `npm run
build`. The tool tests register the real node definitions, so `keepsAspectRatio` is the real rule
rather than a stub. Not checked in a browser: the page on `:8190` is a build that does not advertise these
tools, and what changed is a tool's decision plus one line of `list_nodes`.

**Where** `internal/server/routes_mcp.go`, `internal/server/mcp_test.go`,
`frontend/src/lib/canvas/{canvas-agent-tools,canvas-agent-view,canvas-node-size}.ts`,
`frontend/src/components/canvas/canvas-node.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`,
`frontend/tests/{canvas-agent-tools,canvas-agent-view}.test.ts`.


## 271. `layout` is the node's word, not a mode

**Decision** `requestGeneration` reads the layout attachment from the node's own choice
(`config.imageMode === "layout" && config.layout`) instead of from the resolved mode, which is what
`requestEdit` had always done. The resolved mode — the one the model declares — decides only what `mode` the
request carries.

**Why** #267 changed that line to read the resolved mode, and the resolved mode is never "layout": it is not a
variant any workflow declares. `layout` is the client's name for "a text-to-image run whose prompt carries a
MOSS layout", which the server renders into the prompt (`internal/prompt/layout.go`). So the guard became
false, and every layout run dropped its layout — on the workflows where the feature actually works (the MOSS
ones, which declare no variants), the payload vanished and the run produced a picture from the prompt alone.

This is the failure mode #267 was written against, arriving from the other side: a client word read as if the
server had declared it. Caught while mapping the image family's remaining id-shaped decisions, not by a test —
which is why the test now exists.

**Cost** None: the line goes back to what `requestEdit` does, and the two request paths now agree about what a
layout run is. A stale `layout` on a family that declares modes pins the mode that asks least (#268) *and*
keeps the layout, which is one more reason the pseudo mode cannot be read from the resolved one.

**Tested** `npx vitest run` (388, two new): a MOSS-shaped workflow sends `layout` + `layoutEnabled` and no
`mode` at all; a family with declared modes sends `mode: "t2i"` (the mode that asks least) and still carries the
layout. The first of those fails against #267's line, which is what makes it a regression test rather than a
description. `npx tsc --noEmit`, `npm run check` (886/853, 183 modules), `npm run build`.

**Where** `frontend/src/services/api/image.ts`, `frontend/tests/api-image-runs.test.ts`.


## 272. What the browser said

**Decision** None — this is the browser check that #264, #266, #267, #269, #270 and #271 were missing. The
server on `:8190` was rebuilt from this tree and restarted (`make build`, `./start.sh`), the page hard-loaded,
and eight things looked at. What follows is what was seen, not what the tests promised.

**On the wire** `GET /api/workflows` carries it: `mode` and `accepts` on the four H3 video workflows,
`variantModes: ["edit","inpaint","outpaint","t2i"]` on `image-qwen21`, `parameters: [horizontalAngle, pitchAngle,
cameraDistance]` on `image-qwen21-angle` (the declaration from #267), `multiplier` on `video-rife`. The agent's
startup frame answered `MCP servers initialized: 1 servers, 13 tools loaded` — twelve tools and `resize_node`.

**The bug this thread started from is gone.** A canvas with a RIFE node saved as `model: default::video-rife`,
`params: {multiplier: 2}` shows a node titled `RIFE 插帧 2×` whose panel is: one connected clip, `Needs 1
clip(s) · 1 connected`, `Multiplier` with the pills `2` and `3`, and Generate. No prompt box, no size/seconds/
mode pills, no red "text-to-video does not accept images" warning. In Chinese: `需要 1 条视频 · 已连 1`,
`插帧倍数`, and the picker reads `RIFE 帧插值` — three dictionaries answering, the requirement, the knob and the
model.

**The angle step renders from its declaration.** Retargeting an image node to `Qwen Image 2.1 多角度` switches
the panel from the composer to the step panel: a prompt box (the step takes words), `需要 1 张图片 · 已连 0`, and
`水平角度` / `俯仰角度` / `镜头距离` as number inputs at their declared defaults (0, 0, 5), with Generate disabled
while the requirement is unmet. Before #267 this was the composer — prompt and size pills, no knobs — and its
request would have been refused for inputs the workflow did not declare.

**Already in the page's own transcript, from a session the user drove**: `list_nodes` answered with the boxes
(`文字节点 (558×222)`, `视频 420×420`, `插值视频 420×420`) and the agent worked out a non-overlapping layout
from them; then `canvas_resize_node` was called and the panel reported `The call succeeded`. That is the tool's
round trip through the bridge, the socket and the page — done before this entry was written, by the person using
it.

**Not exercised** The ratio refusal: the live resize was a square picture into a square card, so the
disagreement path was never taken in the browser (it is unit-tested). Nor was the group-membership gap after a
resize (#270's cost).

**What the browser showed that the tests could not** An image node retargeted to a step keeps its own picture but
the step wants a *connected* one: the angle panel says `已连 0` on a node that visibly holds an image, so the step
cannot run until another node is wired into it. That is how steps have always worked (their media arrive as
references, not as their own content) and it is consistent — but "turn this picture into an angle" is exactly the
sentence a user will say next, and the engine already has the picture in hand. Left as a question, not changed
here.

**Where** Nothing. The server is running the rebuilt binary on `:8190`; the page was reloaded against it.


## 273. A node panel asks its kind for its controls instead of branching

**Decision** The controls a node's panel shows beside its prompt are a static table, one component per
generation kind, in `frontend/src/components/canvas/panels/`: `NODE_CONTROLS[mode]` answers with
`ImageControls`, `VideoControls`, `AudioControls` or `TextControls`. The panel keeps the shell — the reference
bar, the prompt box, the agent settings, the generate button — and renders `<Controls … />` where a four-arm
`mode === … ? … : …` chain used to sit in the middle of its JSX.

**Why** That chain put four different clusters of pickers and popovers inside one function, and the facts that
actually differ per kind (which pickers, which popover, which session) were spread around it as ternaries on
`mode === "text"`. The card itself made this move long ago — `nodeContentRenderers[type]` is the same shape, one
component per type, looked up at render — so the panel was the one place left asking what it was drawing.

**What it is not** A registry: no `register…`, no lifecycle, nothing that runs at startup. The table is a
`Record<CanvasGenerationMode, ComponentType<NodeControlsProps>>`, written out once, so the compiler refuses a new
kind with no controls. The canvas had a plugin mechanism and deleted it (#148); a table typed by a closed union
is not that.

**The seam** `NodeControlsProps`: the shared core (`node`, `config`, `onConfigChange`, `onOpenPreferences`) and
the few optional members only one kind has (the image popover's open notification and its three editors, the
video kind's frame mode and mode switch and source length, the text kind's agent). A kind reads what it needs.

**Cost** The panel went from 588 lines to 538 — less than the "~350" I said it would, because the arms were only
about fifty lines and the rest of the panel is the shell that stays. What is left are the `mode === "text"`
ternaries around the placeholder wording, the caption button and the generate button's "connect the agent"
behaviour: those are the shell's behaviour rather than a kind's controls, and moving them would mean the table
carrying `placeholder` and `primary` — a second decision, not this one. Every kind also receives the whole props
object, so a kind that needs two fields still takes a bag of twelve; that is deliberate (four near-identical prop
types are worse) and it is the part most likely to drift.

**Tested** `npx tsc --noEmit`, `npm run check` (189 modules, 886/853 keys, prettier clean), `npx vitest run`
(40 files, 388 tests), `npm run build`. In the browser, on an isolated copy of the workspace
(`/tmp/verify`, port 8191, its own canvas root): a text node's panel shows its agent cluster; an image node's
shows the workflow picker, the base-model picker and its settings popover (Size, Aspect ratio); a video node's
shows the workflow picker and its popover (Resolution, Seconds, Refine, Mode) — and picking `Quality` wrote
`videoSelfLiftMode: quality` onto the node, which is the moved `videoConfigPatch` working. An audio node could
not be made from the canvas menu (there is no such entry — a sound arrives by import, through a native file
chooser), so that panel was not looked at; it is the same three lines as the video one.

**Where** `frontend/src/components/canvas/panels/{node-controls,node-controls-props,image-controls,video-controls,audio-controls,text-controls}.tsx`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`.


## 274. The keys a run may take are on the wire, and the canvas prunes to them

**Decision** `PublicEntry` and every `VariantContract` now carry `inputs`: the keys a run of that workflow (in
that mode) may carry. It is `Entry.AcceptedInputs()`, which is `InputSpecs` reduced to its keys — the same list
`ValidateInputs` enforces. On the client, `paramsAcceptedBy(config, model, params, mode)` keeps only the stored
knobs that list names, and the four request paths ask it before they send: `requestGeneration`, `requestEdit`,
`createServerVideoTask`, `createVideoStepTask`.

**Why** A node keeps its `params` when the model under it changes, and a knob belongs to the model that
declared it, not to the node. So a value from a previous model travelled with the request and was refused:

```
POST /api/canvases/…/runs  {"workflow":"image-z-image-turbo","inputs":{"prompt":"probe","upscale_model":"…"}}
→ 400 unknown_input "upscale_model"; workflow image-z-image-turbo accepts: …
```

That is reachable with the shipped workflows and no operator additions: upscale a picture (the node stores
`upscale_model`), change the node's model to Z-Image, press generate. The refusal names a field the user never
typed.

**The same line closes the latent one** `videoSelfLiftMode` used to be sent to every from-prompt video workflow
as `transition_step`. It is a declared parameter of the four H3 workflows and of nothing else, so an operator's
own video workflow was refused on every run. Now it is a knobs-like value that survives the same pruning.

**Why the wire and not a client rule** The client could have guessed — union of `parameters` with a hardcoded
`editCanvasSize` — but `editCanvasSize` is a *request* key rather than a declared parameter, so that rule would
have dropped it, and a future workflow whose knob is bound as `params.<name>` without a declaration would have
been dropped too. The server already computes this list for validation; carrying it is what makes the panel and
the 400 the same answer rather than two.

**Three states, again** `inputs` is absent when a server does not say, and the client then sends everything it
has: a model it knows nothing about is not a model that takes nothing. `[]` is normalised away for the same
reason.

**Cost** The workflows payload grows by one array per workflow and per mode (15 to 24 short strings each, the
request's own keys included). A knob the server does not declare is now dropped silently instead of refused
loudly — which is the same outcome seen from the other side, since the server would have refused the run
anyway; what changed is that the run now happens.

**Tested** `go test ./...` (`TestPublicProjectionCarriesTheKeysARunMayTake`: the entry's keys, the variant's own,
and that a key the projection offers is one `ValidateInputs` accepts), `make check`,
`npx tsc --noEmit`, `npm run check` (189 modules, 886/853 keys), `npx vitest run` (391: the picker entry carries
the list per workflow and per mode, an empty list normalises to absent, `paramsAcceptedBy` keeps an accepted
knob and `editCanvasSize`, drops the stale one, returns nothing when nothing is left, and passes everything
through for a model it knows nothing about; and one request-shaped test whose body is exactly
`{prompt, seed, size}` where `upscale_model` used to be), `npm run build`. On an isolated copy
(`/tmp/verify`, port 8191): all thirteen shipped workflows report their keys, `upscale_model` only on the
upscaler, `multiplier` only on the interpolation, `transition_step` only on the four H3 ones, and
`image-qwen21/outpaint` adds exactly the eight padding keys its siblings do not have.

**Where** `internal/workflow/{inputs,render,render_test}.go`, `frontend/src/services/api/{workflows,image,video}.ts`,
`frontend/src/lib/server-models.ts`, `frontend/src/stores/use-config-store.ts`,
`frontend/tests/{server-models,model-selection,api-image-upscale}.test.ts`.


## 275. `negative` is a key only a graph with a negative text encoder can take

**Superseded by #288** — the key is gone from the contract entirely. What follows is the step that got it
out of nine workflows; it is kept because it is why the removal had a small surface to begin with.

**Decision** `InputSpecs` now adds `negative` only when a binding reads that field — a `negative` binding with
no `from`, or one that names `negative` explicitly. Every other request key is still added for every workflow.
The helper is `negativeBound`; the rule is one `if` in the one function that both the wire projection and the
validator already share.

**Why** `/api/workflows` declared `negative` for all thirteen shipped workflows, and nine of them could not
have used it: Z-Image and the four H3 video workflows wire `ConditioningZeroOut(positive)` as their negative
(there is no second text encoder to write to), ESREGAN has no text at all, `image-qwen21-angle` has the negative
string baked into the graph with no binding, and the music workflow has no text encoder either. A run carrying
the key was accepted and dropped — the same lie #274 removed from the other direction, where the client sent a
key the server refused. A key the contract offers is a key a client may build a control for, and a control that
provably does nothing is worse than no control.

**Why the control is not what was added** Nothing in the UI needed this. ComfyUI drops the branch: `cfg 1` means
`uncond_ = None` in `sampling_function` and `negative_cond = None` in `CFGGuider`, so a negative string has no
route to a prediction. Measured on `192.168.3.233`, ComfyUI 0.43.0, `image-moss-sft-8step`, seed 424242: at
`cfg 1` two unrelated negatives ("worst quality, bad anatomy, watermark, jpeg artifact" and "purple elephant, oil
painting, 1900s sepia photograph") give **pixel-identical** output — 0 of 3,145,728 channel bytes differ; the PNG
files differ only because ComfyUI embeds the workflow JSON, negative included. At `cfg 2` the same pair differs
by a mean of 64/255. Every shipped image graph runs `cfg 1` and the H3 sampler's own default of 5 is overridden
to 1, so
a negative box would be a box that changes nothing until cfg is raised — and raising cfg is exactly what these
distilled models are not trained for (the node's declared parameter range is 1..10, the graphs pin 1). When a
non-distilled model arrives, `negative` and `cfg` are one decision made together; today `negative` is silently
inert and must not be advertised as if it worked.

**Cost** Nine workflows lose a key from their `inputs`: a caller that used to send `negative` there and see no
effect now gets `unknown_input` naming the key. That is the intended trade — the answer changed from "yes, and
nothing happened" to "no". A workflow that gains a negative text encoder later must bind it by name, which is
the rule every other knob already follows.

**Not closed here** Other request keys are still offered to workflows that ignore them: `size` to the upscaler,
`seconds` to an image workflow, `layout` to anything but MOSS. Closing that class is the same shape of fix, but
it needs the client to stop sending those keys first — `frontend/src/services/api/image.ts` sends `size` and `background`
unconditionally — so it is its own change. It is written down where the list lives, in `semanticInputs`.

**Tested** `go test ./...` (`TestShippedNegativeIsAcceptedOnlyWhereItIsRead`: the four entries and four Qwen
modes that bind it accept `negative` and are not refused; the nine that cannot refuse it with the ordinary
unknown-key message; `TestNegativeIsAnInputOnlyWhenABindingReadsThatField`: a `from`-less binding makes the key
real, a binding that reads `params.other` does not, and a workflow with no negative binding does not advertise
it), `make check`, `npx tsc --noEmit`, `npm run check` (189 modules), `npx vitest run`,
`npm run build`. On an isolated copy (`/tmp/verify`, port 8191) `GET /api/workflows` reports
`negative` only for `image-qwen21` (all four variant contracts) and the three MOSS workflows, and for none of
Z-Image, ESREGAN, the angle workflow, the four H3 ones, RIFE or the music one.

**Where** `internal/workflow/inputs.go`.


## 276. A server built in a test is closed in that test

**Decision** `newTestServerWith` registers `t.Cleanup` that calls `srv.Close()` and then `srv.Tasks().Close()`.
Nothing in production changed; only the fixture.

**Why** A server starts what it owns — the task pump, the cleanup ticker, the MCP bridge — and those goroutines
write into the directories the test just made. `t.TempDir()` removes its tree as soon as the test body returns,
so a run that an assertion had queued was still being persisted while the removal walked the same tree:

```
--- FAIL: TestRunValidatesTypedInputs (0.01s)
    testing.go:1464: TempDir RemoveAll cleanup: unlinkat /tmp/TestRunValidatesTypedInputs…/001/data: directory not empty
```

It is not a rare interleaving: the test failed four runs in five on an otherwise clean tree (`git stash` of the
change under test reproduced it), and passed or failed depending only on whether the pump finished first. A gate
that reports a different answer for the same code is worse than a gate that reports a failure, because the
failure gets re-run until it is green and the real one gets re-run with it.

**Cost** Every test server now waits for its store to drain (up to `Store.Close`'s two-second bound) at the end
of its test, and its MCP bridge stops there rather than with the process. Both closes are idempotent, so a test
that already closed them is unaffected. The server package takes ~31s for three runs afterwards, unchanged.

**Tested** `go test -count=1 -run TestRunValidatesTypedInputs ./internal/server/` eight times in a row (was 4/5
failing, now 8/8 passing), `go test -count=3 ./internal/server/` (green), `go test ./...`, `make check`.

**Where** `internal/server/e2e_test.go`.


## 277. A click on a clip is a click on the node

**Decision** `VideoNodeContent` renders the clip without native controls and without pointer events until it is
playing. The only way in is a play button over the still frame (`canvas.node.play`); starting playback attaches
`controls`, so seeking, volume and fullscreen stay the browser's own. The node's state comes from the element's
`play` / `pause` / `ended` events rather than from the button, so playback started anywhere — the button, the
multi-selection's "Play together", the native controls — leaves the node in the same shape.

**Why** `<video controls>` plays when its own surface is clicked, and on a canvas that surface is most of the
node. Measured in the browser before the change: a click on the frame took the clip from `t=0` to playing, while
the same click also selected the node and opened its composer. One gesture, two meanings, and the louder one won
— selecting a clip, or opening the composer to rewrite its prompt, started it. The element now carries
`pointer-events-none` while it is not playing, which puts the node back in the pointer's way: the click selects
and opens, exactly as it does on an image.

**Why not `preventDefault` on the element's click** It was tried and it works — a `click` listener calling
`preventDefault` kept the clip at `t=0` (verified in the page). It was rejected because it leaves the video as
the click target: the frame would still swallow the right-click that opens the node's menu, the wheel would still
be guarded, and the result would rest on a user-agent default action we measured once, with the risk that the
same default is what makes the controls' own play button work. Taking the element out of the pointer's way has
none of that: what happens next is the same DOM arithmetic as every other node.

**Cost** Playback needs one deliberate click where a click used to be enough. A canvas full of paused clips shows
one play button each, over the frame. Wheel over a *paused* clip now zooms the canvas, because the target is the
node and `data-canvas-no-zoom` no longer matches — the same as an image, and the guard still holds while the
clip plays and its controls are live. The controls are the browser's, so they fade when the pointer leaves; a
pause needs a hover first.

**Tested** In the browser on an isolated copy (`/tmp/verify`, port 8191) of a real canvas: clicking the frame of
a paused clip leaves `paused=true, controls=false, currentTime=0` and selects the node (`z-50`) with its composer
open; the play button takes it to `paused=false, controls=true` and the button disappears; `pause()` and reaching
the end both bring the still frame and the button back; shift-click plus "Play together" plays both clips muted
from 0 as before; a wheel over a paused clip moves the canvas zoom 100% → 112%. Photographed at both states.
`npx tsc --noEmit`, `npm run check` (887/854 keys, 189 modules), `npx vitest run`, `npm run build`, `go test ./...`, `make check`.

**Where** `frontend/src/components/canvas/canvas-node.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`.


## 278. A text card is words, and nothing asks it anything

**Decision** A text node has one field: `content`. It has no `prompt`, no `composerContent`, no panel and no
generate button — `generate` is refused on one and so is `set_prompt`, and `set_text` is the only writer. The
反推提示词 button is gone with everything it needed: `captionStatus`/`captionPrompt`/`captionError`,
`caption-jobs.ts`, `requestPromptChat` (`services/api/prompts.ts`), `askOnceAgentSession`, `endAgentSession`, and
the `node:<id>` session name — a text node's own agent had no other caller. The batch machinery went with the
generation that made it: `texts`, `primaryTextId`, `textCount`, and `TextContent`'s `BatchFrame` /
`ExpandedTextCard` / `TextSlotStatus`. `CanvasGenerationMode` lost `"text"`, so the compiler had to visit every
place that had assumed four kinds.

**Why** A text node's prompt was read by exactly one thing: the node's own agent, which answered it and wrote the
card. Nothing else — a connection carries `content` (`resourceText`, `resourceKind` and `builtinResource` all go
through `nodeContentOf`), the server never reads the field, and no run ever carried it. So the field existed to
feed a process whose whole job was to fill the card, and the canvas agent does that directly: `read_node` hands
it a picture, `set_text` writes words, `create_node` makes a card that already says them. Measured on the user's
own canvas first: its one text node held `content` and no `prompt` at all — the one-off agent had never been
used there.

反推 was the last caller, and it was the thing #257 deleted everywhere else: a sentence written inside the canvas
(`用一段话描述这张图片…`, hardcoded Chinese, no skill, no test) whose answer went into `prompt` — a field nothing
downstream reads — so the real flow was 反推 → press ↑ → the same model asked to repeat that sentence → the card.
Two round trips to say one thing, from a button that made a node to hold a question nothing else wanted.

**Why not keep 反推 as a tool** A tool would have to carry the same sentence, and there is nowhere honest to put
it: the canvas has no place for prompt wording that is not a skill (#257), and a tool description is read by
the model before it acts rather than being the thing it acts on.

**Cost** Turning a picture into words is now a conversation with the canvas agent instead of one click, and it
needs a model that declares image input — `read_node` hands the bytes over either way, but whether a model can
read them is AlayaCore's judgement, not this server's. The per-node model picker for writing a card goes with the
panel: the canvas agent's model is the one that writes now. A canvas saved before this change may hold a text
node whose `prompt` had words in it; that field is no longer read, and folding it into `content` would be
inventing an answer to a question nobody can see.

**Tested** In the browser on an isolated copy (`/tmp/verify`, port 8191) of the user's canvas: a click on the
text card opens no panel (0 `[data-node-panel]` elements; before the change it opened one with a prompt box and a
连接 button), a double-click still opens the card's editor with the words in it, an image node's panel is
unchanged (model picker, 1:1, Generate, sent-prompt disclosure — and no 反推 and no agent picker), and the
hover toolbar lists info/remove/download/copy prompt/mask/crop/split/upscale/super-resolve/angle/view/configure
with no 反推, as does the quick-tools window. `npx vitest run` (378 in 39 files — `api-prompts.test.ts` went with
its subject, the rest rewritten for the new answers), `npm run check` (862 zh keys, 829 en, 25 dead keys removed
from each, 186 modules), `npm run build` 558.77 kB, `make check`, `go test ./...`.

**Where** `frontend/src/types/canvas.ts`, `frontend/src/lib/canvas/node-prompt-field.ts`,
`frontend/src/lib/canvas/canvas-agent-tools.ts`, `frontend/src/components/canvas/canvas-node.tsx`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`,
`frontend/src/components/canvas/{canvas-node-hover-toolbar,canvas-image-toolbar-tools}.tsx`,
`frontend/src/components/canvas/panels/{node-controls,node-controls-props}.tsx`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/pages/canvas/hooks/use-generation-runs.ts`,
`frontend/src/services/api/agent.ts`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`internal/server/{routes_mcp.go,agent_instructions.go}`, `docs/server.md`.


## 279. A tool answer is one frame, and the socket admits as much

**Decision** `internal/ws.maxMessage` is the agent's frame bound (`agent.MaxFrameSize`, 64 MiB) rather than a
number of its own, and a test holds the two equal. `MAX_INLINE_MEDIA_BASE64` in `canvas-agent-tools.ts` follows
it: 40 MiB of base64, about 30 MB of file, instead of 5 MiB.

**Why** A tool answer is one message on the agent socket and one frame on the agent's stdin. Those two hops had
unrelated bounds — 8 MiB and 64 MiB — so a picture that the agent would have accepted was refused, and refused
badly: `ws.ReadMessage` fails, the socket dies and the turn with it, and the page shows 请求失败. The number
that was supposed to produce a sentence (`MAX_INLINE_MEDIA_BASE64`, checked in the page) sat in front of a wall
it did not know about, with no relation to it: 5 MiB base64 into an 8 MiB message, 2.3× of headroom, chosen once
by nobody in particular.

Nothing was protected by the smaller number. 64 MiB is already the size the agent's own reader permits one hop
later, so the only thing the 8 MiB bought was an inconsistent refusal — and a tool answer is not a dangerous
message: it is the page the user is looking at answering a call that page made.

**Why not scale the picture here** AlayaCore already scales what it hands a model, so doing it in the page would
be a second answer to the same question and a worse one (it would also mean deciding what a picture is for — a
look, a detail, a colour). What this side owes is the bytes on the wire, and to say so when they do not fit.

**Cost** One WebSocket message may now allocate 64 MiB on each side, where it used to be capped at 8. That is the
same allocation the agent's frame reader already allows, so it is not a new class of failure — and a tool answer
over 40 MiB of base64 is still refused with a sentence that says how to look at the file instead.

**Tested** `go test ./internal/ws/` (the new test fails if the two bounds drift; it is the reason the number can
be stated in one place and read in two), `go test ./...`, `make check`, `npx tsc --noEmit`,
`npm run check`, `npx vitest run`, `npm run build`.

**Where** `internal/ws/ws.go`, `internal/ws/ws_test.go`, `frontend/src/lib/canvas/canvas-agent-tools.ts`.


## 280. Whether a session keeps a conversation is the name's business, not the client's

**Decision** `GET /api/agent/socket/{session}` carries no query. `agentOptionsFor(session)` asks
`sessionFile(session)`: a `canvas:<id>` is spawned with `<CANVAS_ROOT>/<id>/session.alaya`, and any other name is
spawned with no `--session` at all. "This name is not a canvas" is now a sentinel (`errNotACanvas`) rather than
the one generic error, so the caller can tell a name that keeps nothing from a canvas whose directory cannot be
resolved — which used to arrive as the same string.

**Why** `?history=1` asked the client to say whether the server should keep a conversation, while the server
already reads the name to decide *where* it goes (`sessionFile`, #178). One question answered in two places, and
the answer the client gave was the one that could be wrong: a canvas that forgot the flag kept nothing, and a
name that was not a canvas could ask for a file it had no home for. The flag was made for the node panels (#104),
and those no longer exist (#278).

**Why not give every name a file** Measured rather than assumed: `alayacore --rawio --session /tmp/probe.alaya`
writes nothing until something is said, and a `model_sync` command exchange writes nothing either — only
conversation content is persisted. So the choice was never "a file for the models editor or not"; it was "one
rule or two". The name decides where, and a name with nowhere has nothing.

**Cost** The models editor cannot ask for a file even if a future one wanted to; that would have to be a name
with a home, not a flag. The models editor keeps its session, because it cannot not: `model.conf` is a
`---`-separated hand-edited file and AlayaCore is the only thing that writes it, so `model_sync` needs a process
to send it to. What a canvas gains is that it cannot forget its conversation any more.

**Tested** `TestTheNameDecidesWhetherTheConversationIsKept` (a canvas is spawned with a file inside its own
directory, `settings` with none, and a missing canvas is still an error), `go test ./...`, `make check`, `npx tsc --noEmit`, `npm run check`, `npx vitest run`, `npm run build`. The
probe above ran against a copy of the real `model.conf` in `/tmp/probeconf`, so nothing the user owns was
written.

**Where** `internal/server/{agent_conversations.go,agent_config.go,routes_agent.go}`,
`internal/agent/sessions.go` (a comment that named the wrong caller of `List`),
`frontend/src/services/api/agent.ts`, `frontend/src/components/canvas/canvas-agent-panel.tsx`,
`internal/server/agent_e2e_test.go`, `docs/decisions.md` (#104).


## 281. A tool line leads with how it went, and names what it was about

**Decision** A tool call in the agent panel is one line: the state mark, then `calling <tool>`, then the argument
that names what the call was about, then — for a file read — the part of the file it asked for. The mark stands
where the wrench icon stood — a ball turning while the call is out, a green tick when it came back, a red cross
when it came back as a failure, a dashed circle when the turn ended before the call did. The subject comes from
`toolSubjectOf` (`frontend/src/lib/canvas/tool-argument.ts`), a table of the built-in tools' identifying arguments read out of
the call's own JSON — `read_file`/`edit_file`/`write_file` → `path`, `execute_command` → `command`,
`search_content` → `pattern` — plus, for `read_file`, `start_line`/`num_lines` as `start=12, count=40`. The tool's
name and that range never shrink; the subject is the half that gets an ellipsis when the line runs out of room.

**Why the mark first** The question the line is read for is "did it work, or is it still going". A line answers
left to right, so an answer at the right-hand end is the last thing found — and once a path is on the line it is
the first thing an overflow takes. A tool icon was also the one glyph on the line that said the same thing every
time: that a tool ran. The mark says the part that differs.

**Why the range is its own half of the line** Which file is one question and where in it is another, and the
answer to the second is two numbers wide. Drawn at the end of one truncating span, `start=12, count=40` is the
first thing a long path eats — the reader would get a file name and no idea which part of it was read. So the path
gives way and the numbers do not. `start_line: 0` and `num_lines: 0` are AlayaCore's "from the top" and "to the
end", so they are left out rather than drawn as a place in the file.

**Why the argument, and only for these tools** "calling read_file" ten times over is ten identical lines; the file
is what tells them apart. The table stops at the tools whose arguments name a subject in words: the canvas's own
tools take node ids, which a reader cannot follow and which the panel beside them already shows, and a call whose
arguments have not arrived yet — the name frame comes first (#221) — has no subject at all, so the line is what it
was.

**Why a ball** One mark, four forms, and only one of them moves: at 11px a turning outline and a settled success
read too much alike, and a solid disc is unmistakably not a tick. It is `theme.node.muted` with a white specular
highlight off centre, so the rotation is a highlight going round rather than a whole dot rotating invisibly — in
both palettes, since it wears the theme's own colours rather than the two the tick and cross need to mean what
they mean.

**Cost** The table knows AlayaCore's field names, so a built-in added upstream shows no subject until the table
learns it — nothing is guessed from an argument's shape, because "the first string in the JSON" is the sort of
guess that shows a node id to a reader. The wrench icon is gone from the panel's imports.

**Tested** `frontend/tests/tool-argument.test.ts` (each built-in, each shape of a line range, a range with nothing to
narrow, an unknown tool, arguments that have not arrived, are not JSON, or hold an empty or non-string field, and a
command folded onto one line). The states and the truncation were rendered in a throwaway harness at 1× and 4× in
both palettes — a long path cut to `frontend/src/components/c…` with `start=12, count=40` whole beside it — and
two screenshots of the turning ball differ only around the marks, so it turns. End to end on an isolated `:8191`
with the real AlayaCore: a `read_file` call drew `✓ calling read_file frontend/src/main.tsx` in the panel, and a
`canvas_read_node` call was caught while `[aria-label="The call is running"]` was set. `make check` (deadcode
506), `go test ./...`, `npx tsc --noEmit`, `npm run check` (i18n 861/828, exports 187 modules), `npx vitest run`, `npm run build`.

**Where** `frontend/src/components/canvas/canvas-agent-panel.tsx` (`ToolStepLine`),
`frontend/src/lib/canvas/tool-argument.ts`, `frontend/tests/tool-argument.test.ts`.


## 282. A folded thought shows its two ends

**Decision** A collapsed reasoning row reads `Thinking <head> … <tail>`: the first 120 characters of the thought,
one ellipsis, and its last 20. `reasoningPreview` (`frontend/src/lib/canvas/reasoning-preview.ts`) cuts both halves by length,
folds their line breaks into single spaces, drops half a character at either edge, and drops the punctuation a cut
can leave at the front of the tail. Expanded, the preview is not drawn at all — the whole thought is under the row.

**Why** A closed row that says only "Thinking" hides the one thing that tells a reader whether to open it. The two
ends answer the two questions a fold is checked for: the start, to recognise the thought; the end, to know what it
concluded. The middle is the part a reader skips anyway.

**Why the ellipsis is drawn once** The row's "…" is a mark, not a character: it says the middle is gone. A head that
also ended in an ellipsis of its own — which is what an overflowing line does by default — made the row read
`blah… …blah`, two marks for one elision, and that is what an hour of looking at it caught (#282,
`text-overflow: ellipsis` → a fade). So the head *fades* out over the last 24px of its box where it runs out of
room, and the only ellipsis on the row is the one between the halves. A thought short enough that the head is all
of it has no second half and so no "…" to share: that one keeps the ellipsis an overflowing line is supposed to
end in.

**Why the tail is never cut** It is 20 characters by construction, so it fits even a panel dragged to its 320px
minimum, and a tail elided at its own end would drop the very words the tail exists to show. The head is the half
that gives way, and at narrow widths that means the head shows ten characters and fades — the conclusion is what
was asked for.

**Why by length and not by measurement** The thought arrives a delta at a time and the row is redrawn on every
frame (#237). Measuring text per frame — `scrollWidth`, `measureText` — is a layout read per frame; slicing is not.
Both slices are cut before they are tidied, so their cost is the 120+20 units asked for, whatever the thought has
grown to. That is the whole answer to "is this a performance problem": no, and the reason is in the order of the
two operations.

**Why `w-full` on the row, and why it is written down** A `<button>` is sized by its content, so the truncating
head had no width to truncate against: the row grew to the length of the thought's first 120 characters and the
transcript scrolled sideways instead of eliding. Found by asking the panel which elements had `scrollWidth >
clientWidth`, not by looking. The same trap waits for the next row that puts long text inside a button.

**Cost** A tail can begin mid-word, which is the price of not measuring, and a word is worth more than a boundary.
A head that fades takes a couple of its characters with it. The two lengths are constants in one file, and a wider
panel shows more of the same thought rather than more of the thought's ends.

**Tested** `frontend/tests/reasoning-preview.test.ts` (a short thought shown whole, a long one's two ends, the head reaching
the end so there is no middle to elide, line breaks folded, a cut through an emoji at either edge, punctuation left
at the front of the tail, and nothing to show for nothing). In the real panel against a real replayed conversation
on an isolated `:8191`, at 520px and at 408px: the folded rows read
`Thinking 用户希望把几个图片节点的尺寸改成一样的。当前三个图片节点的尺寸分别是：- image-17 … height 会根据图片形状自动计算。`
and, narrowed,
`Thinking 用户希望把几个图片节⌷ … height 会根据图片形状自动计算。` — one ellipsis in the middle either way, the
end whole either way. Opening a row hides the preview and draws the whole thought, and no element in the transcript
overflows horizontally once the button has a width. `make check`, `go test ./...`,
`npx tsc --noEmit`, `npm run check` (i18n 861/828, exports 188 modules), `npx vitest run`, `npm run build`.

**Where** `frontend/src/components/canvas/canvas-agent-panel.tsx` (`ReasoningBlock`),
`frontend/src/lib/canvas/reasoning-preview.ts`, `frontend/tests/reasoning-preview.test.ts`.


## 283. The summarize threshold is the operator's, and it is a flag or nothing

**Decision** `AGENT_AUTO_SUMMARIZE` (0–100, unset = 0) is read by `config.Load` and carried to every spawn as
`--auto-summarize=<n>`. Zero means the flag is not passed at all, not that `--auto-summarize=0` is passed. A value
that is not a whole number in 0–100 stops the server at startup with a sentence naming the variable.

**Why it is an environment variable, and not a field in the models editor** AlayaCore reads this threshold from its
command line, not from `model.conf`: it belongs to the process, not to a model, and a session's model can be changed
after the process exists (`model_set`). The models editor edits `model.conf`, which is AlayaCore's file; a field there
would either do nothing or need AlayaCore to grow one. The other two agent knobs (`ALAYACORE_BIN`,
`AGENT_CONFIG_PATH`) are in the same table in `docs/server.md` for the same reason, and the server is the side that
spawns the process, so the number arrives where the flags are built.

**Why not the settings document** It would put the number where a user could set it in the UI, which is what the other
preferences do — but the server spawns on socket connect, so a client-written document would be steering process
arguments, which is exactly what #280 took away when it deleted `?history=1`. If this ever needs a control in the
panel, it needs a server-owned setting, and that is a different decision.

**Why strict** Every other number in the loader falls back to its default when it cannot be parsed, because those
defaults work. This one's default is "off", and off is invisible: a mistyped threshold would look exactly like a
conversation that never filled up. AlayaCore refuses the same values for the same reason (its `validate.go`), and a
server that accepted 150 would hand it a flag the agent rejects a moment later, turning a configuration mistake into a
spawn failure at the first message instead of a startup failure.

**Cost** The threshold is one number for every session on the server, canvas and models editor alike; per-canvas
thresholds would need a flag per spawn chosen by something, and nothing has asked for one.

**Tested** `TestAutoSummarizeIsTheOperatorsNumberOrNothing` (unset, `0`, `65`, `100`, padded, `101`, `-1`, `65%`,
`sixty` — the last four must fail and name the variable), `TestAutoSummarizeIsAFlagOnlyWhenAskedFor` (0 leaves the
flag off, 65 and 100 carry it), and on an isolated `:8191` with the real AlayaCore: `AGENT_AUTO_SUMMARIZE=150` refused
to start with `startup failed: AGENT_AUTO_SUMMARIZE must be 0 (off) or 1-100 (a threshold percentage), got 150`; with
`=65` the spawned process's `/proc/<pid>/cmdline` read
`alayacore --rawio --builtin-tools=read_file --auto-summarize=65 --config-path …` and the session connected
(`models=3`), so the agent accepts the flag it was given; with the variable unset the same line has no
`--auto-summarize` in it at all. `make check`, `go test ./...`.

**Where** `internal/config/config.go` (`AgentAutoSummarize`, `autoSummarizeValue`), `internal/config/config_test.go`,
`internal/agent/spawn.go` (`SpawnOptions.AutoSummarize`, `args`), `internal/agent/args_test.go`,
`internal/server/routes_agent.go` (`agentOptions`), `docs/server.md`, `.env.example`.


## 284. The running line says the work, not the thought

**Decision** While an answer is streaming and has said nothing yet, the transcript shows one line under its
parts: a turning circle and `Working… / 处理中…`. The folded reasoning row above it keeps its own title
(`Thinking`, #282). The two rows no longer share a word.

**Why** Both were labelled "Thinking", side by side in one bubble, so they read as one thing drawn twice and the
reader could not tell which one opens. They are also not the same claim: the line is true of the whole turn —
a turn running `canvas_move_node` is not thinking — while the fold's title is true only of what the fold holds.

**Why the line exists at all** The start of a turn has no fold and no call yet, so without it the bubble is empty
text over a panel that looks stuck, and the only other evidence is the stop button a panel's height away.

**Cost** "Working" does not say what work: that is #281's tool lines and the fold's ends, and a word that tried
to say both would be the duplicate this removes. The line also vanishes the moment the first word of the answer
arrives, so a turn that starts typing never shows it — its answer is the progress.

**Measured** On an isolated `:8191` with the real agent, the panel was sampled every ~0.2 s across a whole turn:
`Working…` present from the instant the turn opened until it ended, absent from every idle sample, `Thinking…`
in none of them. Not a claim about a re-render after a reload.


## 285. One press, one answer

**Decision** A press of `canvas_generate` has exactly two answers, both facts: a run is out (its id, and the server
will say how it ended), or it did not start and here is why. It answers when the page answers; the bound is the
bridge's own 30 s, after which the agent is told "the canvas did not answer" — an unknown, not a promise, and
nothing was recorded. A finished run's notice is a debt: `Notified` is persisted, `MarkNotified` is called only
after `Tell` succeeded, and `flushRunNotices` pays what a session is owed when it opens. Every run ends: video and
audio have default ceilings (three hours, thirty minutes), and a ComfyUI that has not answered for five minutes
ends the watch with a sentence saying so. And a node says whether anything is happening in it — `list_nodes` and
`read_node` print "generating now" or "last run failed: …".

**Why** The whole promise of a press is "a run exists, and you will be told how it ended". Measured on a real
canvas (192.168.3.233): one turn created three picture nodes, connected a text card into each and pressed generate
on each; the page processed the connects and the presses within 3 ms — before React had committed the new
connections — so the run saw no card, sent an empty prompt, and the server answered 400 in 2 ms.
`runImageGeneration` caught it, marked the node failed and returned normally: the press reported nothing, the tool
waited out its own clock and answered "if it does not, nothing was produced". The three nodes read `All images
failed to generate` — the reason had been overwritten a line later — and the agent, told silence was possible,
ended its turn and never heard another word.

**Why not the version with the promise** The first attempt kept a third answer ("no run reported yet") and made it
a promise: keep the press, say the late refusal, keep a ledger so the promise survived a page that died. It worked,
and it was scaffolding — a clock deciding what a sentence means, two reporters for one press, a state machine for
the case the clock could not cover, and a 30ms guess in the page. All of it existed to make a *page's silence*
trustworthy. Deleting the promise deleted the scaffolding: a slow page is waited for, a dead page is answered by
the bridge, and a run that took hold is covered by the notice the server owes anyway.

**Why the ordering is a prompt rule and not a mechanism** The calls of one turn do not reach the page in the order
the agent made them — measured in the page's console: a press read `connections 17` while the connect that
mattered was still arriving, and a second press went 400 with the connect answered 16 ms later. No page-side fix
can order what it does not control, and serialising the server's publication couples every call's latency to every
earlier one while letting a queued call time out before it is published and then run anyway. So the system prompt
states the transport's truth: press only after the canvas has answered your connections. Breaking it gets a loud
refusal with the reason, which the agent then repaired by itself, twice.

**What is left in the page** Every hand that changes the canvas is wrapped in `flushSync`, so "it returned" and
"the canvas has it" are the same moment — which is what makes the prompt rule above worth its sentence. The
settle-and-retry beat, the promise channel and the queue are gone.

**Cost** A slow press holds the agent's turn for as long as the page takes (bounded by the bridge's 30 s). A notice
can be delivered twice if the process dies inside the writer's debounce window; that direction is chosen — a
duplicate is a sentence the agent reads, a loss is a conversation that stops.

**Measured** On an isolated `:8191` with the real AlayaCore, against a real ComfyUI and against a stub that accepts
`/prompt` and never finishes: a press that never became a run answered `400` and, in the same second, "generate on
image-… did not start: … requires a non-empty prompt. Nothing was queued, so there is nothing to wait for — fix
that and press it again"; a run with no session open logged "ended with nobody to tell …, and the notice is owed"
and 7 s later, on the page opening, "told …, late", accepted by AlayaCore and worked into a new turn; the stub's
run failed as "generation timed out" with its notice; a real generation finished in 7 s and told the agent. Tests:
`TestANoticeNobodyHeardIsOwedUntilItIsPaid`, `TestTheNoticeSurvivesASessionThatWasNotThere`,
`TestWaitForHistoryGivesUpOnAComfyUIThatNeverComesBack`, and the two "one press, one answer" cases.

**Where** `internal/task/task.go` (`Notified`, `MarkNotified`, `OwedTo`), `internal/server/run_notice.go`,
`internal/generate/runner.go` (`unreachableBudget`), `internal/config/config.go` (`millisOrDefault`),
`frontend/src/lib/canvas/{agent-generate,canvas-agent-tools,node-generation-facts,canvas-agent-view}.ts`,
`frontend/src/pages/canvas/hooks/{use-canvas-agent-tools,use-generation-runs}.ts`.


## 286. The rules that tell the agent how this canvas is meant to be used

**Decision** The canvas's system prompt (`canvasInstructions`) grew by three paragraphs, one was rewritten, and the
two tools that write words gained a sentence each:

- *Candidates are one card.* "…make one text node holding the words, make the picture nodes, and connect the card
  into each of them with canvas_connect — leave their own prompts empty — then press each one with canvas_generate —
  and press only after the canvas has answered your connections: the calls of one turn do not always arrive in the
  order you made them." Editing the card and pressing again is a new set from the new words; another candidate is a
  new node, because pressing replaces what a node holds.
- *Nothing about negations.* A rule saying "write only what should be there, never a negation, never a row of NOs"
  was written, measured and **removed**: the prompt mentions negatives nowhere — not to forbid them, not to define
  them, not to quote them — and neither do `set_text` and `set_prompt`.
- *Placement leaves room.* "…read the card sizes list_nodes reports, and put the cards side by side or one under
  another, not on top of each other."
- *Asking about a node is answered by showing it.* The old paragraph began "The viewport is the user's" and buried
  the rule in an aside; it now begins with the trigger — "When the user asks about a node … call canvas_focus_node
  on it before you answer, and write its title with an @ in front" — and keeps "Naming a node is not showing it."
- *One clause in "Say a thing once"*: "when the words are new **and only that node needs them**", which is where the
  rule used to contradict the card.

**Why** Measured on a real canvas (192.168.3.233): the agent wired three nodes to one text card and pressed generate
in one turn — the idiom this prompt now describes — so the shape is right and the prompt is the place to say it. The
placement rule came out of a real conversation where three 240-high pictures landed at y=-120/80/280 and overlapped.
The focus rule existed and was too soft to survive the sentence after it ("one node per answer is enough"), which is
why a question about a node came back as an id.

**Why these words, and for the smaller model too** A cloud model and whatever local one serves `generic-model` read
the same paragraphs, so each is written the same way: the trigger first, the tool named in the sentence, the
imperative before the reason, no aside inside an aside. The shape is the mitigation — a model that reads only each
paragraph's first sentence still has every rule.

**Why the prompt says nothing about negations** Because it did not work, and saying it may have made it worse. Three
times, against the local `generic-model`, with a card whose own text already ends in "NO text, NO words, NO letters
…", the agent copied that row into the words it wrote: the example in front of it beats a rule about examples.
Strengthening the paragraph twice and repeating it in both tools changed nothing, and the rule had to *quote* the
words it forbade, putting them in the prompt for a model to imitate. The operator's instruction settled it: do not
ask it not to write them, do not mention them at all. Enforcing it would be a code rule in `set_text` (refuse or
strip a trailing row), which nobody has asked for.

**Cost** 6 paragraphs / 391 words → 8 paragraphs, 563 words as this is written (#285's ordering clause landed after
this change). The order changed too: candidates and placement sit right after "prefer a connection to a copy",
because they are that rule applied, and focus — the rule the user asked for — moved one place down.

**Measured** `TestAgentSpawnCarriesTheCanvasRule` names one phrase per rule, in the order the prompt states them: a
paragraph that loses its rule is a behaviour that quietly goes back to the model's taste. Live on an isolated
`:8191` with the real AlayaCore and ComfyUI: "用那张森林提示词卡，给我两个候选图" produced the whole idiom in one turn —
one card, two picture nodes, two connections, two presses, no prompt on either node, both runs completed, the cards
side by side without touching the card. A press on a node the agent had hollowed out (no prompt, no connection)
answered in the same second: "generate on image-… did not start: workflow image-z-image-turbo requires a non-empty
prompt".

**Where** `internal/server/agent_instructions.go`, `internal/server/mcp_test.go`.


## 287. An entry says the decision and the refusal, not the process

**Decision** Every entry carries four things and no more: the decision, the counterfactual (why not the obvious
alternative), what it costs, and a measurement bound to the machine it was measured on. Process narration, the
list of gates that ran and the numbers they printed do not belong — `git show` is better at all three and cannot
go stale. An entry whose subject no longer exists is not deleted but compressed to a tombstone: what it was, why
it went, and what must not come back.

**Why** Measured over the 285 entries before this one: `**Decision**` sections were 45.1% of the file, `Why`
20.1%, `Cost` 7.7%, `Tested` 15.4%, `Where` 6.7%. A file that is 45% prose restating what was built is read by
an agent *one grep at a time* — ~2.8 KB per hit, half of it the diff it could have had from git. 69 entries froze
a snapshot of the day's numbers (`deadcode 508`, `561 kB`, `vitest 397`). Of the 400 distinct paths the `Where`
lines name, 131 do not exist: 121 more were one of two renames (`canvas/web/`, `main.go`) and are corrected, and
what remains names files the entries themselves record as deleted — which is not rot but the point.

**What this is not** It is not pruning. Of the entries that looked like narration, every one sampled carried a
refusal that had been measured or an alternative that had been rejected: the padding is inside entries, not
between them. Nor is it deletion of superseded entries — #262 describes something that no longer
exists, and the reason it must not come back exists nowhere else. Numbers are addresses: nothing is
renumbered, and an entry that does leave takes every citation of it with it (#341, and `check:decisions` fails
on one that stays behind).

**A measurement is not a rule** A sentence with a model name, a version or a number is what was true that day.
The fix is a fixture — `ComfyUI 0.43.0`, `seed 424242`, the workflow — beside the rule it supports, never the
number alone. #275 said "byte-identical" about pictures that differ in their PNG bytes and agree to the last
pixel, because ComfyUI embeds the workflow (negative included) in the file; an agent quoting it as a rule would
have been right by accident.

**Found on the way** #75 opened "decided, not implemented… the four `/api/prompts/*` recipes are still what runs"
about a route #82 replaced with a socket before it was ever built — the one entry in the file that named a live
component which did not exist.

**Where** `docs/decisions.md`.


**Scope of this pass, and where it stopped** The entries over 5 KB are rewritten first, because that is where the
bytes are; below that size an entry is mostly its decision and its refusal already, and rewriting 250 of them risks
losing a nuance to save a few kilobytes. Paths were corrected mechanically where one of two renames was the only
reason a `Where` line failed, and left alone where the file is one the entry records as deleted — a tombstone whose
path no longer resolves is saying what it means.


## 288. There is one prompt box, and there will never be a second

**Decision** A negative prompt is not part of this server, for any workflow, and the operator has confirmed it never
will be. What that removed:

- the seven `negative` bindings in `registry.json` (`image-qwen21` and its `inpaint`/`outpaint`/`t2i` variants, the
  three MOSS workflows);
- the request-level input and the helper that decided who could read it (`InputSpecs`, `negativeBound`, #275);
- `Context.Negative` / `BuildContextParams.Negative` and the `negative` key `fields()` rendered;
- the `Negative:` line in `handleRunCreate`;
- the inference that turned a second text encoder into `negative`/`negative2` bindings when a graph is imported;
- `shipped_negative_test.go`, and the negative assertions in `bindings_test.go`.

A run that carries `negative` now gets `unknown_input` with the accepted list, from every workflow, including the
seven that used to take it. The graphs keep their own strings — `image-moss-*` node 5 still says "worst quality, bad
anatomy, watermark, jpeg artifact" and `image-qwen21-*` still says "artifacts, low quality, blurry, deformed,
watermark" — because that is the export's default and a model's own default belongs in the graph.

**Why the removal changes no picture** Every one of the seven bindings carried a `default` that was *identical* to
the value already in its graph (checked one by one), so the binding could only ever re-write what was there. Removing
it leaves the graph's own string untouched.

**Why it went at all, given it was inert** Because an input on the wire is a promise that a control can be built for
it, and the promise was already false in two directions. At `cfg 1` — which every shipped image graph pins — ComfyUI
drops the uncond branch entirely (`uncond_ = None` in `sampling_function`, `negative_cond = None` in `CFGGuider`), and
measured on `192.168.3.233` with `image-moss-sft-8step`, seed 424242: two unrelated negatives give **pixel-identical**
output at `cfg 1` (0 of 3,145,728 channel bytes differ) and a mean difference of 64/255 at `cfg 2`. And the product
question is settled: one box. Leaving the key would leave a second way to say a prompt — the thing #203, #229 and
#286 spent their sentences removing — and every new graph would keep being asked whether it has a second encoder.

**Cost** An external caller that used to send `negative` now gets a `400` naming the key. Changing a graph's negative
string now means editing the graph, which is where a model's own default belongs and which is also why the inference
no longer invents a binding nobody can set. A future non-distilled model that *wants* a negative prompt cannot have
one through this server; that is a tombstone, not an oversight — reverse this entry on purpose or not at all.

**Measured** On an isolated `:8191` with a stub ComfyUI capturing `/prompt`: `GET /api/workflows` reports `negative`
for no workflow; a run carrying it is refused with `unknown_input`; and the same moss request that used to send the
binding's default sends the graph's own string, unchanged — node 4 `a cat`, node 5 `worst quality, bad anatomy,
watermark, jpeg artifact`, `cfg 1`. `make check` (508 exports, every one reachable) and `go test ./...` pass, with
the inference test now asserting that a second text encoder stays **unbound**.

**Where** `internal/workflow/{inputs,bindings,infer}.go`, `internal/server/routes_runs.go`, `workflows/registry.json`,
`docs/protocol.md`.

## 289. The working line follows the send, not the first frame

**Decision** The panel's one "Working…" row is drawn from `busy` — set where the socket takes the message — and not
from an answer that has arrived. It sits at the end of the transcript instead of inside an answer bubble, and it
carries the seconds counted since the send: `Working… 12s`. The condition is `agentIsWorking(messages, busy)` in
`lib/canvas/agent-transcript.ts`: a turn is running and the answer being written has no text yet.

**Amended by #342** The seconds are the turn's, and where they start is the agent's, held by the session: the task
frame that opens a turn states it, and a reload continues the count instead of restarting it. Where this entry says
"counted since the send" read "since the turn began", and where it says this side is "the only side that can count
them" read "the only side that can keep the start" — the page still ticks, but it is told where to start, and a
message queued into a running turn no longer restarts the number.

**Why** Between the message going out and the first frame coming back there is nothing on screen. The model's first
token, and the tool call that often opens a turn, take seconds to minutes, and the panel looked idle for all of it:
`busy` was true, the stop button was there, and nothing on screen told a thinking agent from a hung one. The row
that already existed could not help, because it was a child of an answer bubble and answer bubbles are created by
frames (`answerFrame` — a frame that says nothing opens nothing).

The seconds are counted on this side because it is the only side that can count them: the agent's own `ttft_ms`
arrives with the step that *ends* the wait. It is the one number here that is not the agent's, and it is what makes
waiting distinguishable from a hang — the same silence with nothing moving.

Rejected: opening an empty answer message at the send so the old row had somewhere to live. That is exactly what
`answerFrame` refuses and rightly — an empty bubble with a spinner in it claims the agent is saying something. What
is true at the send is that a *turn* is running, which is why the row lives outside the bubbles.

**Cost** One predicate, one interval that runs only while the wait lasts (the transcript is memoised, so a tick
re-renders the row), and one string that is no longer the agent's vocabulary: `{{seconds}}` is translated, unlike
`tok/s`. The row also comes back for a message queued into a turn that has already spoken and then been closed by
the echo of the new one — correct, since the queue line is gone and the agent is working on those words.

**Tested** `frontend/tests/agent-transcript.test.ts` (`agentIsWorking`: on from the send with an empty transcript and
with only the echo, off once the answer has text, on for a call-only or reasoning-only turn, off with no turn
running, back for a queued message). In the browser, against an isolated server on `:8191` whose agent is a fake
speaking AlayaCore's wire (`ALAYACORE_BIN`) and answering ten seconds late: pressing Enter produced `Working… 0s` in
the same observation as the user's own message, and a sync five seconds later read `Working… 6s` with nothing from
the agent in between. `npx tsc --noEmit`, `npx vitest run` (402), `npm run check`, `npm run build` (560.91 kB).

**Where** `frontend/src/lib/canvas/agent-transcript.ts` (`agentIsWorking`),
`frontend/src/components/canvas/canvas-agent-panel.tsx` (the row, the interval, the scroll effect's dependency),
`frontend/src/i18n/locales/{en-US,zh-CN}.ts` (`canvas.agent.working`, `canvas.agent.workingHint`),
`frontend/tests/agent-transcript.test.ts`.

## 290. The agent can see a group, and can change one

**Decision** `list_nodes` states membership from both ends — a group's line ends `members: n1, n2`, a member's
line carries `in group g1`, and an empty group says `members: none` — and two tools exist: `group_nodes {nodeIds}`
and `ungroup_nodes {nodeIds}`. Both are the canvas's own buttons (`applyGroupSelection` / `applyUngroupSelection`)
reached with an explicit set instead of the live selection, and the page's Group/Ungroup callbacks were rewritten
to take that set and answer with what they did, so the toolbar and the tools are one function each. `create_node`
still refuses `group`. The system prompt gained one paragraph: a group is a container, grouping is the user's
tidying, and membership is not geometry.

**Why** The list described a flat canvas, so a group appeared as a card with nothing in it. The agent could see
the box and had no way to answer "what is in it" except by reading the rectangle — wrong in both directions,
because membership is a field on the member (`metadata.groupId`) that outlives a drag and is never recomputed
from where the cards sit. The relation existed in the document and in the panel's own side list, and no tool
named it.

The write half is the same gap from the other side: the only way to put a node in a group was to move it inside
the rectangle, and there was no way to make a group, dissolve one, or take a node out. `ungroup_nodes` covers the
two shapes the button covers — a group named is dissolved, a member named leaves, a group left empty goes away —
and a group named in `group_nodes` brings its members and is absorbed, which is how two groups become one.

**Rejected** Letting `create_node` make a `group`. A group holds nodes that already exist, so an empty one is a
card whose only purpose is to be filled by the next call, which could have been the first. The refusal and its
test stay; a group is made from what is on the canvas. **Amended by #291** (that reason is a preference, and the
fact is that an empty group was swept away by the next grouping) and **superseded by #292**, which stopped that
sweep and opened `create_node` to `group`.

**Cost** Two entries in the advertised table (`routes_mcp.go`, and `mcp_test.go`'s list of names), two branches in
`runTool`, two hands on `CanvasHands`, one clause on every member line (two tokens per member), and the two
callbacks in `project.tsx` returning what they changed. `group_nodes` refuses a set that is already one group
rather than making a second card around the same nodes, and says which group it is.

**Tested** `canvas-agent-view.test.ts`: a group naming its members, a member naming its group, an empty group
saying `members: none`. `canvas-agent-tools.test.ts`: the ids reaching the canvas and the answer, the three
refusals (one node, a set that is already one group, ids the canvas does not hold), dissolving, taking one member
out, and a node that is in no group. `mcp_test.go`: the advertised vocabulary, and three phrases pinning the new
system-prompt rule. In the browser, end to end, through the MCP endpoint against the real page (isolated server on
`:8191`, fake agent, canvas of three nodes): `group_nodes ["n1","n2"]` →
`grouped n1, n2 into group-…-d8ifk`; `list_nodes` then reported the card at `(76, 48), 788×316 members: n1, n2`
with both members `in group …`; grouping `["n1","n3"]` moved `n1` out of the first group and left it holding
`n2`; `ungroup_nodes` on a member released it; merging two groups by naming both left one group holding both
their members; `ungroup_nodes` on the merged group released them and removed the card. `npx tsc --noEmit`,
`npx vitest run` (412), `go test ./...`, `make check` (508 exports, every one reachable), `npm run build`
(563.72 kB).

**Where** `frontend/src/lib/canvas/canvas-agent-view.ts` (`membersByGroup`, `groupClause`),
`frontend/src/lib/canvas/canvas-agent-tools.ts` (`groupNodes`, `ungroupNodes`, `nodeIdsOf`, `noSuchNodes`,
`CREATE_TYPES`' comment), `frontend/src/pages/canvas/project.tsx` (`groupNodes`, `ungroupNodes`, `groupSelection`,
`ungroupSelection`), `frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`,
`internal/server/routes_mcp.go`, `internal/server/agent_instructions.go`, `internal/server/mcp_test.go`,
`frontend/tests/{canvas-agent-view,canvas-agent-tools}.test.ts`.

## 291. A group is not made out of nothing, and the reason is not the one #290 gave

**Superseded by #292** — a press no longer deletes boxes it did not empty, so the refusal this entry argued for is gone.

**Decision** `create_node` still refuses `group`, but #290's reason for it — "an empty group's only purpose is
to be filled by a later call" — was a preference dressed as a fact. The fact is that an empty group is transient
canvas state, and that is the reason that stands.

**Why** `emptyGroupIds` collects every group with no members, and `applyGroupSelection` and `applyUngroupSelection`
delete them. Measured: a canvas holding `g-empty` beside two text nodes, with those two grouped, keeps
`g-new, a, b` — the empty group is gone. So a group a tool made out of nothing would survive only until the
user's next tidying press, and nothing in the tool's answer could say so. `group_nodes` makes a card that is
already filled, which is a state the canvas keeps.

The asymmetry is real: `builtin-nodes` registers `group` as a definition and `NodeCreateMenu` lists every
registered type, so a person can make an empty group by clicking. What makes that work is that a person fills it
in the next breath; an agent cannot promise the next breath, and any grouping or ungrouping in between removes
the thing it just made.

**Cost** There is no way for the agent to make a container and fill it over several calls. If that is ever
wanted, it is one line in `CREATE_TYPES` — but the description then has to carry "an empty group is removed by
the next grouping or ungrouping", or the agent will build on state that evaporates between two of its own calls.

**Tested** The sweep above, run once and thrown away: `applyGroupSelection` over `[g-empty, a, b]` as a
throwaway vitest case.

**Where** `frontend/src/lib/canvas/canvas-node-geometry.ts` (`emptyGroupIds`),
`frontend/src/lib/canvas/canvas-agent-tools.ts` (`CREATE_TYPES`),
`frontend/src/components/canvas/nodes/builtin-nodes.tsx`,
`frontend/src/components/canvas/canvas-create-menus.tsx`.

## 292. An empty group is a box, not litter

**Decision** Grouping and ungrouping delete the group shells *they themselves emptied*, and nothing else:
`emptyGroupIds(nodes, keepId)` — which removed every memberless group after any grouping or ungrouping — became
`emptiedGroupIds(before, after)`, the groups that had members before the press and have none after it. And
`create_node` may make a `group`: a container holds nodes rather than content, an empty one is a legitimate card,
a prompt on one is refused, and `group_nodes` stays the tool for wrapping nodes that already exist.

**Why** The sweep came in with the initial import (`ccfe94b`) and was decided nowhere — the log had no entry about
groups at all until #290. What it did was delete cards the press had not emptied: a box somebody made to fill
later, or a group whose members had been deleted, disappeared because two unrelated nodes were grouped in another
corner of the canvas. The half that is defensible is kept: a press that takes every member of `g1` into another
group leaves `g1` holding nothing, and that shell is debris the press itself made.

**Rejected** Deleting the sweep outright. It is the only thing that removes the shell a merge leaves behind, and
merging — take these two groups and make one — would otherwise leave an empty card every time.

**Cost** A group whose members are all deleted now stays as an empty box until someone deletes it, like any other
node. That is the price of not deleting other people's cards on an unrelated press. **Amended by #318**: that
sentence described what removing the sweep left behind, and the reason it gives does not cover the delete itself —
a delete that takes a card's last member is not an unrelated press, so it now removes the shell it emptied. `create_node`'s vocabulary
grew by one type; a group has no prompt, and a call that carries one is refused rather than answered with a node
that is not what was asked for.

**Tested** `frontend/tests/canvas-node-geometry.test.ts` (new, 9): wrapping, a pre-existing empty group left alone,
the shell a press emptied removed, a selected group absorbed, dissolving on ungroup, a group kept for the members
that stay, a box removed when its last member leaves, an already-empty box left alone.
`canvas-agent-tools.test.ts`: a group can be created, and a prompt on one is refused. Browser, end to end through
the MCP endpoint against a real page (isolated `:8191`): made a group (`members: none`), grouped two other nodes —
the empty box was still there afterwards — then took a group's last member into a third group: that shell was
gone, the empty box remained. `npx tsc --noEmit`, `npx vitest run` (422), `go test ./...`, `make check`,
`npm run build` (564.00 kB).

**Where** `frontend/src/lib/canvas/canvas-node-geometry.ts` (`emptiedGroupIds`, `applyGroupSelection`,
`applyUngroupSelection`), `frontend/src/lib/canvas/canvas-agent-tools.ts` (`CREATE_TYPES`, `createNode`),
`internal/server/routes_mcp.go` (`create_node`, `group_nodes`), `frontend/tests/canvas-node-geometry.test.ts`,
`frontend/tests/canvas-agent-tools.test.ts`.

## 293. A node a button creates records the workflow it submitted

**Decision** `buildStepNodeMetadata(config, workflowId, params)` (`canvas-node-factory.ts`) is the one way an
action records what the node it produced *is*: the model that workflow answers to — `modelForWorkflow(config,
workflowId)`, new in `use-config-store.ts` — plus the knobs the run was given, filtered by the workflow's own
`inputs` (`paramsAcceptedBy`). The 放大/超分 editor and the multi-angle editor use it, and they write it when the
node appears rather than when the run ends.

**Why** Both submit a workflow that is not the node's own model — an upscale is `image-esrgan-upscale` whatever
the canvas is set to — so what they recorded was either nothing (`superResolveImageNode` wrote `prompt`/`status`,
and `imageMetadata` contributes only `workflow`/`generatedAt`) or the *source picture's* model (the angle
editor). A node with no `model` is drawn by `buildNodeConfig`'s fallback, so an upscaled picture came back as a
Z-Image text-to-image card: prompt box, size/quality, a send button that repaints over the result, and no
放大模型 knob — while the same card's info popover said `workflow: image-esrgan-upscale`. The video half of this
was settled in #263; the image half never followed, which is why the node a button makes and the node whose model
was picked by hand were two different cards for one workflow.

**Rejected** Reading `metadata.workflow` at render to pick the panel. `model` is what the node is *set to run*
and `workflow` is who *made* the artifact; a user who retargets a node makes them diverge, so the maker would
override the target. Also rejected writing the bare workflow id when the list offers nothing: `channelModelOf`
cannot resolve it, `resolveModelForCapability` falls back to the canvas default, and the #263 lie returns with an
extra unrecognisable value stored on the node — so no model is claimed, and the knobs, which are what the run was
told, are kept.

**Cost** A node whose workflow is not in the model list records no model. The one way that survived is a
workflow that declares a base model nobody installed, since a run is submitted by id and the dialog only asks
whether ComfyUI can run it — and an earlier decision deleted the other one, the resource centre's 启用 checkbox.

**Also** `videoModelForWorkflow` is now a two-line delegation to `modelForWorkflow`, and `videoWorkflowId`, its
only helper, is gone. `buildImageGenerationMetadata`'s step branch is deliberately untouched: it echoes the
config's own model, which is correct for the editors that do run the node's model (mask, outpaint, MOSS layout).

**Tested** `frontend/tests/step-node-metadata.test.ts` (new, 5): an upscale node names the upscaler and
`modelIsStep` agrees (that is the panel), the chosen model file is recorded, an undeclared knob is dropped, an
angle node names the angle workflow and its three knobs, a workflow nothing offers leaves no model claim, and a
variant is never the answer. `npx tsc --noEmit`, `npm run check` (i18n, exports, format), `npx vitest run` (427),
`make frontend`.

**Where** `frontend/src/lib/canvas/canvas-node-factory.ts`, `frontend/src/stores/use-config-store.ts`,
`frontend/src/lib/canvas/video-model-mode.ts`, `frontend/src/pages/canvas/hooks/use-image-editors.ts`,
`frontend/tests/step-node-metadata.test.ts`.

## 294. One upscale action, because there is one upscaler

**Decision** The 超分 action is gone. `CanvasNodeUpscaleDialog` is the only upscale dialog: it asks for the one
knob the only upscaler declares (`upscale_model`), shows the output size the chosen file implies, and submits
`image-esrgan-upscale`. Deleted with the button: the workflow picker and its `preferredWorkflowId` bypass,
`dit_model`, the target-short-edge `resolution` branch with its 2×/3×/4× segmented, the advanced-parameter
collapse (and `components/kit/nav.tsx`, whose `Collapse` was its only user), the SeedVR2 branch of
`prettyModel`, and the copy that promised quality — `AI 超分`, `Start super resolution`,
`没有可用的超分工作流`.

**Why** Two buttons ran one graph. They were two things when they were written: 放大 was a *browser-side*
resize (the initial import's `use-image-editors.ts`, `resolveUpscaleSize`, high/bilinear/nearest, no
request at all) and 超分 was the SeedVR2 graph, whose own knobs were `dit_model` and a target short edge. #65
turned 放大 into a run of `image-esrgan-upscale` and pinned it with `preferredWorkflowId`, so from then on it
borrowed the super-resolution dialog; #64 deleted `image-seedvr2-upscale` ("no caller left") and the video
one. What was left was a second title over the same run, whose only unique control — the workflow picker —
listed exactly one entry, and a dialog whose remaining branches served a workflow that no longer existed.

**Rejected** Keeping the generic dialog and deleting only the button. That is the same code with a one-item
dropdown in front of it: a control that cannot change anything reads as a choice and is not one. When a second
upscaler with knobs of its own arrives, the picker comes back with it — a smaller diff than this one, and with
a workflow to justify every branch.

**Cost** There is no super-resolution path, and this makes that explicit instead of hiding it behind a button.
Enlarging stays a size tool, and the dialog now says so in a line of its own: upscaling makes the picture bigger,
not clearer — for more detail, generate again on a larger canvas. `accepts` still says the upscaler takes
exactly one image, so the run is refused at submission rather than a minute later inside ComfyUI.

**Tested** `npx tsc --noEmit`; `npm run check` (i18n lost four dead keys — `common.yes`/`common.no` were the
boolean branch of the deleted parameter form; exports: `Collapse` and `WorkflowParameter` had no callers left);
`npx vitest run` (427); `make check`; `make frontend` (564 kB → 556 kB). The live `/api/workflows` row for
`image-esrgan-upscale` was read again for the dialog's data: one `select` parameter, three files, no
`resolution`.

**Where** `frontend/src/pages/canvas/hooks/use-image-editors.ts` (`upscaleImageNode`),
`frontend/src/components/canvas/canvas-image-toolbar-tools.tsx`, `frontend/src/components/canvas/canvas-tool-node-panel.tsx`,
`frontend/src/components/canvas/canvas-node-toolbar.tsx`,
`i18n/locales/{zh-CN,en-US}.ts` (`canvas.upscale.*`).

## 296. The image toolbar does not offer to copy a prompt

**Decision** The `copyPrompt` quick tool is gone: its definition in `imageToolDefinitions`, its handler in the
hover toolbar, `hooks/use-copy-text.ts` (its only caller), the four strings it owned — `copyPrompt`,
`copyPromptTitle`, `canvas.nodeToolbar.noPrompt`, `common.copied` — plus `common.promptCopied`, which its toast
was passed, and the `copy-to-clipboard` dependency that the hook was the only user of.

**Why** It copied `metadata.prompt` — the words the user typed — and nothing in the canvas consumes that copy:
a run reads the node, the agent reads the node, and anyone who wants the words can select them where they
already are. The image toolbar's job is to *do something to the picture* (mask, crop, split, upscale, angle);
this was the one entry that only moved text to the clipboard, which the browser does from a selection.

**Rejected** Keeping it for the node-info dialog. The prompt is already shown there as selectable text; a
button that duplicates the browser's own copy is the same litter one corner over.

**Cost** A habit changes. Nothing read `metadata.prompt` through this path, so nothing else moved.

**Tested** `npx tsc --noEmit`; `npm run check` — i18n dropped to 840 keys and the checker named `common.copied`
only once the hook went, which is how the last caller of a string surfaces; `npx vitest run` (426);
`make frontend`. A saved quick-tool preference is filtered against the ids that exist
(`IMAGE_QUICK_TOOLS_STORAGE_KEY`), so a stored `copyPrompt` is ignored rather than leaving a hole in the bar.

**Where** `frontend/src/components/canvas/canvas-image-toolbar-tools.tsx`,
`frontend/src/components/canvas/canvas-node-toolbar.tsx`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`, `frontend/package.json`.

## 297. Material is not a generator, and nothing can make it one

**Decision** A node with content and no recorded `model` is drawn as *material*: the node panel says what it is
and offers nothing else — no prompt box, no send button, no model picker, no reference bar (`nodeCanGenerate`,
`canvas-generation-helpers.ts`). It has no run, and none of the three ways to give it one survives: the panel
draws no control, `canvas_set_node` refuses a model or a mode (`materialClause`), and `canvas_generate` refuses to
press it. `canvas_read_node` answers that there is no run and no model can be set, instead of "no model has been
picked for it", which read as an invitation. The crop and split editors stop copying the source's `prompt` onto
the piece they make.

**Why** The composer's fallback answers "no model" with the canvas's default model, which is right for an empty
node and wrong for a picture somebody cut out: a crop was drawn by the browser, an upload arrived from outside, a
mask node is a byproduct of an edit, a frame was taken out of a film. The panel claimed a model for all of them
and offered a send button whose only possible effect was to repaint the material with that default — destructive,
and a claim the node never made. The copied prompt made it worse by enabling the button: a crop of a Qwen picture
was one press away from becoming a Z-Image render of its parent's words.

**Why the picker went** This entry used to keep one control — an empty model picker — on the reasoning that
choosing a model *is* saying "generate here". That reasoning was wrong about what "here" is: a run reads only what
is connected to it (`buildNodeGenerationContext`) and never its own content (`requestGeneration` sends
`references: []`), so the press the picker bought could not read the picture it stood on — only overwrite it.
On a frame taken from a clip: pick a model, type "make it night", press, and the run is a text-to-image of those
words; `fillImage` writes it over the frame, and nothing connected ever said the frame was the subject. The
placeholder said "say what it should become" while not one byte of the picture was sent. Material is an *input*,
and it is used as one: a connection, or the card's own tools (outpaint, mask, upscale, angle), which read the
picture and make a new node out of it.

**Three states, two facts** No content: the panel's job is to run the default model into it. Content plus
`model`: a run of this node's own, and send asks it again. Content without `model`: material, nothing to re-run.
No new field — no `origin`, no `madeBy: "manual"`. `model` is already the node's answer to "what would run
here", and a crop's honest answer is "nothing"; a second field would be a second answer to that question, which
is how #293's bug read from the other end.

**Also live by the same rule** A node made by a build before #293 has content, `workflow` and no `model`. It is
material here, which is the honest reading (it knows who made it, not what to run) and stops anything repainting
it.

**Cost** Material can no longer be regenerated in place, and there is no longer a one-click way to point a model
at it: the person has to make a node and connect the material to it. That gesture is the point — it is the only
one that keeps the picture.

**Tested** `frontend/tests/node-generatable.test.ts` (3): an empty node is a generator, a recorded model is
re-askable, and crop/split/upload/mask material is not — including the workflow-only node above.
`frontend/tests/canvas-agent-tools.test.ts`: `read_node` answers material with "no model can be set on it and no
run comes from it", `set_node` refuses a model and refuses a mode alone (writing nothing), `generate` refuses to
press it — and a text card still gets the plan's own "holds words" refusal rather than the material one.
`npx tsc --noEmit`, `npm run check`, `npx vitest run` (550), `make check`, `make frontend`.

**Where** `frontend/src/lib/canvas/canvas-generation-helpers.ts` (`nodeCanGenerate`, `materialClause`),
`frontend/src/lib/canvas/node-generation-facts.ts` (`heldNoun`), `frontend/src/lib/canvas/canvas-agent-tools.ts`
(`readNode`, `setNode`, `pressGenerate`), `frontend/src/components/canvas/canvas-node-prompt-panel.tsx` (the
material branch), `frontend/src/pages/canvas/hooks/use-image-editors.ts` (`cropImageNode`, `splitImageNode`),
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`, `frontend/tests/{node-generatable,canvas-agent-tools}.test.ts`.

## 298. A native select's popup follows the palette

**Decision** The two native `<select>`s on the canvas — the upscaler's model list in a step node's panel, and the
LoRA card's file picker — take `nativeSelectStyle(theme)` / `nativeOptionStyle(theme)` from `canvas-theme.ts`:
the `color-scheme` of the palette in use, plus the text and option colours stated on the element.

**Why** That popup is the browser's, not ours: it is painted from the colour scheme the element declares, not
from the card behind it. A select whose `color` came from the dark palette therefore opened a **light** list of
**light** text — the upscaler's three weight files were unreadable (screenshot of the 放大 node's panel,
2026-11-05) — and no stylesheet can reach that list, because the list is not in the document.

**Rejected** Swapping the kit `Select` in for both. It would fix the colour and match the rest of the app, but it
renders its popup through a portal at body level, and both call sites live inside the canvas's transformed
layer — placement would then have to be taught about pan and zoom (`getPopupContainer`, `data-canvas-no-zoom`),
which is a much bigger promise than "the list is readable".

**Cost** The popup is still the OS's: its font, row height and shadow are not ours, and `color-scheme` is
honoured by Chromium and Firefox rather than by every renderer — the per-option colours are the fallback for the
rest.

**Tested** `frontend/tests/native-select-style.test.ts` (new, 2): dark and light each answer their own scheme, and
an option's text and background come from the same palette as the card. `npx tsc --noEmit`, `npm run check`
(i18n 842, exports 186), `npx vitest run` (431), `make frontend`.

**Where** `frontend/src/lib/canvas-theme.ts`, `frontend/src/components/canvas/canvas-tool-node-panel.tsx`,
`frontend/src/components/canvas/nodes/lora-node.tsx`, `frontend/tests/native-select-style.test.ts`.

## 299. Parameters describe inputs; they are not inputs

**Decision** `InputSpecs` builds the accepted key set from the request-level keys the engine reads and from the
workflow's bindings, then *decorates* those specs with the declared `parameters` (label, range, options, the value
a panel shows). A parameter whose key nothing reads adds nothing. And the key a binding contributes is the one it
*reads*, not the name it has: `horizontal` (`from: params.horizontalAngle`) contributes `horizontalAngle`; a
binding derived from `size.width`/`seconds`/`quality.steps` contributes none; a binding with no `from`
(`task_type`) contributes its own name.

**Why** Two mechanisms were deciding what a run may carry, and neither was the contract. `parameters` were added
as inputs on their own, so the audio workflow's length *bound* — 4 s to 360 s, read by the canvas to size its
slider — was also an accepted key, and a request carrying `duration` was accepted and ignored (the binding reads
`seconds`). Meanwhile the binding that really reads a knob was rejected for having the wrong *name*: the angle
workflow's `horizontal` was skipped because `from` was not `params.horizontal`, and `horizontalAngle` only worked
because a parameter happened to exist with that name (#267's neighbour). One rule now: a key exists because
something reads it, and what it is called is what the reader says.

**Cost** `audioQuality` becomes an accepted key — a binding read `params.audioQuality` while the contract refused
it, so the format quality could only ever be its default. Nothing becomes unacceptable. Three fixtures gained the
binding their parameters described, which is the shape the rule asks for.

**Tested** `internal/workflow/inputs_test.go`: a binding contributes the key it reads and not its own name; a
derived binding contributes nothing; a parameter nothing reads is refused as `unknown_input` and absent from the
specs; a parameter decorates the spec that exists (range, options, type); every parameter a shipped workflow
declares describes an input it accepts. `TestPublicProjectionCarriesTheKeysARunMayTake`'s fixture now binds
`resolution` instead of only declaring it. `go test ./...`, `make check`.

**Where** `internal/workflow/inputs.go`, `internal/workflow/inputs_test.go`, `internal/workflow/render_test.go`,
`internal/server/e2e_test.go`, `docs/protocol.md`.

## 300. A default is stated in the caller's domain, and the graph holds the value

**Decision** A binding that *derives* its value — `multiply`, `secondsToFrames`, `secondsToFrames17`, `snap16`,
`snap32`, `invert10` — carries no `default`: the graph holds that value, and the source parameter holds the
caller's. Twenty-one such defaults were deleted. A default that is written verbatim must equal the graph's
authored value, except where one graph file serves several workflows (the H3 trio re-parameterises
`video-h3-ref2va-drama-vdn.json`). Two values were wrong and are corrected: `image-z-image-turbo`'s `steps` said
10 where its graph says 8.

**Why** A default is chosen first and transformed afterwards, so a default written in the graph's domain comes out
of the conversion wrong. RIFE's output frame rate carried `48` (frames per second) where the binding multiplies by
24 — a run that omitted the multiplier would have asked for 1152 fps; three H3 `length` bindings carried `124`
(frames) where the binding converts seconds — an omitted length became ~2980 frames. Both were dormant only
because the canvas always sent the parameter they read. Where the conversion *was* idempotent (a size already
snapped to 16) the default was a copy of the graph: the same fact, written twice, waiting to drift. Z-Image's
`steps` had already drifted, and every `quality: auto` run paid a step the 8-step distill never asked for.

**Rejected** Fixing only the two wrong numbers. It leaves 19 copies of graph values that nothing needs, and no way
to tell a copy from a decision. Also rejected: making the renderer fall back to a declared default when the graph
has a value — two answers to one question.

**Verified** Rendering every shipped graph from an empty request, before and after: the only differences are
`steps` 10 → 8 and `length` 2980 → 124 (seeds differ, they are random). Nothing else moved, which is the point —
the deleted defaults were all reproducing the graph.

**Tested** `internal/workflow/defaults_test.go` (new, 3): a deriving binding carries no default; a default written
verbatim equals its canonical graph's value (skipping shared files, with the reason in the test); and the value a
panel publishes equals the default of the binding that reads that key — which is what lets a node be created
without writing any params and still show the number the run will use. `go test ./...`, `make check`.

**Where** `workflows/registry.json`, `internal/workflow/defaults_test.go`.

## 301. A button creates a node; the node's send button runs it

**Decision** The image toolbar's 放大 and the video toolbar's 插帧 now only create a node: it appears wired to its
source, selected, with its panel open, carrying the workflow's model and no params and no prompt — and nothing
runs until that node's own send button is pressed. `CanvasNodeUpscaleDialog` is gone with it, and so are the two
request builders that existed only for these buttons: `requestUpscale` and `createVideoInterpolateTask`. Both
nodes now submit through the paths a step node always had (`requestGeneration` → `requestServerStep`,
`createVideoGenerationTask` → `createVideoStepTask`).

**Why** The parameter a step takes is a choice, and choosing it after the run is paying for the wrong one. The
interpolation ran at 2× before anyone could pick 3×; the upscale ran with whatever weight the dialog defaulted to,
or asked for a modal whose only purpose was to collect the same numbers the node's card shows one instant later.
After #293 the card *is* the parameter form — model, needs, send — so the dialog was that form twice, once
throwaway. A node that is already spinning is also the worst place to discover the default was not what you
wanted.

**Rejected** Keeping a pre-flight dialog for the upscaler's output size. It shows a predicted number; the node
shows the actual one, one press later, and a wrong 4× guess costs one 2× run — the same price RIFE has always
charged for guessing a multiplier.

**Also** Neither node records a `prompt`: an upscaler and an interpolation are asked nothing, so inheriting the
source's words was the same claim #297 removed from a crop. The interpolation's title loses its "2×" — the
multiplier is a setting now, and a title that pre-empts it would contradict the card. The one sentence the
upscale dialog owed the user — bigger, not clearer, generate again on a larger canvas — moved to the button's
tooltip, which is where the decision is made.

**Cost** One extra press for the common case. Both buttons leave the node selected with its panel open, so it is
"look at the default, press send".

**Tested** `frontend/tests/step-node-metadata.test.ts` (6th case): the node a button creates names the workflow,
carries no params so the workflow's own declaration decides, and is a generator with no content — which is what
puts the step panel in front of the user with a live send button. `frontend/tests/api-image-runs.test.ts`
became `api-image-runs.test.ts` with the four `requestUpscale` cases deleted; the step, angle, layout and stale-knob
cases it also held stay, because those go through `requestEdit`. `api-video-runs.test.ts` lost its
`createVideoInterpolateTask` case. `npx tsc --noEmit`, `npm run check` (i18n at 833 keys), `npx vitest run` (427),
`make check`, `make frontend`.

**Where** `frontend/src/pages/canvas/hooks/use-image-editors.ts`, `frontend/src/pages/canvas/hooks/use-video-editors.ts`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/services/api/{image,video}.ts`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.

## 302. Every request key is one the workflow reads

**Decision** The engine-owned request keys — `prompt`, `size`, `quality`, `seconds`, `mode`, `frameMode`,
`background`, `editCanvasSize`, `layout`/`layoutEnabled` — are offered per workflow, each derived from the
declaration that consumes it (a binding reading `size.width`, a `quality.*` preset field, `from: seconds`, a
variant list, a frame-mode rule, a background prompt, an output size, `promptInject: "moss-layout"`). `duration` is
gone: nothing ever read it. And the canvas sends only the keys the contract lists, for the engine's keys as well as
for the knobs.

**Why** This is the last place the "accepted and then ignored" failure lived, and #275 had already written down the
shape of the fix: the client has to stop sending those keys first. `size` went to the upscaler (which has no latent)
and to Qwen (whose picture follows its reference and its own `resolution`), `quality` to every video workflow and to
MOSS, `mode` to workflows with no variants, `background` to workflows with no background prompt — each accepted,
validated and dropped. A request that carries a key nothing reads cannot be told apart from one that carries a typo,
which is what the typed contract exists to prevent.

**Cost** `audio-minimax-music-3` declared its length bound on a parameter named `duration`, which was also the key
that bound nothing; the parameter is now `seconds` — the key the run reads — and `server-models.ts` reads the bound
from there. `mode` on a single-mode video workflow is no longer accepted and no longer sent; the workflow's declared
`mode` decides, as `PlanMedia` always did.

**Still open** Qwen's geometry controls. `image-qwen21` reads neither `size` nor `editCanvasSize`: its t2i graph
carries a fixed `EmptyImage(1024×1024)` and the entry declares no output size, so the panel's size picker and its
canvas-ratio pills do nothing — the contract says so now, where before they were accepted and dropped. Honouring
them is graph authoring (a `size.width/height` binding on that node, an `outputSize` rule for the edits, and a
decision about which sizes the model is asked for), not a contract change, so it is its own entry.

**Corrected (#303, #306)** That held only for the entry, not for its variants. `t2i` declares
`outputSize: {node: 13, latentNode: 10, latentSource: 14, fromSize: true, skipNativeSquare: true}`, so a size *is*
written into node 13 and the latent is repointed at the encoded result — the fixed `EmptyImage(1024×1024)` is what
runs when nothing is asked. `edit` declares an `outputSize` without `fromSize`: it reads `editCanvasSize` (the
canvas-ratio pills) and not a size. The two keys are now offered one at a time, because a `fromSize` graph can
never read the canvas one (#306). `inpaint` and `outpaint` declare no output size at all, and do not want one:
their picture is the source's geometry, or the source plus the padding the caller asked for.

**Tested** `internal/workflow/inputs_test.go`: a table toggling one declaration at a time, asserting the key appears
exactly where it is read; `duration` is not an input; `loras` stays open. The shipped-workflow test now requires a
minimal request per workflow — words only where a prompt is bound, and a prompt refused where one is not. Fixtures
gained the bindings their requests rely on. `frontend/tests/api-image-runs.test.ts`: a Qwen-shaped contract drops
`size` and `quality` from the request. `go test ./...`, `make check`, `npx tsc --noEmit`, `npm run check`,
`npx vitest run` (428), `make frontend`.

**Where** `internal/workflow/inputs.go` (`semanticSpecs`, `bindingsWithVariants`, `injectsLayout`,
`frameModeDeclared`), `internal/workflow/entry.go` (`PromptInjectLayout`), `internal/server/routes_runs.go`,
`workflows/registry.json`, `frontend/src/stores/use-config-store.ts` (`acceptedInputs`),
`frontend/src/services/api/{image,video}.ts`, `frontend/src/lib/server-models.ts`, `docs/protocol.md`.

## 303. A mode's published contract is the entry its run uses

**Decision** One merger, `mergeVariant`, produces the entry a mode runs: the parent with the variant's graph,
bindings, defaults, `outputSize`, prompt handling, outputs and media contract swapped in. `ResolveForMode` and
`ResolveMode` return it, `mergeVariantContract` is gone, and the published per-mode contract is read off that same
entry (`contractOf`). The keys a variant contributes through its own `outputSize` — `size` where it declares
`fromSize`, `editCanvasSize` wherever it declares one at all — are now in the wire contract because the entry that
computes them carries that `outputSize`.

**Why** The projection computed a mode's list from a copy of the *parent* with the variant's bindings swapped in.
That is not the entry `ValidateInputs` sees, and the difference was invisible while the canvas sent everything.
#302 made the canvas send only what the contract lists, and the gap became a regression: `image-qwen21/t2i`
publishes no `size` (its `outputSize` lives on the variant), so the size picker and the canvas-ratio pills stopped
reaching the graph — a working feature turned into the dead control #302 was trying to remove. Two hand-written
mergers (`ResolveForMode`, `ResolveMode`) that had already drifted from the projection are what made it possible;
there is one now.

**Cost** The wire payload grows by the keys the variants really take (`t2i` gains `size` and `editCanvasSize`,
`edit` gains `editCanvasSize`). Nothing else changes: the same merges in the same order, minus the second copy.

**Resolved (#307)** The engine's keys were unioned at the time: `semanticSpecs` asked every variant what its bindings
read, so a family whose modes disagreed about `size`, `quality`, `seconds` or `layout` would publish a key one of
them drops. A mode now reads its own declarations, and only the unresolved entry — the object a model card is drawn
from — still answers for the whole family.

**Tested** `internal/workflow/render_test.go`: a mode's contract is the entry its run uses, byte for byte, and an
`outputSize` with `fromSize` makes `size` readable while one without it publishes `editCanvasSize` and not `size`.
`internal/workflow/inputs_test.go`: every shipped workflow's every mode publishes exactly what
`ResolveForMode(...).AcceptedInputs()` accepts, plus the Qwen `t2i` case by name — the regression, pinned.
`go test ./...`, `make check`.

**Where** `internal/workflow/registry.go` (`mergeVariant`), `internal/workflow/loaders.go`,
`internal/workflow/render.go` (`contractOf`), `internal/workflow/{render,inputs}_test.go`.

## 304. A control exists where the key it writes is read

**Decision** The image settings panel and the Qwen window ask the workflow's contract which rows they have:
`size`, `background` and `seed` in `ImageSettingsPanel`, `editCanvasSize` for the canvas-ratio pills, `background`
for the window's own switch. A key the contract does not list means the row is not rendered; a contract that lists
no inputs at all — a model the server did not describe — means nothing is claimed and the row stays. A panel with
no rows left renders nothing, title included.

**Why** #302 made the request carry only the keys the workflow reads, which closed the hole at the server and left
it open on screen. The size picker still appeared on Qwen's `edit`, `inpaint` and `outpaint` (the picture follows
the reference; `size` is not theirs), and the transparent switch still appeared on every Z-Image and MOSS node
although only Qwen declares a `backgroundPrompt`. The run then dropped what the user had chosen without saying so —
the "点了没反应" of the accepted-and-ignored keys, one layer up, and the worse version of it, because the control
is the only thing the user sees. One predicate answers both questions, so a control and the request cannot
disagree.

**Rejected** A list of which workflow gets which control. It would be a second copy of the contract, drifting from
the first the day a graph changes — the shape #275/#302 kept having to delete. Deriving it costs one
`inputs.includes(key)`.

**Cost** 透明背景 leaves Z-Image and the three MOSS workflows; 尺寸 leaves Qwen's `edit`, `inpaint` and `outpaint`.
That is today's graphs read honestly: nothing in those pictures is transparent — `qwen-rgba` is a prompt the server
wraps around the words, and no other entry has one — and their size follows the reference. The rule is derived, so
a graph that gains a `backgroundPrompt` or a `fromSize` output size brings its control back with no code change.

**Still open** Qwen's `edit`, `inpaint` and `outpaint` now have no size control to offer, because they have no
`outputSize` to write one into (see the correction in #302). Giving them one is graph authoring plus a decision
about which sizes the model may be asked for; its own entry.

**Tested** `frontend/tests/contract-controls.test.ts`: the three states (listed / not listed / not described),
`size` on Qwen's `t2i` but not on its `edit`, `background` absent on a workflow with no `backgroundPrompt`, an
upscaler naming none of the three, and a table asserting `acceptsInput` and `acceptedInputs` answer the same
question for every key and every mode. `npx tsc --noEmit`, `npm run check`, `npx vitest run` (433), `make check`,
`make frontend`.

**Where** `frontend/src/stores/use-config-store.ts` (`acceptsInput`),
`frontend/src/components/image-settings-panel.tsx`,
`frontend/src/components/canvas/canvas-image-settings-popover.tsx`,
`frontend/tests/contract-controls.test.ts`, `docs/decisions.md` (#302's correction).

## 305. The mask editor has one button, and it runs

**Decision** 导出到画布 is gone. The footer is Reset and 生成; `submit()` takes no flag, `CanvasImageMaskEditPayload` has
no `generate` field, and `maskEditImageNode` always creates the mask node, the result node and the run — the path it
already took when pressed with 立刻生成.

**Why** It was the only editor with a "don't run yet" button, and the thing it deferred was the model — deferred
badly. The exported node recorded `{ prompt }` and nothing else, so its send button ran the canvas's *default* image
model instead of the one the editor would have used, without `imageMode`, and with two references wired to a workflow
that may accept none: Qwen's `inpaint` only ran if the canvas's mode happened to be `inpaint`; Z-Image's t2i refused
the references outright. "Decide later" delivered a card that could not reproduce the run it was exported from.

**Rejected** Keeping it and recording what it needs (#293's rule for a button-created node: model, mode, params),
which would make the two buttons differ only by one press. #301's rationale for that shape — a cost multiplier (2× or
3×) the dialog chose before the user could — has no analogue here: the mask and the words are the editor's own
inputs, and the model comes from the source node, which the user can change on its card before opening the editor.
Outpaint and MOSS layout are the same kind of editor (a source, a prompt, a run) and were never given a second button;
that is the house answer, and this was the exception.

**Also** One path means one prompt composition: the `maskPrompt` wrapper ("参考图1为原图，图2是蓝色标注区域…") is now written
only where the request is sent, so the reference labels cannot be added twice — which is what would have happened the
moment an exported node's send button re-wrapped the text `requestEdit` had already wrapped.

**Tested** `npx tsc --noEmit`, `npm run check` (i18n 832 keys, no dead keys — `maskExport` removed from both locales),
`npx vitest run` (433), `make check`, `make frontend`.

**Where** `frontend/src/components/canvas/canvas-node-mask-edit-dialog.tsx` (`CanvasImageMaskEditPayload`),
`frontend/src/pages/canvas/hooks/use-image-editors.ts` (`maskEditImageNode`),
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.

## 306. A size is rendered at the size it asks for, and one key says which size

**Decision** `applyOutputSize` aligns a canvas to **16**, not 32 — in `snap` and in the `skipNativeSquare`
comparison — and `editCanvasSize` is published only where a graph reads it, which is an `outputSize` *without*
`fromSize`. The `resolution` param keeps its own 32: that is the encoder's rule, written in its tooltip.

**Why** The canvas aligns to 16 everywhere else: the panel's step, the `snap16` bindings, and the VAE itself. This
one path aligned to 32, twice as coarse, so a size the canvas had already made legal was moved a second time —
3840×2160 came out 3840×2176, which is a different ratio and 8,355,840 pixels, more than the canvas's own
8,294,400 ceiling. And a `fromSize` entry *took* `size` while the list also offered `editCanvasSize`, which that
path can never read (`outputSize = ctx.Size`, unconditionally), so a leftover pill value travelled and was dropped —
the accepted-and-ignored failure #302 has been deleting, one layer deeper.

**How the fact was established** Not from documentation, and not from anyone's memory: the shipped `t2i` graph was
queued on the ComfyUI the server points at (0.43.0), with node 13 set to 528×528 and the latent repointed at node
14 — the exact two lines `applyOutputSize` writes — and the file came back **528×528**. 520×520 and 522×522 came
back **512×512**, so the VAE floors to 16. 1360×768, which is a preset value and not a multiple of 32, came back
1360×768. The probe also showed something worth knowing: the shipped graph takes its latent from the text encoder
(node 5, sized by `resolution`), so `size: auto` is a `resolution²` run and only an explicit size repoints it.

**Measured again, at the top of the range** 3840×2160 asked → **3840×2160** file (`comfyloft-probe_00006_.png`),
with the same two lines the binding writes. The numbers above established *where* the floor is; this is the size
that matters most, because the ceiling is exactly where the old 32-step arithmetic went over the canvas's own
8,294,400-pixel bound (3840×2176). The probe was run after the fact rather than as part of the change, which is
why it was recorded as optional; it confirms rather than discovers.

**Rejected** Retuning `imageSizePresets` so that every preset is a multiple of 32. That was the first plan, and it
rested on an assumption: eight presets would have moved — 4k 16:9 would have become 3584×2016 — to satisfy a
constraint the graph does not have. A display bent around an unverified limitation is its own kind of lie.

**Cost** Nothing visible: no preset changes, no control appears or disappears. A caller that asks for a size that
is not a multiple of 16 is rounded up to one instead of being floored by the VAE — the same adjustment as before,
one step finer, and now the same step the panel promises.

**Tested** `internal/workflow/outputsize_test.go`: 1360×768 and 3840×2160 are written into the canvas node exactly
and the latent is repointed; 520×520 becomes 528×528; the native square is still kept, and a 16-aligned
1040×1040 is no longer mistaken for it (which it was at 32, dropping the requested size). `inputs_test.go`: a
`fromSize` entry accepts `size` and not `editCanvasSize`, a canvas-sized one the other way round. `go test ./...`,
`make check`.

**Where** `internal/workflow/bindings.go` (`applyOutputSize`), `internal/workflow/inputs.go` (`semanticSpecs`),
`internal/workflow/outputsize_test.go`, `internal/workflow/inputs_test.go`, `docs/decisions.md` (#302's correction).

## 307. A mode publishes only what that mode reads

**Decision** The engine's own keys — `size`, `quality`, `seconds`, `layout`/`layoutEnabled`, `frameMode` — are derived
from a mode's own declarations once a mode is resolved. `mergeVariant` marks the entry it produces
(`resolvedMode`), and `bindingsWithVariants`, `injectsLayout` and `frameModeDeclared` stop consulting the family when
that mark is set: the merge has already folded the variant's own bindings, `PromptInject` and `FrameMode` in, so
reading the entry is reading the mode. The unresolved entry — what a model card is drawn from — keeps the union,
because a card has to answer for every mode it offers.

**Why** A family's per-mode list was the union of all its modes' bindings, so every mode published the engine keys
any sibling read: a `t2i` that sizes its canvas made its `edit` publish `size`, although that edit reads none. The
consequences are all of the kinds this build keeps deleting — the canvas kept the key (#302 sent it), #304 drew the
control that writes it, and the run dropped it. Nothing shipped was wrong yet: `image-qwen21` is the only family and
none of its four modes binds `size`, `quality` or `seconds`. But the shape was one new variant away from being live,
and a latent hole a later graph can open silently is the kind this project pays for twice.

**Cost** One unexported field and three early returns. The card's list is no longer byte-identical to the modes'
lists — it is their superset by construction, which is what it always meant to be.

**Tested** `internal/workflow/inputs_test.go`: a family whose `t2i` reads `size` and `quality` and whose `edit` reads
neither — the card covers both, `t2i` publishes both, `edit` publishes neither and still accepts `mode`. The shipped
contracts are unchanged, which is the other half: this removed a latent hole, not a behaviour. `go test ./...`,
`make check`.

**Where** `internal/workflow/entry.go` (`resolvedMode`), `internal/workflow/registry.go` (`mergeVariant`),
`internal/workflow/inputs.go` (`bindingsWithVariants`, `injectsLayout`, `frameModeDeclared`),
`internal/workflow/inputs_test.go`, `docs/decisions.md` (#303's resolution).

## 308. A move carries the cards it is a move of, and a group is one thing

**Decision** `withGroupMembers(ids, nodes)` — the cards a move carries: the ids named, plus the members of any group
among them, found by `groupId` rather than by the box. The drag and the agent's `move_node` both ask it, and
`moveNodesTo` now moves every card it names instead of only the one the tool stated. A group's move leaves no
membership behind it (the card travels with them), and a plain node moved onto a group still joins it, which is what
the drag does at the end of a move.

**Why** The tool's description had promised since #184 that `move_node` was "the way dragging it does" — and the drag
expanded a selected group into its members while the tool did not. So an agent asked to tidy a group moved the box
and left every member where it was: a card drawn around nothing, and a user who then had to drag it back by hand. The
interface was not too small on purpose; the two paths had simply grown a rule each, and only one of them had the
group rule. One function, two callers, is the shape that cannot drift again.

**Rejected** Telling the agent to move the group and then its members in separate calls. It is the same ambiguity
one layer up — *which* members, read from a `list_nodes` that may be a render behind — and it makes one gesture into
N+1 calls with a half-moved canvas if one of them fails. The tool states a card; a group *is* a card and its
members, so one call is the honest size.

**Cost** `move_node` on a group answers with more than it was asked to move ("and its 3 members"), which is the
difference between moving a group and moving a box, and is exactly what a caller needs to know. Membership is still
not geometry: moving a group whose member sits *outside* the card (#290) carries it too, and that is right — it is a
member.

**Tested** `npx vitest run`: `canvas-node-geometry.test.ts` pins the four cases of `withGroupMembers` (a group
carries its members; a plain node carries itself; a selection naming both counts each once; a member named alone
does not drag its siblings), and `canvas-agent-tools.test.ts` pins the two answers (`moved group-1 (group) and its 2
members to (640, 320)`, and the plain `moved text-1 (text) to (10, 20)`). Not checked in a browser: the page on
`:8190` predates these builds, and what changed is which ids a move names.

**Where** `frontend/src/lib/canvas/canvas-node-geometry.ts` (`withGroupMembers`),
`frontend/src/pages/canvas/project.tsx` (`moveNodesTo`, `handleNodeMouseDown`),
`frontend/src/lib/canvas/canvas-agent-tools.ts` (`moveNode`), `internal/server/routes_mcp.go` (`move_node`),
`frontend/tests/{canvas-node-geometry,canvas-agent-tools}.test.ts`.

## 309. A run's shape is a setting, and the tool states it in the request's own names

**Decision** A sixteenth tool, `set_node_settings(nodeId, { size, quality, seconds, background, seed, format,
instructions, params })`, writes the fields the node's own panel writes, and `read_prompt` reads them back in
the same clause. Every value is checked by the function that already decides it — `planImageSize` for a size,
`VIDEO_SECONDS_MIN/MAX` and a sound's declared `duration` for a length, `audioFormatOptions` for a container —
and whether a key means anything at all is asked of the published contract, the three-state answer #304 gave
the panel's rows. One refusal, never a partial write: a call that gets any setting wrong writes none and says
which.

Not here, on purpose: `model` and the Qwen `t2i`/`edit`/`inpaint`/`outpaint` mode (that is which run this is,
not its shape, and the picker's value space is the family's own — a separate tool with its own validation),
`loras` (the LoRA nodes connected to the node fill it in at press time), `layout`/`layoutEnabled` (the MOSS
editor's regions), and masks, crops and outpaints (each is a new node built in a viewport).

**Why** The agent could say *what* to draw and press the button, and nothing else: ~20 settings lived in the
panel and none of them were reachable, so "a 16:9 hero shot, five seconds, seed 42" was a sentence it had to
hand back. The rest of the panel's vocabulary was already in the request — `size`, `seconds`, `background`,
`seed`, `format`, `lyrics` and the workflow's declared knobs are the keys `POST /runs` validates — so a second
naming scheme would have been the lie. And the panels' own rule (#302/#304) applies unchanged: a setting the
run would drop is refused at the tool, with the list the run does read, rather than written into a node and
silently ignored.

**What was measured before deciding** Two facts, both from the code the request runs, not from taste:
- A seed travels only when the node also says it is fixed (`buildGenerationConfig` deletes `params.seed`
  otherwise), so the tool writes `{seed, seedFixed}` together — the pair the panel's switch and box write
  between them. Writing `params.seed` alone would have been accepted and dropped.
- A picture's stored size is pixels, and the panel reads it back through `inferMediaRatio`/`readMediaDimensions`
  — so a ratio is *not* a stored value. The tool resolves what it can (`planImageSize` accepts `WxH` only) and
  refuses `16:9` with the pixels to say instead, which is also why the answer is the node's clause rather than
  the request: what was written is what a later `read_prompt` will report.
- A *film's* pixels are not a number it is given: `normalizeVideoSize` derives them from the quality tier and
  the shape at submit, so a stored `1280x720` on a 1080p node runs 1920×1080. Writing a size without saying
  that would be the accepted-and-replaced failure this build keeps deleting, so the tier is a setting of its own
  (`quality`, the panel's 480/720/1080 pills) and a size the tier would not make is refused with the one it
  does. The tier the check uses is the one the run will use — the node's own, or the canvas default — read from
  `buildGenerationConfig`, not guessed.

**Rejected** A `set_node_settings(settings: object)` that accepted anything and let the request's own pruning
silently drop what the workflow does not read. That is exactly the failure #302 spent a decision deleting, seen
from the agent's end: a tool that answers "set" while nothing changed. Also rejected: clamping a length into
the declared range instead of refusing it. A clamp answers `isError: false` while doing something the caller
did not ask for, which is #270's reason for refusing a contradictory resize.

**Cost** The tool is the largest surface an agent has on a node, and it is the first one that could spoil work
the user did by hand — a size or a seed is a choice, not a description. The system prompt carries the rule
("a node the user sized is theirs"), and the answer always says what the node is now set to, so a wrong write
is visible in the same turn. `read_prompt` grew a clause, which makes it longer; the settings it names are the
ones a rewrite has to respect, and `list_nodes` stays free of them for #233's reason.

**Tested** `npx vitest run` (465 — 36 new): `node-settings.test.ts` pins the writes (`1000x1000` written as
`1008x1008`, the seed pair and its clearing, the transparent background, a film's size refused at the wrong tier and taken
when the tier is stated with it, params merged over the node's own and refused by key, `loras`/`layout` naming
their owner) and the refusals (a picture has no length and the message
names what it keeps, a sound has no knobs, a text card/a group/a LoRA/a material node has no run to configure, a
key outside the contract lists the ones it reads, no contract is silence not refusal, one wrong setting writes
none, nothing stated is refused). `canvas-agent-tools.test.ts` pins the tool's two answers and that a refused
call writes nothing. `node-generation-facts.test.ts` pins the read-back: settings named in request order, a
node with settings and no picker still saying them, a seed without `fixed` not claimed, `auto` left out.
`internal/server/mcp_test.go` pins the sixteen names and the new prompt rules. `go test ./...`, `make check`
(503 exports), `npx tsc --noEmit`, `npm run check` (832/799), `make frontend`, `make build`. Not checked in a
browser: the page on `:8190` is a build from before this commit, so the new tool is advertised by the server
and answered by the page only after both are reloaded.

**Where** `frontend/src/lib/canvas/node-settings.ts` (new), `frontend/src/lib/canvas/canvas-agent-tools.ts`
(`set_node_settings`, two hands), `frontend/src/lib/canvas/node-generation-facts.ts` (`configuredClause`,
`settingsClause`), `frontend/src/services/api/image.ts` (`planImageSize`, `sizeProblem`),
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`, `frontend/src/pages/canvas/project.tsx`
(`nodeContract`), `internal/server/routes_mcp.go`, `internal/server/agent_instructions.go`,
`internal/server/mcp_test.go`, `frontend/tests/{node-settings,canvas-agent-tools,node-generation-facts}.test.ts`.

## 310. A run the agent started is a run it can end

**Decision** A seventeenth tool, `stop_node(nodeId)`: the panel's stop button without the question before it — a
call *is* the sure part — and an answer with one of four shapes rather than one: the run was cancelled; there was
nothing running; the press was caught before it reached the server; or the server did not confirm the cancel, which
is a failed call because the caller asked for the run to stop and cannot be told that it did. In the page, stopping
is two endings: the watch is aborted (which is what puts the node back to idle instead of leaving it spinning), and
the run is cancelled **by its id** — the one path every watcher shares.

**Why** The vocabulary had a start and no brake. An agent could press a three-minute render and then only wait: if
the user changed their mind, the GPU kept drawing a picture nobody wanted, and the agent had nothing to offer but
"it will finish eventually". That is also what made pressing safe to teach — the system prompt now says *press
nothing you cannot stop*, which is only a rule once there is a way to stop.

**What the page's own stop does not do, and this does** `stopGenerationByRunningId` aborts the request's controller
and clears the node. For a run the page *submitted* that is enough: `waitForRun` was called with `cancelOnAbort:
true`, so the abort cancels the run on the server. For a run the page *picked up again after a reload* it is not —
the resume pollers pass `cancelOnAbort: false`, deliberately (leaving the page must not kill a render), and video's
poller has no cancel path at all. So the button's stop on a resumed run aborted the watch and left ComfyUI
rendering, with the node saying idle. The tool cancels by `runId` as well, which covers every watcher, and clears
the node's `runId` so the next reload does not reattach to a run nobody is waiting for. The server's cancel is
idempotent (`task.Store.Cancel` returns a terminal run unchanged), so the live path's second DELETE — the one
`cancelOnAbort` sends — costs nothing and is swallowed as before.

**Rejected** Reusing the button's function as the whole of it. It would have answered "stopped" for a resumed run
that is still rendering — the accepted-and-ignored failure in its worst form, because the agent would then tell the
user it was stopped. Also rejected: making `stop_node` a variant of `generate` with a flag. Start and stop are two
intents with two answers, which is why `set_prompt` and `set_text` are two tools.

**Cost** The atomic answer is impossible and the tool says so: a run can end between the cancel and the node's
clear, so "it had already ended" is one of the shapes. A stop does not undo a partial artifact — a cancelled run
writes nothing into the node, so what the node holds is what it held before, and the sentence says that rather than
"deleted".

**Tested** `npx vitest run` (471 — six new in `canvas-agent-tools.test.ts`): the four answers (cancelled, nothing
running, caught before submitting, not confirmed with the reason), the run that ended first, and a text card refused
before the page is asked. `internal/server/mcp_test.go` pins the seventeen names, in order, and the new prompt rule
(`canvas_stop_node`, "Press nothing you cannot stop"). `go test ./...`, `make check` (503 exports),
`npx tsc --noEmit`, `npm run check` (832/799), `make frontend`, `make build`. Not checked in a browser: the page on
`:8190` predates this commit, so the tool is advertised and answered only after a restart and a reload.

**Where** `frontend/src/lib/canvas/canvas-agent-tools.ts` (`stopNode`, `StopOutcome`),
`frontend/src/pages/canvas/project.tsx` (`stopNodeRun`), `frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`,
`internal/server/routes_mcp.go`, `internal/server/agent_instructions.go`, `internal/server/mcp_test.go`,
`frontend/tests/canvas-agent-tools.test.ts`.

## 311. Which run a node is, and what changing it stops meaning

**Decision** An eighteenth tool, `set_model(nodeId, { model, mode })`: the workflow the node generates with, and
the mode a family is asked in. The vocabulary is the canvas's, not the picker's storage: `image-qwen21` and
`default::image-qwen21` are the same run, and both resolve. A mode is resolved the way the panel resolves it — on
a picture it is written beside the model, on a film it *names* the workflow (`videoModelModePatch`'s own rule,
which the panel's mode pill already follows) — and a mode whose node pack is missing is refused at the tool rather
than queued to fail inside ComfyUI. `read_prompt` now prints the mode ("set to run image-qwen21 as edit"), because
the wording a rewrite must use depends on it and nothing else said it.

The tool also answers the one thing the panel never has to: **which settings the new run no longer reads**. A
`size` set for Z-Image is still on a node switched to Qwen's edit, and the request will now leave it out without a
word (#302). The values stay — a knob belongs to the model that declared it, and the panel leaves them too (#274) —
and the answer names them.

**Why** The agent could set a size, a length and a seed (#309) but not the model, which is the first sentence a
user says ("用 Qwen 的 edit 模式"). What it will not do is write a model onto **material**: a crop's panel has no
control to mirror, and a model set on a node holding a picture nothing here made would not re-run anything — it
would replace that picture, because a run reads only what is connected to it (#297).

**What was measured before deciding** Three facts, from the code the pickers and the request run:
- A node stores `channel::model`; every tool and sentence names the workflow. So one resolver accepts both, asks
  `workflowModelOptions` for the list (the pickers' own), and refuses a name that two channels both carry rather
  than choosing a server for the user.
- A film's `videoMode` is written by `videoModelModePatch` from the workflow's declared `mode`, so "change the
  mode" and "change the workflow" are one act on a film — and the panel's mode pill already implements it as
  `videoModelForMode`. The tool follows the panel instead of inventing a second rule.
- Qwen's `blockedModes` are per family (`variantModes` ∩ missing node packs). Writing a blocked mode would open
  the mask editor and then fail inside ComfyUI, so it is refused with the blocked list named.

**Rejected** Letting the mode stand as a free field ("it will fall back at press time"). `imageModeFor` does fall
back, silently, and the answer would then say a mode the run does not use — the accepted-and-ignored failure again,
in the one place where the mode changes the *wording* the model is asked with.

**Cost** Base models — the `.safetensors` a family can be pointed at — are **not** in the catalog: they are files
picked by filter and aliased ("moody", "fp16"), the same kind of choice as a LoRA stack, and the panel keeps them
behind their own row. They remain reachable the low way: `unet` is a published key, so `set_node_settings`'s
`params: { unet: … }` sets one. Also: switching a model never clears a stale setting, so the report is the whole
of the help — an agent that ignores it gets a run that ignores the value, and the contract is what says so.

**Tested** `npx vitest run` (494 — 23 new): `node-model.test.ts` pins the resolver (workflow id and picker value,
an unknown name listed against what exists, a name two channels carry refused with both labels), the modes (a
family's own, one it does not offer, a blocked one named with the reason, a workflow with none, a film's mode
naming its workflow, a film mode contradicting a named film, a sound having none, a picture keeping its own when
only the model is named), the stale report (named and not written; an unfixed seed not claimed; nothing published
claiming nothing), and the refusals (text/group/LoRA, neither argument, a mode with no model). `canvas-agent-tools
.test.ts` pins the tool's answers and that a refusal writes nothing. `node-generation-facts.test.ts` pins the mode
in the clause. `internal/server/mcp_test.go` pins the eighteen names in order and the rewritten prompt rule ("Which
model runs is a separate act, not a setting" — the old sentence said it was not a tool's business, which is no
longer true). `go test ./...`, `make check` (503 exports), `npx tsc --noEmit`, `npm run check` (832/799, 187
modules), `make frontend`, `make build`. Not checked in a browser: the page on `:8190` predates this commit.

**Where** `frontend/src/lib/canvas/node-model.ts` (new), `frontend/src/lib/canvas/canvas-agent-tools.ts`
(`set_model`), `frontend/src/lib/canvas/node-settings.ts` (`heldKeys`), `frontend/src/lib/canvas/node-generation
-facts.ts` (the mode in the clause), `frontend/src/pages/canvas/project.tsx` (`modelCatalog`),
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`, `internal/server/routes_mcp.go`,
`internal/server/agent_instructions.go`, `internal/server/mcp_test.go`,
`frontend/tests/{node-model,canvas-agent-tools,node-generation-facts}.test.ts`.

## 312. What models there are is data, and the agent can ask

**Decision** A tool, `list_models({capability?})`: every workflow this canvas can run, grouped by the kind of
content, with the ones that are **steps** named apart, each saying what it takes (words, or how many pictures or
clips), the modes a family offers — including a mode whose node pack is missing, marked where it is offered — and,
for a step, the knobs it declares. It is built from the same catalog the node's picker decides with
(`describeModelCatalogs` over the config store's channels), so a listing can never offer a model a picker would
not, and `set_node`'s `model` takes exactly the names it answers with.

**Why** Asked how many image models the canvas had, the agent recited the names it had scraped off the nodes: nine
image rows, three of them steps, two video workflows missing because nothing on screen used them, the audio one
absent — and then said it could not get the complete list. It could not: no tool listed models. The prompt gained
one sentence — ask, do not recite — and **no list**: the list is data and belongs in the answer to a call, and a
list copied into a prompt is wrong the moment the operator installs a workflow. Counting is the question this
answers, and a step is not a generator, so "how many image models" has a different answer once the upscaler stops
counting.

**Cost** One more tool, and one more place that has to know what a model is: the catalog's own description is
where the words live, so a new field in a workflow's contract has to be added to that sentence as well.

**Tested** Its own file, and the wiring in `frontend/tests/canvas-agent-tools.test.ts`: one catalog per kind is
asked of the page, all three unless the call names one, and a kind that is not one of them is refused rather than
silently ignored. The listing's rules — steps apart, an unused workflow still on the list — are pinned in
`frontend/tests/node-model.test.ts`.

**Where** `frontend/src/lib/canvas/node-model.ts` (`describeModelCatalogs`, `ModelCatalog.step`),
`frontend/src/lib/canvas/canvas-agent-tools.ts` (`listModels`), `internal/server/routes_mcp.go` (`list_models`),
`internal/server/agent_instructions.go` ("What models there are is data, not memory").


## 313. A workflow's special requirement is its own declaration, said before the press

**Decision** Two surfaces, both reading data that was already published:
- `list_models` says what each **mode** takes (`t2i (words only)`, `edit (1-4 images)`, `inpaint (2 images)`,
  `outpaint (1 image)`), read from `variantContracts[mode].accepts` — and a step's line carries the knobs it
  declares (`image-qwen21-angle · 1 image · knobs horizontalAngle, pitchAngle, cameraDistance`), read from
  `parameters`.
- `read_prompt` appends what the node's run needs and what is wired into it: `it takes 1 image; nothing connected,
  so a press would be refused`. Read from the same `accepts` the panel and the server's `PlanMedia` use, plus the
  connections the tool can see.

`SettingsContract` grew `media` (`ModelAccepts`), because a node's workflow publishes one projection and the
tools read it through one hand.

**Why** Two workflows in this install are shaped like this and nothing in the agent's vocabulary said so: the angle
re-render and the character swap take a picture or a clip, and a prompt cannot replace it. The information existed
twice already — the registry's `accepts` (with a hand-written `note`) and the server's refusal, which appends that
note (`hint(note)`) — but the only way an agent ever met it was by pressing a node that could not run and reading
the 400. A caller choosing a workflow could not tell inpaint (needs a source *and* a mask) from t2i (needs
nothing), because the listing said only `1-4 images` for the whole family.

**Rejected** Three things, all of which looked like the obvious fix and are not:
- **Carrying `note` (and `parameters[].description`) into the client and showing it in the panel.** `#66` decided
  the opposite for a reason: the registry is written in English and the UI's copy comes from `i18n` keyed by
  workflow id. Re-introducing English prose would either break the Chinese UI or demand a dictionary entry per
  workflow — the table of ids this build keeps deleting (#267, #294). The note already reaches the agent where it
  belongs: in the server's refusal.
- **A media gate in the client before submitting.** `PlanMedia` is the server's, it is authoritative (modes,
  frame modes, `minTotal`, per-mode variants), it answers in milliseconds, and it carries the note. A second copy
  in the page is the first thing that drifts, and the panel's own `ready` only ever disabled the *step* panel's
  button — so the "人 and agent disagree" premise was wrong for every other kind of node.
- **Enforcing parameter ranges in `set_node_settings`.** `ValidateInputs` already rejects an out-of-range value at
  submission with the declared bound in the message, so the gap was a nicer sentence and not a failed run.

**Cost** The listing is longer: four modes with their media is one long line, and a step gets a line of its own
instead of appearing in a comma list. `read_prompt` is a line longer for every node whose workflow declares media
— and it is silent for a model the server did not describe, which is the three-state rule everywhere else.

**Tested** `npx vitest run` (509 — fifteen new). `node-model.test.ts`: a step is named on its own line with its
knobs and is not among the generators (asserted on the text *above* the steps' heading, so the old
"does not contain" could not pass by accident); each mode says what it takes. `node-generation-facts.test.ts`:
`requiresClause` for a source picture (present and missing), words-only, too many of an optional kind, the
character swap's picture-and-clip, and the silence of an unpublished contract — the formatter's own first
version said "up to 1 clips" and counted a permission ("up to 2 sounds") as a requirement, both caught here.
`canvas-agent-tools.test.ts`: `read_prompt` with nothing wired and with a picture wired. `go test ./...`,
`make check` (503 exports), `npx tsc --noEmit`, `npm run check` (832/799, 187 modules), `make frontend`,
`make build`. Not checked in a browser: the page on `:8190` predates this commit.

**Where** `frontend/src/lib/canvas/node-model.ts` (`modeMedia`, `knobs`, `describeModel`),
`frontend/src/lib/canvas/node-generation-facts.ts` (`requiresClause`),
`frontend/src/lib/canvas/node-settings.ts` (`SettingsContract.media`),
`frontend/src/lib/canvas/canvas-agent-tools.ts` (`readPrompt`, `connectedMedia`),
`frontend/src/pages/canvas/project.tsx` (`modelCatalog`, `nodeContract`),
`frontend/tests/{node-model,node-generation-facts,canvas-agent-tools}.test.ts`.

## 314. Two keys, one gesture: the backquote holds the microphone too

**Decision** `Ctrl`/`⌘` + `'` and `Ctrl`/`⌘` + the backquote above Tab start and end dictation through one
predicate pair (`isTalkChord`, `isTalkKey` in `agent-dictation.ts`) and one handler in the hook, so the
microphone, the length cap, the release path and the caret are the same code whichever key was held. The
matching that used to live inline in `use-hold-to-talk.ts` moved into the pure module, where "the two keys are
one gesture" is a fact with tests rather than two lines to compare by eye.

**Why** The user's reason, in their words: it is easier to press and asks less of a keyboard (更好按，更不挑键盘).
The backquote sits on the home row, one key from where the hand already rests for the modifier, and it is not a
character whose position moves around a layout's punctuation block. Nothing else here binds it: the canvas reads
`modifier + letter`, `Space` is the temporary tool, `Shift` and `Ctrl` alone are additive selection and the
temporary tool, and neither key types anything under the chord nor is bound by a browser (`⌘+'` is Firefox's
quick-find and `⌘` with the backquote cycles an app's windows — both on macOS, which is why the documents still
say `Ctrl` first).

**Rejected** A second listener, or a second constant, on the "it is only one more line" argument: two handlers
with the same body is how two keys stop being identical the first time one of them is fixed, and the release
path is the one that would be forgotten — it carries the two extra cases (`Control`, `Meta`) that make letting
go work from either half of the chord. Also rejected: matching only `event.key` (a layout can report a different
character at the same physical key) and only `event.code` (an event may carry none — and the old code already
accepted the character, which is why the pair reads both).

**Cost** Two more literals in a list, six test cases, and two pieces of copy that now name a second key: the
microphone button's tooltip (「Ctrl / Cmd + ' 或 `」) and the shortcut dialog's row, whose key chip reads
`' / ` and a backquote. On some keyboards `Ctrl` + backquote reopens a console in another application —
nothing this build runs binds it, and `preventDefault()` is only reached while the agent panel is mounted and
the chord really is the chord.

**Tested** `npx vitest run` (515 — six new in `tests/agent-dictation.test.ts`): every question asked of both keys
and answered the same way, with `Ctrl` and with `⌘`; a bare `'` and a bare backquote are keystrokes, not gestures;
`Ctrl+A`, `Ctrl+Z`, `Ctrl` and `⌘` alone are not the chord; a layout's different character at the physical
backquote still is, and an event with neither the position nor the character is not; the release is recognised
from either key and from neither `Control`, `Meta` nor `Shift` (those stay the hook's own cases). `npx tsc
--noEmit`, `npm run check` (832/799, 187 modules), `go test ./...`, `make check` (503 exports), `make frontend`,
`make build`. Not tried in a browser: the page running on `:8190` predates this commit.

**Where** `frontend/src/lib/canvas/agent-dictation.ts` (`TALK_CHARS`, `TALK_CODES`, `isTalkKey`, `isTalkChord`),
`frontend/src/components/canvas/use-hold-to-talk.ts`, `frontend/src/components/canvas/canvas-top-bar.tsx`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/src/i18n/locales/{zh-CN,en-US}.ts`,
`frontend/tests/agent-dictation.test.ts`.

## 315. One row says what the turn is doing, and it does not scroll

**Decision** The "working" line and the "N queued" line are one row, in the composer's status area above the box,
drawn from one four-state value (`agentRunState(working, queued)` in `agent-transcript.ts`):

| state | the row |
| --- | --- |
| `idle` | nothing |
| `waiting` | 处理中… 3 秒 |
| `waiting-queued` | 处理中… 3 秒（2 条消息已排队,会在当前步骤之后一起插入） |
| `queued` | 2 条消息已排队,会在当前步骤之后一起插入 |

One spinner, one place, `text-[11px]` like the dictation row under it. The transcript lost its trailing spinner,
so its auto-follow effect went back to depending on the messages alone — nothing in that box appears without a
message to announce it any more.

**Why** Both lines are the same subject — a turn is running — and they were drawn twice, in two places, with two
spinners: the wait at the end of the transcript (drawn from the send, before any frame comes back), the queue
above the box (put there so a queue nobody can see would not look like a lost message). Queuing a message
mid-turn put two spinners on screen at once, and the one line that says the agent is alive could scroll out of
sight in a long conversation while the count stayed. In the user's words: 这两个信息… 都是运行状态,应该放在一个地方.

**Three keys, not one sentence glued from two clauses.** Each state's copy is a whole sentence in `i18n`
(`working`, `workingQueued`, `steeringQueued`), because the wait and the count can each appear alone — and a
language that names the count first has to be a translation, not a second layout. The both-at-once case is the
user's own suggestion: the count in parentheses after the timer.

**Rejected** Leaving the wait in the transcript and moving only the count up: that is still two rows for one
subject, and the timer would be invisible to a reader who scrolled into the history. Also rejected: dropping the
seconds whenever a queue exists — the timer is what tells an agent that is thinking from a panel doing nothing,
and a queued message is not evidence of progress.

**Cost** The row is 11px like its neighbours rather than 12px, and the end of the conversation no longer marks
where the answer will start. The seconds still reset whenever the wait ends (an answer that starts speaking
clears it), which the merged row inherits unchanged.

**Tested** `npx vitest run` (519 — four new in `tests/agent-transcript.test.ts`): the wait alone, the wait with a
queue, the queue alone while an answer is being written (checked against `agentIsWorking` on folded frames, which
is the case two conditions in the JSX would have got wrong), and nothing at all for an idle turn with an empty
queue. `npx tsc --noEmit`, `npm run check` (833/800, 187 modules), `go test ./...`, `make check` (503 exports),
`make frontend`, `make build`. Not seen on a screen: the page on `:8190` predates this commit.

**Where** `frontend/src/lib/canvas/agent-transcript.ts` (`agentRunState`, `AgentRunState`),
`frontend/src/components/canvas/canvas-agent-panel.tsx` (`turnLines`), `frontend/src/i18n/locales/{zh-CN,en-US}.ts`
(`workingQueued`), `frontend/tests/agent-transcript.test.ts`.

## 316. A card that travels with its group keeps it, wherever the move puts it

**Decision** `settleMoveMembership(moved, movedIds)` (`canvas-node-geometry.ts`) is what a move leaves behind: a
node carried by a group that is also moving keeps its `groupId` and is never read against a rectangle, and a node
that moved *without* its group — a loose one, or a member dragged out on its own — is placed by
`findContainingGroupId`, which is how a card is dragged out of a group and how a loose one dropped on a group joins
it. `moveNodesTo` (the tool's hand) and `finishNodeDrag` (the mouse's) both call it, which is the one function, two
callers shape this log keeps arriving at (#308). `findContainingGroupId` lost its export with its last outside
caller.

**Why** Both paths re-derived membership for *every* moved node from where it landed, including the members the
group itself was carrying. Two cards that overlap is not an edge case, it is the state a canvas is in whenever
anything has been grouped and then arranged — grouping moves nothing, so the cards sit where the members already
were. On a real canvas (session of 2026-11-06) an agent tidied five groups by moving them: cards 688×316 spaced 300
apart, so neighbours overlapped by 16 px. The fourth `move_node` lifted `group-…-pl0ta` (Qwen) from y=898 to 1100;
its two images went to y=1152, their centres at 1272, which was inside `group-…-p88he`'s rectangle (1198–1514), and
the re-read handed them to it. The fifth call then reported `and its 4 members` — the Z-Image card carrying the Qwen
pictures — and the Qwen card stood at y=1100 empty while its pictures sat at 1404 inside the other group. The agent
blamed `group_nodes` and wrote itself a rule about dissolving groups before making them; `group_nodes` was innocent
and the trade it proposed would have made the mess slower. The same line existed at the end of a drag
(`project.tsx`), so a person moving a group by hand got the same result.

**Rejected** Better tie-breaks in `findContainingGroupId` — smallest area wins, topmost wins. Each swaps one
accident for another: the gesture did not say "regroup", so any rule that reads rectangles to answer it invents an
answer. Also rejected: dropping geometric adoption altogether. Dragging a loose card onto a group joining it is a
gesture people use, and it is the only way to put a node in a group without the toolbar. Also rejected here (not
refused): re-fitting a group's rectangle when a member leaves, and removing the shell a drag-out emptied — both are
about stale rectangles and shell debris (#292), both are their own decision, and neither is needed to stop a move
from rewriting who belongs to what.

**Cost** A member of a moving group can no longer end up in another group by being dragged through its rectangle.
That is the point — merging groups is `group_nodes` naming both cards, an explicit word — and it also means a
member drawn outside its card (#290) now travels without being silently released. One predicate, five tests.

**Tested** `frontend/tests/canvas-node-geometry.test.ts`, five new: a group moved over another card keeps its own
members (the member's centre inside *both* rectangles, the second card later in the list, which is the case that
returned `g2` before), a member outside its card keeps it, a loose node dropped on a card joins it, a member moved
on its own out of its card leaves it, a member moved on its own into another card joins that one. With the predicate
disabled, two of them fail; with it, all pass. In the browser, end to end, two bundles against isolated servers
(`:8191` this one, `:8192` the same code with only that predicate turned off, `CANVAS_ROOT` and `WEB_DIR` in /tmp,
headless Chrome driven over CDP) on a fixture of two 400×300 cards with two 150×120 text members each: dragging
`g1` by its card onto `g2`'s exact position (both rects then `(100, 500)`, the members landing on top of `g2`'s)
stored `m1, m2 in group g2` on the old bundle and `in group g1` on this one, with `g1`'s own members never released;
dragging `m1` alone out of its card released it and left `g2` alone; dragging `m3` from `g2` into `g1`'s card
joined `g1` and snapped it inside the card. `move_node` was not exercised in the browser — it reaches the same
function through the same `setNodes` update. `npx vitest run` (524), `npx tsc --noEmit`, `npm run check`
(187 modules, 833/800 keys).

**Where** `frontend/src/lib/canvas/canvas-node-geometry.ts` (`settleMoveMembership`, `findContainingGroupId` now
file-local), `frontend/src/pages/canvas/project.tsx` (`moveNodesTo`, `finishNodeDrag`, and the import it no longer
needs), `frontend/tests/canvas-node-geometry.test.ts`.

## 317. A move says what it changed, and takes away the card it emptied

**Decision** `move_node` answers with the membership its landing changed — `; left g1`, `; joined g2` — and with
the cards it took away. Deletion is `withoutEmptiedGroups(before, nodes, connections)`: `emptiedGroupIds` (#292),
which already decides the shells grouping and ungrouping may delete, applied to the third gesture that can empty a
group, by the drag and by the tool alike. A group that was already empty is untouched, and a group that goes takes
its connections with it. The page clears the UI state that named a removed card (`forgetNodes`, the bookkeeping
`deleteNodes` already owed, extracted so there is one copy).

**Why** #316 stopped a move from rewriting who belongs to what, but a node moved *on its own* still changes groups
geometrically — that is how a card is dragged out and how one is dropped on a card — and the tool said nothing
about it. For a person the change is visible: the card snaps into the drop target, the highlight, the shape. For an
agent the answer is the whole of its senses, so the next `list_nodes` was the first it heard of a change it had
caused. The same argument decides the shell. Dragging a card's last member out leaves a box drawn around nothing;
grouping and ungrouping already delete the shell they empty and call it debris the press made (#292), and a move is
that same press by another hand. Keeping one of the three and not the others is the inconsistency, not the fix.

**Rejected** Leaving the empty box, on the grounds that #292 priced it ("a group whose members are all deleted now
stays as an empty box"). That price was about *deletion* — the node the person asked to delete is the node that
goes, and sweeping the container too would turn one delete into two. A move is different: the member survives and
is moved somewhere, so the card is the only thing the gesture left behind. Deleting the shell on a member's
*deletion* was not done and is still #292's recorded cost. Also rejected: reporting membership as node ids
(`text-1 left group-1`) — the moved node is the sentence's subject, so the group is the only new noun the answer
needs.

**Cost** A member dragged out of a card that held only it now takes the card with it, so "I'll put it back" costs a
re-group (or one undo). A group that changes hands has two clauses in its answer instead of one, and `move_node`'s
description grew a sentence.

**Tested** `canvas-node-geometry.test.ts` (+3): a card whose last member moved out is removed and loses its
connections; a card that still holds a member stays; a box that was already empty is left alone.
`canvas-agent-tools.test.ts` (+3, and one fixture grew a second member so two clauses could be read apart):
`; left group-1`, `; joined group-2`, `; left group-1, removed because nothing was left in it`, and a group moved
onto another card reporting no membership at all. In the browser, on the same build, two drags: one card's only
member onto the other card — the member joined it and the emptied card was gone from the document — and, because
the drop handler stopped going through a `setNodes` updater, a whole card dragged onto another (the #316 case)
again kept its members and removed nothing. `npx vitest run` (531), `npx tsc --noEmit`, `npm run check`, `go test ./...`.

**Where** `frontend/src/lib/canvas/canvas-node-geometry.ts` (`withoutEmptiedGroups`),
`frontend/src/lib/canvas/canvas-agent-tools.ts` (`moveNode`, `moveClause`, `MoveOutcome`),
`frontend/src/pages/canvas/project.tsx` (`moveNodesTo`, `finishNodeDrag`, `forgetNodes`),
`internal/server/routes_mcp.go`, `frontend/tests/{canvas-node-geometry,canvas-agent-tools}.test.ts`.

## 318. A delete that empties a card takes the card with it

**Decision** `deleteNodes` applies `withoutEmptiedGroups` (#317) to what it leaves behind, and answers with the
cards it took away: `delete_node` appends `; removed g1, which the delete left empty`. A card that still holds a
member, and a box that was already empty, are untouched. #292's cost sentence — "a group whose members are all
deleted now stays as an empty box" — is amended: it described the state removing the sweep left behind, and its
reason ("the price of not deleting other people's cards on an unrelated press") does not reach a press that
deletes the card's last member.

**Why** #292's rule is "the shells *this press* emptied are debris this press made", and it was applied to
grouping and ungrouping, then to moving (#317), and not to deleting — so the same canvas state was litter by one
gesture and permanent by another. The cost sentence was read as a decision to keep it; read against the rule it
cites, it is only a description: the delete of a last member is the emptiest possible case of "this press emptied
it". Leaving it also taught the agent nothing: `delete_node` said the node was gone and the next `list_nodes`
showed a card that had never held anything.

**Rejected** Deleting the shell when the *group* is deleted and not when its last member is — that is the
asymmetry, not a rule. Also rejected: reporting nothing and letting `list_nodes` explain it later, which is what
`move_node` was doing before #317.

**Cost** Deleting a member can now remove two nodes, so "I only asked for one" is a thing a person can say; the
undo is one step, since both removals are written in the same update. `delete_node`'s answer grew a clause and its
description a sentence.

**Tested** `canvas-agent-tools.test.ts` (+3): a card whose last member is deleted is removed and named in the
answer; a card that keeps a member stays; an empty box elsewhere is not swept. In the browser, on an isolated
server with a card holding one member beside a loose node: clicking the member (it took the selection, `z-50`,
no dialog) and sending the page a Delete keydown left the document holding the loose node alone — the member and
its card were both gone. `npx vitest run` (534), `npx tsc --noEmit`, `npm run check`, `go test ./...`.

**Where** `frontend/src/lib/canvas/canvas-agent-tools.ts` (`CanvasHands["deleteNodes"]`, `deleteNode`),
`frontend/src/pages/canvas/project.tsx` (`deleteNodes`), `internal/server/routes_mcp.go`,
`frontend/tests/canvas-agent-tools.test.ts`, and #292's cost paragraph above.

## 319. One question, one reader: the node tools are cut by what they answer

**Decision** Seven tools over a node's content, and each answers exactly one thing: `read_node` / `set_node` for
the parameters of the next run (which workflow and mode, size, length, quality, seed, background, container,
instructions, the workflow's own knobs), `read_prompt` / `set_prompt` for the words it will be asked, `read_text` /
`set_text` for the words it holds, and `read_media` for the picture, film or sound itself — which has no writer,
because a file enters the canvas as a new node (#228). A reader reports exactly what its writer writes: `set_node`
answers with the same `configuredClause` that `read_node` gives, and neither carries bytes.

`read_node` carries no media, no words, no run state and no maker. State and provenance stay on the `list_nodes`
line and in the caption `read_media` sends with a picture. `set_node` is the old `set_node_settings` and `set_model`
in one call: the run is chosen first, and every stated setting is judged against the contract of the model that
will run it (`nodeContract(nodeId, run)`), in one write — all of it or none of it.

**Why** The reads were cut by payload size, not by question: `read_node` answered with content, the picture's
bytes, the run's state and what made it, while `read_prompt` answered with the words *and* the whole
configuration. Two names with one `nodeId` differed by three orders of magnitude in cost, so nothing at the call
site said what a read would spend. Measured on one real session (`canvases/0d0a9a0c2250/session.alaya`, 55.1 MiB,
235 tool calls): **20 `canvas_read_node` calls carried 54.90 MiB — 99.7% of the conversation** — while the other
215 calls together carried 65 kB. Two of those reads were made to answer 最新的图片是哪一张 / 最旧的图片是哪一张, on
nodes the same conversation had already read, for a date that its last `list_nodes` (3.5 kB) already printed: 5.8
MiB for two facts.

The writes had the mirror-image defect. A size is judged against the workflow that will run it, and #309's promise
that "a call that gets any setting wrong writes none of them" could not hold across two calls: `set_model` would
succeed, and the size that followed would be refused, leaving the user's one sentence half applied.

**Cost** One more name (20 tools), and #257's rewrite workflow now reads twice — `read_prompt` for the words and
`read_node` for the run — where it used to read once. Both answers are a few hundred bytes, which is the trade the
old arrangement could not make while `read_node` carried pictures. `planNodeModel` and `planNodeSettings` keep
their own validation; `set_node` only decides the order and the atomicity. The rule "change the model when the user
asks for that model, never to tidy" is now carried by the system prompt alone, no longer by a tool of its own.

**Tested** `npx vitest run` (544, including: `read_node` never returns a non-text block, `read_media` returns the
image block plus its caption, `read_node` on a text node points at `read_text`, `set_node` writes model and size
together and writes nothing when the size is refused, `set_node` judges the size by the contract of the model being
set), `npx tsc --noEmit`, `npm run check` (i18n, exports, prettier), `npm run build` 573.63 kB, `make check`
(vet, every Go package, deadcode 503 exports), and `tools/list` on a live server: twenty names in the order the
agent receives them.

**Where** `frontend/src/lib/canvas/canvas-agent-tools.ts` (`readNode`, `readText`, `readMedia`, `readPrompt`,
`setNode`, `CanvasHands["nodeContract"]`), `frontend/src/pages/canvas/project.tsx` (`nodeContract`),
`internal/server/{routes_mcp.go,agent_instructions.go,run_notice.go}`, `internal/server/{mcp,run_notice}_test.go`,
`frontend/tests/canvas-agent-tools.test.ts`.

## 321. A node has no name

**Decision** A node is its id and its type. `CanvasNodeData` loses `title`, `titleKey` and `titleParams`; the
rename UI on the card goes with them (the dashed label above a node, its double-click editor, and the two
dismiss/cancel keys); every default title is gone from `NODE_DEFAULT_SIZE`, from the node factory and from
`getNodeSpec`. Where a person or an agent needs words for a node, it is the type's own name
(`getNodeDefinition(type).title` — "Image", "组"), the node's id, or what the node holds.

The one place a *generated* name survived was the capture-frame menu on a video node ("视频 首帧"), and it goes
too: the picture a capture makes is an ordinary image node, connected to the video it came from, and the
connection is what says so.

**Why** A title was three fields of ceremony for a label nobody read. Measured on the working canvas: 17 nodes,
none renamed, every one carrying `title: "Image"` or `"Group"` — a name that belongs to eleven nodes and names
none of them. It cost more than that: the side panel and the reference block fell back to it, `list_nodes`
printed it beside `(image)`, an import named its node after the file, a duplicate appended " Copy", and a
citation tried to be a name, because a mention that reads `@Image` cannot
be resolved to a node and a mention that reads the id never needed a title at all.

**Cost** A canvas of pictures has nothing above a card to aim at, and the side panel's rows are separated by
thumbnail and type name alone. Three i18n keys per language go with it (`canvas.node.untitled`,
`canvas.node.renameHint`, the three `videoFrames.*Title`), plus `canvas.upscale.title`,
`canvas.runtime.cropNodeTitle`, `canvas.runtime.splitTitle`, `canvas.nodeToolbar.name` and `canvas.node.node`.
An older canvas keeps its `title` fields in the file — nothing reads them — and the next save drops them
(`documentOf`). A media file a run is handed is now named by the node's id instead of its title, which is at
least unique: eleven pictures all sent `Image.png`.

**What the type does not catch** Four writers outlived the field: the mask, outpaint and MOSS-layout nodes still
wrote `title` and `titleKey`, and those writes kept `canvas.runtime.maskNodeTitle`,
`canvas.runtime.maskResult`, `canvas.outpaint.resultTitle` and `canvas.mossLayout.resultTitle` alive, so the
i18n check counted them as used. `tsc` never saw them because a node literal inside `[...prev, {…}]` is inferred
rather than freshly checked — a spread of the current nodes in the same array literal is what turns the element
type into a union and drops the excess-property check. They are removed, and the key counts are 819 zh / 786 en.

**Tested** `npx vitest run` 550 (one new: a legacy document's title fields do not survive a save; the fixtures
and the four assertions that read titles were rewritten around what a node actually says), `npx tsc --noEmit`,
`npm run check` (i18n: 819 zh keys and 786 en, no dead ones; exports; prettier), `npm run build` 570.00 kB,
`go test ./internal/server/`.

**Where** `frontend/src/types/canvas.ts`, `frontend/src/constant/canvas.ts`, `frontend/src/lib/canvas/{node-registry,canvas-node-factory,canvas-document,canvas-agent-view,node-prompt-field,canvas-export,canvas-resource-references}.ts`,
`frontend/src/components/canvas/{canvas-node,canvas-create-menus,canvas-side-panel-elements,canvas-node-toolbar,canvas-node-reference-bar,canvas-agent-panel,canvas-node-generation,nodes/builtin-nodes}.tsx`,
`frontend/src/pages/canvas/{project.tsx,hooks/use-content-ingress.ts,hooks/use-image-editors.ts}`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts` (the `title` keys are gone with the field).

## 322. A key column is sized by its own words, never by a number

**Decision** The node information panel's keys are one grid column for the whole panel, sized `max-content`
(`grid-cols-[max-content_minmax(0,1fr)]` in `canvas-node-toolbar.tsx`), and `InfoRow` returns the key and
the value as two cells of that grid rather than being a grid of its own. The value column is `minmax(0,1fr)` and
keeps `break-words`: a prompt gives way when the panel is narrow, a key never does.

**Why** The key column was 72px per row. "Generated at" wrapped onto two lines while "ID" left most of its cell
empty — a number somebody guessed, and one that only has to survive until the next key or the next language. It
was already wrong in the language it was guessed in: English is where this panel's keys are longest. The row is a
table of facts, and the only width a table's key column can honestly have is the width of its widest key.

**The rest of the app, checked** No other panel puts a key and its value in two columns of prose: the
system-status dialog, the settings dialogs and the tool-node panel are label-left/value-right
(`justify-between`), which sizes itself, and the JSON tab is a `<pre>`. The one other fixed column
(`canvas-node-angle-dialog.tsx`, 88px, three rows of label + slider + number) is a *control* row, and its four
labels fit at 88px in both languages; it is also a column shared by rows that must line up, so it stays a number
until a translation outgrows it — at which point those rows want this same treatment against a shared parent grid.

**Cost** The column is now as wide as the widest key rather than a constant, so a panel of long keys pushes the
values further right than it used to, and the gap between key and value is 20px rather than 12.

**Tested** `npx vitest run` 550, `npx tsc --noEmit`, `npm run check`, `npm run build`, and the built stylesheet
carries `grid-template-columns:max-content minmax(0,1fr)`. The layout was rendered rather than assumed: this
panel's own markup, with the video node's nine keys, against that stylesheet in headless Chrome — every key on one
line, values starting at one x, the prompt wrapping inside the value column. The unit suite runs in `node` with no
DOM, so a column width is nothing a test here can see, and the app itself has not been opened: what is verified is
the rule and the CSS, not the running page.

**Where** `frontend/src/components/canvas/canvas-node-toolbar.tsx` (`CanvasNodeInfoModal`, `InfoRow`).

## 323. A film's frames are pictures, and a picture is a node

**Decision** `capture_frame` takes a film's first and/or last frame out of it as image nodes, each wired from the
film it came out of: `frame` is `first`, `last`, or `both`, and `both` is the default. The page decodes the frame
(`captureFrames` in `project.tsx` — the card menu's own code, not a second copy of it), uploads it, and writes the
node and the connection before the call returns; the tool answers with the ids and the size of each picture. The
frames hold no model, so the answer ends by saying the one thing that can be done with them: connect them to the
node that should run from them. There is no `current` frame — a playhead is a fact about the user's screen, and
the card's menu keeps that item for the person.

**Why a node and not bytes** A run of a frames workflow takes a picture, and this is how a longer clip is made:
the last frame of one clip is the first frame of the next. Handing the frame back as media would be the 54.9 MiB
that #319 measured — a caller that needs the *picture as an input* needs it on the canvas, wired.

**Why its own verb** It cannot be `generate` (no model, no GPU, no run — that is what #297 made "material" mean),
and it cannot be an option on `create_node`: that tool's invariant is "a node made empty, then filled by a run",
while this one is made *filled*, fails in a different way (a decode, not a refusal), and would be the only argument
on that tool that produces bytes. It sits after `connect` in the vocabulary, because make / connect / capture are
the three tools that change the graph rather than what runs in it. `join_clips` (#324) is the same kind of act.

**Tested** `frontend/tests/canvas-agent-tools.test.ts` (5): both frames by default with both ids in the answer; one
named frame, with what the next clip does with it; a picture refused as "one frame already"; `current` refused with
the three choices named; a film still generating refused as such; the page's decode failure passed through as the
answer. `npx tsc --noEmit`, `npm run check`, `npx vitest run` 563, `go test ./internal/server/`, `make check`.

**Where** `frontend/src/lib/canvas/canvas-agent-tools.ts` (`captureFrame`, `CaptureOutcome`, the hand),
`frontend/src/pages/canvas/project.tsx` (`captureFrames`, `captureVideoNodeFrame`),
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`, `internal/server/routes_mcp.go`,
`internal/server/agent_instructions.go`, `internal/server/mcp_test.go`.

## 324. One verb for joining clips, and it does not guess

**Decision** `POST /api/canvases/{id}/join` takes `{"files": [name, ...], "reencode": false}` and makes one clip
of the canvas's own files, in the order given. It probes every input with ffprobe first; when the inputs agree on
every track (kind, codec, size, pixel format, frame rate, sample rate, channels) it copies the streams
(`-f concat -c copy -movflags +faststart`); when they do not it refuses, naming the file and the field that
differ; and it re-encodes only when the caller asks for it. The result is read back before it is handed over — its
duration must be the inputs' sum and it must have a video track — and then it is moved into the canvas and answered
with `{upload, durationMs, width, height, mode}`. The tool `join_clips {nodeIds, reencode?}` does the same through
the page, which writes one video node wired from each clip in the list. The selection toolbar's Join is that same
hand, ordered left to right.

**Why a route and not a run** The browser cannot mux H.264 (it can draw a frame, which is why #323 is the page's),
and a run would put a CPU file copy behind the GPU queue with fixed media slots — five clips cannot be one run.
So this is not a model, and the node it makes records none: it is material, like a captured frame, and the wires
from the clips it was built out of say what it was built out of.

**Why the probe, and why a refusal** ffmpeg's concat demuxer does not refuse inputs it cannot stitch: it writes a
file, and the file plays until the first seam and then stops. Trusting its exit code would save that as a node. So
the parameters are compared before anything is written, and the answer names the clip and the field ("clip-2.mp4
is 96×96 and clip-1.mp4 is 64×64") — the same refuse-don't-clamp rule a size gets (#270). Re-encoding is the
escape, and it changes every frame of the result, which is why it is a word in the call rather than a fallback.

**Also decided with it** A clip's own length is now on its `list_nodes` line (`pictureClause`): a card never shows
one, so unlike the picture's pixels it is never left out. A chain is planned from it — "how many more clips make a
minute" — and `join_clips` answers with the result's length for the same reason.

**Cost** Two clips that were not made the same way cannot be joined from the UI yet: it asks for a copy, and a
refusal is shown as a toast. The escape exists on the route and the tool (`reencode: true`); a button for it is a
follow-up, to be added when someone actually hits it.

**Tested** `internal/server/join_test.go` (6): every way two clips can differ, as the sentence each one produces;
silence when they agree; a sound's channel count; the route's refusals (one file, a missing file, a name outside
the canvas); one real join of two ten-frame clips through ffmpeg, which answers `mode: copy`, about 2 s of clip,
and a file the canvas then serves; mismatched clips refused with both names in the sentence. `go test
./internal/server/`, `make check`, and on the frontend `npx vitest run` 562 (three for `join_clips`: the order is
the list, one clip is not a join, reencode passed through or refused when it is not a boolean).

**Where** `internal/server/routes_join.go`, `internal/upload/upload.go` (`Adopt`, `moveFile`),
`internal/server/server.go` (`probeVideoFile` now reads through the one probe), `internal/server/join_test.go`,
`frontend/src/services/api/join.ts`, `frontend/src/lib/canvas/canvas-agent-tools.ts` (`joinClips`, `JoinOutcome`),
`frontend/src/pages/canvas/project.tsx` (`joinClips`, `joinSelectedVideos`),
`frontend/src/components/canvas/canvas-selection-toolbar.tsx`, `frontend/src/lib/canvas/canvas-agent-view.ts`,
`internal/server/routes_mcp.go`, `internal/server/agent_instructions.go`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.

## 325. How a film's frames map is a setting, not a leftover knob

**Decision** `frameMode` is a `set_node` setting on a film — `first`, `last`, or `both` — writing
`metadata.frameMode`, the field the panel's own pill writes and the request reads; `read_node` states it back
("frames first"). A workflow that declares no frames refuses it with the list of keys it does read.

**Why** It was reachable only as `params.frameMode`. That did reach the request, because a frames workflow
declares the key — but it did not reach the node: the pill showed nothing, `read_node` reported it as one of the
workflow's knobs rather than as what the connected pictures are, and a node could be running with a frame mapping
its own panel could not show. Two paths to one request key is how a panel and a tool drift apart (#302, #309).

**Cost** "Put this film in frames mode" is two statements: the workflow (whose declared mode fixes it) and this.
And the key is only meaningful together with the pictures: a film with no connected picture, or more than its
workflow takes, is refused by the run, not by this setting.

**Tested** `frontend/tests/node-settings.test.ts` (one new: a film takes `frameMode` and writes it, a workflow with
no frames refuses it by name, `middle` is not a frame mode), `frontend/tests/node-generation-facts.test.ts` (the
clause reads back what the settings wrote). `npx tsc --noEmit`, `npm run check`, `npx vitest run` 563.

**Where** `frontend/src/lib/canvas/node-settings.ts` (`frameMode` field, `heldKeys`),
`frontend/src/lib/canvas/node-generation-facts.ts` (`settingsClause`), `internal/server/routes_mcp.go` (the
`set_node` schema).


## 326. A rule about working is in the prompt; a description says what a call does

**Decision** "Do not wait for it and do not poll the node" is stated once, in `canvasInstructions`: *"Pressing is
not waiting: canvas_generate answers when the run is out, and how it ended reaches you as a message — finished,
failed or cancelled, however long it took."* The rule left `generate`'s description, which now says only what the
call does — it answers at once, the node shows its own progress and holds the result, a text node generates
nothing — and it left the tool's answer, which keeps the fact about the run it started ("run … is out … you will be
sent a message when it finishes") and no instruction.

**Why** The sentence was in two places and the prompt had none, while the paragraph above it — a longer video is a
chain, *"let each run finish before you take its frame"* — already assumed the mechanism without ever stating it.
Three homes for one instruction is the sediment #203 named ("a third copy of the same sentence is sediment"), and
the two existing copies had already begun to disagree: a run ends in three ways (`run_notice.go`: finished,
cancelled, failed with the reason) while the description said "a message saying how it went".

Which half goes where is #203's line for `connect` — the description carries the mechanism, the prompt carries the
policy — and the prompt is the only text with the durability a rule needs: it is set on every spawn, it survives
the compaction of a conversation and any trimming of the tool list, and the temptation to poll arrives *after* the
call, when the description has already been read and answered. `list_nodes` then hands the agent a handle for
exactly that mistake (`[generating now]`), which is why the rule is worth a sentence rather than a shrug.

**Cost** The instruction is paid once instead of twice, and the answer's remaining promise is a fact about one run
rather than a rule. What is lost is the reminder at the moment of temptation: a model that ignores the system
prompt has only "you will be sent a message" to work from, and an agent told too little polls (#225). One authority
for the rule, and the fact beside it, is the trade.

**Tested** `internal/server/mcp_test.go` (`TestAgentSpawnCarriesTheCanvasRule` names "Pressing is not waiting",
"finished, failed or cancelled" and "Do not wait for it and do not poll the node"), `frontend/tests/agent-generate.test.ts`
(the answer still promises the message, and now a case pins that it says `poll` nowhere). `go test ./...`,
`npx vitest run`, `make check`.

**Where** `internal/server/agent_instructions.go`, `internal/server/routes_mcp.go` (`generate`),
`frontend/src/lib/canvas/agent-generate.ts`, `internal/server/mcp_test.go`, `frontend/tests/agent-generate.test.ts`.


## 327. Deleting a node is a move into the canvas's trash

**Decision** A delete — the Delete key, the hover toolbar's remove, `delete_node` — takes the node out of `nodes`
and puts it in `document.trash` with the connections it had and when it went, newest first, the newest 20 kept.
`restore_node`, and the side panel's Deleted list, puts it back: its wires are restored when both ends are still
there and the pair is not connected already, and a `groupId` whose group is gone is cleared. A group is never in
the trash: deleting one releases its members and destroys nothing.

**Why** The canvas had one gesture with no way back, and two separate reasons, both measured on this machine.

- *The undo stack is memory.* It is emptied when a canvas is opened, so a delete was reversible only inside the tab
  that made it. The agent's `delete_node` is the page's own `deleteNodes`, so Ctrl+Z undid it too — but a reload
  made every mistake permanent, and a mistake is usually noticed after the reload.
- *The file died with the node.* The server keeps a canvas's media in `files/`, and the collector deletes what
  neither the document nor a task still names, with a grace measured from the *file's own age* — so deleting a
  picture made yesterday had its bytes collected at the next save, 180 ms of debounce later. Ctrl+Z brought the
  card back empty. On the canvas this was found on, twelve files were already unreferenced and eight were hours
  short of their 24-hour birthday: "you can still get it back" was luck with a timer on it.

Putting the node *in* the document is what fixes both with one mechanism. The collector's one rule is "the document
names it" — it scans for `files/<name>` and deliberately knows nothing about nodes (#148) — so a trashed node keeps
its file alive without the collector learning a new concept, and the way back outlives the tab. No second store and
no second lifetime rule for bytes, which is what the old "no trash directory" decision refused.

**Cost** A seventh field in the document and a third list in the side panel. The trash holds 20 nodes, and a node
pushed out of it stops naming its file: its bytes then wait out the existing grace and go, which is the one
lifetime rule this adds. Clear canvas is deliberately *not* trashed — it is a confirmed "throw it all away", and a
20-slot trash holding a tenth of a cleared board would be a promise it cannot keep. The trash belongs to the
canvas rather than to the session that filled it, so it is also where a user's own deletions go, and
`restore_node` may put back something the agent never touched — which the prompt says out loud.

**Tested** `frontend/tests/canvas-trash.test.ts` (10: what a delete keeps, a group is not kept, the limit, the three
relations a restore may not invent, ids it could not find); `canvas-agent-tools.test.ts` (the delete's sentence, a
group's different one, an id answered as "in the trash" rather than unknown, restore, restore of something that is
not there); `canvas-agent-view.test.ts` (the header's count, a trash line for a picture and for words, an empty
trash is not a section, an unreadable timestamp, the unit of the age); `canvas-document.test.ts` (a trashed node's
media is written by reference, so the document does not carry this server's address); `internal/canvas` —
`TestSweepKeepsTheFileOfANodeTheDocumentOnlyHoldsInItsTrash`, the pin on the whole mechanism: a file three days
old, named only inside `trash`, survives a real sweep. `mcp_test.go` pins `restore_node` in the tool order and the
prompt's "Deleting is a move, not a loss".

In the browser, against the running server and a throwaway canvas (deleted afterwards): a node deleted with the
Delete key left `trash: [image-verify]` in `canvas.json` and its file on disk; aged to three days and saved again,
the file survived the sweep; the Deleted tab drew the row with its thumbnail and Restore, in a brand-new tab that
had only ever read the document; restoring put the picture back, selected, with the trash empty. Two things were
fixed after seeing it: the English tab label shortened to "Deleted" (it truncated at the column's default width),
and the header's hint to "Files are kept".

**Where** `frontend/src/lib/canvas/canvas-trash.ts`, `frontend/src/components/canvas/canvas-side-panel-deleted.tsx`,
`frontend/src/components/canvas/canvas-side-panel.tsx`, `frontend/src/pages/canvas/project.tsx` (`deleteNodes`,
`restoreNodes`, the history entry, the save patch), `frontend/src/lib/canvas/canvas-agent-tools.ts` (`restore_node`,
`noSuchNode`, `delete_node`), `frontend/src/lib/canvas/canvas-agent-view.ts` (`describeCanvas`, `trashLine`),
`frontend/src/lib/canvas/canvas-generation-helpers.ts` (`hydrateCanvasTrash`),
`frontend/src/services/api/canvases.ts` (`readTrash`), `frontend/src/lib/canvas/canvas-document.ts`,
`frontend/src/types/canvas.ts` (`CanvasTrashEntry`), `internal/server/routes_mcp.go` (`nodeIdSchema`, the two
tools), `internal/server/agent_instructions.go`, `internal/canvas/canvas.go`.


## 328. Undo says what it will take back, and a delete offers it

**Decision** A history step is described as it is made — `{ kind, ids }` from `describeChange` — and the Canvas
menu's item reads "Undo: deleted image-3", "Undo: moved image-3", "Undo: connected a → b". A delete also answers
with a toast that carries the way back: "Deleted image-3" and an **Undo** button that restores from the trash. The
step count and the "progress unavailable" flag a run writes into a node's metadata are not changes: the diff that
makes the label is also what decides whether a step is taken at all.

**Why** The user's report was "the agent's operations and mine are not connected". Mechanically they were — the
agent's `delete_node` is the page's own `deleteNodes`, so it lands in the same stack — but three things made that
invisible, and one of them was a real leak:

- *The word "Undo" says nothing.* After an agent turn the stack holds one step covering whatever the whole turn
  did, and the menu looked the same whether that was a deletion or a nudge. A person had to press it to find out.
- *The one destructive gesture was silent.* A node vanishing is the only thing here that cannot be redrawn from
  what is left, and nothing said it was recoverable (#327 made it recoverable; this says so).
- *A run was filling the stack.* `stepProgress` is written into the node's metadata on every poll, so `nodes`
  changed identity twice a second and each change committed a history entry: a two-minute render wrote eighty
  steps and pushed everything the user had done out of a fifty-step stack. Undo had been unusable after any long
  run, which is exactly when a person most wants it.

**Cost** The diff runs on every state change — two `JSON.stringify` per node, on a board that may hold hundreds,
every 180 ms of activity. And a step is described by its loudest part (a deletion over an addition over a wire
over a change): a step that did three things is named for one of them, so "Undo: deleted image-3" may also put
back a wire. Both are prices of one sentence in a menu.

**Rejected** A per-call history step for each agent tool call. It would make Undo step through a turn one action
at a time — asked for and declined, because undoing a whole turn with one press is what most people mean. Also
rejected: taking Ctrl+Z from the agent panel's textarea. Focus in a text box means the text box, and a shortcut
that silently means different things in different places is worse than one that only works on the canvas.

**Tested** `frontend/tests/canvas-change.test.ts` (14: nothing-changed is null, delete vs restore vs create, move
vs resize vs edit, wire made vs cut, canvas-only, a deletion named over an addition, a progress tick is not a
step, a finished run is one, and the wording through a fake `t`). In the browser on a throwaway canvas (deleted
afterwards): the Delete key answered "Deleted image-verify" with an Undo button, which put the picture back; the
menu read "Undo: deleted image-verify" and restored it; a drag then read "Undo: moved image-verify".

**Where** `frontend/src/lib/canvas/canvas-change.ts`, `frontend/src/pages/canvas/project.tsx` (the history
effect, `deleteNodes`, the menu's labels), `frontend/src/components/canvas/canvas-menu.tsx`,
`frontend/src/components/kit/toast.ts` (`action`), `frontend/src/i18n/locales/{en-US,zh-CN}.ts`.


## 329. A clip opens at its own size, and the window can be as wide as the window

**Decision** Double-clicking a clip card opens the media dialog the way a double-click on a picture already did:
the same dialog, titled "Video details" instead of "Image details", showing the clip at its own resolution,
shrunk only when the window is smaller than it is, with the browser's controls and playing from the start. The
dialog is sized by its media, so a 736-pixel clip opens 736 wide and a 3840-pixel one opens as wide as the window
allows. Two clicks are not a request: the play button over the still frame swallows its own double click (two
presses are two plays), and while a clip *is* playing the frame belongs to the element, so a double click there is
the browser's own and opens nothing.

**Why** A card is a fixed box, and a clip's whole point — detail, motion, framing — lives in its resolution, so
the card is the one view that cannot show it. The elements list already answers this for a picture (hovering a row
shows the picture at its own size), and the canvas answered it for a picture; a clip had no answer at all, because
`onDoubleClick` returned early for every type but Image and Text. The user asked for the picture's behaviour on a
clip, and for the size to be the clip's own.

That request then exposed a real bug in the dialog itself. It was centred with `left: 50%` plus
`-translate-x-1/2` and sized `w-auto`, and a translate moves a box after the fact without widening it: with
`left: 50%` the shrink-to-fit width is capped at the space from the middle of the window to its right edge, so no
preview — picture or clip — could ever be wider than half the window. Measured before the fix: a 3840×2160 clip
came out 1125 wide in a 2263-wide window, letterboxed inside its own box because the height had been clamped while
the width had not. Centring by `inset-x-0` + `mx-auto` leaves the whole window available, and the `auto` size is
now `w-fit`: 2133×1200 for the same clip, edge to edge, no letterbox. The picture path is unchanged in appearance
and gains the same headroom when a picture is bigger than half the screen.

**Cost** The dialog's element is a second `<video>` for the same file, so the preview fetches it again (a cache
hit for a local file, and the reason `preload` is not forced off). `autoPlay` means opening a clip's preview always
starts it — the double click is treated as the decision to watch, which is what the gesture means; there is no
muted autoplay and no loop. A clip already playing on its card keeps the native player while it plays, so the one
state where the card does not answer the double click is the state where the browser already has a bigger answer.

**Rejected** Reusing the elements list's hover overlay for this. It is a pointer-transparent box with no controls:
the same size, but nothing to scrub with, and it would sit over the canvas rather than over the window. Also
rejected: giving the preview a fixed `panel` size. The dialog's own note says a window that resizes to its contents
breaks the user's sense of where it is — the exemption is for media, whose size *is* the thing being looked at, and
a 720p clip has no business being shown in a 1000-pixel frame.

**Tested** In the browser on a throwaway canvas (deleted afterwards) against the running server: a 736×736 clip
with a recorded natural size, the same clip with none, a 1280×720 clip and a 3840×2160 clip. Each opened at its own
size — 736, 736, 1280 and 2133×1200 — with the 4K one filling the window and the test pattern's squares square,
i.e. the ratio held with both constraints clamping. Double-clicking the play button started playback and opened
nothing (native controls appeared, no dialog). A picture still opened as "Image details" at 736, and Preferences
still opened as a centred 1000-pixel panel, so the centring change cost the fixed sizes nothing. `npx vitest run`
(598), `npx tsc --noEmit`, `npm run check` (842/809 keys, 190 modules), `npm run build` (587.30 kB).

**Where** `frontend/src/components/canvas/canvas-node.tsx` (the card's `onDoubleClick`, the play button's own
double click, `onPreviewNode`), `frontend/src/components/kit/dialog.tsx` (the centring and the `auto` size),
`frontend/src/pages/canvas/project.tsx` (`handleNodePreview`, the media dialog),
`frontend/src/i18n/locales/{en-US,zh-CN}.ts` (`canvas.runtime.videoDetails`).


## 330. A mask is opened by the mode that needs it, not by the picture's toolbar

**Decision** Mask editing is not a quick tool on an image card's toolbar. It is opened by the control that
chooses what the model should do with the picture: in the image settings popover, picking `inpaint` opens the mask
editor (and `outpaint` opens the outpaint one). The toolbar keeps only the tools that act on the picture itself —
info, delete, download, crop, split, upscale, angle, view.

**Why** The user asked the question the button could not answer: "inpaint 的时候才需要它，放在一个图片的通用工具条
上面有什么用呢". The code agrees with them, and more strongly than the question assumed. A mask is not something a
picture carries; it is an input one *mode* of one model declares. Only `image-qwen21` has it: its `inpaint` variant
binds `mask` to a second `LoadImage`, then `ImageToMask` → `InpaintCropImproved` → `SetLatentNoiseMask` → …
→ `InpaintStitchImproved`. Every other image workflow in the registry takes **no pictures at all** — Z-Image Turbo
and the MOSS ones have `EmptyLatentImage` and no `LoadImage`, and no `refs` binding — so pressing the toolbar button
on one of them uploaded a source and a mask that the graph could not accept, and the run came back as a fresh
text-to-image of the sentence: a picture that had nothing to do with the one it was painted on. It also lied about
the mode: the run's config was given `imageMode: "inpaint"` on the way out without writing it back to the node, so
the panel's pill still read "Text to image" for a run that had gone out as inpaint. A control that is wrong for
every model but one, and misreports what it did for that one, belongs where the model and the mode are chosen.

**Cost** One click more on the path that does work: Qwen's pill → 局部重绘 → editor, instead of a button on the
card. And the editor is now found only by someone who has already decided to inpaint — the hint under the pills
("选择后自动打开蒙版，只修改蒙版覆盖区域") is what has to teach it. The editor's payload is one shape now: it always
sends the white-on-transparent mask with `imageMode: "inpaint"` and the instruction as written, instead of choosing
between a real mask and a blue-overlay-plus-instruction picture depending on the model's workflow id. The drawn
overlay is still uploaded, but only as the mask node's own picture — what you see when you reopen that node — so
that binding and that picture are two files with two jobs rather than two candidate payloads.

**Rejected** Keeping the button and hiding it when the model has no mask input. That is a per-model condition on a
toolbar shared by every picture, and it would still put the mask next to Crop. Also rejected: keeping it visible
but disabled with a hint, which on a bar this dense is a permanently greyed button that has to be explained.

**Tested** In the browser on a throwaway canvas (deleted afterwards): an image card's toolbar reads
info / remove / download / crop / split / upscale / angle / view with no 局部编辑, and "Customize toolbar" lists the
same eight, 8/8 checked; a node set to Qwen Image 2.1 whose mode pill is opened shows 局部重绘 and clicking it opens
"Local mask edit" with brush, instructions and Generate. The inpaint itself was run twice on that canvas — once with
the old payload, once after it was collapsed to one shape — because the collapse changes what is sent to ComfyUI and
reading it was not enough: a brush dot in the middle of the animal with "turn the selected area into a bright red
balloon" came back a red balloon in exactly that spot, frame still 736×736; after the trim, "…a glowing yellow
lantern" came back a lantern in the same spot, with `references: [files/source.png, files/up-e76b452f.png]` and the
mask node binding that same file. Nothing outside the mask moved in either run. `npx vitest run` (598),
`npx tsc --noEmit`, `npm run check` (839/806 keys — the two `imageTools.mask*` strings and `canvas.runtime.maskPrompt`
are gone, and the material hint no longer names a card tool that does not exist), `npm run build` (585.89 kB).

**Where** `frontend/src/components/canvas/canvas-image-toolbar-tools.tsx` (the missing definition, and the note
saying why), `frontend/src/components/canvas/canvas-node-toolbar.tsx`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/pages/canvas/hooks/use-image-editors.ts` (`maskEditImageNode`
sends one payload), `frontend/src/i18n/locales/{en-US,zh-CN}.ts` (`canvas.imageTools.mask*` and
`canvas.runtime.maskPrompt` removed, `canvas.runtime.materialHint` corrected).


## 331. A clip opens at its own size from its toolbar, not only from a gesture

**Decision** The video card's toolbar reads info, delete, download, interpolate, view video. The last entry opens
the same dialog the double click on the card opens — the clip at its own resolution, with the browser's controls —
because it is the same handler: the toolbar's `onView`, and the card's double click, both reach the page's
`handleNodePreview`. An empty video card has no such entry, for the same reason it has no download: there is
nothing to open. The toolbar's picture tool and the clip's button are one prop (`onView`) and two definitions:
the picture's `view` is the last entry on the picture's list, the clip's `viewVideo` the last entry on its own,
because the two bars are built by two functions for two kinds of card (#332).

**Why** The user said it in one line: the picture's toolbar ends with a preview that opens the picture bigger, and
the clip had that answer only as a double click on the card — "缺少一个工具条上面的按钮". #329 gave the clip the
picture's behaviour; a picture also had the button, so the two cards answered the same question differently, and a
gesture nobody can see is not a tool. The prop was named `onViewImage` while it served only the picture tool; it is
`onView` now that both cards ask for it, and the name stays literal inside the image-tools module, where the
handler is still a picture's.

**Cost** The clip's bar gains a fourth entry — interpolate, frame, view. There is no longer an asymmetry to
defend: neither bar is configurable since #332, so the clip's list of what a clip can do and the picture's list
of what a picture can do are the same kind of list.

**Rejected** Reusing the picture's `view` definition by making `buildImageToolbarTools` type-agnostic. That list
is the picture's five verbs, keyed by ids that only a picture has; a clip's `viewVideo` is not one of them, and
the clip's bar is built from its own three. A second definition with its own words is smaller than teaching one
list to serve a card it is not about. Also rejected: a dialog of its own for clips. It is one dialog, titled by
the node's type since #329.

**Tested** In the browser against the running server, on a throwaway canvas (deleted afterwards, `lastCanvas` put
back): a selected 736×736 clip's toolbar read Info / Delete / Download / Interpolate / View video, and the button
opened "Video details" at 736 — the clip's own width — with the native controls (scrubber, play, full screen,
volume); in 简体中文 the same bar read 信息 / 删除 / 下载 / 插帧 / 查看视频 and opened 视频详情. An empty video card's
toolbar offered only Info / Delete, and the picture card's toolbar was unchanged (crop / split / upscale /
multi-angle / view image / more), its own view still opening the picture. `npx vitest run` (598),
`npx tsc --noEmit`, `npm run check` (841/808 keys, 190 modules), `npm run build` (586.19 kB).

**Where** `frontend/src/components/canvas/canvas-node-toolbar.tsx` (the `viewVideo` entry, `onViewImage` →
`onView`), `frontend/src/pages/canvas/project.tsx` (`onView={handleNodePreview}`),
`frontend/src/components/canvas/canvas-node.tsx` (the `VideoNodeContent` note saying the gesture is a shortcut),
`frontend/src/i18n/locales/{en-US,zh-CN}.ts` (`canvas.nodeToolbar.viewVideo`, `viewVideoTitle`).


## 332. The bar over a node holds what only that kind of node can do; the menu holds what all of them can

**Decision** Two surfaces, one job each, nothing in both. The bar over a selected card carries the verbs of its
type and nothing else: a picture gets crop / split / upscale / multi-angle / view image, a clip gets interpolate /
view video, a text card gets its two font sizes. Information, download, duplicate, grouping and delete are every
node's, so they live in the right-click menu, which is also the menu for a connection. A node with no verbs of its
own — a group, an audio card — gets no bar at all. The one item that stays on the menu although it belongs to one
type is frame capture: "the current frame" means the frame under the pointer, so it belongs to the moment rather
than to the node.

**Why** It is the user's rule, and it is the one that can be written down: *the bar is the node's own, the menu is
everyone's*. The split it replaced could not be stated. The bar carried info, download, delete and ungroup beside
the type-specific tools, so delete and ungroup appeared in both surfaces while duplicate and grouping appeared in
only one; a reader could not tell which list a new verb belonged to, and neither could the next change. The picture
bar had also grown a configuration system — a stored key, a settings dialog, a "show labels" switch and a "more"
button — to hold eight entries in a 48-pixel strip, and after the move it holds five, which is the shape a bar can
actually keep: labels on, no settings, no ellipsis, nothing to choose.

**Cost** One more click for the five things that left the bar: deleting, downloading, reading the facts and
ungrouping are now right-click (or the Delete key), not a button above the card. The image bar's labels are always
on: with five entries the words cost nothing and the icons alone ("multi-angle" as a 3D rotation) were the part
that needed a tooltip. And the picture bar is no longer configurable — there is nothing left to configure when a
type has five tools and the bar is the only place they exist.

**Rejected** Two other homes for the same verbs, both argued for and both wrong. *Everything into the right-click
menu* hides crop/split/upscale/multi-angle behind a gesture nobody performs to find things, and it makes one menu
that must also serve connections. *Everything into the panel under the card* is worse: that panel is the model and
the options that model declares — model, mode, ratio, duration, generate — and a row of picture verbs inside it
would blur the one surface in the app that has a single, clear subject. The bar and the panel are both anchored to
the selected card; that was the reason to merge something, and the thing to merge was the *duplicated* verbs, not
the panel.

**Tested** In the browser against the running server, on a throwaway canvas holding an image, a clip, a text card,
an audio card and a group (deleted afterwards, `lastCanvas` put back). Selecting the picture showed Crop / Split /
Upscale / Multi-angle / View image and nothing else; the clip showed Interpolate / View video; the text card showed
Smaller / Larger; the group and the audio card showed **no bar at all**. Right-clicking the picture gave Info /
Download / Duplicate / —— / Delete, the clip gave the three frame grabs and then the same five, the audio card gave
Info / Download / Duplicate / Delete, the group gave Info / Duplicate / Ungroup / Delete. Info opened "Node
information" for the node that was right-clicked; Download saved the real file (`canvas-image-img.png`, 2.1 MB, in
the browser's download directory); Crop on the bar still opened the crop dialog; the Delete key still deleted the
selected card (toast "Deleted txt", undo offered). `npx vitest run` (598), `npx tsc --noEmit`, `npm run check`
(828/795 keys, 187 modules), `npm run build` (575.92 kB — down from 586.19).

**Where** `frontend/src/components/canvas/canvas-node-toolbar.tsx` (the type-gated tool list, no state, no
settings), `frontend/src/components/canvas/canvas-context-menu.tsx` (info and download added, all node rows behind
`menu.type === "node"`, a divider before the delete), `frontend/src/components/canvas/canvas-image-toolbar-tools.tsx`
(the five definitions, the configuration layer gone), `frontend/src/pages/canvas/project.tsx` (`toolbarNodeId`,
`keepNodeToolbar`, `hideNodeToolbar` and their five resets gone; `onInfo`/`onDownload`/`canDownload` wired into the
menu), `frontend/src/i18n/locales/{en-US,zh-CN}.ts` (the eight `imageTools.*` configuration strings and the five
bar-only `nodeToolbar.*` tooltips gone). Deleted: `canvas-image-toolbar-settings-modal.tsx`, and the kit components
only it used — `kit/card.tsx`, `kit/text.tsx`, `Space` in `frontend/src/components/kit/display.tsx`.


## 333. A clip's frame grabs are a button on its bar, not entries in the menu

**Decision** "Capture a frame" is one button on the clip's bar, opening three choices: first frame, last frame,
current frame. It is the fifth thing on that bar (interpolate, frame ▸, view), and the right-click menu no longer
has the three entries: the menu is every node's verbs, and a frame grab is a clip's own.

**Why** #332 put the three grabs on the menu as the one exception to its own rule — they belong to a clip, but
"the current frame" needs the frame under the pointer. The request that followed was direct: they are the clip's,
so they go where the clip's other verbs are. The exception did not survive the question, and it should not have:
the bar is already anchored to the card and the clip is right there under it, so "current" means the playhead of
the clip whose bar you are pressing — no pointer position needed, and one less thing the menu carries for a type
it is not about. Three flat buttons would have been wider than the card they sit over (the three label sets plus
interpolate plus view is ~500 px against a 420 px card), so it is one button with a small menu: the chevron says
there is more behind it, and the item you pick closes it.

**Cost** A menu inside the bar — the first popover anchored to a bar button in this app, with its own dismissal
(a press outside it, in the capture phase, so a press that starts a canvas drag closes it before the drag begins).
One more click for anyone grabbing frames often: two presses instead of one. And the three grabs share a glyph
family that has to be kept symmetrical by hand: lucide ships `gallery-horizontal-end` and no start, so the first
frame is that same glyph mirrored (`-scale-x-100`), and the pair then reads as one strip marked at either end.

**Rejected** Three separate buttons on the bar: at 420 px per card the bar becomes wider than the card and covers
its neighbours, and the three of them are one act with three answers, not three acts. Also rejected: keeping the
frame grabs in the menu and calling the pointer-position rule an exception — an exception nobody can state is how
#332's problem started.

**Tested** In the browser against the running server, on a throwaway canvas with one clip and one picture (deleted
afterwards, `lastCanvas` put back): the clip's bar read Interpolate / Frame ▾ / View video; the Frame button opened
the three items under itself and pressing Frame again closed it; Capture current frame put a **new image node** on
the canvas, wired from the clip and selected, showing the frame — the clip's own bar rules applied to it (Crop /
Split / Upscale / Multi-angle / View image); the clip's right-click menu was Info / Download / Duplicate / —— /
Delete with no frame entries left; a press elsewhere closed the popover. The three icons were read back from a
zoomed screenshot: marker left, marker right, markers both sides. `npx vitest run` (598), `npx tsc --noEmit`,
`npm run check` (830/797 keys, 187 modules), `npm run build` (577.10 kB).

**Where** `frontend/src/components/canvas/canvas-node-toolbar.tsx` (`ToolbarTool.menu`, the popover in
`ToolbarAction`, the `captureFrame` button and its three items), `frontend/src/components/canvas/canvas-context-menu.tsx`
(the frame block, `canCaptureVideoFrame` and `onCaptureVideoFrame` gone), `frontend/src/pages/canvas/project.tsx`
(`onCaptureVideoFrame` wired to the bar), `frontend/src/i18n/locales/{en-US,zh-CN}.ts`
(`canvas.nodeToolbar.captureFrame`, `captureFrameTitle`).


## 334. A group is dissolved, not deleted, and the menu says so

**Decision** The right-click menu of a **group card** reads info, duplicate, ungroup — and no delete. Every other
node keeps its delete, and a member of a group keeps both: ungroup there means "take this card out of its group,
the card stays", while delete means "this card goes". With the delete row gone from a group card, the divider that
separated it goes too.

**Why** A group cannot be deleted. Deleting one releases its members and destroys nothing (#327): the trash never
holds a group, because a box with no members in it is not something anyone wants back. So on a group card the menu
offered two names for one act, and one of them was a lie — which is what the question "右键菜单里面的 ungroup 有什么用
啊" was really asking. On a *member* the two rows are not the same act at all, which is why ungroup stays there.

**Cost** A user who wants "the box gone" has to pick a verb that does not say delete. That is the point — it is the
honest word — but it is a small unlearning for anyone used to right-click → delete on everything. The Delete key
still dissolves a group it is pressed on, unchanged: the keyboard is not a menu and has no row to relabel.

**Tested** In the browser against the running server, on a throwaway canvas (deleted afterwards, `lastCanvas` put
back): a group card's menu read Info / Duplicate / Ungroup with no delete row and no dangling divider; pressing
Ungroup dissolved it — both pictures stayed where they were, stayed selected, and the dashed box was gone; grouping
them again from the selection bar and right-clicking **one member** gave Info / Download / Duplicate / Ungroup / ——
/ Delete, and pressing Ungroup released that one picture (the box went to "Group 1 node", the card and its file
untouched, `groupId` cleared in the saved document).

That test also found a bug that had nothing to do with this change and was older than it: every row in this menu
was wired `onClick={onClick}`, so the click's `MouseEvent` was passed into handlers that take a `Set` of ids —
right-click → Ungroup threw `TypeError: e.has is not a function` and did nothing, on any node, in every build since
the menu grew the row. `MenuButton` now calls `onClick?.()` with no arguments, and the group and ungroup rows close
the menu like the others do.

**Where** `frontend/src/components/canvas/canvas-context-menu.tsx` (`canDelete`, the delete row and its divider,
`MenuButton`'s click), `frontend/src/pages/canvas/project.tsx` (`canDelete={contextMenuNode?.type !==
CanvasNodeType.Group}`, the group/ungroup rows closing the menu).


## 335. A card leaves a group by leaving the box, not by a menu item

**Decision** Ungroup exists for **groups only**. The menu row, the selection bar's button and the agent's
`ungroup_nodes` all take a group and dissolve it; a member is never released in place. Asked to do it anyway,
`ungroup_nodes` answers where the card stands, that belonging is decided by where it stands, and that it comes out
by being moved outside the box. `canUngroupSelectedNodes` is "the selection holds a group", and
`applyUngroupSelection` dissolves groups and lets their members out — nothing else.

**Why** Because membership is geometry, at the end of every move: `findContainingGroupId` reads the boxes and the
card's centre, and a card standing inside a box joins it again (#308). So "released, but still standing in the
box" is a state the drawing cannot show: the card looks like it is in the group and is not, until somebody nudges
it. Two states that look identical and behave differently is the worst kind of state to keep, and the user said it
plainly: "不要让它看上去好像在组里，其实不在组里 —— 这是个非常糟糕的设计".

**Cost** Taking one card out of a group is a drag, not a menu row: pick it up and put it down outside the box. That
gesture is what the canvas already reads (#308), so nothing new has to be learnt — but the discoverable version of
the act is gone, and a canvas saved before this change may still hold a member whose card sits outside its box
(the data model allows it; the UI just no longer creates it).

**Rejected** Ungrouping a member *and* moving it out of the box in the same press: a verb that silently relocates
what it acts on is a worse surprise than a drag the user did not think of. Also rejected: keeping the row and
showing it greyed when the card is loose — the row was only ever meaningful for a card in a group, and a permanently
greyed or conditionally appearing row is what raised the question in the first place ("有的没有，有的有，怎么回事啊").

**Tested** `frontend/tests/canvas-node-geometry.test.ts`: a member on its own, and a selection of members with no
group among them, are not a group to dissolve (`applyUngroupSelection` returns null); `canUngroupSelectedNodes` is
true for a group, false for a member, false for a loose node; dissolving still lets every member out where it
stands. `frontend/tests/canvas-agent-tools.test.ts`: `ungroup_nodes` on a member is refused with "inside group-1 …
move it outside the box", and nothing is written to the canvas. In the browser against the running server, on a
throwaway canvas (deleted afterwards, `lastCanvas` put back): a member's menu read Info / Download / Duplicate /
Delete with no Ungroup, the group card's menu read Info / Duplicate / Ungroup, and dissolving it removed the box,
left both pictures where they stood, selected, with no `groupId` in the saved document. `npx vitest run` (597),
`npx tsc --noEmit`, `npm run check` (830/797 keys, 187 modules), `npm run build` (577.65 kB).

**Where** `frontend/src/lib/canvas/canvas-node-geometry.ts` (`canUngroupSelectedNodes`, `applyUngroupSelection`),
`frontend/src/lib/canvas/canvas-agent-tools.ts` (`ungroupNodes`, and the sentence `group_nodes` gives when the set
is already one group), `frontend/src/pages/canvas/project.tsx` (`ungroupNodes`' doc), its two test files.


## 336. A sweep after #335: a gate left red, and five sentences that promised a call the canvas refuses

**Decision** Six things fixed in one pass, all of them the same shape — something still *said* what the code no
longer does. (1) `npm run check` was red at #335: a template literal in `canvas-agent-tools.ts` ran past the
formatter's 255 columns, so `format:check` failed and `tsc` was never reached. (2) The MCP `ungroup_nodes`
description still offered "name a node and it leaves the group it is in", which #335 refuses — the description and
its argument now say a group to dissolve, and the agent's own rule says a card leaves by being moved out of the
box. (3) `capture_frame` called the frame grabs "the card's own menu": they are a button on its bar since #333.
(4) `create_node`'s schema did not list `group` among its types, though the canvas makes one — the create menu
offers it, `CREATE_TYPES` accepts it, a test makes one — and the same description explained how. (5) A text card's
bar reads "Smaller" / "Larger", which are words about zoom: since #332 the labels are always on, so the words are
the button, and a font button that says 缩小 is a button that lies about what it does. It reads 减小字号 /
增大字号 now, and the two `zoomOut`/`zoomIn` keys under `nodeToolbar` are gone (the editors' own zoom keeps its
pair). (6) The bar's dead machinery: `extraTools` (a prop no caller passes), `CanvasNodeToolbarItem` (a second,
unused button shape with a `danger` field nothing renders), `active` (a class no definition ever sets) and
`resolveToolText`'s string branch (every definition is a thunk).

**Why** A description is the only thing the model reads before it calls, so a sentence that contradicts the code
costs a failed call and a retry that works around a refusal that is correct; the same is true of a label on a
button, which is the only thing a person reads before pressing. The dead machinery is the project's own rule
stated in `types/canvas-node.ts` — "a flag nothing sets is a branch nothing takes" — found false in the file next
to it. And a gate that is red at HEAD is worse than no gate: the next reader is told the code is checked.

**Cost** One more rule to keep: the words on the bar are read as the command, so a reused key (`zoomOut`) that
happens to fit the tooltip does not fit the label. Nothing was reflowed or restructured; the sweep touched six
files and deleted two exported names.

**Rejected** Leaving the tool descriptions to the next change that touches the same behaviour. They were already a
release behind twice: #333 moved the frame grabs and left `capture_frame` pointing at the menu, #335 changed what
`ungroup_nodes` accepts and left two descriptions promising the old call. The stale sentence is invisible to every
gate this project has — no compiler, no test, no i18n check reads English prose a model is told — so the only
place it gets caught is a reader looking for exactly this. Also rejected: keeping `zoomOut`/`zoomIn` and passing a
longer `title`; the label is what the button says.

**Tested** `internal/server/mcp_test.go` (`TestToolsDescribeWhatTheCanvasAccepts`): `ungroup_nodes` says
"dissolve" and no longer says "it leaves the group it is in" or "the nodes to take out of theirs", and
`create_node`'s enum is exactly image / video / audio / text / group. `frontend/tests/canvas-image-toolbar-tools.test.ts`:
a picture's bar is crop, split, upscale, angle, view in that order, each with a label and a longer title, and each
button calls its own handler and no other. `frontend/tests/settings-dead-keys.test.ts`: a stored preferences
document loses the key #332 orphaned and keeps every other key — see the paragraph below. In the browser against
the running server, on a throwaway canvas (deleted afterwards, `lastCanvas` put back): a text card's bar read
减小字号 / 增大字号, and pressing 增大字号 took its text from 14px to 16px; a picture's bar read Crop / Split /
Upscale / Multi-angle / View image, and Crop opened the crop dialog; in English the text card read Decrease font
size / Increase font size. `npx vitest run` (602 in 52 files), `npx tsc --noEmit`, `npm run check` (828/797 keys,
187 modules), `npm run build` (577.62 kB), `make check` (504 exported declarations, all reachable).

**Where** `frontend/src/lib/canvas/canvas-agent-tools.ts` (the wrapped return), `internal/server/routes_mcp.go`
(`ungroup_nodes`, `capture_frame`, `create_node`'s enum and its description), `internal/server/agent_instructions.go`
(the group paragraph), `frontend/src/components/canvas/canvas-node-toolbar.tsx` (the two font labels, the
`active` class, `extraTools`), `frontend/src/components/canvas/canvas-image-toolbar-tools.tsx` (the definition type,
`buildImageToolbarTools`), `frontend/src/types/canvas-node.ts` (`CanvasNodeToolbarItem` gone), the two dictionaries,
and the four tests named above.

### A number nothing answers to, and the gate that now reads them

Three files cited `#312` for the decision behind `list_models` and `describeModelCatalogs`; `#312`'s own commit
never wrote the entry, and the doc has no `## 312.` heading. Two comments cited entries the doc had deleted — correctly, since both subjects are gone, but the sentence that pointed at them stayed.
A reader following any of the five numbers finds nothing, and that is worse than a sentence without a number:
it reads like the rule is recorded somewhere they have not found. `#312` is written now, from the commit that
made the decision and the code that still follows it; the two historical citations lost their numbers, since
the sentence already says the thing is gone. And `npm run check:decisions` (`scripts/check-decisions.cjs`,
third in `npm run check`) fails on the fifth one: it reads every `#N` written **in prose** — a comment, or a
line of Markdown — and requires an entry. A `#` in code is not a citation, which is also what keeps hex colours
out of it: this tree writes them in strings, never in comments.

**Where** `docs/decisions.md` (#312, #41), `frontend/scripts/check-decisions.cjs`, `frontend/package.json`,
`frontend/src/components/canvas/canvas-refresh-shell.tsx`, `frontend/tests/overlay-z-index.test.ts`.

### The same sweep, in the two places a document can go stale

Two leftovers of the same kind, both in documents rather than in code:

- **A preference nothing reads.** `canvas-image-quick-tools-v8` was which tools a picture's bar showed; #332
  deleted the reader and the writer and left the key in the workspace's settings, where it outlives the build
  that made it. `use-settings-store.ts` now drops it as a document is read — the bootstrap and the HTTP fallback
  both — the way the config store already drops the address of the old single speech server (#252). The next
  write persists the pruned document.
- **A route in no table.** `POST /api/canvases/{id}/join` landed in #324 and neither `docs/server.md` nor
  `docs/protocol.md` listed it, while both claim to be complete ("every one of them is served today"). Both have
  the row now, and `protocol.md`'s opening claim — "every tool action submits a run" — says what it always meant:
  every action a model can be asked for does, except joining clips (a mux) and taking a frame (a draw in the page).

**Where** `frontend/src/stores/use-settings-store.ts` (`DEAD_SETTINGS`, `withoutDeadSettings`),
`frontend/tests/settings-dead-keys.test.ts`, `docs/server.md`, `docs/protocol.md`.


## 337. One table for a node's first size, and one lookup over it

**Decision** `NODE_SPECS` in `constant/canvas.ts` is the only place a built-in node's starting size and starting
metadata are written. Two things that used to sit beside it are derived or gone: `NODE_DEFAULT_SIZE` is computed
from the specs (`satisfies` kept the completeness check, the test below keeps it honest), and the second
`getNodeSpec` in `node-registry.ts` — with its `FALLBACK_SPEC` — is deleted.

**Why** The two lookups could not disagree, and that was the problem: the registry's read the registered
definitions, which are built from this table, so its answer was always the table's answer with a step in
between. A reader had to open both files to learn that, and the next person to change a size had two functions to
check. The sizes were also written down twice in one file, in two tables with the same numbers.

**Cost** A type this build does not have now gets a neutral spec from a constant beside the table
(`UNKNOWN_NODE_SPEC`, an empty 340×240 card) instead of the registry's fallback. That is the same card; it just
lives where the table does. The registry keeps the one job it is good at — what a type *is* — and no longer
answers what size it starts at.

**Tested** `frontend/tests/node-specs.test.ts`: every type in `CanvasNodeType` has a card and a starting metadata,
the size table equals the specs it was derived from, a text card starts with a font size, and an unknown type
still answers with a card that can be clicked. `npx vitest run` (612), `npx tsc --noEmit`, `npm run check`.

**Where** `frontend/src/constant/canvas.ts`, `frontend/src/lib/canvas/node-registry.ts`,
`frontend/tests/node-specs.test.ts`.


## 338. The bar over the canvas is one pill and one button, and it is the selected card's

**Decision** `components/canvas/canvas-bar.tsx` holds the two things every canvas bar is made of: `CanvasBar` (the
white 48-pixel pill, `z-[45]`, which stops a press from reaching the board) and `CanvasBarButton` (a labelled
button with the tooltip whose four props were identical in both copies, plus the popover for a button that has
choices). Both bars use them: the one over a selected card and the one over a selection of several. The card's bar
is `canvas-node-toolbar.tsx` (`CanvasNodeToolbar`) and no longer claims to be a hover bar; the Info dialog that
shared its file moved to `canvas-node-info-modal.tsx`.

**Why** The two bars were the same object written out twice — radius, border, shadow, hover background, the
tooltip's colour and type — and a verb added to either meant copying the button again. The name was the second
half of the same problem: the bar has been drawn for the *selected* card since the verbs became the card's own
(#332), and a file called "hover" tells the next reader it appears under the pointer. One pill, one button, two
callers, and a file name that matches what is in it.

**Cost** `data-node-toolbar` — which `project.tsx` measures to frame a card that has a bar above it — is a prop on
`CanvasBar` rather than an attribute written where the bar is built. And the Info dialog is a module of its own,
which is one more file for something that is not a bar.

**Rejected** Leaving the two in place and sharing only the class strings through a constant: the button is where
the behaviour is (the popover's capture-phase dismissal, the `aria-haspopup` pair), and a shared string would have
left two of those to keep in step.

**Tested** In the browser against the running server, on a throwaway canvas (deleted afterwards, `lastCanvas` put
back): a selected picture's bar read Crop / Split / Upscale / Multi-angle / View image and Crop opened the crop
dialog; a text card's bar read 减小字号 / 增大字号 and the increase button took its text from 14px to 16px; the
selection bar's Group still wrapped two cards. `npx vitest run` (612), `npx tsc --noEmit`, `npm run check` (828/795
keys, 189 modules).

**Where** `frontend/src/components/canvas/canvas-bar.tsx`,
`frontend/src/components/canvas/canvas-node-toolbar.tsx` (was `canvas-node-toolbar.tsx`),
`frontend/src/components/canvas/canvas-node-info-modal.tsx` (new, moved out of it),
`frontend/src/components/canvas/canvas-selection-toolbar.tsx`, `frontend/src/pages/canvas/project.tsx` (two
imports).


## 339. A drag settles membership one card at a time

**Decision** One rule decides who belongs to what after a move: `settleMoveMembership`, called by the drag and by
`move_node` alike. A card carried by its own group keeps that group; any other card is judged by where its own
centre landed. The drag no longer has a second rule. `findGroupDropTarget` and `snapNodesIntoGroup` are deleted,
and the box that lights up while the pointer moves is computed by `movingIntoGroupIds` from the same function, so
it cannot promise something the drop does not do.

**Why** The two rules answered the same question differently. `settleMoveMembership` was per card; the drag's
drop-target path was per *gesture* — one group for the whole drag, chosen as the last group any moving card's
centre fell in — and it then assigned every moving card to it and snapped the lot into that box. Two loose cards
dragged at once, one landing on group A and one on group B, therefore both joined B; dragging them one at a time
put one in each. The answer to "where does this card belong" depended on whether the pointer happened to be over a
box, which is not a rule anyone could state.

**Cost** A card dropped on a group is no longer pulled inside its rectangle: it stays where it was released, which
can be half over the edge. That is what a member outside its card already was (#290), and the alternative was
moving a card the person had just placed. The highlight is now a set of groups rather than one id, compared by
content so a drag frame that changes nothing does not re-render the board.

**Tested** `frontend/tests/canvas-node-geometry.test.ts`: one drag of two cards over two groups puts each in the
group it landed in; the highlight names exactly those two groups, and names none when a card lands on bare canvas.
The existing move cases (a group keeps its members, a member outside its box keeps it, a member dragged out
leaves, a loose card dropped on a card joins) are unchanged and still pass. In the browser: dragging a selected
card over a group highlights that group and dropping it there makes it a member (the `groupId` is in the saved
document). `npx vitest run` (612), `npx tsc --noEmit`.

**Where** `frontend/src/lib/canvas/canvas-node-geometry.ts` (`settleMoveMembership`, `movingIntoGroupIds`),
`frontend/src/pages/canvas/project.tsx` (`finishNodeDrag`, the per-frame highlight, `dropTargetGroupIds`),
`frontend/tests/canvas-node-geometry.test.ts`.


## 340. A save is a write only when the document changed

**Decision** The save queue remembers the document it last wrote, per canvas, and a flush that would send the same
one does nothing: no request, no new `rev`, no `updatedAt`. `noteOnDisk(id)` is what primes that memory when a
canvas is opened, created or imported — what a load produced is on disk by definition.

**Why** Opening a canvas saved it. Loading builds a new `nodes` array (hydration resolves media references), the
page reads any change of that array as an edit, and the queue wrote the document back — so `rev`, the number two
tabs compare to notice each other's work (#158), moved every time a canvas was merely looked at, and `updatedAt`,
which orders the canvas list, turned into "when did you last open this". The canvas that was opened saved itself
in the same second it was read, with identical bytes.

**Cost** A migration that only touches the in-memory document — `adoptLegacyRunIds` rewriting the three old run-id
fields — is no longer persisted by the act of opening. It is applied on every read, so nothing behaves
differently, but the file keeps the old shape until the next real edit. The fingerprint is a `JSON.stringify` per
flush, which is the serialisation the request would do anyway.

**Rejected** Comparing revisions from the server instead: the question is "is what is in memory what is on disk",
and the server's `rev` answers a different one — it also moves when another tab writes.

**Tested** `frontend/tests/canvas-save-queue.test.ts`: the document a load produced is not written back; an edit
after the load is written once, and the same document again is not a second write; a rename is a change even when
the document is untouched; a forgotten canvas is written from scratch next time. `npx vitest run` (612),
`npx tsc --noEmit`.

**Where** `frontend/src/lib/canvas/save-queue.ts` (`written`, `fingerprint`, `noteOnDisk`),
`frontend/src/stores/canvas/use-canvas-store.ts` (`loadCanvas`, `createCanvas`, `importCanvas`),
`frontend/tests/canvas-save-queue.test.ts`.


## 341. The record says what is true now: seven entries out, and a gate that reads citations

**Decision** Seven entries whose subject is gone left the record: SeedVR2 (a video upscaler nothing here
maintains), the no-VDN workflows, the `catalogue.json` rename that the next entry corrected, the
`infinite-canvas/` → `canvas/` move, the plugin SDK's name, the third-party agent plugin, and the browser storage
keys from before the preferences moved to the server. What replaced them is the code, which no longer contains any
of it. Two entries were rewritten rather than kept as
removal narratives: #44 lost a paragraph about `handleRetryNode`, and #45 stopped being "Retry joins the
generation module" — it now states the seam it was really about, "the page owns the canvas, the module owns
generation", because retry itself is gone and #234 records why it must not come back. Three corrections of fact:
#80 no longer describes the nameless `/api/agent/once` route (gone since #83), #129 no longer cites the entry it
superseded, and the licence path is `frontend/LICENSE`. Two entries still said "gateway" in present-tense prose
(#241, #258); the word is history. And about thirty citations inside the record pointed at entries that had been
deleted — thirteen of them before this pass — which are rewritten to say the thing instead of naming a number that
no longer exists.

**Why** The file's own rule is that an entry records a rule that is true now, and that a removed subject takes its
entry with it. A tombstone reads like a constraint: "SeedVR2 is gone, and do not answer 'find a better one' with
these two packs" is a paragraph a future design negotiates with, about conditions that no longer apply. The rule is
right; the record was not following it, and nothing was checking whether a citation still pointed anywhere. That
is the same failure the rest of this sweep is about — a sentence that claims something a reader can no longer
find — one layer up, in the document that is supposed to be the answer.

**Cost** Seven numbers now have holes, and a hole is only acceptable because nothing cites it: `check:decisions` reads the record as well as the code, so an entry that
quotes a number with no entry fails the gate. The pass was judgement, not a script: of 306 entries, the eight
candidates checked by hand were the ones whose *subject* — not whose paths — was verifiably absent, and the rest
were left alone. A later pass with the same method will find more; the gate does not force the judgement, it only
keeps the result honest.

**Rejected** Renumbering to close the holes. Numbers are addresses — 53 code comments, tests and other entries
cite them — and a shifting numbering would break every citation to save a reader the sight of a gap. Also rejected:
keeping a short "was removed" line for each of the seven. That is the tombstone, in one sentence instead of five.

**Tested** `node frontend/scripts/check-decisions.cjs` passes on the record and the tree (313 entries, every
prose citation answers to one), and fails when a comment is planted that cites a number the record does not
have. `make check`,
`npm run check`, `npx vitest run` (612). `docs/known-issues.md` carries a fresh "last verified" marker: its one
entry (RIFE on a silent clip) was re-checked against `workflows/video-rife.json` at `94498f4`, where
`VHS_VideoCombine.audio` is still `["1", 2]`.

**Where** `docs/decisions.md`, `docs/known-issues.md`, `frontend/scripts/check-decisions.cjs` (it now reads the
record too), `frontend/package.json` (`check:decisions` in `check`).


## 342. The wait is the turn's, and the agent is the one who says it began

**Decision** `Working… Ns` counts the turn in flight, and a turn is what the agent says it is. AlayaCore
broadcasts the task as running in `beginTask`, before the work starts, and as over in `handleTaskDone`, when the
task goroutine has returned; `turnStep` now reports which of the two a frame was — `turnBegan`, `turnEnded`, or
neither — and the pump records or clears the turn in wire order. The session holds `busy` beside the instant the
turn began, one guarded pair, and `Send` records nothing: what the agent accepts is a turn, what it refuses never
becomes one. The `turn` frame on connect states `running` with `elapsedMs`, the age of the turn when the frame was
written. The panel reads that into an instant on its own clock (`turnStartedAt(elapsedMs, now)`), sets the instant
where a turn begins for it — the send — and where it joins one — the frame — and derives the number from it once a
second. The flag and the instant are one piece of state (`turn: {startedAt} | null`), and an error the agent answers
a message with clears it, because a message it could not take never becomes a task. **Amends #289.**

**Why** The row exists to tell an agent that is thinking from a panel that is hung (#289), and the number in it was
the one thing on the panel that a reload destroyed: the interval took `Date.now()` when the row appeared, so a page
reopened three minutes into a silent turn showed `Working… 0s` — the exact state the number is there to rule out,
with its evidence erased. The window is not a corner case: `agentIsWorking` asks about *text*, so a turn that is only
reasoning keeps the row for as long as the model thinks, which is the longest silence a turn has. Nor can the page
remember the start itself: the turn belongs to the session, outlives the socket that started it, and is already the
subject of the `turn` frame — so a refresh, a second tab, a panel closed and reopened, and a reader on another
machine are one case and not four.

#289's premise was narrower than it read. The agent's `ttft_ms` does arrive with the step that *ends* the wait, so
the agent cannot supply a count that is still running; but the session wrote the prompt and is still there
afterwards, so "when did this turn begin" is a fact it has and the page does not. The tick stays on this side
because that is all it is — one subtraction, re-rendering the row.

**Why the session does not keep its own opinion** The `task` frame is the only thing that knows. In AlayaCore,
`handleInputFrame` stages content items — text, a picture, a film — and `UE` sends what is staged as one message, so
whether a message has words is not part of "is this a message"; `submitPrompt` starts a task, steers the running one,
or refuses; `beginTask` announces the running state itself ("the frame is required, not decorative"); and
`runTaskNormal` defers its result, so `handleTaskDone` announces the end of **every** accepted task, an error
included. A refused message gets an `SM error` and neither frame. Two bugs lived in the gap between that and a
session that guessed: `Send` decided "a turn" on `req.Prompt != ""` while `writeRequest` wrote on `HasPrompt`, so a
picture with no words was written and not recorded, and a prompt of spaces was recorded with nothing written — a turn
no frame could ever end, `busy` for the life of the process and a delete route that refuses forever. And a turn
recorded *after* its frames were written could have the agent's `done` land before the flag it was meant to clear,
leaving the same permanent `busy`. Both are gone because nothing is inferred: `HasPrompt` decides only what is
written, and both ends arrive from the agent, in one goroutine, in order.

**Cost** One field on a frame that already exists, one guarded pair in `Session`, one subtraction in the panel. The
flag now follows the write by one round trip through the agent rather than being set in the same call, so a delete
arriving between a prompt and the task-start frame is still possible — a window no bookkeeping on this side could
close, answered by the agent, which is who the route was asking. The page's row is still the page's ("since I sent")
until a `done`, an error or a reload, so a task started by a command — `:continue`, `:summarize` — has no row though
the session knows it is running; that is #289's rule and it did not change. `turnStep` loses its `hasPrompt`
parameter: the only caller always passed `true`, and a command's answer no longer ends anything. And the age travels
as a duration rather than the instant it began, for a reason that costs the field its intuitive shape: the two sides
can be two machines, and a turn is exactly as long on a clock that differs from the browser's by two minutes.

**Rejected** Marking the turn where the prompt is written, which is what this entry did at first: it answers "is a
turn running" with a guess, and every case the guess gets wrong — a picture with no words, a prompt of spaces, a
refusal, a task a command started — has to be paid for separately, and was. Ticking on the server: a frame a second
on the channel that carries the conversation, to say something the page can derive from a start it already has.
Sending the instant the turn began instead of its age: two clocks, and `time.Since` on the session's monotonic clock
and `performance.now()` in the page are each immune to their own machine's clock being adjusted, which a wall-clock
instant and a subtraction across two machines are not. Remembering the start in the page (`localStorage`, the store):
the page is what went away, and the turn may have been started by a tab that is gone.

**Tested** Go: `TestAnImageOnlyMessageIsATurn` — a `UX` picture and its `UE` make a task the session sees running
while the model is looking at it, and idle when it ends; `TestAMessageTheAgentRefusesIsNoTurn` — an `SM error` with
no task frames leaves the session idle, which is the case a recorded turn would have left busy forever;
`TestAWhitespaceOnlyMessageIsNoTurn` — nothing is written and nothing is a turn. `TestAReloadInTheMiddleOfATurnKeepsIt`
and `TestASocketGoingAwayKeepsTheAgent` still state the turn from the connect frame, now off the agent's task frames,
and `internal/agent` and `internal/server` pass in full. Frontend: `frontend/tests/agent-transcript.test.ts`
(`turnStartedAt`: an age of twelve seconds read against this page's clock is a start twelve seconds ago and not now;
an absent field and a zero one both mean "began here"; an age below zero is no age). In the browser, on an isolated
server on `:8195` whose agent is a fake speaking AlayaCore's wire and answering ninety seconds late: pressing Enter
produced `Working… 2s` in the same observation as the user's own message, and `10s` eight seconds later; three
seconds after a reload — a page that had existed for three seconds — it read `13s`, and `17s` four seconds after
that, so the count continued instead of restarting at zero. At `21s` a second message was sent into the running turn
and read `24s` two seconds later, so a queued message does not restart it. And a message the fake refused showed the
agent's error with **no row at all**, the "Clear history" button back to its idle label — the panel and the session
agreeing that nothing is running. `go test ./internal/...`, `make check` (gofmt, vet, deadcode), `npm run check`
(i18n, exports, decisions, prettier, `tsc`), `npx vitest run`, `npm run build` (576.91 kB). The panel's arithmetic
has no automated test of its own — there is no DOM harness in this tree — so that wiring rests on the browser
observation and on `turnStartedAt`'s three cases.

**Where** `internal/agent/run.go` (`turnChange`, `turnStep`), `internal/agent/sessions.go` (`Send`, `beginTurn`,
`endTurn`, `Turn`, the pump's switch), `internal/agent/events.go` (`ElapsedMs` on `turn`),
`internal/server/routes_agent.go` (the frame), `internal/server/agent_e2e_test.go`, `internal/agent/session_test.go`
(the fake agent's task frames and the three tests), `frontend/src/lib/canvas/agent-transcript.ts` (`turnStartedAt`),
`frontend/src/components/canvas/canvas-agent-panel.tsx` (the `turn` state, the tick, the error branch),
`frontend/src/services/api/agent.ts`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts` (`canvas.agent.workingHint` — it
said the seconds were counted here), `frontend/tests/agent-transcript.test.ts`.

## 343. The gateway sends and echoes; what it keeps is what the agent cannot say twice

**Decision** AlayaCore is a mature agent, so `internal/agent` is a relay with a mailbox. A message goes out as
the wire's own content items and a flush (`UX`…, `UE`), and what comes back is relayed as the frames it arrived
as — no translation of a message into "a turn started", no summary of a step into a status. The state this side
may hold is of exactly two kinds: (1) what the agent has said and will not say again — the conversation's frames
(`transcript`: a process replays its session file only when it starts, and says the rest once), its startup
broadcast and its later statements about itself (`startup`: models, active model, level, usage), and the raw model
entries `model_sync` has to round-trip because a canvas cannot see their keys; (2) routing for one socket or one
tool call (`sink`, `watchGeneration`, `pending`). Everything else is a fact the agent owns, and the session reads
it off the frame that says it: the turn in flight off `task` (#342), the model list off `model_list`, a failure off
`error`. The session may *timestamp* what the agent announced — the age of a turn is its own measurement of an
announcement — but it may not decide what the announcement would have been.

**The test, for the next thing** Two questions, in order: does the agent say it, and will it say it again? Said and
repeatable — keep nothing, ask again. Said once — cache it, and write down why it cannot be said twice. Not said —
then it is not available, and the answer is a frame or a field on one (as `elapsedMs` is for the age of a turn), not
a value this side computes because it seemed equivalent.

**Why** A duplicate of the agent's state is a second truth that only the agent can correct, and the correction is
invisible until it is wrong. `busy` meant "we wrote a prompt, so a turn is running", and it was wrong about a
message of pictures and no words, a message of spaces, a message the agent refused, and a task a command started —
four cases, each found and paid for separately before the flag was made to follow the agent's own frame (#342).
None of those cases was hard; what was hard was that a local guess has no failure signal of its own. The same rule
says where a missing capability belongs: a page that wants to know something the wire does not carry is asking for
a frame, not for a timer.

**Cost** The canvas cannot be optimistic about the agent's *state*, only about its own: the working row is drawn
from the send (#289) while the session's flag waits for the task frame, one round trip later. And the gateway has
one fewer place to put a convenience — a field on a frame, a comment beside a `switch`, or nothing.

**Rejected** Mirroring the agent's state so a page need not ask: what `startup` does is cache statements, and a
model of the agent is a different thing — it is what `busy` was. A heartbeat, so the page can learn what it can
already derive (#342). A timer to end a turn the agent has not ended: only the agent can end a turn, and if it does
not, the answer is to find out why rather than to guess on its behalf.

**Where** `internal/agent/{sessions,run,history,events,spawn}.go`; the rule made concrete in #342; and the
architecture note in `docs/server.md` that states it for the next reader.

## 344. The record's pointers point at files that exist

**Decision** A pass over the record and the four prose documents. Six entries whose subject is verifiably gone
left: the model call scripts, the persisted stores' recovery and their version, the prompt route, the bundled VAE
payload — and the three sentences that cited them now say the thing instead of naming a number. Every file pointer in a `**Where**` section was then resolved against the tree:
seventy-two occurrences of sixteen names were pointed at today's files (`routes_video.go` →
`routes_generation.go`, `resources/index.json` → `resources.json`, `gateway-*` → `server-*`,
`use-local-gateway-sync.ts` → `use-local-server-sync.ts`, the hover toolbar → the node toolbar,
`canvas-node-super-resolve-dialog.tsx` → the tool node panel), forty paths still written in the old shorthand
(`canvas/web/src/…`, `components/…`, a bare `agent-transcript.ts`) were rewritten to the file they name today, and
seventeen `Where` lists were corrected by hand: `postprocess.go`, `catalogue.go`, `node-title.ts`,
`canvas-manager-dialog.tsx` and `prompts.ts` are gone, so the entries that named them no longer do.

**What is deliberately not touched** An entry that records a *removal* names where the thing was: `canvas/plugins/**`
in #148, `resources/payload/**` in #117, `stores/use-storage-recovery-store.ts` in #46's prose. Rewriting those to
today's paths would make the sentence describe the wrong moment, and deleting them would lose the only record of
what was taken out and why. Prose keeps its old names wherever it is describing an old state; only the pointers are
held to the tree. What is not allowed is a *live* entry pointing at a file that is not there, and after this pass
none does: every pointer that begins in this tree's layout (`internal/`, `frontend/`, `cmd/`, `workflows/`,
`tools/`, `scripts/`, `docs/`) resolves to something that exists, checked with brace and glob expansion
(`internal/workflow/{inputs,bindings}.go`, `frontend/src/i18n/locales/*.ts`).

**Why** A pointer a reader follows to nothing is worse than no pointer at all: it reads as "the rule is recorded
somewhere and this file has moved", so the reader goes looking for a rule instead of reading the one in front of
them. A `Where` is the one part of an entry that makes a claim about the *tree*, and it is the part that rots
silently — no gate sees a path.

**Cost** Six numbers are now holes, which is acceptable only because nothing cites them: `check:decisions` reads the record as well as the code. The pass was a script plus judgement: the script
resolved what was mechanically resolvable, and each of the six entries was checked by hand against the tree — its
subject had no file, symbol or endpoint left.

**Rejected** Renumbering to close the holes: numbers are addresses, and sixty-odd citations would break to save a
reader the sight of a gap (#341). Deleting every entry whose `Where` names a path that is gone: in a removal entry
that path is the subject. A gate for `Where` paths: it would need waivers for AlayaCore's own `internal/…` files
(two entries cite them) and for runtime directories (`canvas.json`, `mcp.conf`, `model.conf`), and a gate that a
later reader switches off is worse than the pass it replaces. `check:decisions` keeps the citations honest, and
this entry keeps the rule for the pointers.

**Tested** `node frontend/scripts/check-decisions.cjs` (308 entries, every `#N` cited in prose answers to one),
`npm run check`, `make check`, `npx vitest run` (618), `npm run build` (576.91 kB). The pass's last check was run
against the result: no pointer in a current-layout `Where` fails to resolve with braces and globs expanded, and the
six removed numbers are cited by nothing.

**Where** `docs/decisions.md`, `docs/server.md`.

## 345. The queue is counted once, where the page cannot lose it

**Decision** The size of the agent's steering queue is counted by the session, from the agent's own phases — one
`queued` per message taken into the queue, and `delivered`, `dropped` or `refused` ending that submission — and it
is *stated* rather than recounted: every `steering` event carries the count, and the `turn` frame carries it too, so
a page that connects joins the number instead of starting at zero. The panel keeps no tally: `steering` and `turn`
both set it from the event's `queued`.

**Why** The page counted — `+1` on `queued`, anything else `0`, and `0` on every `history`, which is every
connection. So a reload mid-turn showed `Working… 90s` with no "(2 queued, …)" while the agent still held the
messages, and reopening the panel or a second tab did the same; the only reason it was not noticed sooner is that a
queue is usually short-lived. It is the fault #342 fixed one fact over: a number about the turn, kept by the page,
and lost exactly when the page goes away. The agent states each phase and never the size, so the size is this side's
*measurement of announcements* — the kind #343 allows, as the age of a turn is — and it belongs where the
announcements are read, which is the pump.

**Cost** One field on two events, one int under the turn's lock, and a closure in the pump so the session learns
what it relays. A phase this build has not met is read as terminal: if AlayaCore grows a phase that does not end a
submission, the count under-reports until this code learns it — the safe direction, because the next `queued`
restates it, and a queue nobody can see is worse than a number that is behind.

**Rejected** Seeding the page's tally from the frame and letting it count the rest: two counters, and the one that
drifts is the one on screen. Deriving the size from the transcript: the agent echoes a queued message only when it
is spliced, so a message in the queue has no echo by definition. A frame of its own for the queue: `steering`
already exists and already carries the phase, and the size is one field on it and on `turn`.

**Tested** `internal/agent/session_test.go` (`TestTheQueueIsCountedOnceAndStated`: two `queued` phases make the
events state 1 and then 2, the session holds the same, and `delivered` states none).
`internal/server/agent_e2e_test.go`: `TestAReloadInTheMiddleOfATurnKeepsIt` — a socket that reconnects a second
into a turn with a message queued is told `queued: 1` along with the age; `TestASocketGoingAwayKeepsTheAgent` — an
idle turn states no queue. In the browser, on an isolated server on `:8195` whose agent queues a message into a
ninety-second turn: pressing Enter showed `Working… 3s (1 queued, used together after the current step)`, and `5s`
before a reload; three seconds after the reload — a page that had existed for three seconds — it read `Working… 8s
(1 queued, used together after the current step)`. Both the age and the queue survived, which is what the page's
own tally could not do.

**Where** `internal/agent/events.go` (`Queued`), `internal/agent/sessions.go` (`queued`, `noteSteering`, `Queued`,
the pump's emit), `internal/server/routes_agent.go` (the connect frame), `internal/agent/session_test.go`,
`internal/server/agent_e2e_test.go`, `frontend/src/services/api/agent.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx` (the `steering` and `turn` branches).


## 346. The count the agent restates is the count a page that comes back is shown

**Decision** Every `SM task` frame is written into the session's own `startup` state as well as relayed, so the
snapshot a new connection is given carries the count the agent last stated — the one it restored from the session
file at startup and then every restatement since, a summarize included. The `models` frame therefore carries the
last three numbers (`context_tokens`, `step_tps`, `ttft_ms`), not only the ones from startup.

**Why** A session outlives its socket (#100), so the `models` frame on a reconnect is a cache of what the agent
said about itself, and #343 says such a cache is written by the pump. It was written only by `waitReady`, at
spawn. The pump's `task` branch relayed the numbers and dropped them, which is invisible until something moves
the count down: auto-summarize does exactly that, by most of a conversation. The open page drew the drop
correctly, and then a reload put the old number back, and a `model_sync` in the settings window put it back on
every other canvas too — that restatement is published to every other session, so the same stale cache decided
their denominators. Restarting the server appeared to fix it because a new process reads the summarized file and
reports the small count in its startup broadcast; no page should have needed a restart to be told the truth.
`startup.usage` was the only field of the cached state that changed during a conversation and the only one the
pump did not write — `models`, `active` and `level` were already collected.

**Cost** One `state.collect` on a frame that already arrives a few times a step, under the lock the pump already
holds; the snapshot now moves mid-turn, which is what it is for. A page that reconnects mid-step is told the
count from the last step boundary rather than a fresher one — the agent has said nothing newer, and inventing a
number is what #343 forbids. The sentence in #224 that says `models` carries the count "when the agent restored a
count from a session file at startup" is superseded: it carries the last one stated.

**Tested** `internal/agent/session_test.go` (`TestSessionKeepsTheCountItRestates`): the fake agent reports 1500 at
startup and 9 by the end of a turn; a second `Connect` on the live session and a list restated through
`adoptModels` both carry 9/0/0 — the same three numbers as the `usage` event the page saw last, which is the
invariant. Before the fix both read 1500 — the reported bug, reproduced at the layer that caused it. Read end to
end against the real AlayaCore: the summarize path sets the count with `setContextTokensEvent`
(`session_task.go`), the task's end saves the compacted contents with that count (`session_loop.go`), and a new
process restores it (`session.go`) — so the restart that hid the bug is the same fact this fix stops depending on.

**Where** `internal/agent/run.go` (`turnStep`, `task`), `internal/agent/sessions.go` (`state`), `internal/agent/events.go`
(`Event.ContextTokens`), `internal/agent/session_test.go`, `docs/server.md`.


## 347. The limit a model holds is the list's, and the frame only says which model

**Decision** `startup.event()` fills the active model's `contextLimit` from the entry with the same id in the model
list, when the list holds one; `state.active` is left as the agent stated it, and a list that does not name the
active model leaves the stated limit standing.

**Why** The limit belongs to the entry, and the entry is what an editor rewrites: `model_sync` replaces
`model.conf`, the agent restates the list to every session, and the `model` frame is sent again only to the session
that did the sync (`SwitchModel`). Every other open canvas therefore held a copy of the old limit, and the panel
draws `22K/262144` with it — a denominator that is wrong until that session's own agent happens to restate `SM
model`, which for a canvas nobody switches a model on is never. Measured on the fake agent before the fix: with id
1 edited from 1000 to 5000, another session's snapshot still said 1000. It is the same fault as #346 one field
over — a copy of an agent fact that only one path wrote — and the same answer: derive it from the statement that
does arrive instead of keeping a second copy.

**Cost** One derived copy per event, and events are built on a connect and on a restated list rather than per
step. The list always states `context_limit` (`ModelInfo` has no `omitempty` on it, because it is the field an
editor edits), so the entry's value is taken as it stands rather than only when non-zero — a model edited down to
"no limit" says so instead of keeping the old number.

**Rejected** Refreshing `state.active` inside `adoptModels`: it fixes the one caller and leaves the copy for the
next path to remember — which is precisely how #346 happened. Clearing `active` and letting the page find its
model in the list: the session would lose the one fact only the `model` frame carries, which is *which* model it
is on.

**Tested** `internal/agent/startup_test.go` (`TestTheActiveModelsLimitIsTheLists`): 1000 from the frame, 5000 after
the list is restated, `state.active` still 1000 (the derived value is a copy), and a list without the active model
keeps the stated limit.

**Where** `internal/agent/events.go` (`startup.event`, `startup.activeModel`), `internal/agent/startup_test.go`,
`docs/server.md`.
