import { resolve } from "path";
import { defineConfig, type PluginOption } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import zipPack from "vite-plugin-zip-pack";

const isDev = process.env.NODE_ENV === "development";
// 开发产物直接输出到工程根目录（工程本身位于 data/plugins/ 下，
// 思源按 <插件目录>/index.js 加载），发布产物输出到 dist/ 并打包 package.zip
const outputDir = isDev ? "." : "dist";

export default defineConfig({
    build: {
        outDir: outputDir,
        emptyOutDir: false,
        minify: !isDev,
        sourcemap: isDev ? "inline" : false,
        lib: {
            entry: resolve(import.meta.dirname, "src/index.ts"),
            name: "DownloadAssetPlugin",
            fileName: () => "index.js",
            formats: ["cjs"],
        },
        rollupOptions: {
            external: ["siyuan"],
            output: {
                entryFileNames: "index.js",
            },
        },
    },
    plugins: (isDev
        ? []
        : [
            viteStaticCopy({
                targets: [
                    { src: "./plugin.json", dest: "./" },
                    { src: "./i18n/*.json", dest: "./" },
                    { src: "./icon.png", dest: "./" },
                    { src: "./preview.png", dest: "./" },
                    { src: "./README*.md", dest: "./" },
                ],
            }),
            zipPack({
                inDir: "./dist",
                outDir: "./",
                outFileName: "package.zip",
            }),
        ]) as PluginOption[],
});
