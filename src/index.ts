import { Plugin } from "siyuan";
import { downloadToAsset } from "./download";
import { initLogger, runWithLog } from "./logger";
import { loadRules } from "./rules";
import { buildSetting } from "./settings";
import { uploadAssetToUrl } from "./upload";

export default class DownloadAssetPlugin extends Plugin {
    onload() {
        void initLogger(this);
        // addAgentCapability 返回注册 id，由宿主登记在本插件实例上并在卸载时
        // 自动清理（siyuan 包中无对应的注销 API），因此不需要 onunload 处理
        this.addAgentCapability({
            name: "download_asset",
            title: this.i18n.toolTitle || "Download Asset",
            description:
                "Download a file from an http(s) URL and save it into the SiYuan workspace assets folder. " +
                "Use this whenever the user wants to save an online image/file/attachment into the notes. " +
                "从指定 http(s) 链接下载资源并保存到工作空间 assets 目录，返回可直接在文档中引用的 assets/ 相对路径。",
            inputSchema: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description:
                            "Full http(s) URL of the resource to download. 要下载资源的完整 http(s) 链接。",
                    },
                    filename: {
                        type: "string",
                        description:
                            "Optional target filename with extension, e.g. \"diagram.png\". If omitted it is inferred from the URL. " +
                            "可选，保存使用的文件名（需含扩展名）；缺省时从 URL 自动推断。",
                    },
                },
                required: ["url"],
            },
            effects: {
                localWrite: true, // 写入工作空间 assets 目录
                dataEgress: true, // 向外网 URL 发起请求
            },
            handler: (args) => runWithLog("download_asset", args, () => downloadToAsset(args)),
        });

        this.addAgentCapability({
            name: "upload_asset",
            title: this.i18n.uploadToolTitle || "Upload Asset",
            description:
                "Upload a file from the SiYuan workspace assets folder to an http(s) URL, sending the raw file bytes as the request body (POST or PUT). " +
                "Set multipart=true for form-style endpoints (fileField names the file part, fields adds text parts). " +
                "Custom headers go through the headers object; reference credentials with {{secrets.NAME}} (only interpolated when the target host is in that secret's allowedHosts, " +
                "configured in SiYuan Settings → AI) or {{vars.NAME}} — never paste plaintext tokens. " +
                "path accepts a bare filename and auto-matches SiYuan's timestamp-suffixed asset names. " +
                "Targets are gated by user-managed rules: blacklisted hosts are refused, whitelisted hosts upload silently, " +
                "and anything else pops a confirmation dialog where the user can allow/deny once or save the target as a rule " +
                "(wildcard hosts like https://*.example.com are supported). " +
                "从工作空间 assets 目录选择附件上传到指定 http(s) 链接：默认以原样二进制 POST/PUT；" +
                "表单类接口用 multipart=true（fileField 指定文件字段名，fields 附带文本字段）。" +
                "自定义请求头经 headers 对象传入，凭据用 {{secrets.NAME}} 引用（仅当目标主机在该密钥 allowedHosts 内才插值，" +
                "在思源 设置 → AI 中配置），或 {{vars.NAME}}——不要把明文 token 直接写进参数。" +
                "path 可只写原始文件名，自动匹配思源加的时间戳后缀。" +
                "黑名单地址直接拒绝；白名单地址静默上传；其余地址弹出确认框，由用户放行一次/拒绝一次/加入白名单/加入黑名单（支持 https://*.example.com 通配）。",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description:
                            "Path or filename of a file inside the workspace assets folder, e.g. \"assets/photo.png\" or \"photo.png\"; " +
                            "a bare name auto-matches SiYuan's timestamp-suffixed copies. 工作空间 assets 目录内的文件路径或文件名（可只写原始名）。",
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
                        description:
                            "Optional HTTP method, defaults to POST. 可选，默认 POST。",
                    },
                    headers: {
                        type: "object",
                        additionalProperties: { type: "string" },
                        description:
                            "Optional extra request headers, e.g. {\"X-Token\": \"{{secrets.NAME}}\"}. Secrets are only interpolated " +
                            "when the target host is in the secret's allowedHosts. 可选的附加请求头；凭据用 {{secrets.NAME}} 引用（按目标主机门控）或 {{vars.NAME}}。",
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
                            "Form field name for the file part when multipart=true, defaults to \"file\". " +
                            "multipart 模式下文件字段名，默认 \"file\"。",
                    },
                    fields: {
                        type: "object",
                        additionalProperties: { type: "string" },
                        description:
                            "Extra text form fields when multipart=true. multipart 模式下附带的文本字段。",
                    },
                },
                required: ["path", "url"],
            },
            effects: {
                localRead: true, // 读取工作空间 assets 文件
                dataEgress: true, // 向外网 URL 发送数据
            },
            handler: (args) => runWithLog("upload_asset", args, () => uploadAssetToUrl(args, this, this.i18n)),
        });

        void loadRules(this);
        this.setting = buildSetting(this);
    }
}
