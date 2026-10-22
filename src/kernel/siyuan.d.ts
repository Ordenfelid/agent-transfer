// 内核插件沙箱注入的 globalThis.siyuan 类型声明（kernel/plugin/sandbox.go）。
// kernel.js 以顶层脚本求值，无模块系统；本声明仅供 TypeScript 检查。

interface SiyuanClientResponse {
    url: string;
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    text(): Promise<string>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}

interface SiyuanClient {
    fetch(path: string, init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string | ArrayBuffer;
    }): Promise<SiyuanClientResponse>;
}

interface SiyuanEffects {
    localRead?: boolean;
    localWrite?: boolean;
    dataEgress?: boolean;
    externalCost?: boolean;
}

interface SiyuanAgent {
    registerCapability(
        name: string,
        config: {
            title?: string;
            description: string;
            inputSchema: Record<string, unknown>;
            outputSchema?: Record<string, unknown>;
            effects?: SiyuanEffects;
        },
        handler: (args: Record<string, unknown>) => unknown,
    ): Promise<unknown>;
    unregisterCapability(name: string): Promise<void>;
}

interface SiyuanPluginLifecycle {
    onload: (() => void) | null;
    onrunning: (() => void) | null;
    onunload: (() => void) | null;
}

declare const siyuan: {
    plugin: {
        name: string;
        version: string;
        displayName: string;
        platform: string;
        i18n: Record<string, string>;
        lifecycle: SiyuanPluginLifecycle;
    };
    logger: {
        trace(...args: unknown[]): void;
        debug(...args: unknown[]): void;
        info(...args: unknown[]): void;
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
    client: SiyuanClient;
    agent: SiyuanAgent;
};
