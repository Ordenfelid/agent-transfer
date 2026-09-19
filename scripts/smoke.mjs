import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require2 = createRequire(path.join(root, "package.json"));
const ts = require2("typescript");

// ---------- 模块加载器：TS -> CommonJS，stub 掉 siyuan 依赖 ----------
function compile(file) {
  const src = fs.readFileSync(path.join(root, "src", file), "utf8");
  return ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
}

const registry = {};
function load(name, siyuanStub) {
  if (registry[name]) return registry[name].exports;
  const mod = { exports: {} };
  registry[name] = mod;
  const req = (id) => {
    if (id === "siyuan") return siyuanStub;
    if (id.startsWith("./")) return load(id.slice(2).replace(/\.ts$/, "") + ".ts", siyuanStub);
    throw new Error("unexpected require " + id);
  };
  new Function("require", "module", "exports", compile(name))(req, mod, mod.exports);
  return mod.exports;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

// ---------- 全局桩 ----------
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const pngB64 = Buffer.from(pngBytes).toString("base64");

const calls = [];        // forwardProxy 请求
const toasts = [];       // showMessage
const getFileCalls = []; // 读取 assets 文件的请求
const readDirCalls = []; // 读取 assets 目录列表的请求
let dialogs = [];

// readDir 桩的默认目录项：photo.png/empty.png 精确可命中，sub 为目录
const ASSET_ENTRIES = [
  { name: "photo.png", updated: 300 },
  { name: "empty.png", updated: 1 },
  { name: "sub", isDir: true, updated: 1 },
];

class FakeDialog {
  constructor(opts) {
    this.opts = opts;
    this.destroyed = false;
    this.buttons = {};
    const vm = / value="([^"]*)"/.exec(opts.content || "");
    this.input = { value: vm ? vm[1] : "" };
    this.error = { textContent: "", style: {} };
    const self = this;
    this.element = {
      querySelector(sel) {
        if (sel.includes('data-da="rule"')) return self.input;
        if (sel.includes('data-da="error"')) return self.error;
        const m = /\[data-action="([^"]+)"\]/.exec(sel);
        return m ? self.button(m[1]) : null;
      },
    };
    dialogs.push(this);
  }
  button(action) {
    if (!this.buttons[action]) {
      this.buttons[action] = { listeners: {}, addEventListener(t, cb) { this.listeners[t] = cb; } };
    }
    return this.buttons[action];
  }
  click(action) { this.button(action).listeners.click(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.opts.destroyCallback?.(); } }
}

const siyuanStub = {
  fetchSyncPost: async (url, data) => {
    if (url === "/api/network/forwardProxy") { calls.push({ url, data }); return globalThis.__fpResp(data); }
    throw new Error("unexpected api " + url);
  },
  showMessage: (text) => toasts.push(text),
  Dialog: FakeDialog,
};

