// 两个 Agent 工具的实现：
// - downloadAsset：url 模式经 forwardProxy 拉取后落盘；dataBase64 模式直接解码落盘
// - uploadAsset：读取 assets 内文件，headers/fields 支持 {{secrets.NAME}}/{{vars.NAME}}
//   插值（secrets 按目标主机门控），raw 或 multipart 经 forwardProxy 发出
// 出站请求一律经内核 forwardProxy（SSRF 拨号策略生效），落盘走 /api/asset/upload。

import { ToolError } from "./errors";
import { base64ToBytes, bytesToBase64, concatBytes, normalizeBase64, utf8Encode } from "./codec";
import {
    extByMime,
    formatSize,
    hasExt,
    inferFilename,
    mimeByFilename,
    mimeOfContentType,
    parseHttpUrl,
    sanitizeFilename,
} from "./neturl";
import { fetchSecretsVars, forwardProxy, getFileBytes, uploadAssetBytes } from "./runtime";
import { resolveAssetPath } from "./assets";
import { resolveTemplates, throwIfUnresolved } from "./interpolate";

// 与内核 forwardProxy 的 32MB 响应/内存上限保持同量级
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
// 响应回传给模型的截断长度：常见 JSON 响应（含文件链接）需完整可读
const SNIPPET_MAX = 2048;

export async function downloadAsset(args: Record<string, unknown>): Promise<{ result: string }> {
    const hasUrl = typeof args.url === "string" && !!args.url.trim();
    const hasB64 = typeof args.dataBase64 === "string" && !!(args.dataBase64 as string).trim();
    if (hasUrl === hasB64) {
        throw new ToolError("url 与 dataBase64 必须二选一（恰好提供一个）");
    }
    const requested = typeof args.filename === "string" ? sanitizeFilename(args.filename) : "";

    let bytes: Uint8Array;
    let filename: string;
    let mime: string;
    if (hasUrl) {
        const target = parseHttpUrl(args.url as string);
        siyuan.logger.info(`download_asset: GET ${target.href}${requested ? " filename=" + requested : ""}`);
        const data = await forwardProxy({
            url: target.href,
            method: "GET",
            timeout: TIMEOUT_MS,
            contentType: "",
            responseEncoding: "base64",
        });
        const status = Number(data.status ?? 0);
        if (status < 200 || status >= 300) {
            throw new ToolError(`下载失败：远端返回 HTTP ${status}`);
        }
        if (typeof data.body !== "string" || !data.body) {
            throw new ToolError("下载失败：响应内容为空，请确认链接指向具体文件而非网页");
        }
        // base64 解码前先按 4/3 估体积，避免超限文件白白解码
        if (data.body.length * 3 / 4 > MAX_BYTES) {
            throw new ToolError(`文件超过 ${MAX_BYTES / 1024 / 1024}MB 的大小限制`);
        }
        bytes = base64ToBytes(data.body);
        if (!bytes.length) {
            throw new ToolError("下载失败：响应内容为空");
        }
        mime = mimeOfContentType(data.contentType || "");
        filename = requested || inferFilename(target, data.contentType || "");
        if (!hasExt(filename)) {
            const ext = extByMime(mime);
            if (ext) {
                filename += "." + ext;
            }
        }
    } else {
        if (!requested) {
            throw new ToolError("使用 dataBase64 时必须同时提供 filename（含扩展名），否则无法确定保存的文件名");
        }
        let b64: string;
        try {
            b64 = normalizeBase64(args.dataBase64 as string);
        } catch (e) {
            throw new ToolError(`dataBase64 不是合法的 base64 字符串：${e instanceof Error ? e.message : String(e)}`);
        }
        if (b64.length * 3 / 4 > MAX_BYTES) {
            throw new ToolError(`文件超过 ${MAX_BYTES / 1024 / 1024}MB 的大小限制`);
        }
        bytes = base64ToBytes(b64);
        if (!bytes.length) {
            throw new ToolError("dataBase64 解码后内容为空");
        }
        filename = requested;
        mime = mimeByFilename(filename);
        siyuan.logger.info(`download_asset: base64 直灌 ${formatSize(bytes.length)} → ${filename}`);
    }

    const path = await uploadAssetBytes(filename, mime, bytes);
    return {
        result:
            `已保存为 ${path}（${formatSize(bytes.length)}${mime ? "，" + mime : ""}）。` +
            "可在文档中直接使用该路径引用此附件。",
    };
}

