# Download Asset（下载资源到附件）

为思源笔记 [Agent](https://b3log.org/siyuan) 提供一个工具：**把给定链接的资源下载并保存到工作空间 `assets/` 目录**，返回可直接在文档中引用的附件路径。

## 它做什么

注册一个名为 `download_asset` 的 Agent 工具：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 要下载资源的完整 http(s) 链接 |
| `filename` | 否 | 保存使用的文件名（含扩展名），缺省时从 URL 推断 |

对 Agent 说「下载这个图片：https://example.com/a.png」即可触发。

- **下载**走内核代理 `/api/network/forwardProxy`（不受浏览器 CORS 限制），`base64` 返回后还原。
- **入库**走 `/api/asset/upload`（`assetsDirPath: /assets/`），由内核按思源资产命名规范自动重命名去重，最终路径取自返回的 `succMap`。
- **副作用声明** `localWrite + dataEgress`：Agent 执行该工具前会先弹审批确认。

## 内置约束

- 仅允许 `http/https`；拒绝本机/内网地址（localhost、127/8、10/8、172.16/12、192.168/16、169.254/16 等）。
- 单文件上限 50 MB（内核代理会把响应体整个载入内存）。
- 文件名会剥掉路径部分与控制字符；无扩展名时按 Content-Type 补全。
- 所有失败都返回 `error` 字符串给模型（含原因），便于其自行纠正参数后重试。

## 开发

源码位于思源工作空间之外（避免 `node_modules` 进入内核同步/快照），构建产物统一进 `dist/`，用 `npm run deploy` 安装到工作空间（目标目录可用 `SIYUAN_PLUGIN_DIR` 覆盖）。

```bash
npm install
npm run deploy   # 构建 + 安装 dist/ 到 {工作空间}/data/plugins/download-asset/
npm run dev      # watch 构建 dist/；改完拷过去或 deploy 后，思源里禁用→启用插件即可重载
npm run build    # 发布构建：输出 dist/ 并打包 package.zip
npm run check    # tsc 类型检查
npm test         # mock 内核的 handler 冒烟测试（21 条断言）
```

验证顺序：思源重启后，先在「设置 → 集市/插件」启用本插件；再到 **Agent 设置的工具列表**确认 `download_asset` 出现且勾选；最后让 Agent 下载一个真实链接，观察审批弹窗与 `assets/` 目录落盘。

## 发布（可选）

`npm run build` 生成 `package.zip`；按版本打 tag 建 GitHub Release 并上传 `package.zip`；首次上架集市需向 [siyuan-note/bazaar](https://github.com/siyuan-note/bazaar) 的 `plugins.txt` 添加本仓库后提 PR。发布前请补全 `plugin.json` 中的 `url` 字段并替换 `icon.png` / `preview.png`。

## 要求

- 思源笔记 ≥ 3.8.0（`addAgentCapability` 所需的最低版本）。
