// {{secrets.NAME}} / {{vars.NAME}} 模板插值，语义对齐内核 http_request 工具：
// secrets 仅当目标主机在该密钥的 allowedHosts（大小写不敏感精确匹配，空列表=全拒）
// 时替换；vars 无主机门槛。密钥明文只经内核接口进入内存，绝不进入返回给模型的
// 内容；未解析占位符由调用方决定拒发。

import { ToolError } from "./errors";
import type { SecretItem, VarItem } from "./runtime";

export interface UnresolvedRef {
    kind: "secrets" | "vars";
    name: string;
    /** 名称在库中存在（secrets 场景即「未授权该主机」而非「未配置」） */
    exists: boolean;
}

const TEMPLATE_RE = /\{\{(secrets|vars)\.([^}]+)\}\}/g;

/** 纯插值：返回替换后文本与未解析引用（原占位符保留在文本中） */
export function resolveTemplates(
    text: string,
    secrets: SecretItem[],
    vars: VarItem[],
    host: string,
): { text: string; unresolved: UnresolvedRef[] } {
    const unresolved: UnresolvedRef[] = [];
    const seen: Record<string, boolean> = {};
    const report = (ref: UnresolvedRef) => {
        const key = ref.kind + "." + ref.name;
        if (!seen[key]) {
            seen[key] = true;
            unresolved.push(ref);
        }
    };
    const out = text.replace(TEMPLATE_RE, (whole: string, kind: string, rawName: string) => {
        const name = rawName.trim();
        if (kind === "vars") {
            for (const item of vars) {
                if (item.name === name && typeof item.value === "string") {
                    return item.value;
                }
            }
            report({ kind: "vars", name, exists: vars.some((v) => v.name === name) });
            return whole;
        }
        let hit: SecretItem | undefined;
        for (const item of secrets) {
            if (item.name === name && typeof item.value === "string") {
                hit = item;
                break;
            }
        }
        const lowerHost = host.trim().toLowerCase();
        const allowedHosts = (hit && hit.allowedHosts) || [];
        let allowed = false;
        if (hit && lowerHost) {
            for (const h of allowedHosts) {
                if (typeof h === "string" && h.trim().toLowerCase() === lowerHost) {
                    allowed = true;
                    break;
                }
            }
        }
        if (allowed && hit) {
            return hit.value as string;
        }
        report({ kind: "secrets", name, exists: secrets.some((s) => s.name === name) });
        return whole;
    });
    return { text: out, unresolved };
}

export function throwIfUnresolved(refs: UnresolvedRef[], where: string): void {
    if (!refs.length) {
        return;
    }
    const seen: Record<string, boolean> = {};
    const parts: string[] = [];
    for (const ref of refs) {
        const key = ref.kind + "." + ref.name;
        if (seen[key]) {
            continue;
        }
        seen[key] = true;
        parts.push(
            ref.kind === "vars"
                ? `{{vars.${ref.name}}}（变量未配置）`
                : ref.exists
                    ? `{{secrets.${ref.name}}}（该密钥未授权目标主机，需在其 allowedHosts 中添加）`
                    : `{{secrets.${ref.name}}}（密钥未配置）`,
        );
    }
    throw new ToolError(
        `${where} 中存在未解析模板：${parts.join("、")}。密钥与变量在 思源 设置 → AI 中配置，` +
        "配置前请勿把明文凭据直接写入参数（会留在对话记录里）",
    );
}
