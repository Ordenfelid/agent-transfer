// 上传目标地址规则：scheme://host[:port]。路径与查询串不参与匹配；
// host 支持 "*"（任意主机）与 "*.<域名>"（匹配该域及其任意深度子域）。

export interface UrlRule {
    scheme: string; // http | https
    host: string; // 小写；"*" / "*.example.com" / 精确域名
    port: string; // 显式端口；空表示按协议默认端口（http:80 / https:443）
}

export interface RuleParseResult {
    rule?: UrlRule;
    error?: string;
}

const DEFAULT_PORT: Record<string, string> = { "http": "80", "https": "443" };

export function effectivePort(scheme: string, port: string): string {
    return port || DEFAULT_PORT[scheme] || "";
}

export function ruleToString(rule: UrlRule): string {
    return `${rule.scheme}://${rule.host}${rule.port ? ":" + rule.port : ""}`;
}

/** 解析一条规则文本；允许粘贴完整 URL（路径/锚点会被忽略），通配只支持最左侧整段 "*." */
export function parseRule(raw: string): RuleParseResult {
    const s = (raw ?? "").trim();
    if (!s) {
        return { error: "规则为空" };
    }
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s);
    if (!m) {
        return { error: `缺少 scheme://，应形如 https://example.com：${s}` };
    }
    const scheme = m[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
        return { error: `仅支持 http/https 规则，收到 ${scheme}://` };
    }
    const authority = s.slice(m[0].length).split(/[/?#]/, 1)[0];
    if (!authority) {
        return { error: `缺少主机名：${s}` };
    }
    if (authority.includes("@")) {
        return { error: "不支持 user@host 形式" };
    }
    let host = authority;
    let port = "";
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
        host = authority.slice(0, colon);
        port = authority.slice(colon + 1);
        if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
            return { error: `端口无效：${port}` };
        }
    }
    host = host.toLowerCase().replace(/\.$/, "");
    if (!host) {
        return { error: `缺少主机名：${s}` };
    }
    if (host.includes(":")) {
        return { error: `暂不支持 IPv6 规则：${host}` };
    }
    if (host === "*") {
        return { rule: { scheme, host, port } };
    }
    if (host.includes("*")) {
        if (!/^\*\.(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(host)) {
            return { error: `通配符只能作为最左侧整段主机名，如 *.example.com：${host}` };
        }
        return { rule: { scheme, host, port } };
    }
    if (!/^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(host)) {
        return { error: `主机名无效：${host}` };
    }
    return { rule: { scheme, host, port } };
}

/** 目标 URL 是否命中规则（scheme、主机、生效端口都需一致） */
export function matchRule(rule: UrlRule, target: URL): boolean {
    const scheme = target.protocol.replace(":", "").toLowerCase();
    if (scheme !== rule.scheme) {
        return false;
    }
    if (effectivePort(rule.scheme, rule.port) !== effectivePort(scheme, target.port)) {
        return false;
    }
    const host = target.hostname.toLowerCase();
    if (rule.host === "*") {
        return true;
    }
    if (rule.host.startsWith("*.")) {
        return host === rule.host.slice(2) || host.endsWith(rule.host.slice(1));
    }
    return host === rule.host;
}

/** 设置面板用：按行解析（空行与 # 注释跳过），返回去重后的规则与错误说明 */
export function parseRuleLines(lines: string): { rules: UrlRule[]; errors: string[] } {
    const rules: UrlRule[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const line of lines.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith("#")) {
            continue;
        }
        const { rule, error } = parseRule(s);
        if (!rule) {
            errors.push(`${s}：${error}`);
            continue;
        }
        const key = ruleToString(rule);
        if (!seen.has(key)) {
            seen.add(key);
            rules.push(rule);
        }
    }
    return { rules, errors };
}
