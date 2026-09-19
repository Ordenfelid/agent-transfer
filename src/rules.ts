// 上传目标名单（白/黑）的运行时状态与持久化。
// 持久化经插件 data 目录（saveData/loadData），内容为规则文本数组，
// 加载时逐条重新解析，损坏/失效条目直接丢弃，保证状态永远可用。

import { matchRule, parseRule, ruleToString, type UrlRule } from "./patterns";

export interface UploadRules {
    whitelist: UrlRule[];
    blacklist: UrlRule[];
}

/** 只依赖 loadData/saveData，测试时可传入假实现 */
export interface RulesStorage {
    loadData(storageName: string): Promise<any>;
    saveData(storageName: string, content: any): Promise<any>;
}

const STORAGE_NAME = "upload-rules.json";

let rules: UploadRules = { whitelist: [], blacklist: [] };

export function getRules(): UploadRules {
    return rules;
}

export function setRules(next: UploadRules): void {
    rules = next;
}

export async function loadRules(storage: RulesStorage): Promise<void> {
    try {
        const raw = await storage.loadData(STORAGE_NAME);
        if (!raw) {
            return;
        }
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const revive = (list: unknown): UrlRule[] => {
            if (!Array.isArray(list)) {
                return [];
            }
            return list
                .map((item) => parseRule(String(item)))
                .filter((r) => r.rule)
                .map((r) => r.rule as UrlRule);
        };
        rules = { whitelist: revive(parsed?.whitelist), blacklist: revive(parsed?.blacklist) };
    } catch {
        rules = { whitelist: [], blacklist: [] };
    }
}

export async function saveRules(storage: RulesStorage, next: UploadRules): Promise<void> {
    rules = next;
    await storage.saveData(
        STORAGE_NAME,
        JSON.stringify(
            {
                whitelist: next.whitelist.map(ruleToString),
                blacklist: next.blacklist.map(ruleToString),
            },
            null,
            2,
        ),
    );
}

/** 弹窗「加入名单」用：追加到指定名单末尾；同一地址两个名单互斥、自身去重 */
export async function appendRule(storage: RulesStorage, list: "whitelist" | "blacklist", rule: UrlRule): Promise<void> {
    const next: UploadRules = {
        whitelist: [...rules.whitelist],
        blacklist: [...rules.blacklist],
    };
    const key = ruleToString(rule);
    const dup = (r: UrlRule) => ruleToString(r) === key;
    // 名单互斥：加入一边时从另一边移除，黑名单优先级靠 checkUrl 的判定顺序保证
    next.whitelist = list === "blacklist" ? next.whitelist.filter((r) => !dup(r)) : next.whitelist;
    next.blacklist = list === "whitelist" ? next.blacklist.filter((r) => !dup(r)) : next.blacklist;
    next[list] = next[list].filter((r) => !dup(r));
    next[list].push(rule);
    await saveRules(storage, next);
}

export type UrlVerdict =
    | { verdict: "allow"; matched: string }
    | { verdict: "deny"; matched: string }
    | { verdict: "ask" };

/** 黑名单优先于白名单；两边都不命中时需要弹窗确认 */
export function checkUrl(url: URL): UrlVerdict {
    for (const r of rules.blacklist) {
        if (matchRule(r, url)) {
            return { verdict: "deny", matched: ruleToString(r) };
        }
    }
    for (const r of rules.whitelist) {
        if (matchRule(r, url)) {
            return { verdict: "allow", matched: ruleToString(r) };
        }
    }
    return { verdict: "ask" };
}
