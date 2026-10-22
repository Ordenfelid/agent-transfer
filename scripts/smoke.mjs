// kernel 模块单测：不依赖真内核，桩掉全局 siyuan（client.fetch / logger / plugin / agent）。
// 端到端验证对着真实内核的 MCP /mcp 进行，不在此文件覆盖。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require2 = createRequire(path.join(root, "package.json"));
const ts = require2("typescript");

// ---------- 模块加载器：src/kernel/*.ts -> CommonJS ----------
function compile(file) {
  const src = fs.readFileSync(path.join(root, "src", "kernel", file), "utf8");
  return ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
}

const registry = {};
function load(name) {
  if (registry[name]) return registry[name].exports;
  const mod = { exports: {} };
  registry[name] = mod;
  const req = (id) => {
    if (!id.startsWith("./")) throw new Error("unexpected require " + id);
    return load(id.slice(2).replace(/\.ts$/, "") + ".ts");
  };
  new Function("require", "module", "exports", compile(name))(req, mod, mod.exports);
  return mod.exports;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}
const errOf = (fn) => { try { fn(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const errOfAsync = (p) => p.then(() => "", (e) => (e instanceof Error ? e.message : String(e)));

// ---------- 全局桩 ----------
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const pngB64 = Buffer.from(pngBytes).toString("base64");

const fpCalls = [];
const uploads = [];
const readDirCalls = [];
const getFileCalls = [];
const registered = [];
let readDirEntries = [
  { name: "photo.png", updated: 300 },
  { name: "empty.png", updated: 1 },
  { name: "sub", isDir: true, updated: 1 },
];
let fileBytes = pngBytes;
let fpResponder = () => ({ status: 200, contentType: "image/png", body: pngB64, elapsed: 5 });
let uploadResponse = { code: 0, msg: "", data: { succMap: { "photo.png": "assets/photo-20260913120000-abcd.png" } } };
let confItems = { secrets: [], vars: [] };

const jsonResp = (obj) => ({
  ok: true, status: 200, headers: { "Content-Type": "application/json" },
  text: async () => JSON.stringify(obj), json: async () => obj,
  arrayBuffer: async () => new Uint8Array(Buffer.from(JSON.stringify(obj))).buffer,
});

globalThis.siyuan = {
  client: {
    fetch: async (url, init) => {
      if (url === "/api/network/forwardProxy") {
        fpCalls.push(JSON.parse(init.body));
        return jsonResp({ code: 0, data: fpResponder() });
      }
      if (url === "/api/file/readDir") {
        readDirCalls.push(JSON.parse(init.body));
        return jsonResp({ code: 0, data: readDirEntries });
      }
      if (url === "/api/file/getFile") {
        getFileCalls.push(JSON.parse(init.body));
        if (fileBytes === null) return jsonResp({ code: -1, msg: "file not found" });
        return {
          ok: true, status: 200, headers: { "Content-Type": "application/octet-stream" },
          text: async () => "", json: async () => ({}),
          arrayBuffer: async () => new Uint8Array(fileBytes).buffer,
        };
      }
      if (url === "/api/asset/upload") {
        uploads.push({ headers: init.headers, body: Buffer.from(init.body) });
        return jsonResp(uploadResponse);
      }
      if (url === "/api/system/getConf") {
        return jsonResp({ code: 0, data: { conf: { secrets: { items: confItems.secrets }, variables: { items: confItems.vars } } } });
      }
      throw new Error("unexpected api " + url);
    },
  },
  logger: { info() {}, warn() {}, error() {} },
  plugin: { i18n: {}, lifecycle: {} },
  agent: {
    registerCapability: async (name, cfg, handler) => { registered.push({ name, cfg, handler }); },
    unregisterCapability: async (name) => {
      const i = registered.findIndex((r) => r.name === name);
      if (i >= 0) registered.splice(i, 1);
    },
  },
};

// ---------- 一、codec ----------
const codec = load("codec.ts");
check("C1 normalize ws+base64url+pad", codec.normalizeBase64(" a-b\n") === "a+b=");
check("C2 normalize 余1 throws", errOf(() => codec.normalizeBase64("abcde")).includes("余 1"));
check("C3 invalid char throws", errOf(() => codec.normalizeBase64("ab*d")).includes("字母表"));
{
  const rt = codec.base64ToBytes(pngB64);
  check("C4 decode", Buffer.from(rt).equals(Buffer.from(pngBytes)));
  check("C5 encode", codec.bytesToBase64(rt) === pngB64);
  // 摘掉全局 Buffer 强制走纯 JS 路径（内核 goja 侧的兜底分支）
  const savedBuffer = globalThis.Buffer;
  delete globalThis.Buffer;
  try {
    const rt2 = codec.base64ToBytes(pngB64);
    check("C6 pure-js roundtrip", savedBuffer.compare(savedBuffer.from(rt2), savedBuffer.from(pngBytes)) === 0 && codec.bytesToBase64(rt2) === pngB64);
  } finally {
    globalThis.Buffer = savedBuffer;
  }
}
check("C7 utf8 cjk+surrogate", Buffer.from(codec.utf8Encode("a中😀")).equals(Buffer.from("a中😀", "utf8")));
check("C8 concat", Buffer.from(codec.concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])])).equals(Buffer.from([1, 2, 3])));

