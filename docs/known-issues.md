# Known issues

Open problems, verified against the current tree — last verified at `94498f4`, so an entry older than the code
around it is worth re-checking before it is trusted. Each entry says what breaks, why, and what the fix is, so
nobody has to rediscover it. Only a defect belongs here: a fix, and the reason it was chosen, live in
[`decisions.md`](decisions.md), and an entry leaves this file the moment it stops being one.

---

## 1. Interpolating a silent clip fails inside VHS

**Symptom** `video-rife` fails with `VHS failed to extract audio` when the clip has no audio track.

**Cause** `VHS_VideoCombine.audio` is `["1", 2]`, the audio output of `VHS_LoadVideo`
(`workflows/video-rife.json`). A silent source leaves nothing there to combine. Both H3 graphs wire audio the
same way and always produce it, so this only bites an imported or trimmed clip.

**Fix to decide** Detach the audio input when the source has no audio stream, at the cost of never carrying
audio through the interpolation. The media plan is declared in `registry.json` (`video-rife`), so this is an
`accepts`/binding question rather than a code branch.

---

## 2. A tool confirmation would hang the canvas's turn

**Symptom** None today — the frame cannot arrive. If AlayaCore is ever started with `--tool-confirm`, it asks the
adapter to allow a tool call (`SM tool_confirm`) and waits for `:tool_confirm <id>` or `:tool_decline <id>`.
`internal/agent` neither relays the question nor sends either answer, so the turn would wait until it is
cancelled, with nothing on screen saying why.

**Cause** `SpawnOptions.args` passes no `--tool-confirm`, and AlayaCore has no config-file key for one — it is a
command-line flag only (`internal/config/config.go`, `--tool-confirm`) — so the confirmation set is empty and the
frame is never emitted. The canvas has no surface for the question either: it is the one thing the agent can ask
that needs a word back and is not a `tool` call the page can run.

**Fix to decide** Either answer it — a dialog in the panel, a message up the socket, and the
`:tool_confirm`/`:tool_decline` command down, the shape MCP's own confirmation already has — or refuse to start
when the flag is configured, so the gap is named at startup instead of found as a turn that never ends. The
second is the smaller change and the honest one while no surface exists to answer with.

---

## 3. A mode's media declaration swallows its family's

**Symptom** None in the shipped registry today, and that is why it is worth writing down: `image-qwen21` declares
nothing on the family, so nothing can be lost yet. The moment a family declares a kind its modes do not — a clip
limit on the base, an audio limit on the base — every mode of it loses that declaration.

**Cause** `mergeVariant` replaces the whole contract rather than the kinds a variant names
(`internal/workflow/registry.go`): `if variant.Accepts != nil { merged.Accepts = variant.Accepts }`. Qwen's four
modes each declare `images` and nothing else, so a family-level `videos: {"max": 0}` would vanish under all four
and a clip wired into an edit node would be accepted by `PlanMedia`, dropped by `applyArrayBinding` (which
truncates to `max`, and here has no socket to wire it into), and answered with a run that never read it — the
picture-silence of #348, one kind over, in a place a per-entry test cannot see.

**Fix to decide** Merge the contract a kind at a time, so an unnamed kind falls back to the family's — the
reading `mergeVariant`'s own comment describes ("a variant is a different graph, so it may declare a different
media/mode contract"), kept per field. The alternative is to make every variant restate every kind it means,
which is one more place per mode to forget; the derived test in `shipped_media_test.go` checks the effective
contract of each mode, so either answer is caught the day it is wrong.
