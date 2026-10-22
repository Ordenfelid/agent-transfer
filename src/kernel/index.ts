// agent-transfer 内核插件入口（kernel.js）。
// 一次注册同时服务思源内 Agent 会话与外部 MCP 客户端（/mcp 投影，Token 鉴权）；
// 出站请求的效果声明（dataEgress 等）交给内核审批流，插件自身不再弹窗。

import { downloadAsset, uploadAsset } from "./transfer";

const i18n = (siyuan.plugin && siyuan.plugin.i18n) || {};

function callTool(
    name: string,
    fn: (args: Record<string, unknown>) => Promise<{ result: string }>,
    args: Record<string, unknown>,
): Promise<{ result: string }> {
    return fn(args).catch((e: unknown) => {
        siyuan.logger.warn(`${name} 调用失败：${e instanceof Error ? e.message : String(e)}`);
        throw e;
    });
}

siyuan.plugin.lifecycle.onload = () => {
    siyuan.agent
        .registerCapability(
            "download_asset",
            {
                title: i18n.toolTitle || "Download Asset",
                description:
                    "Save a file into the SiYuan workspace assets folder, either by downloading from an http(s) URL, " +
                    "or by decoding dataBase64 content you already have (e.g. a file produced by another tool). " +
                    "Returns an assets/ path that can be referenced directly in documents. " +
                    "提供两种方式把文件存入思源工作空间 assets：从 http(s) 链接下载，或直接提交手头已有的 base64 内容" +
                    "（如其他工具产出的文件）；返回可在文档中直接引用的 assets/ 路径。",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: {
                            type: "string",
                            description:
                                "Full http(s) URL of the resource to download; omit when using dataBase64. " +
                                "要下载资源的完整 http(s) 链接；使用 dataBase64 时省略。",
                        },
                        dataBase64: {
                            type: "string",
                            description:
                                "Standard base64 (base64url also accepted) of the file content; requires filename; " +
                                "omit when using url. 文件内容的 base64（兼容 base64url）；须同时给 filename；使用 url 时省略。",
                        },
                        filename: {
                            type: "string",
                            description:
                                'Target filename with extension, e.g. "diagram.png". Optional for url (inferred from the URL), ' +
                                "required for dataBase64. 保存使用的文件名（含扩展名）：url 模式可选（缺省从 URL 推断），dataBase64 模式必填。",
                        },
                    },
                },
                effects: {
                    dataEgress: true, // url 模式向外网发起请求
                    localWrite: true, // 写入工作空间 assets 目录
                },
            },
            (args: Record<string, unknown>) => callTool("download_asset", downloadAsset, args),
        )
        .catch((e: unknown) => {
            siyuan.logger.error(`registerCapability(download_asset) 失败：${e instanceof Error ? e.message : String(e)}`);
        });

    siyuan.agent
        .registerCapability(
            "upload_asset",
            {
                title: i18n.uploadToolTitle || "Upload Asset",
                description:
                    "Upload a file from the SiYuan workspace assets folder to an http(s) URL, sending the raw file bytes as the " +
                    "request body (POST or PUT). Set multipart=true for form-style endpoints (fileField names the file part, " +
                    "fields adds text parts). Custom headers go through the headers object; reference credentials with " +
                    "{{secrets.NAME}} (only interpolated when the target host is in that secret's allowedHosts, configured in " +
                    "SiYuan Settings → AI) or {{vars.NAME}} — never paste plaintext tokens. path accepts a bare filename and " +
                    "auto-matches SiYuan's timestamp-suffixed asset names. " +
                    "从工作空间 assets 目录选择附件上传到指定 http(s) 链接：默认以原样二进制 POST/PUT；表单类接口用 " +
                    "multipart=true（fileField 指定文件字段名，fields 附带文本字段）。自定义请求头经 headers 对象传入，" +
                    "凭据用 {{secrets.NAME}} 引用（仅当目标主机在该密钥 allowedHosts 内才插值，在思源 设置 → AI 中配置），" +
                    "或 {{vars.NAME}}——不要把明文 token 直接写进参数。path 可只写原始文件名，自动匹配思源加的时间戳后缀。",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                'Path or filename of a file inside the workspace assets folder, e.g. "assets/photo.png" or ' +
                                '"photo.png"; a bare name auto-matches SiYuan\'s timestamp-suffixed copies. ' +
                                "工作空间 assets 目录内的文件路径或文件名（可只写原始名）。",
                        },
                        url: {
                            type: "string",
                            description:
                                "Target http(s) URL. Supports {{vars.NAME}} placeholders (secrets are not allowed in the URL). " +
                                "接收文件的完整 http(s) 目标链接，支持 {{vars.NAME}} 占位（不允许 {{secrets.*}}）。",
                        },
                        method: {
                            type: "string",
                            enum: ["POST", "PUT"],
                            description: "Optional HTTP method, defaults to POST. 可选，默认 POST。",
                        },
                        headers: {
                            type: "object",
                            additionalProperties: { type: "string" },
                            description:
                                'Optional extra request headers, e.g. {"X-Token": "{{secrets.NAME}}"}. Secrets are only ' +
                                "interpolated when the target host is in the secret's allowedHosts. " +
                                "可选的附加请求头；凭据用 {{secrets.NAME}} 引用（按目标主机门控）或 {{vars.NAME}}。",
                        },
                        multipart: {
                            type: "boolean",
                            description:
                                "Send as multipart/form-data instead of the raw file body, defaults to false. " +
                                "以 multipart/form-data 表单上传（代替原样二进制），默认 false。",
                        },
                        fileField: {
                            type: "string",
                            description:
                                'Form field name for the file part when multipart=true, defaults to "file". ' +
                                "multipart 模式下文件字段名，默认 file。",
                        },
                        fields: {
                            type: "object",
                            additionalProperties: { type: "string" },
                            description: "Extra text form fields when multipart=true. multipart 模式下附带的文本字段。",
                        },
                    },
                    required: ["path", "url"],
                },
                effects: {
                    localRead: true, // 读取工作空间 assets 文件
                    dataEgress: true, // 向外网 URL 发送数据
                },
            },
            (args: Record<string, unknown>) => callTool("upload_asset", uploadAsset, args),
        )
        .catch((e: unknown) => {
            siyuan.logger.error(`registerCapability(upload_asset) 失败：${e instanceof Error ? e.message : String(e)}`);
        });
};

// 内核对三个生命周期钩子都会无条件调用，缺一个就记错误日志
siyuan.plugin.lifecycle.onrunning = () => {
    // onload 已完成注册，这里没有启动期工作
};

siyuan.plugin.lifecycle.onunload = () => {
    siyuan.agent.unregisterCapability("download_asset").catch(() => {
        // 插件停止时内核本就会整体清理注册项，这里只是尽力而为
    });
    siyuan.agent.unregisterCapability("upload_asset").catch(() => {
        // 同上
    });
};