// ---------- 二、neturl ----------
const nu = load("neturl.ts");
{
  const u = nu.parseHttpUrl("https://User:Pw@Example.COM:8443/a/b?x=1#frag");
  check("N1 userinfo stripped+lower", u.host === "example.com" && u.port === "8443" && u.scheme === "https");
  check("N1 pathname/search/origin", u.pathname === "/a/b" && u.search === "?x=1" && u.origin === "https://example.com:8443");
  check("N2 default port empty", nu.parseHttpUrl("http://example.com/x").port === "");
  check("N3 not-a-url", errOf(() => nu.parseHttpUrl("example.com/x")).includes("http(s)"));
  check("N4 ftp", errOf(() => nu.parseHttpUrl("ftp://example.com/a")).includes("http(s)"));
  check("N5 bad port", errOf(() => nu.parseHttpUrl("http://example.com:0/")).includes("端口"));
  check("N5 port 65536", errOf(() => nu.parseHttpUrl("http://example.com:65536/")).includes("端口"));
  check("N6 ipv6", errOf(() => nu.parseHttpUrl("http://[::1]/")).includes("IPv6"));
  for (const h of ["127.0.0.1", "10.1.2.3", "192.168.1.9", "169.254.1.1", "172.16.0.1", "172.31.255.255", "localhost", "nas.local", "git.internal"]) {
    check(`N7 private ${h}`, errOf(() => nu.parseHttpUrl(`http://${h}/x`)).includes("内网"));
  }
  check("N8 172.32 public ok", nu.parseHttpUrl("http://172.32.1.1/x").host === "172.32.1.1");
  check("N9 extByMime", nu.extByMime(nu.mimeOfContentType("image/png; charset=binary")) === "png");
  check("N9 mimeByFilename", nu.mimeByFilename("a.docx").includes("wordprocessingml"));
  check("N10 sanitize traversal", nu.sanitizeFilename("..\\..\\evil.png") === "evil.png" && nu.sanitizeFilename("..") === "");
  check("N10 sanitize control chars", nu.sanitizeFilename("a\u0000b.png") === "ab.png");
  check("N11 inferFilename from url", nu.inferFilename(nu.parseHttpUrl("https://cdn.example.com/imgs/cover.jpg?w=100"), "") === "cover.jpg");
  check("N11 inferFilename fallback+ext", nu.inferFilename(nu.parseHttpUrl("https://example.com/files/xyz"), "application/pdf") === "xyz.pdf");
  check("N12 formatSize", nu.formatSize(1024) === "1.0 KB" && nu.formatSize(33554432) === "32.0 MB");
}