// ---- upload_asset ----

interface MultipartBuilt {
    body: Uint8Array;
    contentType: string;
}

export async function uploadAsset(args: Record<string, unknown>): Promise<{ result: string }> {
    // URL 只允许 {{vars.*}}：模型可控地址上插 secrets 等于把密钥发给任意主机，
    // 与内核 http_request 的策略一致。与内核相同，先插值再解析校验
    // （占位符可能位于主机位）；插值后完整校验协议与内网地址
    if (typeof args.url === "string" && /\{\{secrets\./.test(args.url)) {
        throw new ToolError(
            "url 中不允许使用 {{secrets.*}}（防止密钥被发往任意主机，与原生工具一致），请改用 {{vars.*}} 或直接给出地址",
        );
    }
    const { secrets, vars } = await fetchSecretsVars();
    const urlRaw = typeof args.url === "string" ? args.url : "";
    const urlOut = resolveTemplates(urlRaw, [], vars, "");
    throwIfUnresolved(urlOut.unresolved, "url");
    const target = parseHttpUrl(urlOut.text);

    const method = normalizeMethod(args.method);
    const multipart = normalizeMultipart(args.multipart);
    const fileField = normalizeFileField(args.fileField);
    const rawHeaders = normalizeStringMap(args.headers, "headers");
    const rawFields = normalizeStringMap(args.fields, "fields");
    if (!multipart && (Object.keys(rawFields).length || args.fileField !== undefined)) {
        throw new ToolError("fields/fileField 仅在 multipart=true 时有效，请同时设置 multipart=true");
    }

    const relPath = await resolveAssetPath(args.path);
    const bytes = await getFileBytes("/data/assets/" + relPath);
    if (!bytes.length) {
        throw new ToolError(`附件内容为空：${relPath}`);
    }
    if (bytes.length > MAX_BYTES) {
        throw new ToolError(`文件超过 ${MAX_BYTES / 1024 / 1024}MB 的大小限制（实际 ${formatSize(bytes.length)}）`);
    }
    const filename = relPath.split("/").pop() || relPath;
    const mime = mimeByFilename(filename);

    // headers/fields 的值插值：secrets 按目标主机门控；残留占位符拒发。
    // 日志只记请求头名字，插值后的值不落日志
    const headers = interpolateMap(rawHeaders, target.host, secrets, vars, "headers");
    const fields = interpolateMap(rawFields, target.host, secrets, vars, "fields");
    siyuan.logger.info(
        `upload_asset: ${method} ${target.origin} file=${filename}（${formatSize(bytes.length)}）` +
        `${Object.keys(headers).length ? " headers=" + Object.keys(headers).join(",") : ""}`,
    );

    let payload: Uint8Array;
    let contentType: string;
    if (multipart) {
        const built = buildMultipart({
            fields,
            fileField,
            filename,
            mime,
            bytes,
        });
        payload = built.body;
        contentType = built.contentType; // boundary 由插件控制，忽略用户 Content-Type
    } else {
        payload = bytes;
        contentType = pickHeader(headers, "content-type") || mime;
    }

    const data = await forwardProxy({
        url: target.href,
        method,
        timeout: TIMEOUT_MS,
        contentType,
        headers: stripContentType(headers),
        payloadBase64: bytesToBase64(payload),
        responseEncoding: "text",
    });
    const status = Number(data.status ?? 0);
    if (status < 200 || status >= 300) {
        throw new ToolError(`上传失败：远端返回 HTTP ${status}`);
    }
    let snippet = "";
    if (typeof data.body === "string" && data.body.trim()) {
        const text = data.body.trim();
        snippet = text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text;
    }
    return {
        result:
            `已上传 ${filename}（${formatSize(bytes.length)}）到 ${target.href}，远端返回 HTTP ${status}` +
            (data.elapsed != null ? `，耗时 ${data.elapsed}ms` : "") +
            (snippet ? `。响应内容：${snippet}` : "。"),
    };
}

function normalizeMethod(raw: unknown): "POST" | "PUT" {
    const m = typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase() : "POST";
    if (m !== "POST" && m !== "PUT") {
        throw new ToolError(`method 仅支持 POST 或 PUT，收到的是 ${m}`);
    }
    return m;
}

function normalizeMultipart(raw: unknown): boolean {
    if (raw === undefined || raw === null) {
        return false;
    }
    if (typeof raw === "boolean") {
        return raw;
    }
    throw new ToolError(`multipart 仅接受布尔值，收到的是 ${typeof raw}`);
}

function normalizeFileField(raw: unknown): string {
    if (raw === undefined || raw === null) {
        return "file";
    }
    if (typeof raw !== "string" || !raw.trim()) {
        throw new ToolError("fileField 必须是非空字符串（multipart 文件字段名）");
    }
    return raw.replace(/[\r\n"]/g, "").trim().slice(0, 100);
}

/** headers/fields 共用的规范化：仅接受字符串到字符串的平面对象，拒绝换行注入 */
function normalizeStringMap(raw: unknown, name: string): Record<string, string> {
    if (raw === undefined || raw === null) {
        return {};
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new ToolError(`${name} 必须是字符串到字符串的对象，如 {"X-Token": "{{secrets.token}}"}`);
    }
    const out: Record<string, string> = {};
    for (const key of Object.keys(raw as Record<string, unknown>)) {
        const value = (raw as Record<string, unknown>)[key];
        const k = key.trim();
        if (!k) {
            throw new ToolError(`${name} 的键不能为空`);
        }
        if (/[\r\n]/.test(k)) {
            throw new ToolError(`${name} 的键不能包含换行：${JSON.stringify(key)}`);
        }
        if (typeof value !== "string") {
            throw new ToolError(`${name}.${key} 的值必须是字符串（可用 {{secrets.NAME}} 或 {{vars.NAME}} 引用）`);
        }
        if (/[\r\n]/.test(value)) {
            throw new ToolError(`${name}.${key} 的值不能包含换行`);
        }
        out[k] = value;
    }
    return out;
}

function interpolateMap(
    map: Record<string, string>,
    host: string,
    secrets: Parameters<typeof resolveTemplates>[1],
    vars: Parameters<typeof resolveTemplates>[2],
    where: string,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(map)) {
        const r = resolveTemplates(map[key], secrets, vars, host);
        throwIfUnresolved(r.unresolved, `${where}.${key}`);
        out[key] = r.text;
    }
    return out;
}

function pickHeader(headers: Record<string, string>, lowerName: string): string | null {
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lowerName && headers[key].trim()) {
            return headers[key].trim();
        }
    }
    return null;
}

/** Content-Type 经 forwardProxy 的 contentType 参数传递（内核在 headers 之后应用会覆盖），从头发数组剔除 */
function stripContentType(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== "content-type") {
            out[key] = headers[key];
        }
    }
    return out;
}

