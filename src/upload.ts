// upload_asset 工具：把工作空间 assets 内的文件上传到指定 http(s) 链接。
// 默认发送原样二进制 body（POST/PUT）；multipart=true 时拼装 multipart/form-data
// （fileField 指定文件字段名，fields 附带文本字段）。
// 自定义请求头经 {{secrets.NAME}}/{{vars.NAME}} 模板取值，语义对齐内核
// http_request：secrets 按目标主机门控（allowedHosts 精确匹配），URL 只允许
// vars——明文凭据不进模型上下文，未解析占位符直接拒发。
// 目标地址经用户名单门控：黑名单直接拒绝；白名单静默上传；其余弹确认框，
// 用户可放行一次/拒绝一次/把（可改写成通配的）地址加入白名单或黑名单。

import { fetchSyncPost, showMessage } from "siyuan";
import { askUploadDecision } from "./dialog";
import { resolveAssetPath } from "./assets";
import { buildMultipart } from "./multipart";
import { ToolError, bytesToBase64, formatSize, parseTargetUrl } from "./download";
import { logEvent, redactHeaderValue, type SecretLike } from "./logger";
import { getSecretsVars, resolveTemplates, type UnresolvedRef } from "./secrets";
import { ruleToString } from "./patterns";
import { appendRule, checkUrl, type RulesStorage } from "./rules";

// 与内核 forwardProxy 的 32MB 响应/内存上限保持同量级
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
// 响应回传给模型的截断长度：常见 JSON 响应（含文件链接）需完整可读
const SNIPPET_MAX = 2048;

// 扩展名 → MIME，缺省 application/octet-stream
const MIME_BY_EXT: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
    json: "application/json", zip: "application/zip", "7z": "application/x-7z-compressed",
    gz: "application/gzip", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
    ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

interface IWindowSiyuan {
    siyuan: { config: { api: { token: string } } };
}

interface IForwardProxyData {
    body?: string;
    status?: number;
    err?: string;
    elapsed?: number;
}

interface IAssetFile {
    name: string;
    mime: string;
    bytes: Uint8Array;
}