// ---------- 三、interpolate ----------
const interp = load("interpolate.ts");
const SEC = [{ name: "tok", value: "sec-val", allowedHosts: ["Upload.Example.COM"] }];
const VARS = [{ name: "base", value: "https://v.example.com" }];
check("I1 secret on allowed host (case-insens)", interp.resolveTemplates("{{secrets.tok}}", SEC, [], "upload.example.com").text === "sec-val");
{
  const out = interp.resolveTemplates("{{secrets.tok}}", SEC, [], "other.example.com");
  check("I2 other host unresolved+exists", out.text === "{{secrets.tok}}" && out.unresolved.length === 1 && out.unresolved[0].kind === "secrets" && out.unresolved[0].exists === true);
}
{
  const out = interp.resolveTemplates("{{secrets.tok}}", [{ name: "tok", value: "v", allowedHosts: [] }], [], "upload.example.com");
  check("I3 empty allowlist denies", out.text === "{{secrets.tok}}" && out.unresolved[0].exists === true);
}
check("I4 missing secret not-exists", interp.resolveTemplates("{{secrets.nope}}", SEC, [], "x.com").unresolved[0].exists === false);
check("I5 var ungated", interp.resolveTemplates("{{vars.base}}", SEC, VARS, "any.com").text === "https://v.example.com");
{
  const out = interp.resolveTemplates("{{vars.nope}}", SEC, VARS, "x.com");
  check("I6 missing var", out.text === "{{vars.nope}}" && out.unresolved[0].kind === "vars" && out.unresolved[0].exists === false);
}
check("I7 surrounding text", interp.resolveTemplates("Bearer {{secrets.tok}}-x", SEC, [], "upload.example.com").text === "Bearer sec-val-x");
{
  const out = interp.resolveTemplates("{{secrets.tok}} {{vars.nope}} {{secrets.tok}}", SEC, VARS, "other.example.com");
  check("I8 dup refs once", out.unresolved.length === 2);
}
check("I9 throw msg secret-unauth", errOf(() => interp.throwIfUnresolved(interp.resolveTemplates("{{secrets.tok}}", SEC, [], "other.com").unresolved, "h")).includes("未授权目标主机"));
check("I9 throw msg secret-missing", errOf(() => interp.throwIfUnresolved(interp.resolveTemplates("{{secrets.nope}}", SEC, [], "x.com").unresolved, "h")).includes("密钥未配置"));
check("I9 throw msg var-missing", errOf(() => interp.throwIfUnresolved(interp.resolveTemplates("{{vars.nope}}", SEC, VARS, "x.com").unresolved, "h")).includes("变量未配置"));

// ---------- 四、assets 路径解析 ----------
const am = load("assets.ts");
check("A1 bare name", am.normalizeAssetRelPath("photo.png") === "photo.png");
check("A1 assets/ prefix stripped", am.normalizeAssetRelPath("assets/sub/photo.png") === "sub/photo.png");
check("A1 backslash+query+hash", am.normalizeAssetRelPath("assets\\photo.png?x=1#f") === "photo.png");
check("A2 traversal rejected", errOf(() => am.normalizeAssetRelPath("../conf.json")).includes("不合法"));
check("A2 empty segment rejected", errOf(() => am.normalizeAssetRelPath("assets//x.png")).includes("不合法"));
check("A2 assets dir only rejected", errOf(() => am.normalizeAssetRelPath("assets")).includes("文件名"));
check("A2 missing arg rejected", errOf(() => am.normalizeAssetRelPath(undefined)).includes("path"));
check("A3 exact match", await am.resolveAssetPath("assets/photo.png") === "photo.png");
readDirEntries = [{ name: "photo-20260913120000-abcd.png", updated: 9 }];
check("A4 fuzzy timestamp unique", await am.resolveAssetPath("photo.png") === "photo-20260913120000-abcd.png");
readDirEntries = [
  { name: "photo-20260913120000-abcd.png", updated: 9 },
  { name: "photo-20260910100000-ffff.png", updated: 8 },
];
{
  const m = await errOfAsync(am.resolveAssetPath("photo.png"));
  check("A5 multiple candidates error", m.includes("photo-20260913120000-abcd.png") && m.includes("photo-20260910100000-ffff.png"));
}
readDirEntries = [{ name: "other.png", updated: 1 }];
check("A6 not found", (await errOfAsync(am.resolveAssetPath("photo.png"))).includes("未找到"));
readDirEntries = [
  { name: "sub", isDir: true, updated: 1 },
  { name: "photo-20260913120000-abcd.png", updated: 9 },
];
check("A7 dirs skipped in fuzzy", await am.resolveAssetPath("photo.png") === "photo-20260913120000-abcd.png");
readDirEntries = [{ name: "photo.png", updated: 1 }];
check("A8 subdir readDir path", await am.resolveAssetPath("assets/sub/photo.png") === "sub/photo.png" && readDirCalls.at(-1).path === "/data/assets/sub/");

