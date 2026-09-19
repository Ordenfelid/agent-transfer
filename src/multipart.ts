// multipart/form-data 手工拼装：文本字段在前、文件字段在后，boundary 由本模块
// 生成并随 contentType 返回（forwardProxy 的 contentType 参数需带同一 boundary）。
// 拼好的整体作为二进制 payload 走 base64 通道，内核不做任何解析。

export interface IMultipartInput {
    fields: Record<string, string>;
    fileField: string;
    filename: string;
    mime: string;
    bytes: Uint8Array;
}

export function buildMultipart(input: IMultipartInput): { body: Uint8Array; contentType: string } {
    const boundary = "----SiyuanDownloadAsset" +
        Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const pushText = (s: string) => parts.push(enc.encode(s));

    for (const [name, value] of Object.entries(input.fields)) {
        pushText(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${sanitizeToken(name)}"\r\n` +
            `\r\n${value}\r\n`,
        );
    }
    pushText(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${sanitizeToken(input.fileField)}"; filename="${sanitizeToken(input.filename)}"\r\n` +
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
function sanitizeToken(s: string): string {
    return s.replace(/["\r\n]/g, " ").trim().slice(0, 200);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
