// 插件设置页：白名单/黑名单两个多行文本框，每行一条规则（支持 # 注释），
// 确认时逐行解析、去重、与另一名单冲突的条目以黑名单为准；
// 另有调试日志区：导出 agent 调用日志为 .txt / 清空日志。

import { Setting, showMessage } from "siyuan";
import { clearLog, getLogEntries, getLogText } from "./logger";
import { parseRuleLines, ruleToString, type UrlRule } from "./patterns";
import { getRules, saveRules, type RulesStorage } from "./rules";

interface IPluginLike {
    i18n: Record<string, string>;
}

const RULE_SYNTAX = "每行一条 scheme://host[:port]，支持 *.example.com 通配（含子域及主域），路径不参与匹配。";

export function buildSetting(plugin: IPluginLike & RulesStorage): Setting {
    const t = (key: string, fallback: string) => plugin.i18n?.[key] || fallback;

    const mkArea = (rules: UrlRule[]): HTMLTextAreaElement => {
        const ta = document.createElement("textarea");
        ta.className = "b3-text-field fn__flex-shrink";
        ta.rows = 6;
        ta.spellcheck = false;
        ta.style.resize = "vertical";
        ta.style.fontFamily = "var(--b3-font-family-code, monospace)";
        ta.value = rules.map(ruleToString).join("\n");
        return ta;
    };
    const wlArea = mkArea(getRules().whitelist);
    const blArea = mkArea(getRules().blacklist);

    const setting = new Setting({
        width: "640px",
        confirmCallback: () => {
            const wl = parseRuleLines(wlArea.value);
            const bl = parseRuleLines(blArea.value);
            const blKeys = new Set(bl.rules.map(ruleToString));
            const wlDedup = wl.rules.filter((r) => !blKeys.has(ruleToString(r)));
            void saveRules(plugin, { whitelist: wlDedup, blacklist: bl.rules });
            const problems = [...wl.errors, ...bl.errors];
            if (wl.rules.length !== wlDedup.length) {
                problems.push("同时出现在两个名单的条目已按黑名单处理");
            }
            showMessage(problems.length ? `名单已保存，但有问题：${problems.join("；")}` : t("settingsSaved", "名单设置已保存"));
        },
    });

    setting.addItem({
        title: t("settingsWhitelist", "上传白名单（免确认）"),
        direction: "column",
        description: RULE_SYNTAX,
        actionElement: wlArea,
    });
    setting.addItem({
        title: t("settingsBlacklist", "上传黑名单（直接拒绝）"),
        direction: "column",
        description: `${RULE_SYNTAX}黑名单优先于白名单；本机/内网地址始终拒绝。`,
        actionElement: blArea,
    });

    const mkBtn = (label: string, onClick: () => void, danger = false) => {
        const b = document.createElement("button");
        b.className = danger ? "b3-button b3-button--error" : "b3-button b3-button--outline";
        b.textContent = label;
        b.addEventListener("click", onClick);
        return b;
    };
    const exportLog = () => {
        const count = getLogEntries().length;
        if (!count) {
            showMessage(t("logEmpty", "暂无日志"));
            return;
        }
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, "0");
        const name = `agent-transfer-log-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
        const blob = new Blob([getLogText()], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        showMessage(`${t("logExported", "已导出日志")} ${name}（${count} ${t("logEntriesUnit", "条")}）`);
    };
    const logButtons = document.createElement("div");
    logButtons.className = "fn__flex";
    logButtons.style.gap = "8px";
    logButtons.append(
        mkBtn(t("logExport", "导出日志"), exportLog),
        mkBtn(t("logClear", "清空日志"), () => {
            clearLog();
            showMessage(t("logCleared", "日志已清空"));
        }, true),
    );
    setting.addItem({
        title: t("settingsLog", "调试日志（Agent 调用）"),
        direction: "column",
        description: t(
            "settingsLogDesc",
            "记录每次 download_asset / upload_asset 调用的参数、名单判定、用户决策与网络结果（密钥明文自动脱敏），用于定位 Agent 调用问题。日志随插件数据保留最近记录，可导出为 .txt；清空后不可恢复。",
        ),
        actionElement: logButtons,
    });
    return setting;
}