// multipart/form-data 手工拼装：文本字段在前、文件字段在后，boundary 由本模块
// 生成并随 contentType 返回（forwardProxy 的 contentType 参数需带同一 boundary）。
// 拼好的整体作为二进制 payload 走 base64 通道，内核不做任何解析。

interface MultipartInput {
    fields: Record<string, string>;
    fileField: string;
    filename: string;
    mime: string;
    bytes: Uint8Array;
}

function buildMultipart(input: MultipartInput): MultipartBuilt {
    const boundary = "----AgentTransfer" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const parts: Uint8Array[] = [];
    const pushText = (s: string) => parts.push(utf8Encode(s));

    for (const name of Object.keys(input.fields)) {
        pushText(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${sanitizeMimeToken(name)}"\r\n` +
            `\r\n${input.fields[name]}\r\n`,
        );
    }
    pushText(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${sanitizeMimeToken(input.fileField)}"; filename="${sanitizeMimeToken(input.filename)}"\r\n` +
        `Content-Type: ${input.mime}\r\n` +
        `\r\n`,
    );
    parts.push(input.bytes);
    pushText(`\r\n--${boundary}--\r\n`);

    return {
        body: concatBytes(parts),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

/** 头部参数值消毒：去除引号与换行，防止破坏 MIME 段头 */
function sanitizeMimeToken(s: string): string {
    return s.replace(/["\r\n]/g, " ").trim().slice(0, 200);
}
