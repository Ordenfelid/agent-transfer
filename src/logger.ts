// Agent 调用日志：定位「工具调用到底卡在哪一步」。
// 每次工具调用记录入参、流程内关键分支（目标/名单判定/用户决策/请求头/
// 请求与响应）与最终返回/错误及耗时；环形缓冲保留最近若干条，随插件数据
// 防抖持久化（重载插件不丢），可在设置页导出为文本。
//
// 密钥安全（与工具本身的口径一致，明文凭据绝不入日志）：
// - 入参记录的是模型给出的原始值，{{secrets.*}}/{{vars.*}} 占位符本身不含
//   明文，原样保留；敏感名头（Authorization/X-Token 等）上的明文值整体打码；
// - 插值后真正发出的请求头在记录前把密钥明文替换为 <secret:NAME>；
// - {{vars.*}} 变量按内核语义视为非敏感（常用于拼 URL），原样记录。

export type LogLevel = "info" | "warn" | "error";

export interface AgentLogEntry {
    t: number; // epoch ms
    call: number | null; // 调用序号；invoke/done/error 一定有，过程事件跟随当前调用
    tool: string;
    level: LogLevel;
    event: string;
    msg: string;
}

/** 只依赖 loadData/saveData，与 RulesStorage 同理，测试可传假实现 */
export interface LoggerStorage {
    loadData(storageName: string): Promise<any>;
    saveData(storageName: string, content: any): Promise<any>;
}

/** redactSecrets 系列接受的密钥形状（secrets.ts 的 ISecretItem 的子集） */
export interface SecretLike {
    name: string;
    value: string;
}

const STORAGE_NAME = "agent-log.json";
const MAX_ENTRIES = 2000; // 环形缓冲上限，约覆盖百余次完整调用
const MAX_STR = 300; // 单值截断长度
const MAX_MSG = 2000; // 单条日志截断长度
const PERSIST_DEBOUNCE = 2000;
// 值可能是明文凭据的头名（命中即整体打码，宁严勿漏）
const SENSITIVE_KEY_RE = /authorization|token|secret|cookie|passwd|password|api-?key|private-?key/i;

let entries: AgentLogEntry[] = [];
let seq = 0;
let storage: LoggerStorage | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorConsole = true;
// 当前调用序号：runWithLog 执行期间有效，过程事件据此归属。宿主逐个执行
// 工具调用；若未来并发，过程事件可能归到相邻调用，但时间线仍按 t 可读
let currentCall: number | null = null;

/** onload 时调用：绑定持久化并恢复历史日志。mirrorConsole=false 供测试静音 */
export async function initLogger(s: LoggerStorage, consoleMirror = true): Promise<void> {
    storage = s;
    mirrorConsole = consoleMirror;
    try {
        const raw = await s.loadData(STORAGE_NAME);
        if (!raw) {
            return;
        }
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const list: unknown[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
        entries = list.filter(isEntry).slice(-MAX_ENTRIES);
        for (const e of entries) {
            seq = Math.max(seq, e.call ?? 0);
        }
    } catch {
        // 日志存储损坏直接弃用，绝不影响插件功能
    }
}

function isEntry(e: unknown): e is AgentLogEntry {
    const o = e as Partial<AgentLogEntry> | null;
    return !!o && typeof o.t === "number" && typeof o.tool === "string" &&
        typeof o.event === "string" && typeof o.msg === "string";
}

/** 过程事件：由工具流程内的关键分支调用（target/verdict/decision/request…） */
export function logEvent(tool: string, event: string, msg: string, level: LogLevel = "info"): void {
    push({ t: Date.now(), call: currentCall, tool, level, event, msg: truncate(msg, MAX_MSG) });
}

/** 包装 agent handler：记录入参、返回/错误与耗时；自身绝不吞异常 */
export async function runWithLog<T extends { result?: string; error?: string }>(
    tool: string,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
): Promise<T> {
    const call = ++seq;
    const prev = currentCall;
    const start = Date.now();
    currentCall = call;
    logEvent(tool, "invoke", `参数 ${sanitizeArgs(args)}`);
    try {
        const out = await fn();
        if (out && typeof out.error === "string" && out.error) {
            logEvent(tool, "error", out.error, "error");
        } else {
            logEvent(tool, "done", `返回 ${truncate(out?.result ?? "", MAX_STR)}（耗时 ${Date.now() - start}ms）`);
        }
        return out;
    } catch (e) {
        // handler 按约定不抛出；兜底记录后原样上抛给宿主
        logEvent(tool, "error", `插件未捕获异常：${e instanceof Error ? e.message : String(e)}`, "error");
        throw e;
    } finally {
        currentCall = prev;
        void persistNow(); // 调用收尾立即落盘；过程中的事件只靠防抖
    }
}

function push(e: AgentLogEntry): void {
    entries.push(e);
    if (entries.length > MAX_ENTRIES) {
        entries.splice(0, entries.length - MAX_ENTRIES);
    }
    if (mirrorConsole) {
        console.debug("[agent-transfer]", e.tool, e.event, e.msg);
    }
    schedulePersist();
}

function schedulePersist(): void {
    if (!storage || saveTimer) {
        return;
    }
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void persistNow();
    }, PERSIST_DEBOUNCE);
}

