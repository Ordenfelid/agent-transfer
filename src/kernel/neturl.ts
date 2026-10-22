// http(s) URL 解析与文件名推断。内核 goja 没有WHATWG URL，这里手工解析
// 仅覆盖工具实际需要的字段；内网/本机地址一律拒绝（请求由内核在本机发出）。

import { ToolError } from "./errors";

export interface HttpUrl {
    href: string;
    scheme: string; // http | https
    host: string; // 小写主机名（不含端口）
    port: string; // 显式端口；空表示协议默认
    origin: string;
    pathname: string;
    search: string;
}

// 与 v0.4.1 前端版相同的私网/本机判据（内核 SSRF 拨号之外的第二道防线）
const PRIVATE_HOST = /^(localhost$|.*\.local$|.*\.internal$|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/i;

const URL_RE = /^(https?):\/\/([^/?#]*)([^#]*)/i;

export function parseHttpUrl(raw: string): HttpUrl {
    const s = raw.trim();
    const m = URL_RE.exec(s);
    if (!m) {
        throw new ToolError(`无效的 URL（需要完整 http(s) 链接）：${s}`);
    }
    const scheme = m[1].toLowerCase();
    let authority = m[2];
    if (authority.indexOf("@") >= 0) {
        authority = authority.slice(authority.lastIndexOf("@") + 1);
    }
    let host = authority;
    let port = "";
    const colon = authority.lastIndexOf(":");
    if (colon >= 0 && authority.indexOf("]") < 0) {
        host = authority.slice(0, colon);
        port = authority.slice(colon + 1);
        if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
            throw new ToolError(`URL 端口无效：${s}`);
        }
    }
    host = host.toLowerCase().replace(/\.$/, "");
    if (!host) {
        throw new ToolError(`URL 缺少主机名：${s}`);
    }
    if (host.indexOf(":") >= 0 || host.indexOf("[") >= 0) {
        throw new ToolError(`不支持 IPv6 地址：${s}`);
    }
    if (!/^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(host)) {
        throw new ToolError(`URL 主机名无效：${host}`);
    }
    if (PRIVATE_HOST.test(host)) {
        throw new ToolError(`拒绝访问内网或本机地址：${host}`);
    }
    let rest = m[3] || "/";
    if (!rest.startsWith("/")) {
        rest = "/" + rest;
    }
    const q = rest.indexOf("?");
    const pathname = q === -1 ? rest : rest.slice(0, q);
    const search = q === -1 ? "" : rest.slice(q);
    return {
        href: s,
        scheme,
        host,
        port,
        origin: scheme + "://" + host + (port ? ":" + port : ""),
        pathname,
        search,
    };
}

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

export function mimeOfContentType(contentType: string): string {
    return (contentType.split(";")[0] || "").trim().toLowerCase();
}

export function mimeByFilename(filename: string): string {
    const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
    return MIME_BY_EXT[ext] || "application/octet-stream";
}

export function extByMime(mime: string): string | undefined {
    return EXT_BY_MIME[mime];
}

export function sanitizeFilename(name: string): string {
    // 去掉可能的路径部分与控制字符，只留文件名本身
    const parts = name.split(/[\\/]/);
    let out = (parts[parts.length - 1] || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (out === "." || out === "..") {
        out = "";
    }
    return out.slice(0, 120);
}

export function inferFilename(target: HttpUrl, contentType: string): string {
    const segs = target.pathname.split("/");
    let name = "";
    const last = segs[segs.length - 1] || "";
    try {
        name = sanitizeFilename(decodeURIComponent(last));
    } catch {
        name = sanitizeFilename(last);
    }
    if (!name || !hasExt(name)) {
        const ext = EXT_BY_MIME[mimeOfContentType(contentType)];
        name = (name || "download") + (ext ? "." + ext : ".bin");
    }
    return name;
}

export function hasExt(name: string): boolean {
    return /\.[a-z0-9]{1,8}$/i.test(name);
}

export function formatSize(n: number): string {
    if (n >= 1024 * 1024) {
        return (n / 1024 / 1024).toFixed(1) + " MB";
    }
    if (n >= 1024) {
        return (n / 1024).toFixed(1) + " KB";
    }
    return n + " B";
}