globalThis.window = {
  siyuan: {
    config: {
      api: { token: "test-token" },
      secrets: { items: [] },
      variables: { items: [] },
    },
  },
};
const setSecrets = (items) => { globalThis.window.siyuan.config.secrets.items = items; };
const setVars = (items) => { globalThis.window.siyuan.config.variables.items = items; };
globalThis.__readDirResp = () => ({ code: 0, data: ASSET_ENTRIES });
globalThis.__captured = {};
globalThis.fetch = async (url, init) => {
  if (url === "/api/file/readDir") {
    readDirCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(globalThis.__readDirResp()), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === "/api/file/getFile") {
    getFileCalls.push(JSON.parse(init.body));
    const r = globalThis.__fileResp();
    if (r.errorJson) return new Response(JSON.stringify(r.errorJson), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(r.bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
  }
  globalThis.__captured = { url, headers: init.headers, form: init.body };
  return new Response(JSON.stringify(globalThis.__uploadResp), { status: 200, headers: { "content-type": "application/json" } });
};

// ---------- 一、download_asset 原有用例 ----------
const { downloadToAsset } = load("download.ts", siyuanStub);

const form = () => globalThis.__captured.form;
const uploadedFile = () => form().get("file[]");

// 1 happy path
globalThis.__fpResp = () => ({ code: 0, msg: "", data: { status: 200, content_type: "image/png", body: pngB64 } });
globalThis.__uploadResp = { code: 0, msg: "", data: { succMap: { "photo.png": "assets/photo-20260913120000-abcd.png" }, err: "" } };
let r = await downloadToAsset({ url: "https://example.com/photo.png" });
check("1 result has final path", !!r.result && r.result.includes("assets/photo-20260913120000-abcd.png"), JSON.stringify(r));
check("1 forwardProxy base64", calls.at(-1).url === "/api/network/forwardProxy" && calls.at(-1).data.responseEncoding === "base64");
check("1 upload assetsDirPath", form().get("assetsDirPath") === "/assets/");
check("1 upload file name/type", uploadedFile().name === "photo.png" && uploadedFile().type === "image/png");
check("1 auth header", globalThis.__captured.headers.Authorization === "Token test-token");
check("1 size reported", /(\d+\.?\d*) B/.test(r.result));

// 2 explicit filename w/o ext -> ext from mime
globalThis.__fpResp = () => ({ code: 0, data: { status: 200, content_type: "application/pdf", body: pngB64 } });
globalThis.__uploadResp = { code: 0, data: { succMap: { "doc.pdf": "assets/doc-x.pdf" } } };
r = await downloadToAsset({ url: "https://example.com/getfile?id=9", filename: "doc" });
check("2 ext appended", uploadedFile().name === "doc.pdf", uploadedFile().name);

// 3 infer from url path with query string
globalThis.__fpResp = () => ({ code: 0, data: { status: 200, content_type: "image/jpeg", body: pngB64 } });
globalThis.__uploadResp = { code: 0, data: { succMap: { "cover.jpg": "assets/cover-x.jpg" } } };
r = await downloadToAsset({ url: "https://cdn.example.com/imgs/cover.jpg?w=100" });
check("3 infer filename", uploadedFile().name === "cover.jpg", uploadedFile().name);

// 4 nothing inferable -> .bin
globalThis.__fpResp = () => ({ code: 0, data: { status: 200, content_type: "", body: pngB64 } });
globalThis.__uploadResp = { code: 0, data: { succMap: { "download.bin": "assets/download-x.bin" } } };
r = await downloadToAsset({ url: "https://example.com/files/xyz" });
check("4 fallback .bin", uploadedFile().name === "xyz.bin", uploadedFile().name);

// 5 invalid url
r = await downloadToAsset({ url: "not a url" });
check("5 invalid url", !!r.error && r.error.includes("无效"), JSON.stringify(r));

// 6 ftp rejected
r = await downloadToAsset({ url: "ftp://example.com/a.zip" });
check("6 ftp rejected", !!r.error && r.error.includes("http/https"), JSON.stringify(r));

// 7/8 private hosts rejected
r = await downloadToAsset({ url: "http://127.0.0.1:6806/api/file/putFile" });
check("7 loopback rejected", !!r.error && r.error.includes("内网"), JSON.stringify(r));
r = await downloadToAsset({ url: "http://192.168.1.10/admin" });
check("8 lan rejected", !!r.error && r.error.includes("内网"), JSON.stringify(r));

// 9 remote 404
globalThis.__fpResp = () => ({ code: 0, data: { status: 404, content_type: "text/html", body: "" } });
r = await downloadToAsset({ url: "https://example.com/missing.png" });
check("9 http 404 surfaced", !!r.error && r.error.includes("404"), JSON.stringify(r));

// 10 kernel-level error
globalThis.__fpResp = () => ({ code: -1, msg: "timeout" });
r = await downloadToAsset({ url: "https://example.com/a.png" });
check("10 kernel error surfaced", !!r.error && r.error.includes("timeout"), JSON.stringify(r));

// 11 oversize rejected before decode
let big = "A".repeat(Math.floor(50 * 1024 * 1024 * 4 / 3) + 100);
globalThis.__fpResp = () => ({ code: 0, data: { status: 200, content_type: "image/png", body: big } });
r = await downloadToAsset({ url: "https://example.com/big.png" });
check("11 oversize rejected", !!r.error && r.error.includes("50MB"), JSON.stringify(r));
big = null;

// 12 upload kernel failure
globalThis.__fpResp = () => ({ code: 0, data: { status: 200, content_type: "image/png", body: pngB64 } });
globalThis.__uploadResp = { code: 1, msg: "assets dir not exist" };
r = await downloadToAsset({ url: "https://example.com/a.png" });
check("12 upload failure msg", !!r.error && r.error.includes("assets dir not exist"), JSON.stringify(r));

// 13 succMap missing
globalThis.__uploadResp = { code: 0, data: { err: "unknown file ext" } };
r = await downloadToAsset({ url: "https://example.com/a.png" });
check("13 missing succMap", !!r.error && r.error.includes("路径"), JSON.stringify(r));

// 14 path traversal sanitized
globalThis.__uploadResp = { code: 0, data: { succMap: { "evil.png": "assets/evil-x.png" } } };
const BS = String.fromCharCode(92);
r = await downloadToAsset({ url: "https://example.com/a.png", filename: ".." + BS + ".." + BS + "evil.png" });
check("14 traversal sanitized", uploadedFile().name === "evil.png", uploadedFile().name);

// 15 missing url
r = await downloadToAsset({});
check("15 missing url", !!r.error && r.error.includes("url"), JSON.stringify(r));

// 16 empty body
globalThis.__fpResp = () => ({ code: 0, data: { status: 200, content_type: "image/png", body: "" } });
r = await downloadToAsset({ url: "https://example.com/a.png" });
check("16 empty body", !!r.error && r.error.includes("为空"), JSON.stringify(r));

// ---------- 二、patterns：规则解析与通配匹配 ----------
const { parseRule, parseRuleLines, matchRule, ruleToString } = load("patterns.ts", siyuanStub);
const R = (s) => parseRule(s).rule;

check("P1 plain host", ruleToString(R("https://example.com")) === "https://example.com");
check("P2 path stripped", ruleToString(R("https://example.com/upload?x=1#f")) === "https://example.com");
check("P3 wildcard+port", JSON.stringify(R("https://*.example.com:8443")) === JSON.stringify({ scheme: "https", host: "*.example.com", port: "8443" }));
check("P4 star host", R("https://*")?.host === "*");
check("P5 ftp rejected", !!parseRule("ftp://example.com").error);
check("P6 mid-wildcard rejected", !!parseRule("https://a*.example.com").error);
check("P7 no scheme rejected", !!parseRule("example.com").error);
check("P8 port 0 rejected", !!parseRule("http://example.com:0").error);
check("P9 ipv6 rejected", !!parseRule("https://[::1]").error);

const wild = R("https://*.example.com");
check("P10 wildcard subdomain", matchRule(wild, new URL("https://a.example.com/x")));
check("P11 wildcard apex", matchRule(wild, new URL("https://example.com")));
check("P12 wildcard deep subdomain", matchRule(wild, new URL("https://a.b.example.com")));
check("P13 wildcard scheme mismatch", !matchRule(wild, new URL("http://a.example.com")));
check("P14 wildcard other domain", !matchRule(wild, new URL("https://a.example.org")));
check("P15 wildcard port mismatch", !matchRule(wild, new URL("https://a.example.com:8443")));
const plain = R("https://example.com");
check("P16 default port 443 matches", matchRule(plain, new URL("https://example.com:443/x")) && matchRule(plain, new URL("https://example.com/x")));
check("P17 non-default port no match", !matchRule(plain, new URL("https://example.com:8443")));
const lines = parseRuleLines("https://a.com\n# comment\n\nbad rule\nhttps://a.com");
check("P18 parseRuleLines dedup+errors", lines.rules.length === 1 && lines.errors.length === 1, JSON.stringify(lines));

// ---------- 三、rules：名单状态与判定 ----------
const rulesMod = load("rules.ts", siyuanStub);
const storage = {
  data: null, saved: null,
  loadData: async () => storage.data,
  saveData: async (n, c) => { storage.saved = JSON.parse(c); storage.data = c; },
};
rulesMod.setRules({
  whitelist: [R("https://*.example.com")],
  blacklist: [R("https://evil.example.com")],
});
check("R1 blacklist wins", rulesMod.checkUrl(new URL("https://evil.example.com/x")).verdict === "deny");
check("R2 whitelist subdomain", rulesMod.checkUrl(new URL("https://ok.example.com")).verdict === "allow");
check("R3 unknown asks", rulesMod.checkUrl(new URL("https://other.com")).verdict === "ask");

await rulesMod.appendRule(storage, "blacklist", R("https://*.example.com"));
const cur = rulesMod.getRules();
check("R4 append moves across lists", cur.whitelist.length === 0 && cur.blacklist.length === 2, JSON.stringify(cur));
check("R5 append persists", storage.saved.blacklist.includes("https://*.example.com"));

storage.data = "corrupt {";
await rulesMod.loadRules(storage);
check("R6 corrupt storage resets", rulesMod.getRules().whitelist.length === 0 && rulesMod.getRules().blacklist.length === 0);
storage.data = JSON.stringify({ whitelist: ["https://ok.com", "not a rule"], blacklist: [] });
await rulesMod.loadRules(storage);
check("R7 load drops invalid", rulesMod.getRules().whitelist.length === 1, JSON.stringify(rulesMod.getRules()));

// ---------- 三b、secrets：{{secrets}}/{{vars}} 插值 ----------
const { resolveTemplates, getSecretsVars } = load("secrets.ts", siyuanStub);
const SEC = [{ name: "tok", value: "sec-val", allowedHosts: ["Upload.Example.COM"] }];
const VARS = [{ name: "base", value: "https://v.example.com" }];

check("S1 secret resolved on allowed host (case-insensitive)",
  resolveTemplates("{{secrets.tok}}", SEC, [], "upload.example.com").text === "sec-val");
{
  const out = resolveTemplates("{{secrets.tok}}", SEC, [], "other.example.com");
  check("S2 secret kept on other host", out.text === "{{secrets.tok}}" &&
    out.unresolved.length === 1 && out.unresolved[0].kind === "secrets" && out.unresolved[0].exists === true,
    JSON.stringify(out));
}
{
  const out = resolveTemplates("{{secrets.tok}}", [{ name: "tok", value: "v", allowedHosts: [] }], [], "upload.example.com");
  check("S3 empty allowlist denies all", out.text === "{{secrets.tok}}" && out.unresolved[0].exists === true);
}
{
  const out = resolveTemplates("{{secrets.nope}}", SEC, [], "upload.example.com");
  check("S4 missing secret flagged not-exists", out.unresolved[0].exists === false);
}
check("S5 var resolved without host gate",
  resolveTemplates("{{vars.base}}", SEC, VARS, "any.example.com").text === "https://v.example.com");
{
  const out = resolveTemplates("{{vars.nope}}", SEC, VARS, "upload.example.com");
  check("S6 missing var unresolved", out.text === "{{vars.nope}}" && out.unresolved[0].kind === "vars" && out.unresolved[0].exists === false);
}
check("S7 plain text untouched", resolveTemplates("Bearer token-123", SEC, VARS, "x.com").text === "Bearer token-123");
check("S8 surrounding text kept", resolveTemplates("Bearer {{secrets.tok}}-x", SEC, [], "upload.example.com").text === "Bearer sec-val-x");
{
  const out = resolveTemplates("{{secrets.tok}} {{vars.nope}} {{secrets.tok}}", SEC, VARS, "other.example.com");
  check("S9 dup refs reported once", out.unresolved.length === 2, JSON.stringify(out.unresolved));
}
setSecrets([{ name: "a", value: "1" }]);
setVars([{ name: "b", value: "2" }]);
check("S10 getSecretsVars reads window config",
  getSecretsVars().secrets.length === 1 && getSecretsVars().vars.length === 1);
setSecrets([]);
setVars([]);

// ---------- 三c、assets：路径宽松解析 ----------
const { normalizeAssetRelPath, resolveAssetPath } = load("assets.ts", siyuanStub);
const errOf = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

check("A1 bare name kept", normalizeAssetRelPath("photo.png") === "photo.png");
check("A1 assets/ prefix stripped", normalizeAssetRelPath("assets/sub/photo.png") === "sub/photo.png");
check("A1 backslash+query+hash", normalizeAssetRelPath("assets\\photo.png?x=1#f") === "photo.png");
check("A2 traversal rejected", errOf(() => normalizeAssetRelPath("../conf.json")).includes("不合法"));
check("A2 empty segment rejected", errOf(() => normalizeAssetRelPath("assets//x.png")).includes("不合法"));
check("A2 assets dir only rejected", errOf(() => normalizeAssetRelPath("assets")).includes("文件名"));
check("A2 missing arg rejected", errOf(() => normalizeAssetRelPath(undefined)).includes("path"));

globalThis.__readDirResp = () => ({ code: 0, data: [{ name: "photo.png", updated: 300 }] });
check("A3 exact match", await resolveAssetPath("assets/photo.png") === "photo.png");
globalThis.__readDirResp = () => ({ code: 0, data: [{ name: "photo-20260913120000-abcd.png", updated: 9 }] });
check("A4 fuzzy unique match", await resolveAssetPath("photo.png") === "photo-20260913120000-abcd.png");
globalThis.__readDirResp = () => ({ code: 0, data: [
  { name: "photo-20260913120000-abcd.png", updated: 9 },
  { name: "photo-20260910100000-ffff.png", updated: 8 },
] });
try { await resolveAssetPath("photo.png"); check("A5 multiple candidates error", false); }
catch (e) { check("A5 multiple candidates error", e.message.includes("photo-20260913120000-abcd.png") && e.message.includes("photo-20260910100000-ffff.png"), e.message); }
globalThis.__readDirResp = () => ({ code: 0, data: [{ name: "other.png", updated: 1 }] });
try { await resolveAssetPath("photo.png"); check("A6 not found error", false); }
catch (e) { check("A6 not found error", e.message.includes("未找到"), e.message); }
globalThis.__readDirResp = () => ({ code: 0, data: [
  { name: "sub", isDir: true, updated: 1 },
  { name: "photo-20260913120000-abcd.png", updated: 9 },
] });
check("A7 dirs skipped in fuzzy match", await resolveAssetPath("photo.png") === "photo-20260913120000-abcd.png");
globalThis.__readDirResp = () => ({ code: 0, data: [{ name: "photo.png", updated: 1 }] });
check("A8 subdir readDir path", await resolveAssetPath("assets/sub/photo.png") === "sub/photo.png" &&
  readDirCalls.at(-1).path === "/data/assets/sub/");
check("A9 no-ext name exact only", await resolveAssetPath("assets/photo.png") === "photo.png");
globalThis.__readDirResp = () => ({ code: -1, msg: "dir missing" });
try {
  await resolveAssetPath("assets/photo.png");
  check("A10 readDir error surfaced", false);
} catch (e) {
  check("A10 readDir error surfaced", e.message.includes("dir missing"), e.message);
}
globalThis.__readDirResp = () => ({ code: 0, data: ASSET_ENTRIES });

// ---------- 三d、multipart：表单体拼装 ----------
const { buildMultipart } = load("multipart.ts", siyuanStub);
const mres = buildMultipart({
  fields: { comment: "hello", when: "2026" },
  fileField: "file1",
  filename: "a b.png",
  mime: "image/png",
  bytes: new TextEncoder().encode("BIN-DATA"),
});
const mboundary = mres.contentType.split("boundary=")[1];
const mtext = Buffer.from(mres.body).toString("latin1");
check("M1 contentType w/ boundary", mres.contentType.startsWith("multipart/form-data; boundary=----SiyuanDownloadAsset") && !!mboundary);
check("M2 fields before file part", mtext.indexOf('name="comment"') < mtext.indexOf('name="file1"'));
check("M3 field framing", mtext.includes(`--${mboundary}\r\nContent-Disposition: form-data; name="comment"\r\n\r\nhello\r\n`));
check("M4 file disposition+mime+bytes",
  mtext.includes(`Content-Disposition: form-data; name="file1"; filename="a b.png"\r\nContent-Type: image/png\r\n\r\nBIN-DATA`));
check("M5 closing boundary", mtext.endsWith(`\r\n--${mboundary}--\r\n`));
{
  const q = buildMultipart({ fields: {}, fileField: 'bad"field', filename: 'x"y', mime: "application/octet-stream", bytes: new Uint8Array([1]) });
  const qt = Buffer.from(q.body).toString("latin1");
  check("M6 token sanitize", qt.includes('name="bad field"') && qt.includes('filename="x y"') && !qt.includes('bad"field'));
}
{
  const bin = new Uint8Array([0, 255, 1, 254]);
  const b = buildMultipart({ fields: {}, fileField: "f", filename: "x.bin", mime: "application/octet-stream", bytes: bin });
  check("M7 binary bytes preserved", Buffer.from(b.body).includes(Buffer.from(bin)));
}


// ---------- 四、upload_asset：门控 + 弹窗 + 上传 ----------
const { uploadAssetToUrl } = load("upload.ts", siyuanStub);
const i18n = {};
const setLists = (wl, bl) => rulesMod.setRules({ whitelist: (wl || []).map(R), blacklist: (bl || []).map(R) });
const okFp = () => ({ code: 0, data: { status: 201, body: "{\"url\":\"https://files.example.com/x.png\"}", elapsed: 12 } });
const call = (args) => uploadAssetToUrl(args, storage, i18n);

async function withDialog(action, ruleValue, fn) {
  dialogs = [];
  const p = fn();
  for (let i = 0; i < 100 && !dialogs.length; i++) await new Promise((res) => setTimeout(res, 1));
  if (!dialogs.length) return await p;
  if (ruleValue !== undefined) dialogs[0].input.value = ruleValue;
  dialogs[0].click(action);
  return await p;
}

// U1 黑名单直接拒绝，不弹窗不请求
setLists([], ["https://evil.example.com"]);
globalThis.__fileResp = () => ({ bytes: pngBytes });
globalThis.__fpResp = okFp;
dialogs = [];
const fpBefore = calls.length;
r = await call({ path: "assets/photo.png", url: "https://evil.example.com/up" });
check("U1 blacklist denies", !!r.error && r.error.includes("黑名单") && dialogs.length === 0 && calls.length === fpBefore, JSON.stringify(r));

// U2 白名单静默上传：裸文件名补 assets/ 前缀，POST 原样二进制 base64
setLists(["https://files.example.com"], []);
dialogs = [];
r = await call({ path: "photo.png", url: "https://files.example.com/up" });
const fp = calls.at(-1).data;
check("U2 no dialog on whitelist", dialogs.length === 0);
check("U2 result ok", !!r.result && r.result.includes("HTTP 201") && r.result.includes("https://files.example.com/up"), JSON.stringify(r));
check("U2 path normalized", getFileCalls.at(-1).path === "/data/assets/photo.png", JSON.stringify(getFileCalls.at(-1)));
check("U2 binary base64 payload", fp.method === "POST" && fp.payloadEncoding === "base64" && fp.payload === pngB64 && fp.contentType === "image/png", JSON.stringify(fp));
check("U2 toast shown", toasts.some((t) => t.includes("已上传")));

// U3 灰区弹窗 → 放行一次：上传但名单不变
setLists([], []);
storage.saved = null;
r = await withDialog("allow-once", undefined, () => call({ path: "assets/photo.png", url: "https://gray.example.com/up" }));
check("U3 allow-once uploads", !!r.result && !storage.saved, JSON.stringify(r));

// U4 灰区弹窗 → 拒绝一次
r = await withDialog("deny", undefined, () => call({ path: "assets/photo.png", url: "https://gray.example.com/up" }));
check("U4 deny once", !!r.error && r.error.includes("拒绝"), JSON.stringify(r));

// U5 灰区弹窗 → 改写为通配后加白名单并上传，后续同域不再弹窗
storage.saved = null;
r = await withDialog("whitelist", "https://*.gray.example.com", () => call({ path: "assets/photo.png", url: "https://api.gray.example.com/up" }));
check("U5 whitelist+upload", !!r.result && storage.saved.whitelist.includes("https://*.gray.example.com"), JSON.stringify(storage.saved));
dialogs = [];
r = await call({ path: "assets/photo.png", url: "https://other.gray.example.com/up" });
check("U5 wildcard covers next call", dialogs.length === 0 && !!r.result, JSON.stringify(r));

// U6 灰区弹窗 → 整条 URL 直接加黑名单（规范化为 origin 规则），不上传
storage.saved = null;
const fpBefore6 = calls.length;
r = await withDialog("blacklist", "https://blocked.example.com/upload?x=1", () => call({ path: "assets/photo.png", url: "https://blocked.example.com/upload?x=1" }));
check("U6 blacklist normalized", !!r.error && r.error.includes("黑名单") && storage.saved.blacklist.includes("https://blocked.example.com") && calls.length === fpBefore6, JSON.stringify({ r, saved: storage.saved }));

// U7 内网地址硬拒绝（先于名单与弹窗）
dialogs = [];
r = await call({ path: "assets/photo.png", url: "http://192.168.1.5/up" });
check("U7 private host rejected", !!r.error && r.error.includes("内网") && dialogs.length === 0, JSON.stringify(r));

// U8 PUT 透传与非法 method
setLists(["https://files.example.com"], []);
r = await call({ path: "assets/photo.png", url: "https://files.example.com/put", method: "put" });
check("U8 PUT passthrough", !!r.result && calls.at(-1).data.method === "PUT", JSON.stringify(calls.at(-1).data));
r = await call({ path: "assets/photo.png", url: "https://files.example.com/put", method: "GET" });
check("U8 invalid method", !!r.error && r.error.includes("POST"), JSON.stringify(r));

// U9 超过 32MB 拒绝
globalThis.__fileResp = () => ({ bytes: new Uint8Array(32 * 1024 * 1024 + 1) });
r = await call({ path: "assets/photo.png", url: "https://files.example.com/up" });
check("U9 oversize", !!r.error && r.error.includes("32MB"), JSON.stringify(r));

// U10 路径越界拒绝
globalThis.__fileResp = () => ({ bytes: pngBytes });
r = await call({ path: "../conf/conf.json", url: "https://files.example.com/up" });
check("U10 traversal rejected", !!r.error && r.error.includes("不合法"), JSON.stringify(r));
r = await call({ path: "assets/../../conf.json", url: "https://files.example.com/up" });
check("U10 embedded traversal", !!r.error && r.error.includes("不合法"), JSON.stringify(r));

// U11 文件不存在：目录里没有该文件（含时间戳模糊匹配）
globalThis.__fileResp = () => ({ bytes: pngBytes });
r = await call({ path: "assets/missing.png", url: "https://files.example.com/up" });
check("U11 not found in dir", !!r.error && r.error.includes("未找到"), JSON.stringify(r));
// U11b 目录里有但读取失败（内核 getFile 返回 JSON 错误）
globalThis.__fileResp = () => ({ errorJson: { code: -1, msg: "file not found" } });
r = await call({ path: "assets/photo.png", url: "https://files.example.com/up" });
check("U11b getFile error", !!r.error && r.error.includes("file not found"), JSON.stringify(r));
globalThis.__fileResp = () => ({ bytes: pngBytes });

// U12 远端 5xx
globalThis.__fileResp = () => ({ bytes: pngBytes });
globalThis.__fpResp = () => ({ code: 0, data: { status: 500, body: "boom" } });
r = await call({ path: "assets/photo.png", url: "https://files.example.com/up" });
check("U12 remote 500", !!r.error && r.error.includes("500"), JSON.stringify(r));

// U13 非 http(s) 协议拒绝
r = await call({ path: "assets/photo.png", url: "ftp://files.example.com/up" });
check("U13 ftp rejected", !!r.error && r.error.includes("http/https"), JSON.stringify(r));

// U14 空文件
globalThis.__fileResp = () => ({ bytes: new Uint8Array(0) });
r = await call({ path: "assets/empty.png", url: "https://files.example.com/up" });
check("U14 empty file", !!r.error && r.error.includes("为空"), JSON.stringify(r));

// U15 弹窗里输入非法规则：不关窗不结算，改点拒绝后按拒绝一次返回
setLists([], []);
globalThis.__fileResp = () => ({ bytes: pngBytes });
dialogs = [];
const p15 = call({ path: "assets/photo.png", url: "https://gray.example.com/up" });
for (let i = 0; i < 100 && !dialogs.length; i++) await new Promise((res) => setTimeout(res, 1));
dialogs[0].input.value = "*.gray.example.com"; // 缺 scheme
dialogs[0].click("whitelist");
check("U15 invalid rule keeps dialog", !dialogs[0].destroyed);
dialogs[0].click("deny");
r = await p15;
check("U15 still deniable", !!r.error && r.error.includes("拒绝"), JSON.stringify(r));

// U16 ESC/关闭弹窗 = 拒绝一次
dialogs = [];
const p16 = call({ path: "assets/photo.png", url: "https://gray.example.com/up" });
for (let i = 0; i < 100 && !dialogs.length; i++) await new Promise((res) => setTimeout(res, 1));
dialogs[0].destroy(); // 模拟 ESC 触发 destroyCallback
r = await p16;
check("U16 close as deny", !!r.error && r.error.includes("拒绝"), JSON.stringify(r));

// U17 缺参数
r = await call({ url: "https://files.example.com/up" });
check("U17 missing path", !!r.error && r.error.includes("path"), JSON.stringify(r));

// ---------- 五、upload_asset 0.3.0：headers/secrets/vars、multipart、宽松路径 ----------
const UP = "https://upload.example.com/up";
setLists(["https://upload.example.com", "https://v.example.com"], []);
globalThis.__fpResp = okFp; // U12 起残留 500 桩，复位
setSecrets([
  { name: "tok", value: "sec-val", allowedHosts: ["upload.example.com"] },
  { name: "elsewhere", value: "other-val", allowedHosts: ["other.example.com"] },
]);
setVars([
  { name: "base", value: "https://upload.example.com" },
  { name: "cmt", value: "hello" },
]);

// U18 headers 插值：secrets 命中 allowedHosts 注入明文，其余头原样透传
r = await call({ path: "photo.png", url: UP, headers: { "X-Token": "{{secrets.tok}}", "Accept": "application/json" } });
const fpn = calls.at(-1).data;
check("U18 secret header injected", !!r.result &&
  fpn.headers.some((h) => h["X-Token"] === "sec-val") && fpn.headers.some((h) => h.Accept === "application/json"),
  JSON.stringify(fpn.headers));
check("U18 raw payload untouched", fpn.payload === pngB64 && fpn.contentType === "image/png");

// U19 用户 Content-Type 优先于扩展名推断，且不进 headers 数组
r = await call({ path: "photo.png", url: UP, headers: { "content-type": "application/x-custom" } });
const fpn19 = calls.at(-1).data;
check("U19 content-type override", fpn19.contentType === "application/x-custom" &&
  !fpn19.headers.some((h) => Object.keys(h).some((k) => k.toLowerCase() === "content-type")),
  JSON.stringify(fpn19));

// U20 密钥存在但未授权该主机 → 拒发并指出原因，且不产生网络请求
const fpBefore20 = calls.length;
r = await call({ path: "photo.png", url: UP, headers: { "X-T": "{{secrets.elsewhere}}" } });
check("U20 host not allowed refuses", !!r.error && r.error.includes("未授权目标主机") && calls.length === fpBefore20, JSON.stringify(r));

// U21 密钥名不存在 → 未配置
r = await call({ path: "photo.png", url: UP, headers: { "X-T": "{{secrets.nope}}" } });
check("U21 missing secret refuses", !!r.error && r.error.includes("密钥未配置"), JSON.stringify(r));

// U22 变量缺配 → 拒发
r = await call({ path: "photo.png", url: UP, headers: { "X-T": "{{vars.nope}}" } });
check("U22 missing var refuses", !!r.error && r.error.includes("变量未配置"), JSON.stringify(r));

// U23 url 支持 {{vars.*}}，插值后按最终地址走名单
r = await call({ path: "photo.png", url: "{{vars.base}}/up" });
check("U23 vars in url", !!r.result && calls.at(-1).data.url === "https://upload.example.com/up", JSON.stringify(r));

// U24 url 里不允许 {{secrets.*}}
r = await call({ path: "photo.png", url: "https://upload.example.com/up?t={{secrets.tok}}" });
check("U24 secrets in url rejected", !!r.error && r.error.includes("url 中不允许"), JSON.stringify(r));

// U25 变量把地址指向内网 → 插值后重新校验拒绝
setVars([{ name: "base", value: "http://192.168.1.9" }]);
r = await call({ path: "photo.png", url: "{{vars.base}}/x" });
check("U25 vars to private host rejected", !!r.error && r.error.includes("内网"), JSON.stringify(r));
setVars([
  { name: "base", value: "https://upload.example.com" },
  { name: "cmt", value: "hello" },
]);

// U26 multipart 上传：boundary/字段插值/文件段/头部注入/忽略用户 Content-Type
r = await call({
  path: "photo.png",
  url: UP,
  multipart: true,
  fileField: "file",
  fields: { comment: "{{vars.cmt}}" },
  headers: { "X-Token": "{{secrets.tok}}", "Content-Type": "text/plain" },
});
const fpn26 = calls.at(-1).data;
{
  const ok = !!r.result && fpn26.contentType.startsWith("multipart/form-data; boundary=");
  const b = ok ? fpn26.contentType.split("boundary=")[1] : "";
  const body = Buffer.from(fpn26.payload, "base64");
  const text = body.toString("latin1");
  check("U26 multipart contentType+binary channel", ok && fpn26.payloadEncoding === "base64", JSON.stringify(fpn26.contentType));
  check("U26 header injected & user CT dropped",
    fpn26.headers.some((h) => h["X-Token"] === "sec-val") &&
    !fpn26.headers.some((h) => Object.keys(h).some((k) => k.toLowerCase() === "content-type")));
  check("U26 field interpolated", text.includes(`Content-Disposition: form-data; name="comment"\r\n\r\nhello\r\n`), text.slice(0, 200));
  check("U26 file part framing+bytes",
    text.includes(`Content-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`) &&
    body.includes(Buffer.from(pngBytes)), "");
  check("U26 closing boundary", text.endsWith(`\r\n--${b}--\r\n`));
}

// U27 fields/fileField 未开 multipart 即使用 → 报错引导
r = await call({ path: "photo.png", url: UP, fields: { a: "b" } });
check("U27 fields need multipart", !!r.error && r.error.includes("multipart=true"), JSON.stringify(r));
r = await call({ path: "photo.png", url: UP, fileField: "x" });
check("U27 fileField needs multipart", !!r.error && r.error.includes("multipart=true"), JSON.stringify(r));

// U28 参数类型约束
r = await call({ path: "photo.png", url: UP, multipart: "yes" });
check("U28 multipart must be boolean", !!r.error && r.error.includes("布尔"), JSON.stringify(r));
r = await call({ path: "photo.png", url: UP, headers: { "X-T": 123 } });
check("U28 header value must be string", !!r.error && r.error.includes("字符串"), JSON.stringify(r));
r = await call({ path: "photo.png", url: UP, headers: { "X-T": "a\r\nb" } });
check("U28 CRLF rejected", !!r.error && r.error.includes("换行"), JSON.stringify(r));

// U29 上传流程内的宽松路径解析：裸名命中时间戳后缀文件
globalThis.__readDirResp = () => ({ code: 0, data: [{ name: "photo-20260913120000-abcd.png", updated: 9 }] });
r = await call({ path: "photo.png", url: UP, headers: { "X-Token": "{{secrets.tok}}" } });
check("U29 fuzzy path resolved in flow", !!r.result &&
  getFileCalls.at(-1).path === "/data/assets/photo-20260913120000-abcd.png", JSON.stringify(getFileCalls.at(-1)));
globalThis.__readDirResp = () => ({ code: 0, data: ASSET_ENTRIES });

// U30 响应回传上限 2KB
{
  const longJson = "{\"url\":\"" + "x".repeat(3000) + "\"}";
  globalThis.__fpResp = () => ({ code: 0, data: { status: 200, body: longJson, elapsed: 5 } });
  r = await call({ path: "photo.png", url: UP });
  check("U30 snippet capped at 2KB", !!r.result && r.result.includes("…") &&
    !r.result.includes("x".repeat(2500)), JSON.stringify(r.result?.slice(0, 80)));
  globalThis.__fpResp = okFp;
}

// ---------- 六、logger：调用日志与脱敏 ----------
const loggerMod = load("logger.ts", siyuanStub);
const logStore = {
  data: null, saved: null,
  loadData: async () => logStore.data,
  saveData: async (n, c) => { logStore.saved = JSON.parse(c); logStore.data = c; },
};
await loggerMod.initLogger(logStore, false); // 第二参关闭 console 镜像，保持测试输出干净
loggerMod.clearLog();

// L1 入参脱敏：占位符原样、敏感头明文打码、普通头保留
const sane = JSON.parse(loggerMod.sanitizeArgs({
  url: "https://upload.example.com/up",
  path: "photo.png",
  headers: { "X-Token": "{{secrets.tok}}", Authorization: "Bearer plaintext-abcdef", Accept: "application/json" },
}));
check("L1 placeholder kept", sane.headers["X-Token"] === "{{secrets.tok}}", JSON.stringify(sane));
check("L1 sensitive masked", sane.headers.Authorization.includes("已打码") && !sane.headers.Authorization.includes("plaintext"), sane.headers.Authorization);
check("L1 plain header kept", sane.headers.Accept === "application/json", sane.headers.Accept);
check("L1 url untouched", sane.url === "https://upload.example.com/up", sane.url);

// L2 插值后值的日志口径：密钥明文→<secret:NAME>，敏感头兜底打码
check("L2 secret redacted", loggerMod.redactSecrets("Bearer sec-val", [{ name: "tok", value: "sec-val" }]) === "Bearer <secret:tok>");
check("L2 short value skipped", loggerMod.redactSecrets("abc", [{ name: "x", value: "a" }]) === "abc");
check("L2 redacted value kept", loggerMod.redactHeaderValue("X-Token", "sec-val", [{ name: "tok", value: "sec-val" }]) === "<secret:tok>");
check("L2 pasted plaintext masked", loggerMod.redactHeaderValue("X-Token", "pasted-token-123", []).includes("已打码"));
check("L2 plain value kept", loggerMod.redactHeaderValue("Accept", "application/json", []) === "application/json");

// L3 完整上传流水：事件齐全 + 密钥明文全程不出现
setLists(["https://upload.example.com"], []);
setSecrets([{ name: "tok", value: "sec-val", allowedHosts: ["upload.example.com"] }]);
setVars([{ name: "base", value: "https://upload.example.com" }]);
const A3 = { path: "photo.png", url: UP, headers: { "X-Token": "{{secrets.tok}}", Accept: "application/json" } };
r = await loggerMod.runWithLog("upload_asset", A3, () => call(A3));
const t3 = loggerMod.getLogText();
for (const ev of ["invoke", "target", "file", "verdict", "headers", "request", "response", "done"]) {
  check(`L3 event ${ev}`, t3.includes(`upload_asset ${ev} |`), ev);
}
check("L3 no secret plaintext", !t3.includes("sec-val"), "sec-val leaked into log");
check("L3 secret marker present", t3.includes("<secret:tok>"), t3.slice(0, 600));
check("L3 duration logged", /耗时 \d+ms/.test(t3));
check("L3 result ok", !!r.result, JSON.stringify(r));

// L4 错误路径：黑名单拒绝同样留痕（含 error 事件）
loggerMod.clearLog();
setLists([], ["https://evil.example.com"]);
r = await loggerMod.runWithLog("upload_asset", { path: "photo.png", url: "https://evil.example.com/up" },
  () => call({ path: "photo.png", url: "https://evil.example.com/up" }));
const t4 = loggerMod.getLogText();
check("L4 error event", t4.includes("upload_asset [ERROR] error |") && t4.includes("黑名单"), t4.slice(0, 400));

// L5 灰区弹窗：ask 判定与用户决策入日志
loggerMod.clearLog();
setLists([], []);
r = await withDialog("allow-once", undefined, () =>
  loggerMod.runWithLog("upload_asset", { path: "assets/photo.png", url: "https://gray.example.com/up" },
    () => call({ path: "assets/photo.png", url: "https://gray.example.com/up" })));
const t5 = loggerMod.getLogText();
check("L5 ask+decision logged", t5.includes("名单未命中") && t5.includes("allow-once"), t5.slice(0, 400));

// L6 持久化与重载恢复
await new Promise((res) => setTimeout(res, 20));
check("L6 persisted", logStore.saved != null && Array.isArray(logStore.saved.entries) && logStore.saved.entries.length > 0);
await loggerMod.initLogger(logStore, false); // 模拟插件重载：从存储恢复
check("L6 restored after reload", loggerMod.getLogEntries().length > 0 && loggerMod.getLogText().includes("名单未命中"));

// L7 环形缓冲上限：只保留最近记录
loggerMod.clearLog();
for (let i = 0; i < 2100; i++) loggerMod.logEvent("test", "e", "m" + i);
{
  const t7 = loggerMod.getLogText();
  check("L7 ring capped", loggerMod.getLogEntries().length < 2100 && t7.includes("m2099") && !t7.includes("m0 |"),
    String(loggerMod.getLogEntries().length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
