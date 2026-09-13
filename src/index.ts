import { Plugin } from "siyuan";
import { downloadToAsset } from "./download";

export default class DownloadAssetPlugin extends Plugin {
    onload() {
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
            handler: (args) => downloadToAsset(args),
        });
    }
}