// ---------- 五、download_asset ----------
const { downloadAsset, uploadAsset } = load("transfer.ts");
const lastFp = () => fpCalls.at(-1);
const lastUpload = () => uploads.at(-1);
{
  check("D1 missing both", (await errOfAsync(downloadAsset({}))).includes("二选一"));
  check("D1 both given", (await errOfAsync(downloadAsset({ url: "https://example.com/a.png", dataBase64: pngB64 }))).includes("二选一"));
  check("D2 b64 needs filename", (await errOfAsync(downloadAsset({ dataBase64: pngB64 }))).includes("filename"));
  check("D2 invalid b64", (await errOfAsync(downloadAsset({ dataBase64: "ab*d", filename: "x.png" }))).includes("base64"));
}
{
  uploads.length = 0;
  const r = await downloadAsset({ dataBase64: pngB64.replace(/\+/g, "-").replace(/\//g, "_"), filename: "diagram.png" });
  check("D3 b64url saved", r.result.includes("assets/photo-20260913120000-abcd.png") && r.result.includes("12 B"));
  const up = lastUpload();
  check("D3 upload multipart w/ filename", up.headers["Content-Type"].startsWith("multipart/form-data; boundary=") && up.body.includes('filename="diagram.png"') && up.body.includes(Buffer.from(pngBytes)));
}
{
  uploads.length = 0; fpCalls.length = 0;
  const r = await downloadAsset({ url: "https://cdn.example.com/imgs/cover.jpg?w=100" });
  check("D4 url mode result", r.result.includes("assets/photo-20260913120000-abcd.png"));
  check("D4 fp GET base64", lastFp().method === "GET" && lastFp().responseEncoding === "base64" && lastFp().url === "https://cdn.example.com/imgs/cover.jpg?w=100");
  check("D4 upload filename from url", lastUpload().body.includes('filename="cover.jpg"'));
}
{
  uploads.length = 0;
  await downloadAsset({ url: "https://example.com/getfile?id=9", filename: "doc" });
  check("D5 ext from content-type", lastUpload().body.includes('filename="doc.png"'));
}
{
  fpResponder = () => ({ status: 404, contentType: "text/html", body: "" });
  check("D6 404 surfaced", (await errOfAsync(downloadAsset({ url: "https://example.com/missing.png" }))).includes("404"));
  fpResponder = () => ({ status: 200, contentType: "image/png", body: "" });
  check("D6 empty body", (await errOfAsync(downloadAsset({ url: "https://example.com/a.png" }))).includes("为空"));
  fpResponder = () => ({ status: 200, contentType: "image/png", body: pngB64, err: "dial timeout" });
  check("D6 kernel proxy err", (await errOfAsync(downloadAsset({ url: "https://example.com/a.png" }))).includes("dial timeout"));
  fpResponder = () => ({ status: 200, contentType: "image/png", body: pngB64, elapsed: 5 });
}
check("D7 loopback rejected", (await errOfAsync(downloadAsset({ url: "http://127.0.0.1:6806/api/file/putFile" }))).includes("内网"));
{
  fpResponder = () => ({ status: 200, contentType: "image/png", body: "A".repeat(Math.floor(33554432 * 4 / 3) + 100) });
  check("D8 oversize", (await errOfAsync(downloadAsset({ url: "https://example.com/big.png" }))).includes("32MB"));
  fpResponder = () => ({ status: 200, contentType: "image/png", body: pngB64, elapsed: 5 });
}
{
  uploadResponse = { code: 1, msg: "assets dir not exist" };
  check("D9 upload failure", (await errOfAsync(downloadAsset({ url: "https://example.com/a.png" }))).includes("assets dir not exist"));
  uploadResponse = { code: 0, data: { errFiles: ["a.png"] } };
  check("D9 succMap missing", (await errOfAsync(downloadAsset({ url: "https://example.com/a.png" }))).includes("路径"));
  uploadResponse = { code: 0, msg: "", data: { succMap: { "photo.png": "assets/photo-20260913120000-abcd.png" } } };
}

// ---------- 六、upload_asset ----------
const UP = "https://upload.example.com/up";
confItems = {
  secrets: [
    { name: "tok", value: "sec-val", allowedHosts: ["upload.example.com"] },
    { name: "elsewhere", value: "other-val", allowedHosts: ["other.example.com"] },
  ],
  vars: [
    { name: "base", value: "https://upload.example.com" },
    { name: "cmt", value: "hello" },
  ],
};

check("U1 secrets in url rejected", (await errOfAsync(uploadAsset({ path: "photo.png", url: "https://upload.example.com/up?t={{secrets.tok}}" }))).includes("url 中不允许"));
{
  fpCalls.length = 0;
  const r = await uploadAsset({ path: "photo.png", url: UP, headers: { "X-Token": "{{secrets.tok}}", Accept: "application/json" } });
  const fp = lastFp();
  check("U2 raw upload ok", r.result.includes("HTTP 200") && r.result.includes(UP));
  check("U2 path resolved+read", getFileCalls.at(-1).path === "/data/assets/photo.png");
  check("U2 raw payload base64", fp.method === "POST" && fp.payloadEncoding === "base64" && fp.payload === pngB64 && fp.contentType === "image/png");
  check("U2 secret header injected", fp.headers.some((h) => h["X-Token"] === "sec-val") && fp.headers.some((h) => h.Accept === "application/json"));
}
{
  const fpBefore = fpCalls.length;
  check("U3 unauth host refuses", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP, headers: { "X-T": "{{secrets.elsewhere}}" } }))).includes("未授权目标主机") && fpCalls.length === fpBefore);
  check("U3 missing secret", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP, headers: { "X-T": "{{secrets.nope}}" } }))).includes("密钥未配置"));
  check("U3 missing var", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP, headers: { "X-T": "{{vars.nope}}" } }))).includes("变量未配置"));
}
{
  await uploadAsset({ path: "photo.png", url: UP, headers: { "content-type": "application/x-custom" } });
  const fp = lastFp();
  check("U4 user content-type wins", fp.contentType === "application/x-custom" && !(fp.headers || []).some((h) => Object.keys(h).some((k) => k.toLowerCase() === "content-type")));
}
{
  await uploadAsset({ path: "photo.png", url: "{{vars.base}}/up" });
  check("U5 vars in url", lastFp().url === "https://upload.example.com/up");
  confItems.vars = [{ name: "base", value: "http://192.168.1.9" }, { name: "cmt", value: "hello" }];
  check("U5 vars to private rejected", (await errOfAsync(uploadAsset({ path: "photo.png", url: "{{vars.base}}/x" }))).includes("内网"));
  confItems.vars = [
    { name: "base", value: "https://upload.example.com" },
    { name: "cmt", value: "hello" },
  ];
}
{
  fpResponder = () => ({ status: 500, contentType: "text/plain", body: "boom" });
  check("U6 remote 500", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP }))).includes("500"));
  fpResponder = () => ({ status: 201, contentType: "application/json", body: "{\"url\":\"https://files.example.com/x.png\"}", elapsed: 12 });
  const r = await uploadAsset({ path: "photo.png", url: UP });
  check("U6 201+elapsed+body", r.result.includes("HTTP 201") && r.result.includes("耗时 12ms") && r.result.includes("files.example.com"));
  fpResponder = () => ({ status: 200, contentType: "text/plain", body: "x".repeat(3000), elapsed: 5 });
  const r2 = await uploadAsset({ path: "photo.png", url: UP });
  check("U6 snippet capped 2KB", r2.result.includes("…") && !r2.result.includes("x".repeat(2500)));
  fpResponder = () => ({ status: 200, contentType: "image/png", body: pngB64, elapsed: 5 });
}
{
  fpCalls.length = 0;
  await uploadAsset({
    path: "photo.png", url: UP, multipart: true, fileField: "file1",
    fields: { comment: "{{vars.cmt}}" },
    headers: { "X-Token": "{{secrets.tok}}", "Content-Type": "text/plain" },
  });
  const fp = lastFp();
  const ok = fp.contentType.startsWith("multipart/form-data; boundary=");
  const b = ok ? fp.contentType.split("boundary=")[1] : "";
  const body = Buffer.from(fp.payload, "base64");
  const text = body.toString("latin1");
  check("U7 multipart channel", ok && fp.payloadEncoding === "base64");
  check("U7 header injected & user CT dropped", fp.headers.some((h) => h["X-Token"] === "sec-val") && !fp.headers.some((h) => Object.keys(h).some((k) => k.toLowerCase() === "content-type")));
  check("U7 field interpolated before file", text.indexOf('name="comment"') < text.indexOf('name="file1"') && text.includes('Content-Disposition: form-data; name="comment"\r\n\r\nhello\r\n'));
  check("U7 file part framing+bytes", text.includes('Content-Disposition: form-data; name="file1"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n') && body.includes(Buffer.from(pngBytes)));
  check("U7 closing boundary", text.endsWith(`\r\n--${b}--\r\n`));
}
{
  check("U8 fields need multipart", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP, fields: { a: "b" } }))).includes("multipart=true"));
  check("U8 bad method", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP, method: "GET" }))).includes("POST"));
  check("U8 multipart bool", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP, multipart: "yes" }))).includes("布尔"));
  check("U8 CRLF rejected", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP, headers: { "X-T": "a\r\nb" } }))).includes("换行"));
  check("U8 header value string", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP, headers: { "X-T": 123 } }))).includes("字符串"));
  check("U8 traversal path", (await errOfAsync(uploadAsset({ path: "../conf/conf.json", url: UP }))).includes("不合法"));
  check("U8 missing path", (await errOfAsync(uploadAsset({ url: UP }))).includes("path"));
}
{
  readDirEntries = [{ name: "photo.png", updated: 1 }, { name: "empty.png", updated: 1 }];
  fileBytes = new Uint8Array(0);
  check("U9 empty file", (await errOfAsync(uploadAsset({ path: "empty.png", url: UP }))).includes("为空"));
  fileBytes = new Uint8Array(33554432 + 1);
  check("U9 oversize", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP }))).includes("32MB"));
  fileBytes = pngBytes;
  readDirEntries = [{ name: "other.png", updated: 1 }];
  check("U9 not found in dir", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP }))).includes("未找到"));
  readDirEntries = [{ name: "photo.png", updated: 1 }];
  fileBytes = null;
  check("U9 getFile error", (await errOfAsync(uploadAsset({ path: "photo.png", url: UP }))).includes("file not found"));
  fileBytes = pngBytes;
}
{
  fpResponder = () => ({ status: 201, contentType: "text/plain", body: "ok", elapsed: 1 });
  await uploadAsset({ path: "photo.png", url: UP, method: "put" });
  check("U10 PUT passthrough", lastFp().method === "PUT");
  readDirEntries = [{ name: "photo-20260913120000-abcd.png", updated: 9 }];
  await uploadAsset({ path: "photo.png", url: UP });
  check("U10 fuzzy path in flow", getFileCalls.at(-1).path === "/data/assets/photo-20260913120000-abcd.png");
  readDirEntries = [{ name: "photo.png", updated: 1 }];
  fpResponder = () => ({ status: 200, contentType: "image/png", body: pngB64, elapsed: 5 });
}

// ---------- 七、注册面 ----------
load("index.ts");
await globalThis.siyuan.plugin.lifecycle.onload();
check("R1 two capabilities", registered.length === 2 && registered.map((r) => r.name).sort().join(",") === "download_asset,upload_asset");
{
  const dl = registered.find((r) => r.name === "download_asset");
  const up = registered.find((r) => r.name === "upload_asset");
  check("R1 effects", !!dl.cfg.effects?.dataEgress && !!dl.cfg.effects?.localWrite && !!up.cfg.effects?.localRead && !!up.cfg.effects?.dataEgress);
  check("R1 schema+desc present", !!dl.cfg.inputSchema && !!up.cfg.inputSchema && up.cfg.inputSchema.required.includes("path") && typeof dl.cfg.description === "string" && typeof up.cfg.description === "string");
}
await globalThis.siyuan.plugin.lifecycle.onunload();
check("R2 unload unregisters", registered.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
