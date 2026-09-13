import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require2 = createRequire(path.join(root, "package.json"));
const ts = require2("typescript");

const src = fs.readFileSync(path.join(root, "src/download.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;

const calls = [];
const siyuanStub = {
  fetchSyncPost: async (url, data) => { calls.push({ url, data }); return globalThis.__fpResp(data); },
};
const mod = { exports: {} };
new Function("require", "module", "exports", js)(
  (name) => { if (name === "siyuan") return siyuanStub; throw new Error("unexpected require " + name); },
  mod, mod.exports,
);
const { downloadToAsset } = mod.exports;

globalThis.window = { siyuan: { config: { api: { token: "test-token" } } } };
globalThis.__captured = {};
globalThis.fetch = async (url, init) => {
  globalThis.__captured = { url, headers: init.headers, form: init.body };
  return new Response(JSON.stringify(globalThis.__uploadResp), { status: 200, headers: { "content-type": "application/json" } });
};

const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]).toString("base64");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
