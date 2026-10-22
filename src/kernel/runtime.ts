// 内核 API 访问层：siyuan.client.fetch（loopback，自动带插件 JWT=管理员）之上的
// 常用封装——JSON 调用、forwardProxy 出站、文件读取、密钥库读取、附件落盘。

import { ToolError } from "./errors";
import { concatBytes, utf8Encode } from "./codec";

interface KernelJsonResp {
    code?: number;
    msg?: string;
    data?: unknown;
}

export async function kernelPostJson(path: string, body: unknown): Promise<KernelJsonResp> {
    const resp = await siyuan.client.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    if (!resp.ok) {
        throw new ToolError(`内核接口 ${path} 返回 HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as KernelJsonResp | null;
    if (!json || typeof json !== "object") {
        throw new ToolError(`内核接口 ${path} 返回了无法解析的内容`);
    }
    return json;
}

function mustOk(path: string, json: KernelJsonResp): KernelJsonResp {
    if (json.code !== 0) {
        throw new ToolError(`内核接口 ${path} 失败：${json.msg || "code " + json.code}`);
    }
    return json;
}

export interface ForwardOptions {
    url: string;
    method: string;
    timeout: number;
    contentType?: string;
    headers?: Record<string, string>;
    payloadBase64?: string;
    responseEncoding?: string;
}

export interface ForwardResult {
    status?: number;
    body?: string;
    contentType?: string;
    err?: string;
    elapsed?: number;
}

/** 经 /api/network/forwardProxy 出站（内核 SSRF 拨号策略生效） */
export async function forwardProxy(opts: ForwardOptions): Promise<ForwardResult> {
    const payload: Record<string, unknown> = {
        url: opts.url,
        method: opts.method,
        timeout: opts.timeout,
    };
    if (opts.contentType !== undefined) {
        payload.contentType = opts.contentType;
    }
    if (opts.headers && Object.keys(opts.headers).length) {
        // forwardProxy 的 headers 是单键对象数组，内核逐个 SetHeader
        const arr: Array<Record<string, string>> = [];
        for (const key of Object.keys(opts.headers)) {
            const item: Record<string, string> = {};
            item[key] = opts.headers[key];
            arr.push(item);
        }
        payload.headers = arr;
    }
    if (opts.payloadBase64 !== undefined) {
        payload.payload = opts.payloadBase64;
        payload.payloadEncoding = "base64";
    }
    if (opts.responseEncoding) {
        payload.responseEncoding = opts.responseEncoding;
    }
    const json = mustOk("/api/network/forwardProxy", await kernelPostJson("/api/network/forwardProxy", payload));
    const data = (json.data ?? {}) as ForwardResult;
    if (data.err) {
        throw new ToolError(`内核网络代理出错：${data.err}`);
    }
    return data;
}

/** 读取工作空间内文件的原始字节（path 为 /data/ 开头的工作空间相对路径） */
export async function getFileBytes(path: string): Promise<Uint8Array> {
    const resp = await siyuan.client.fetch("/api/file/getFile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
    });
    const contentType = headerValue(resp.headers, "content-type") || "";
    if (!resp.ok || contentType.indexOf("application/json") >= 0) {
        let msg = "";
        try {
            const json = (await resp.json()) as KernelJsonResp | null;
            msg = (json && json.msg) || "";
        } catch {
            // ignore
        }
        throw new ToolError(`读取文件失败：${msg || "HTTP " + resp.status}（${path}）`);
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
}

export function headerValue(headers: Record<string, string>, lowerName: string): string | null {
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lowerName) {
            return headers[key];
        }
    }
    return null;
}

// ---- 密钥库（/api/system/getConf，插件 JWT 为管理员角色，与原生设置界面同源）----

export interface SecretItem {
    name: string;
    value?: string;
    allowedHosts?: string[];
}

export interface VarItem {
    name: string;
    value?: string;
}

export async function fetchSecretsVars(): Promise<{ secrets: SecretItem[]; vars: VarItem[] }> {
    const json = mustOk("/api/system/getConf", await kernelPostJson("/api/system/getConf", {}));
    const data = (json.data ?? {}) as {
        conf?: {
            secrets?: { items?: SecretItem[] };
            variables?: { items?: VarItem[] };
        };
    };
    const secrets = (data.conf && data.conf.secrets && data.conf.secrets.items) || [];
    const vars = (data.conf && data.conf.variables && data.conf.variables.items) || [];
    return { secrets, vars };
}

// ---- 附件落盘（/api/asset/upload：内容 hash 去重 + 时间戳改名防覆盖）----

/** 把字节以指定文件名存入工作空间 assets/，返回 assets 相对路径 */
export async function uploadAssetBytes(filename: string, mime: string, bytes: Uint8Array): Promise<string> {
    const boundary = "----AgentTransfer" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const parts: Uint8Array[] = [];
    const pushText = (text: string) => parts.push(utf8Encode(text));
    pushText(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="assetsDirPath"\r\n` +
        `\r\nassets\r\n`,
    );
    pushText(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file[]"; filename="${sanitizeMimeToken(filename)}"\r\n` +
        `Content-Type: ${mime || "application/octet-stream"}\r\n` +
        `\r\n`,
    );
    parts.push(bytes);
    pushText(`\r\n--${boundary}--\r\n`);

    const body = concatBytes(parts);
    const resp = await siyuan.client.fetch("/api/asset/upload", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
        body: body.buffer as ArrayBuffer,
    });
    if (!resp.ok) {
        throw new ToolError(`写入 assets 失败：接口返回 HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as {
        code?: number;
        msg?: string;
        data?: { errFiles?: string[]; succMap?: Record<string, string> };
    } | null;
    if (!json || json.code !== 0) {
        throw new ToolError(`写入 assets 失败：${(json && json.msg) || "code " + (json && json.code)}`);
    }
    const succMap = (json.data && json.data.succMap) || {};
    const path = succMap[filename] || firstValue(succMap);
    if (!path) {
        const failed = json.data && json.data.errFiles;
        const detail = failed && failed.length ? `（${failed.join("、")}）` : "";
        throw new ToolError(`写入 assets 失败：内核未返回文件路径${detail}`);
    }
    return String(path);
}

function firstValue(map: Record<string, string>): string | undefined {
    for (const key of Object.keys(map)) {
        return map[key];
    }
    return undefined;
}

/** MIME 头参数值消毒：去除引号与换行，防止破坏段头 */
function sanitizeMimeToken(s: string): string {
    return s.replace(/["\r\n]/g, " ").trim().slice(0, 200);
}
