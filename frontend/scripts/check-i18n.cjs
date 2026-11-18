#!/usr/bin/env node
// Two rulers for the dictionaries: a key nothing uses, and a key something uses that no longer exists.
//
// Why it is needed: `fallbackLng` is en-US, so a key missing from the Chinese dictionary is **silently shown
// in English** — no error, no warning. In the other direction, deleting a key that is still referenced (or
// with no entry in either dictionary) prints **the key itself** on the screen (`canvas.nodeTypes.audio`).
// Neither is a type error; only running the comparison finds them.
//
// Usage: npm run check:i18n   (exits non-zero when a dictionary or a call site is wrong)

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const WEB = path.resolve(__dirname, "..");
const SRC = path.join(WEB, "src");

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

const parse = (file) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Dotted paths to every leaf value, plus every object path on the way down. */
function flatten(node, prefix, leaves, branches) {
    if (!ts.isObjectLiteralExpression(node)) return;
    for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = prop.name;
        const key = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
        if (!key) continue;
        const full = prefix ? `${prefix}.${key}` : key;
        if (ts.isObjectLiteralExpression(prop.initializer)) {
            branches.add(full);
            flatten(prop.initializer, full, leaves, branches);
        } else {
            leaves.add(full);
        }
    }
}

function loadLocale(name) {
    const sf = parse(path.join(SRC, "i18n/locales", name));
    const leaves = new Set();
    const branches = new Set();
    sf.forEachChild((node) => {
        if (ts.isExportAssignment(node)) flatten(node.expression, "", leaves, branches);
    });
    return { leaves, branches };
}

const zh = loadLocale("zh-CN.ts");
const en = loadLocale("en-US.ts");

// Keys reached through `t(item.labelKey)`, where the value comes from a table in the same file. Listed one
// by one because the tool cannot resolve them: a new `t(variable)` has to be added here, or the keys behind
// that branch are reported as dead.
const HAND_RESOLVED = [
    "canvas.mossLayout.kindObject",
    "canvas.mossLayout.kindCharacter",
    "canvas.mossLayout.kindText",
    "canvas.outpaint.original",
    "config.preferences.defaultImageModel",
    "config.preferences.defaultVideoModel",
    "canvas.sidePanel.tab.canvases",
    "canvas.sidePanel.tab.elements",
    "canvas.sidePanel.tab.deleted",
    // `t(error)` in the model form: `reasoningError` answers with the key of the reason a reasoning block is
    // not usable, or "" for one that is — a pure function with no i18n of its own (`lib/agent-models.ts`).
    "config.preferences.modelReasoningNotJson",
    "config.preferences.modelReasoningNotObject",
    // `t(imageModeRefusalKey(reason))`: the one sentence for a paint verb no installed workflow can run, chosen
    // by why it cannot — no such graph, or that graph's node pack is missing. The key is written once in
    // `lib/canvas/image-mode.ts` and read where the press is answered (`project.tsx`, `use-image-editors.ts`).
    "canvas.runtime.modeBlocked",
    "canvas.runtime.modeNoWorkflow",
];

