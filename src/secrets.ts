// {{secrets.NAME}} / {{vars.NAME}} 模板插值，语义对齐内核 http_request 工具的
// conf.ResolveSecretsVarsForHost：secrets 仅当目标主机在该密钥的 allowedHosts
// （大小写不敏感的精确匹配，空列表视为全拒）时替换；vars 无主机门槛。
// 密钥明文只存在于前端 window.siyuan.config（原生密钥设置界面同源读取），
// 绝不进入返回给模型的内容；未解析占位符由调用方决定是否拒发。

export interface ISecretItem {
    name: string;
    value: string;
    allowedHosts?: string[];
}

export interface IVarItem {
    name: string;
    value: string;
}

export interface UnresolvedRef {
    kind: "secrets" | "vars";
    name: string;
    /** 名称在密钥/变量库中存在（secrets 场景即"未授权该主机"而非"未配置"） */
    exists: boolean;
}

interface IWindowSiyuan {
    siyuan?: {
        config?: {
            secrets?: { items?: ISecretItem[] };
            variables?: { items?: IVarItem[] };
        };
    };
}

const TEMPLATE_RE = /\{\{(secrets|vars)\.([^}]+)\}\}/g;

/** 纯插值：返回替换后文本与未解析引用（原占位符保留在文本中） */
export function resolveTemplates(
    text: string,
    secrets: ISecretItem[],
    vars: IVarItem[],
    host: string,
): { text: string; unresolved: UnresolvedRef[] } {
    const unresolved: UnresolvedRef[] = [];
    const seen = new Set<string>();
    const report = (ref: UnresolvedRef) => {
        const key = `${ref.kind}.${ref.name}`;
        if (!seen.has(key)) {
            seen.add(key);
            unresolved.push(ref);
        }
    };
    const out = text.replace(TEMPLATE_RE, (whole, kind: string, rawName: string) => {
        const name = rawName.trim();
        if (kind === "vars") {
            const hit = vars.find((v) => v.name === name && typeof v.value === "string");
            if (hit) return hit.value;
            report({ kind: "vars", name, exists: vars.some((v) => v.name === name) });
            return whole;
        }
        const hit = secrets.find((s) => s.name === name && typeof s.value === "string");
        const lowerHost = host.trim().toLowerCase();
        const allowed = !!hit && !!lowerHost && (hit.allowedHosts ?? []).some(
            (h) => typeof h === "string" && h.trim().toLowerCase() === lowerHost,
        );
        if (allowed) return hit!.value;
        report({ kind: "secrets", name, exists: secrets.some((s) => s.name === name) });
        return whole;
    });
    return { text: out, unresolved };
}

/** 从 window.siyuan.config 读取密钥/变量（运行时明文，与原生设置界面同源） */
export function getSecretsVars(): { secrets: ISecretItem[]; vars: IVarItem[] } {
    const cfg = (window as unknown as IWindowSiyuan).siyuan?.config;
    const secrets = Array.isArray(cfg?.secrets?.items) ? cfg!.secrets!.items! : [];
    const vars = Array.isArray(cfg?.variables?.items) ? cfg!.variables!.items! : [];
    return { secrets, vars };
}