export async function uploadAssetToUrl(
    args: Record<string, unknown>,
    storage: RulesStorage,
    i18n: Record<string, string>,
): Promise<{ result?: string; error?: string }> {
    const t = (key: string, fallback: string) => i18n?.[key] || fallback;
    try {
        const { secrets, vars } = getSecretsVars();

        // URL 只允许 {{vars.*}}：模型可控地址上插 secrets 等于把密钥发给任意主机，
        // 与内核 http_request 的策略一致。与内核相同，先插值再解析校验
        // （占位符可能位于主机位）；插值后完整校验协议与内网地址
        if (typeof args.url === "string" && /\{\{secrets\./.test(args.url)) {
            throw new ToolError(
                "url 中不允许使用 {{secrets.*}}（防止密钥被发往任意主机，与原生工具一致），请改用 {{vars.*}} 或直接给出地址",
            );
        }
        const urlOut = resolveTemplates(typeof args.url === "string" ? args.url : "", [], vars, "");
        throwIfUnresolved(urlOut.unresolved, "url");
        const target = parseTargetUrl(urlOut.text);
        logEvent("upload_asset", "target", `目标 ${target.href}`);

        const method = normalizeMethod(args.method);
        const multipart = normalizeMultipart(args.multipart);
        const fileField = normalizeFileField(args.fileField);
        const rawHeaders = normalizeStringMap(args.headers, "headers");
        const rawFields = normalizeStringMap(args.fields, "fields");
        if (!multipart && (Object.keys(rawFields).length || args.fileField !== undefined)) {
            throw new ToolError("fields/fileField 仅在 multipart=true 时有效，请同时设置 multipart=true");
        }

        const asset = await readAssetBytes(await resolveAssetPath(args.path));
        logEvent("upload_asset", "file", `附件 ${asset.name}（${formatSize(asset.bytes.length)}，${asset.mime}）`);

        const verdict = checkUrl(target);
        logEvent(
            "upload_asset",
            "verdict",
            verdict.verdict === "ask" ? "名单未命中，等待用户确认" : `命中${verdict.verdict === "allow" ? "白" : "黑"}名单：${verdict.matched}`,
        );
        if (verdict.verdict === "deny") {
            throw new ToolError(
                `目标地址命中黑名单（${verdict.matched}），已拒绝上传。如需调整请在插件设置中修改黑名单。`,
            );
        }
        if (verdict.verdict === "ask") {
            const decision = await askUploadDecision({
                filename: asset.name,
                size: asset.bytes.length,
                url: target.href,
                i18n,
            });
            logEvent(
                "upload_asset",
                "decision",
                `用户选择：${decision.action}${"rule" in decision ? `（${ruleToString(decision.rule)}）` : ""}`,
            );
            if (decision.action === "deny-once") {
                throw new ToolError("用户在确认弹窗中拒绝了本次上传（未加入名单）。");
            }
            if (decision.action === "blacklist") {
                await appendRule(storage, "blacklist", decision.rule);
                showMessage(`${t("uploadBlacklistAdded", "已加入黑名单：")}${ruleToString(decision.rule)}`);
                throw new ToolError(
                    `用户已将 ${ruleToString(decision.rule)} 加入黑名单，本次及后续对该地址的上传均被拒绝。`,
                );
            }
            if (decision.action === "whitelist") {
                await appendRule(storage, "whitelist", decision.rule);
                showMessage(`${t("uploadWhitelistAdded", "已加入白名单：")}${ruleToString(decision.rule)}`);
            }
        }

        // headers/fields 的值插值：secrets 按目标主机门控；残留占位符拒发
        const headers = interpolateMap(rawHeaders, target.hostname, secrets, vars, "headers");
        const fields = multipart
            ? interpolateMap(rawFields, target.hostname, secrets, vars, "fields")
            : {};
        logEvent(
            "upload_asset",
            "headers",
            `请求头 ${JSON.stringify(maskRecord(headers, secrets))}` +
                (multipart ? `，表单字段 ${JSON.stringify(maskRecord(fields, secrets))}` : ""),
        );

        let payload = asset.bytes;
        let contentType: string;
        if (multipart) {
            const built = buildMultipart({
                fields,
                fileField,
                filename: asset.name,
                mime: asset.mime,
                bytes: asset.bytes,
            });
            payload = built.body;
            contentType = built.contentType; // boundary 由插件控制，忽略用户 Content-Type
        } else {
            contentType = pickHeader(headers, "content-type") || asset.mime;
        }

        logEvent(
            "upload_asset",
            "request",
            `${method} ${target.href}，body ${formatSize(payload.length)}，Content-Type: ${contentType}`,
        );
        const { status, snippet, elapsed } = await httpUpload(
            target.href, method, contentType, stripContentType(headers), payload,
        );
        logEvent(
            "upload_asset",
            "response",
            `HTTP ${status}${elapsed != null ? `，耗时 ${elapsed}ms` : ""}${snippet ? `，响应 ${snippet}` : ""}`,
        );
        showMessage(`${t("uploadToastUploaded", "已上传")} ${asset.name} → ${target.origin}`);
        return {
            result:
                `已上传 ${asset.name}（${formatSize(asset.bytes.length)}）到 ${target.href}，远端返回 HTTP ${status}` +
                (elapsed != null ? `，耗时 ${elapsed}ms` : "") +
                (snippet ? `。响应内容：${snippet}` : "。"),
        };
    } catch (e) {
        if (e instanceof ToolError) {
            return { error: e.message };
        }
        return { error: `插件内部错误：${e instanceof Error ? e.message : String(e)}` };
    }
}

function normalizeMethod(raw: unknown): "POST" | "PUT" {
    const m = typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase() : "POST";
    if (m !== "POST" && m !== "PUT") {
        throw new ToolError(`method 仅支持 POST 或 PUT，收到的是 ${m}`);
    }
    return m;
}

function normalizeMultipart(raw: unknown): boolean {
    if (raw === undefined || raw === null) return false;
    if (typeof raw === "boolean") return raw;
    throw new ToolError(`multipart 仅接受布尔值，收到的是 ${typeof raw}`);
}

function normalizeFileField(raw: unknown): string {
    if (raw === undefined || raw === null) return "file";
    if (typeof raw !== "string" || !raw.trim()) {
        throw new ToolError("fileField 必须是非空字符串（multipart 文件字段名）");
    }
    return raw.replace(/[\r\n"]/g, "").trim().slice(0, 100);
}

/** headers/fields 共用的规范化：仅接受字符串到字符串的平面对象，拒绝换行注入 */
function normalizeStringMap(raw: unknown, name: string): Record<string, string> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new ToolError(`${name} 必须是字符串到字符串的对象，如 {"X-Token": "{{secrets.token}}"}`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const key = k.trim();
        if (!key) throw new ToolError(`${name} 的键不能为空`);
        if (/[\r\n]/.test(key)) throw new ToolError(`${name} 的键不能包含换行：${JSON.stringify(k)}`);
        if (typeof v !== "string") {
            throw new ToolError(`${name}.${k} 的值必须是字符串（可用 {{secrets.NAME}} 或 {{vars.NAME}} 引用）`);
        }
        if (/[\r\n]/.test(v)) throw new ToolError(`${name}.${k} 的值不能包含换行`);
        out[key] = v;
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
    for (const [k, v] of Object.entries(map)) {
        const r = resolveTemplates(v, secrets, vars, host);
        throwIfUnresolved(r.unresolved, `${where}.${k}`);
        out[k] = r.text;
    }
    return out;
}

/** 日志口径：插值后真正发出的值先脱敏（密钥明文→<secret:NAME>）再入日志 */
function maskRecord(map: Record<string, string>, secrets: SecretLike[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
        out[k] = redactHeaderValue(k, v, secrets);
    }
    return out;
}

function throwIfUnresolved(refs: UnresolvedRef[], where: string): void {
    if (!refs.length) return;
    const seen = new Set<string>();
    const detail = refs
        .filter((r) => {
            const key = `${r.kind}.${r.name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map((r) =>
            r.kind === "vars"
                ? `{{vars.${r.name}}}（变量未配置）`
                : r.exists
                    ? `{{secrets.${r.name}}}（该密钥未授权目标主机，需在其 allowedHosts 中添加）`
                    : `{{secrets.${r.name}}}（密钥未配置）`,
        )
        .join("、");
    throw new ToolError(
        `${where} 中存在未解析模板：${detail}。密钥与变量在 思源 设置 → AI 中配置，` +
            "配置前请勿把明文凭据直接写入参数（会留在对话记录里）",
    );
}

function pickHeader(headers: Record<string, string>, lowerName: string): string | null {
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lowerName && v.trim()) return v.trim();
    }
    return null;
}

/** Content-Type 经 forwardProxy 的 contentType 参数传递（内核在 headers 之后应用会覆盖），从头发数组剔除 */
function stripContentType(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() !== "content-type") out[k] = v;
    }
    return out;
}

async function readAssetBytes(relPath: string): Promise<IAssetFile> {
    const token = (window as unknown as IWindowSiyuan).siyuan.config.api.token;
    const resp = await fetch("/api/file/getFile", {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: JSON.stringify({ path: `/data/assets/${relPath}` }),
    });
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        const json = await resp.json().catch(() => null);
        throw new ToolError(`读取附件失败：${json?.msg || "文件不存在或不可读"}（${relPath}）`);
    }
    if (!resp.ok) {
        throw new ToolError(`读取附件失败：接口返回 HTTP ${resp.status}（${relPath}）`);
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (!bytes.length) {
        throw new ToolError(`附件内容为空：${relPath}`);
    }
    if (bytes.length > MAX_BYTES) {
        throw new ToolError(`文件超过 ${MAX_BYTES / 1024 / 1024}MB 的大小限制（实际 ${formatSize(bytes.length)}）`);
    }
    const name = relPath.split("/").pop() || relPath;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    return { name, mime: MIME_BY_EXT[ext] || "application/octet-stream", bytes };
}

async function httpUpload(
    url: string,
    method: "POST" | "PUT",
    contentType: string,
    headers: Record<string, string>,
    bytes: Uint8Array,
): Promise<{ status: number; snippet: string; elapsed?: number }> {
    const resp = await fetchSyncPost("/api/network/forwardProxy", {
        url,
        method,
        contentType,
        headers: Object.entries(headers).map(([k, v]) => ({ [k]: v })),
        payload: bytesToBase64(bytes),
        payloadEncoding: "base64",
        responseEncoding: "text",
        timeout: TIMEOUT_MS,
    });
    if (resp.code !== 0) {
        throw new ToolError(`上传失败：${resp.msg || "内核网络代理返回错误"}`);
    }
    const data: IForwardProxyData = resp.data ?? {};
    if (data.err) {
        throw new ToolError(`上传失败：${data.err}`);
    }
    const status = Number(data.status ?? 0);
    if (status < 200 || status >= 300) {
        throw new ToolError(`上传失败：远端返回 HTTP ${status}`);
    }
    let snippet = "";
    if (typeof data.body === "string" && data.body.trim()) {
        const text = data.body.trim();
        snippet = text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text;
    }
    return { status, snippet, elapsed: data.elapsed };
}