// Namespaces reached by string concatenation, declared one by one. Two forms:
//   values: [...]  the suffix can only be one of these (node modes, positions…), and only they count as
//                  used — any other key in the namespace is still dead
//   no values      the suffix comes from a data table (not statically readable), so the whole namespace is
//                  exempt; the reason has to say why
// An undeclared concatenation fails the check: "one template hides a whole namespace" is the hole this list
// exists to keep closed.
const DYNAMIC_PREFIXES = new Map([
    [
        "canvas.promptPanel",
        {
            values: ["image", "video", "audio", "text"],
            why: "the mode of `canvas.promptPanel.${mode}` is the node's generation kind; editImage/editText come from the template's own literal branches",
        },
    ],
    ["canvas.nodeTypes", { why: "the suffix is a node type (image/video/audio/text), from the CanvasNodeType values" }],
    [
        "canvas.toolPanel.kinds",
        {
            values: ["image", "video", "audio"],
            why: "a kind of media a tool workflow takes, from the ModelAccepts it declares",
        },
    ],
    ["canvas.sidePanel.filter", { why: "the suffix is a node type from NODE_FILTER_VALUES" }],
    ["canvas.toolbar", { why: "the suffix is the current canvas tool (select/pan)" }],
    ["server.models", { why: "the suffix is a model id from the registry; the Chinese label comes from chinese(), which reads the zh dictionary only (known-issues #10)" }],
    ["server.variants", { why: "the same: a variant mode id from the registry → its Chinese label" }],
    ["server.parameters", { why: "the same: a parameter `key` from the registry → the Chinese label of a knob" }],
    ["settingsPanels.video", { why: "the suffix is a labelKey from a data table (sizes, speed steps, mode hints)" }],
    ["settingsPanels.video.modes", { why: "the suffix is a mode labelKey from a data table, plus the literals of two hint branches" }],
    ["settingsPanels.model.capabilities", { why: "the suffix is the ModelCapability union; its values live in the type" }],
    ["config.localStorage.stores", { why: "the suffix is a table of localStorage store keys" }],
    [
        "config.preferences.modality",
        {
            values: ["image", "video", "audio", "document"],
            why: "the suffix is one of INPUT_MEDIA in lib/agent-models.ts — the four media words a model may declare; `text` has no box because AlayaCore never filters it",
        },
    ],
    [
        "canvas.change",
        {
            values: ["delete", "restore", "create", "update", "move", "resize", "connect", "disconnect", "canvas"],
            why: "the suffix is a CanvasChange's kind (lib/canvas/canvas-change.ts) — the one sentence the undo menu item is written in, chosen by the diff",
        },
    ],
    ["canvas.videoFrames", { why: "the suffix is one of first/last/both plus a Title suffix; the template cannot say which" }],
    ["apiErrors", { why: "the suffix of apiText(key) is an error-code constant from the calling service" }],
]);

const undeclared = [];
const reachable = new Set(HAND_RESOLVED);
const prefixes = new Set();
const unsound = [];
const stripDot = (s) => (s.endsWith(".") ? s.slice(0, -1) : s);

/**
 * The candidate values a template string can be read as.
 *
 * `t(`canvas.promptPanel.${mode === "image" ? "editImage" : mode}`)` used to count as "the whole namespace
 * is in use", which hid thirteen dead keys under `canvas.promptPanel.` for a release. Only literal
 * candidates (and the branches a condition or a concatenation spells out) count now; one bare variable and
 * the call site is reported as "cannot be resolved statically" for a person to check.
 */
function templateCandidates(prefix, expression) {
    const found = new Set();
    let dynamic = false;
    const walk = (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            found.add(`${prefix}.${node.text}`);
            return;
        }
        if (ts.isParenthesizedExpression(node)) return walk(node.expression);
        if (ts.isConditionalExpression(node)) {
            walk(node.whenTrue);
            walk(node.whenFalse);
            return;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            walk(node.left);
            walk(node.right);
            return;
        }
        dynamic = true;
    };
    walk(expression);
    for (const key of found) reachable.add(key);
    if (!dynamic) return true;

    const declared = DYNAMIC_PREFIXES.get(prefix);
    if (!declared) {
        undeclared.push(prefix);
        return false;
    }
    if (declared.values) {
        for (const value of declared.values) reachable.add(`${prefix}.${value}`);
    } else {
        prefixes.add(prefix);
    }
    return true;
}

function classify(node) {
    if (ts.isParenthesizedExpression(node)) return classify(node.expression);
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
        reachable.add(node.text);
        return true;
    }
    if (ts.isTemplateExpression(node)) {
        const head = stripDot(node.head.text);
        let sound = true;
        for (const span of node.templateSpans) {
            if (!templateCandidates(head, span.expression)) sound = false;
        }
        return sound;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteral(node.left)) {
        const head = stripDot(node.left.text);
        return templateCandidates(head, node.right);
    }
    if (ts.isConditionalExpression(node)) return classify(node.whenTrue) && classify(node.whenFalse);
    return false;
}