async function persistNow(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!storage) {
        return;
    }
    try {
        await storage.saveData(STORAGE_NAME, JSON.stringify({ entries: entries.slice(), seq }));
    } catch {
        // 持久化失败不影响插件功能
    }
}

export function getLogEntries(): readonly AgentLogEntry[] {
    return entries;
}

export function clearLog(): void {
    entries = [];
    void persistNow();
}

/** 导出用可读文本（设置页「导出日志」下载的就是它） */
export function getLogText(): string {
    const head = [
        "==== agent-transfer Agent 调用日志 ====",
        `导出时间：${formatTime(Date.now())}`,
        `条数：${entries.length}/${MAX_ENTRIES}（环形缓冲，仅保留最近记录）`,
        "脱敏说明：{{secrets.*}} 插值结果记为 <secret:NAME>；敏感请求头的明文值整体打码；{{vars.*}} 变量值视为非敏感、原样记录。",
        "======================================",
    ];
    const lines = entries.map((e) => {
        const lv = e.level === "info" ? "" : `[${e.level.toUpperCase()}] `;
        return `[${formatTime(e.t)}] ${e.call != null ? `#${e.call} ` : ""}${e.tool} ${lv}${e.event} | ${e.msg}`;
    });
    return head.join("\n") + "\n" + lines.join("\n") + (lines.length ? "\n" : "");
}

function formatTime(t: number): string {
    const d = new Date(t);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 入参序列化：一层对象（headers/fields）按键名打码，字符串截断 */
export function sanitizeArgs(args: Record<string, unknown>): string {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args ?? {})) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            const map: Record<string, string> = {};
            for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
                map[ik] = typeof iv === "string" ? maskValue(ik, iv) : truncate(JSON.stringify(iv) ?? "", MAX_STR);
            }
            out[k] = map;
        } else if (typeof v === "string") {
            out[k] = maskValue(k, v);
        } else {
            out[k] = v;
        }
    }
    return JSON.stringify(out);
}

/** 单值打码：已脱敏的保留；占位符原样（不含明文）；敏感名整体打码；其余截断 */
export function maskValue(key: string, value: string): string {
    if (value.includes("<secret:") || /\{\{(secrets|vars)\.[^}]+\}\}/.test(value)) {
        return truncate(value, MAX_STR);
    }
    if (SENSITIVE_KEY_RE.test(key)) {
        return `<已打码 ${value.length} 字符>`;
    }
    return truncate(value, MAX_STR);
}

/** 把明文密钥值替换为 <secret:NAME>（长度不足 4 的不替换，避免短值误伤全文） */
export function redactSecrets(value: string, secrets: SecretLike[]): string {
    let out = value;
    for (const s of secrets) {
        if (typeof s.value === "string" && s.value.length >= 4 && out.includes(s.value)) {
            out = out.split(s.value).join(`<secret:${s.name}>`);
        }
    }
    return truncate(out, MAX_STR);
}

/** 插值后 headers/fields 值的日志口径：先替换密钥明文，再按敏感名兜底打码 */
export function redactHeaderValue(key: string, value: string, secrets: SecretLike[]): string {
    return maskValue(key, redactSecrets(value, secrets));
}

export function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + `…(共${s.length}字符)` : s;
}
