import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import zipPack from "vite-plugin-zip-pack";

// 内核插件构建：src/kernel/index.ts → dist/kernel.js（iife 顶层脚本，goja 直接求值）。
// dist/ 即完整插件目录（可直接部署/打包）；package.zip 仅发布构建时生成。
// 安装到思源工作空间用 npm run deploy（SIYUAN_PLUGIN_DIR 覆盖目标）。
const isDev = process.env.NODE_ENV === "development";
const root = import.meta.dirname;

// 静态资源直拷：compat/index.js 在产物中改名为根级 index.js（前端加载器占位桩）。
function copyStaticFiles(): void {
    const outDir = resolve(root, "dist");
    const copy = (from: string, to: string) => cpSync(resolve(root, from), resolve(outDir, to));
    copy("plugin.json", "plugin.json");
    copy("compat/index.js", "index.js");
    mkdirSync(resolve(outDir, "i18n"), { recursive: true });
    for (const name of readdirSync(resolve(root, "i18n"))) {
        if (name.endsWith(".json")) {
            copy(join("i18n", name), join("i18n", name));
        }
    }
    copy("icon.png", "icon.png");
    copy("preview.png", "preview.png");
    for (const name of readdirSync(root)) {
        if (name.startsWith("README") && name.endsWith(".md")) {
            copy(name, name);
        }
    }
}

const copyStatic: Plugin = {
    name: "copy-static",
    closeBundle() {
        copyStaticFiles();
    },
};

const staticPlugins: PluginOption[] = [copyStatic];

if (!isDev) {
    staticPlugins.push(
        zipPack({
            inDir: "./dist",
            outDir: "./",
            outFileName: "package.zip",
        }),
    );
}

export default defineConfig({
    build: {
        outDir: "dist",
        emptyOutDir: true,
        minify: !isDev,
        sourcemap: isDev ? "inline" : false,
        target: "es2018",
        lib: {
            entry: resolve(root, "src/kernel/index.ts"),
            name: "AgentTransferKernel",
            fileName: () => "kernel.js",
            formats: ["iife"],
        },
    },
    plugins: staticPlugins,
});