// `chinese(...)` in lib/server-labels.ts asks the zh dictionary only, so those keys have no en entry.
const KEY_FNS = new Set(["t", "chinese"]);

for (const file of walk(SRC)) {
    if (file.split(path.sep).includes("locales")) continue;
    const sf = parse(file);
    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const takesKey = (ts.isIdentifier(callee) && KEY_FNS.has(callee.text)) || (ts.isPropertyAccessExpression(callee) && callee.name.text === "t");
            if (takesKey && node.arguments.length && !classify(node.arguments[0])) {
                unsound.push(`${path.relative(WEB, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            }
            // i18n.getFixedT("zh-CN")(key)
            if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "getFixedT" && node.arguments.length) {
                classify(node.arguments[0]);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

const used = (key) => reachable.has(key) || [...prefixes].some((p) => key === p || key.startsWith(`${p}.`)) || [...reachable].some((r) => key.startsWith(`${r}.`));

const dead = (locale) => [...locale.leaves].filter((k) => !used(k)).sort();
// An object path taken whole by `t("...", { returnObjects: true })` is not a leaf, so it is not missing.
const missing = (locale) => [...reachable].filter((k) => k.includes(".") && !locale.leaves.has(k) && !locale.branches.has(k) && !prefixes.has(k)).sort();

const problems = [];

const deadZh = dead(zh);
const deadEn = dead(en);
if (deadZh.length) problems.push(`dead keys (nothing references them in zh-CN):\n${deadZh.map((k) => `    ${k}`).join("\n")}`);
if (deadEn.length) problems.push(`dead keys (nothing references them in en-US):\n${deadEn.map((k) => `    ${k}`).join("\n")}`);

const missingZh = missing(zh);
const missingEn = missing(en);
if (missingZh.length) problems.push(`missing keys (referenced by code, absent from zh-CN):\n${missingZh.map((k) => `    ${k}`).join("\n")}`);
if (missingEn.length) problems.push(`missing keys (referenced by code, absent from en-US):\n${missingEn.map((k) => `    ${k}`).join("\n")}`);

// Both dictionaries have to describe the same screen, except here: `chinese()` in lib/server-labels.ts
// reads the zh-CN dictionary only, to give the English model/variant ids in registry.json a Chinese label.
// The English screen shows the registry's own English text, so having no entry there is correct.
const ZH_ONLY_PREFIXES = ["server.models.", "server.variants.", "server.parameters."];
const zhOnlyByDesign = (key) => ZH_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix));

const onlyZh = [...zh.leaves].filter((k) => !en.leaves.has(k) && !zhOnlyByDesign(k)).sort();
const onlyEn = [...en.leaves].filter((k) => !zh.leaves.has(k) && !zhOnlyByDesign(k)).sort();
if (onlyZh.length) problems.push(`only in zh-CN:\n${onlyZh.map((k) => `    ${k}`).join("\n")}`);
if (onlyEn.length) problems.push(`only in en-US:\n${onlyEn.map((k) => `    ${k}`).join("\n")}`);

if (unsound.length) {
    console.warn(`note: ${unsound.length} t(variable) call(s) cannot be resolved statically; check them against HAND_RESOLVED:`);
    for (const site of unsound) console.warn(`    ${site}`);
}

if (undeclared.length) {
    problems.push(`undeclared dynamic key concatenation (spell out the values or the reason in DYNAMIC_PREFIXES):\n${[...new Set(undeclared)].map((prefix) => `    ${prefix}`).join("\n")}`);
}

if (problems.length) {
    console.error(problems.join("\n\n"));
    console.error(`\nfailed: ${deadZh.length + deadEn.length} dead key(s), ${missingZh.length + missingEn.length} missing key(s).`);
    process.exit(1);
}

console.log(`i18n check passed: zh-CN has ${zh.leaves.size} keys, en-US ${en.leaves.size}; no dead keys, none missing, the two agree.`);
