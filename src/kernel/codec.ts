// 字节与编码工具。内核 goja 运行时没有 atob/btoa，base64 优先走 buffer 模块
// 注入的 Buffer（Go 实现，MB 级数据可接受），拿不到时退回纯 JS 实现。
// 纯 JS 路径逐字节循环，避免 String.fromCharCode 展开造成的调用栈溢出。

interface NodeBufferLike {
    toString(encoding: string): string;
}

interface NodeBufferCtor {
    from(data: string | Uint8Array, encoding?: string): NodeBufferLike;
}

function getBuffer(): NodeBufferCtor | null {
    try {
        const candidate = (globalThis as { Buffer?: NodeBufferCtor }).Buffer;
        if (candidate && typeof candidate.from === "function") {
            return candidate;
        }
    } catch {
        // ignore
    }
    try {
        // 经 globalThis.require 动态取模块：require 由内核注入为全局；
        // 模块名运行时拼接，避免打包器把 require("buffer") 当成 Node 内置依赖静态外置成空桩。
        const req = (globalThis as { require?: (id: string) => unknown }).require;
        if (typeof req === "function") {
            const mod = req("buf" + "fer") as { Buffer?: NodeBufferCtor };
            if (mod && mod.Buffer && typeof mod.Buffer.from === "function") {
                return mod.Buffer;
            }
        }
    } catch {
        // ignore
    }
    return null;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) {
    B64_LOOKUP[B64_ALPHABET.charAt(i)] = i;
}

/** 校验并规范化 base64 输入：去空白、兼容 base64url（-_ → +/）、补齐 padding */
export function normalizeBase64(raw: string): string {
    let s = raw.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (s.length % 4 === 1) {
        throw new Error("长度不合法（余 1）");
    }
    while (s.length % 4 !== 0) {
        s += "=";
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
        throw new Error("包含 base64 字母表之外的字符");
    }
    return s;
}

export function base64ToBytes(b64: string): Uint8Array {
    const bufferCtor = getBuffer();
    if (bufferCtor) {
        return bufferCtor.from(b64, "base64") as unknown as Uint8Array;
    }
    return base64ToBytesJs(b64);
}

function base64ToBytesJs(b64: string): Uint8Array {
    // 丢弃 padding，按 4 字符 → 3 字节解出
    const clean = b64.replace(/=+$/, "");
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let acc = 0;
    let bits = 0;
    let pos = 0;
    for (let i = 0; i < clean.length; i++) {
        const v = B64_LOOKUP[clean.charAt(i)];
        if (v === undefined) {
            throw new Error(`位置 ${i} 的字符不在 base64 字母表内`);
        }
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[pos++] = (acc >> bits) & 0xff;
        }
    }
    return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
    const bufferCtor = getBuffer();
    if (bufferCtor) {
        return bufferCtor.from(bytes).toString("base64");
    }
    return bytesToBase64Js(bytes);
}

function bytesToBase64Js(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
        out += B64_ALPHABET.charAt(b0 >> 2);
        out += B64_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >= 0 ? b1 >> 4 : 0));
        out += b1 >= 0 ? B64_ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >= 0 ? b2 >> 6 : 0)) : "=";
        out += b2 >= 0 ? B64_ALPHABET.charAt(b2 & 0x3f) : "=";
    }
    return out;
}

/** 纯 JS UTF-8 编码（含代理对），用于 multipart 文本段等小字符串 */
export function utf8Encode(text: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                i++;
            }
        }
        if (code < 0x80) {
            out.push(code);
        } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
            out.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
            );
        }
    }
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) {
        bytes[i] = out[i];
    }
    return bytes;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) {
        total += part.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
