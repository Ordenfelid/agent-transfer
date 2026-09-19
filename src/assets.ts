// assets 路径宽松解析：agent 可只写原始文件名，自动匹配思源插入附件时
// 加上的 `-YYYYMMDDHHMMSS-随机串` 时间戳后缀。流程：readDir 目标目录 →
// 精确匹配 → 后缀模糊匹配 → 唯一命中即用，多命中报错列出候选。

import { ToolError } from "./download";

interface IWindowSiyuan {
    siyuan: { config: { api: { token: string } } };
}

export interface IDirEntry {
    name: string;
    isDir?: boolean;
    updated?: number;
}

/** 规范化为 assets 内的相对路径（无 assets/ 前缀，拒绝任何越段/空段） */
export function normalizeAssetRelPath(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) {
        throw new ToolError("参数 path 缺失或不是字符串，请提供 assets 下的文件路径或文件名");
    }
    let p = raw.trim().replace(/\\/g, "/");
    p = p.split("?")[0].split("#")[0].replace(/^\/+/, "");
    if (p.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) {
        throw new ToolError(`路径不合法（不允许相对段）：${raw}`);
    }
    if (p === "assets") {
        throw new ToolError("path 仅给出了 assets 目录本身，请附带文件名");
    }
    if (p.startsWith("assets/")) {
        p = p.slice("assets/".length);
    }
    return p;
}

/** 解析出 assets 内真实存在的路径；找不到或多义时抛 ToolError 引导模型自纠 */
export async function resolveAssetPath(raw: unknown): Promise<string> {
    const rel = normalizeAssetRelPath(raw);
    const slash = rel.lastIndexOf("/");
    const dir = slash === -1 ? "" : rel.slice(0, slash);
    const base = slash === -1 ? rel : rel.slice(slash + 1);

    const files = (await listAssetDir(dir)).filter((e) => !e.isDir);
    const exact = files.find((e) => e.name === base);
    if (exact) {
        return dir ? `${dir}/${base}` : base;
    }

    const dot = base.lastIndexOf(".");
    if (dot > 0 && dot < base.length - 1) {
        const stem = base.slice(0, dot);
        const ext = base.slice(dot + 1);
        const re = new RegExp(`^${escapeRegExp(stem)}-\\d{14}-.+\\.${escapeRegExp(ext)}$`);
        const hits = files.filter((e) => re.test(e.name));
        if (hits.length === 1) {
            return dir ? `${dir}/${hits[0].name}` : hits[0].name;
        }
        if (hits.length > 1) {
            const names = hits.map((h) => h.name).sort().join("、");
            throw new ToolError(
                `assets/${dir} 下有多个与 ${base} 对应的时间戳后缀文件：${names}。请在 path 中给出完整文件名后重试`,
            );
        }
    }
    throw new ToolError(
        `assets 中未找到 ${rel}（已尝试时间戳后缀模糊匹配）。请确认文件已存在于工作空间 assets 目录`,
    );
}

async function listAssetDir(dir: string): Promise<IDirEntry[]> {
    const token = (window as unknown as IWindowSiyuan).siyuan.config.api.token;
    const dirPath = `/data/assets/${dir ? dir + "/" : ""}`;
    const resp = await fetch("/api/file/readDir", {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: JSON.stringify({ path: dirPath }),
    });
    if (!resp.ok) {
        throw new ToolError(`读取 assets 目录失败：接口返回 HTTP ${resp.status}（${dirPath}）`);
    }
    const json = await resp.json().catch(() => null);
    if (!json || json.code !== 0) {
        throw new ToolError(`读取 assets 目录失败：${json?.msg || "未知错误"}（${dirPath}）`);
    }
    return Array.isArray(json.data) ? json.data : [];
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
