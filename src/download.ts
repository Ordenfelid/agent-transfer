import { fetchSyncPost } from "siyuan";

// forwardProxy 会把响应体整个 base64 后载入内存，上限不能放开太大
const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

// 常见 MIME → 扩展名，用于补全/推断文件名
const EXT_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/html": "html",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/json": "json",
    "application/zip": "zip",
    "application/x-7z-compressed": "7z",
    "application/gzip": "gz",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

// 禁止下载指向本机/内网的地址：请求由内核在本机发出，等于借内核访问内网
const PRIVATE_HOST = /^(localhost$|.*\.local$|.*\.internal$|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

/** 工具层可预期错误：消息会原样返回给模型，用于其自我纠正 */
class ToolError extends Error {}

interface IWindowSiyuan {
    siyuan: { config: { api: { token: string } } };
}

interface IForwardProxyData {
    body?: string;
    content_type?: string;
    status?: number;
    err?: string;
}

export async function downloadToAsset(
    args: Record<string, unknown>,
): Promise<{ result?: string; error?: string }> {
    try {
        const target = parseTargetUrl(args.url);
        const requested = typeof args.filename === "string" ? sanitizeFilename(args.filename) : "";

        const { bytes, contentType } = await httpGet(target.href);

        const mime = (contentType.split(";")[0] || "").trim().toLowerCase();
        let filename = requested || inferFilename(target, contentType);
        if (!hasExt(filename)) {
            const ext = EXT_BY_MIME[mime];
            if (ext) {
                filename += "." + ext;
            }
        }

        const path = await uploadAsset(new File([bytes], filename, {
            type: mime || "application/octet-stream",
        }));

        return {
            result: `已下载并保存为 ${path}（${formatSize(bytes.length)}，${mime || "未知类型"}）。可在文档中直接使用该路径引用此附件。`,
        };
    } catch (e) {
        if (e instanceof ToolError) {
            return { error: e.message };
        }
        return { error: `插件内部错误：${e instanceof Error ? e.message : String(e)}` };
    }
}

function parseTargetUrl(raw: unknown): URL {
    if (typeof raw !== "string" || !raw.trim()) {
        throw new ToolError("参数 url 缺失或不是字符串，请提供完整的 http(s) 链接");
    }
    let target: URL;
    try {
        target = new URL(raw.trim());
    } catch {
        throw new ToolError(`无效的 URL：${raw.trim()}`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new ToolError(`仅支持 http/https 协议，收到的是 ${target.protocol}`);
    }
    if (PRIVATE_HOST.test(target.hostname)) {
        throw new ToolError(`拒绝下载内网或本机地址：${target.hostname}`);
    }
    return target;
}

function sanitizeFilename(name: string): string {
    // 去掉可能的路径部分与控制字符，只留文件名本身
    name = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (name === "." || name === "..") {
        name = "";
    }
    return name.slice(0, 120);
}

function inferFilename(target: URL, contentType: string): string {
    let name = "";
    const last = target.pathname.split("/").pop() ?? "";
    try {
        name = sanitizeFilename(decodeURIComponent(last));
    } catch {
        name = sanitizeFilename(last);
    }
    if (!name || !hasExt(name)) {
        const ext = EXT_BY_MIME[(contentType.split(";")[0] || "").trim().toLowerCase()];
        name = (name || "download") + (ext ? "." + ext : ".bin");
    }
    return name;
}

function hasExt(name: string): boolean {
    return /\.[a-z0-9]{1,8}$/i.test(name);
}

async function httpGet(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
    const resp = await fetchSyncPost("/api/network/forwardProxy", {
        url,
        method: "GET",
        contentType: "",
        headers: [],
        payload: "",
        responseEncoding: "base64",
        timeout: TIMEOUT_MS,
    });
    if (resp.code !== 0) {
        throw new ToolError(`下载失败：${resp.msg || "内核网络代理返回错误"}`);
    }
    const data: IForwardProxyData = resp.data ?? {};
    if (data.err) {
        throw new ToolError(`下载失败：${data.err}`);
    }
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
    const bytes = base64ToBytes(data.body);
    if (bytes.length === 0) {
        throw new ToolError("下载失败：响应内容为空");
    }
    return { bytes, contentType: data.content_type ?? "" };
}

async function uploadAsset(file: File): Promise<string> {
    const form = new FormData();
    form.append("assetsDirPath", "/assets/");
    form.append("file[]", file, file.name);

    const token = (window as unknown as IWindowSiyuan).siyuan.config.api.token;
    const resp = await fetch("/api/asset/upload", {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: form,
    });
    if (!resp.ok) {
        throw new ToolError(`上传到 assets 失败：接口返回 HTTP ${resp.status}`);
    }
    const json = await resp.json();
    if (json.code !== 0) {
        throw new ToolError(`上传到 assets 失败：${json.msg || "code " + json.code}`);
    }
    const succMap = json.data?.succMap as Record<string, string> | undefined;
    const path = succMap?.[file.name] ?? (succMap && Object.values(succMap)[0]);
    if (!path) {
        const detail = json.data?.err ? `（${json.data.err}）` : "";
        throw new ToolError(`上传到 assets 失败：内核未返回文件路径${detail}`);
    }
    return String(path);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

function formatSize(n: number): string {
    if (n >= 1024 * 1024) {
        return (n / 1024 / 1024).toFixed(1) + " MB";
    }
    if (n >= 1024) {
        return (n / 1024).toFixed(1) + " KB";
    }
    return n + " B";
}
