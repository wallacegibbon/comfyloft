#!/usr/bin/env node
// An export is a promise: every `export` says "something outside relies on this name".
//
// This check uses TypeScript's language service (`findReferences`), not grep — grep cannot tell "the
// declaring file uses it itself" from "something else imports it", and it does not follow barrel
// re-exports.
//
// Three problems:
//   A. referenced by nobody        → delete it
//   B. used only in its own file   → drop the `export`
//   C. used only by tests          → drop the export (and let the test use a public entry), or state the
//                                    reason in TEST_ONLY
//
// C counts as a problem on purpose: a test is not product code, and an export only a test imports means the
// function or type has no real caller — `agent.Run` lived a whole release that way (on the Go side, the
// same blind spot).
//
// Exempt: `src/vite-env.d.ts` is Vite's type declaration and has no runtime exports.

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const WEB = path.resolve(__dirname, "..");

const EXEMPT = new Set([path.join(WEB, "src/vite-env.d.ts")]);

// Exports only a test references, each with its reason. Every line added here is one caller missing from
// the product code.
const TEST_ONLY = new Map([
    [
        "src/lib/canvas/canvas-change.ts:CanvasSnapshot",
        "the two states a step is described from. Product code passes the page's own history entry, which is a superset, so nothing names this type; the test builds one by name to say what a step looks like without a page",
    ],
    [
        "src/lib/canvas/canvas-trash.ts:TRASH_LIMIT",
        "how many deletions a canvas remembers. It is the default argument of `withTrashed` and nothing else reads it by name — the trash list shows whatever it holds — so the test is the only caller that has to know the number",
    ],
    [
        "src/lib/canvas/save-queue.ts:SaveSnapshot",
        "the save queue's input snapshot: the queue's own `snapshot` callback returns it and its `save` callback takes it, but no product code names the type (it is always inferred), so only a test has to construct one by name",
    ],
    ["src/lib/server-models.ts:modelsOf", "the mapping from one workflow to its candidate entries — the unit under test itself; serverModels is only its fold"],
    ["src/services/api/http.ts:ApiError", "the error type http.ts throws; the tests use it to assert the shape of status and body"],
    ["src/services/api/http.ts:readApiErrorMessage", "the parser is the unit under test: the table covers msg / message / error / detail / serialised JSON / HTML; going through apiErrorMessage would mix in the status-code fallback"],
    [
        "src/stores/use-config-store.ts:channelName",
        "the name a channel is rendered by. Its one product caller is `modelOptionLabel` in the same file; nothing on screen names a channel any more — the gateway tab that renamed them is gone (#190) — so there is no other entry to reach it through",
    ],
    [
        "src/stores/use-config-store.ts:normalizeChannelModels",
        "the normalisation `createModelChannel` runs while hydrating a stored document; hydration is behind the module-level store singleton, so the test pins the rule (a stored capability survives) directly rather than by seeding a settings document",
    ],
    ["src/lib/wav.ts:WAV_HEADER_BYTES", "the size of the canonical PCM header is part of the format contract the encoder is tested against; no product code needs the number itself, it only writes through it"],
    ["src/lib/canvas/agent-dictation.ts:MIN_SPEECH_SECONDS", "the shortest gesture worth a request is the rule under test — `isSpeakable` is its only product reader, and a test that restated 0.2 would stop noticing when the threshold moved"],
    [
        "src/lib/canvas/canvas-card-frame.ts:NODE_CARD_FRAME",
        "a card's resting thickness. The renderer never names it — it draws `frame.width` — so the only caller that has to know the number is the test that says every quiet state keeps it and only a pick does not (#361)",
    ],
    [
        "src/lib/canvas/canvas-card-frame.ts:NODE_CARD_FRAME_SELECTED",
        "the other half of that pair: a picked card's thickness is the assertion, and comparing it with `NODE_CARD_FRAME` is the rule of #360 restated — a frame may be loud because it grows outside the card's rect — instead of as 3 and 2",
    ],
]);

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === "dist") continue;
            walk(full, out);
        } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

const srcFiles = walk(path.join(WEB, "src"));
const allFiles = [...srcFiles, ...walk(path.join(WEB, "tests"))];

const configPath = path.join(WEB, "tsconfig.json");
const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, WEB);
const options = {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    composite: false,
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    baseUrl: WEB,
    paths: { "@/*": ["./src/*"] },
    types: [],
};

const host = {
    getScriptFileNames: () => allFiles,
    getScriptVersion: () => "0",
    getScriptSnapshot: (file) => {
        const text = ts.sys.readFile(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => WEB,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const program = service.getProgram();
const checker = program.getTypeChecker();

const unused = [];
const localOnly = [];
const testOnly = [];

for (const file of srcFiles) {
    if (EXEMPT.has(file)) continue;
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;

    let exports;
    try {
        exports = checker.getExportsOfModule(moduleSymbol);
    } catch {
        continue;
    }

    for (const exported of exports) {
        let symbol = exported;
        if (symbol.flags & ts.SymbolFlags.Alias) {
            try {
                symbol = checker.getAliasedSymbol(symbol);
            } catch {
                /* keep the alias */
            }
        }
        const declaration = (symbol.declarations || [])[0];
        const nameNode = declaration?.name;
        if (!nameNode || !ts.isIdentifier(nameNode)) continue;

        const declaringFile = declaration.getSourceFile().fileName;
        // Only report what lives under src/: a re-exported third-party type is not ours to police.
        if (!declaringFile.startsWith(path.join(WEB, "src"))) continue;
        if (EXEMPT.has(declaringFile)) continue;

        const groups = service.findReferences(declaringFile, nameNode.getStart()) || [];
        let external = 0;
        let own = 0;
        let tests = 0;
        const seen = new Set();
        for (const group of groups) {
            for (const ref of group.references) {
                if (ref.isDefinition) continue;
                const key = `${ref.fileName}:${ref.textSpan.start}`;
                if (seen.has(key)) continue;
                seen.add(key);
                if (ref.fileName === declaringFile) own += 1;
                else if (ref.fileName.includes(`${path.sep}tests${path.sep}`)) tests += 1;
                else external += 1;
            }
        }

        const relative = path.relative(WEB, declaringFile);
        const entry = {
            name: exported.getName(),
            where: `${relative}:${declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1}`,
        };
        if (external === 0 && own === 0 && tests === 0) unused.push(entry);
        else if (external === 0 && tests === 0) localOnly.push(entry);
        else if (external === 0 && tests > 0 && !TEST_ONLY.has(`${relative}:${entry.name}`)) testOnly.push(entry);
    }
}

if (unused.length || localOnly.length || testOnly.length) {
    if (unused.length) {
        console.error(`${unused.length} export(s) nothing references (delete them):`);
        for (const item of unused) console.error(`    ${item.where}  ${item.name}`);
    }
    if (localOnly.length) {
        console.error(`${localOnly.length} export(s) used only inside their own file (drop the export):`);
        for (const item of localOnly) console.error(`    ${item.where}  ${item.name}`);
    }
    if (testOnly.length) {
        console.error(`${testOnly.length} export(s) only a test references (drop the export, or state the reason in TEST_ONLY):`);
        for (const item of testOnly) console.error(`    ${item.where}  ${item.name}`);
    }
    process.exit(1);
}

console.log(`export check passed: ${srcFiles.length} modules under src, no exports without a caller.`);
