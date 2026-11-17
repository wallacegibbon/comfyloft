#!/usr/bin/env node
// A name a comment cites must answer to something: every `someName` written in backticks inside a comment has
// to be an identifier this tree actually has. `check:decisions` enforces the same rule for `#N` citations, and
// for the same reason: a reader follows the pointer and finds nothing, which is worse than no pointer at all.
//
// Why it is needed: comments here cite code the way prose cites a footnote — `withBoundMasks`, `showPanel`,
// `generationInputCandidates` — and code moves. One such citation was found the day this check was written: a
// comment in the prompt panel pointed at `nodeTakesPanel`, a function that never existed in this tree, for the
// rule #278 actually put in `showPanel`. Nothing else can see that: the compiler does not read comments, and
// `check:decisions` only looks at numbers.
//
// What counts: a **camelCase** name in backticks in a `//` or `/* */` comment. The shape is the whole point of
// the filter. This tree writes its own identifiers camelCase, and what a comment legitimately cites from
// outside is not camelCase — `AudioWorklet`, `QueryClientProvider`, `clsx`, `fmt.Stringer`, `image_files`,
// `--tool-confirm`, `util.NowIso`. Keeping those out is what lets the check run with no noise, and a check that
// cries wolf gets ignored, which is how #336's "five sentences that promised a call the canvas refuses"
// survived as long as it did.
//
// An identifier counts as present if it appears in *code* (not comments) of the frontend or the gateway, or as a
// key in the shipped workflow data: a comment in the frontend may cite a Go symbol (`util.NowIso`) or a
// registry key, and that is a real pointer. Dotted names are reduced to their last segment for the same reason.
//
// Usage: npm run check:comments   (exits non-zero, naming the file, the line and the name)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

/** Where a comment can live, and where an identifier can live. Both sides of the check. */
const CODE_DIRS = ["frontend/src", "frontend/tests", "internal", "cmd", "tools"];
const CODE_EXT = new Set([".ts", ".tsx", ".go"]);
const DATA_DIRS = ["workflows", "frontend/public"];
const DATA_EXT = new Set([".json"]);

/**
 * Citations that name something outside this tree, listed per file so the name is not excused anywhere
 * else. Each one is checked by hand, and each says what it names: an API a dependency really emits, a
 * dependency this app removed (the sentence is about why), or an AlayaCore symbol the frontend mirrors.
 */
const OUTSIDE = {
    "frontend/src/components/kit/field.tsx": ["getValueFromEvent", "valuePropName", "requiredMark"], // antd's Form.Item, removed with the dependency
    "frontend/src/components/kit/select.tsx": ["showSearch", "optionFilterProp"], // antd's Select, kept as the prop shape
    "frontend/src/components/kit/dialog.tsx": ["destroyOnHidden"], // antd's Modal prop, kept as the prop name
    "frontend/src/components/layout/app-providers.tsx": ["useQuery"], // react-query, which this tree says it never used
    "frontend/src/services/api/http.ts": ["readAxiosError", "onUploadProgress"], // axios and what each service file carried, all removed
    "frontend/tests/api-http.test.ts": ["readAxiosError"], // the same history, restated where the replacement is tested
    "frontend/src/stores/use-config-store.ts": ["channelMode"], // a field deleted with cloud mode; the sentence is about the deletion
    "frontend/src/lib/canvas/agent-usage.ts": ["formatTokenCount"], // AlayaCore's own formatter, mirrored on purpose
    "frontend/tests/agent-usage.test.ts": ["formatTokenCount"], // the same, named where the mirror is tested
    "frontend/src/lib/canvas/canvas-node-geometry.ts": ["snapNodesIntoGroup"], // a whole-gesture rule #339 deleted; the comment says it is gone
    "frontend/src/i18n/index.ts": ["languageChanged"], // i18next's own event, which use-settings-store really listens for
};

function walk(dir, extensions, out = []) {
    const skip = new Set(["node_modules", "dist", ".git", "canvases", "data", "bin"]);
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!skip.has(entry.name)) walk(path.join(dir, entry.name), extensions, out);
        } else if (extensions.has(path.extname(entry.name))) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

const files = (dirs, extensions) => dirs.flatMap((dir) => walk(path.join(ROOT, dir), extensions));

/** Every identifier that appears outside a comment, plus every key in the shipped data. */
function codeNames() {
    const names = new Set();
    for (const file of files(CODE_DIRS, CODE_EXT)) {
        const text = fs
            .readFileSync(file, "utf8")
            .replace(/\/\/[^\n]*/g, " ")
            .replace(/\/\*[\s\S]*?\*\//g, " ");
        for (const match of text.matchAll(/[A-Za-z_]\w*/g)) names.add(match[0]);
    }
    for (const file of files(DATA_DIRS, DATA_EXT)) {
        for (const match of fs.readFileSync(file, "utf8").matchAll(/"([A-Za-z_]\w*)"\s*:/g)) names.add(match[1]);
    }
    return names;
}

/** Every `name` written in backticks inside a comment, with its line. */
function citations(file) {
    const text = fs.readFileSync(file, "utf8");
    const found = [];
    const push = (start, body) => {
        const line = text.slice(0, start).split("\n").length;
        for (const match of body.matchAll(/`([A-Za-z_]\w*)`/g)) found.push({ line, name: match[1] });
    };
    for (const match of text.matchAll(/\/\/[^\n]*/g)) push(match.index, match[0]);
    for (const match of text.matchAll(/\/\*[\s\S]*?\*\//g)) push(match.index, match[0]);
    return found;
}

/** The shape this tree's own identifiers have: `showPanel`, `withBoundMasks` — not `AudioWorklet`, not `clsx`. */
const OWN_SHAPE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;

const known = codeNames();
const broken = [];
for (const file of files(CODE_DIRS, CODE_EXT)) {
    const relative = path.relative(ROOT, file);
    const outside = OUTSIDE[relative] || [];
    for (const { line, name } of citations(file)) {
        if (!OWN_SHAPE.test(name) || known.has(name) || outside.includes(name)) continue;
        broken.push(`${relative}:${line}  \`${name}\``);
    }
}

if (broken.length) {
    console.error(`comment name check failed: ${broken.length} cited name(s) answer to nothing in this tree`);
    broken.forEach((line) => console.error("  " + line));
    console.error("a name that names something outside this tree, or something this tree deleted, belongs in OUTSIDE above, with what it names");
    process.exit(1);
}
console.log("comment name check passed: every camelCase name cited in a comment exists in the tree");
