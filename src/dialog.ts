// 上传前确认弹窗：目标既不在白名单也不在黑名单时弹出。
// 四个动作：放行一次 / 拒绝一次 / 加入白名单并上传 / 加入黑名单；
// 地址栏可编辑，便于把完整 URL 改写成通配规则（如 https://*.example.com）再入名单。

import { Dialog } from "siyuan";
import { formatSize } from "./download";
import { parseRule, type UrlRule } from "./patterns";

export type UploadDecision =
    | { action: "allow-once" }
    | { action: "deny-once" }
    | { action: "whitelist"; rule: UrlRule }
    | { action: "blacklist"; rule: UrlRule };

function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c] as string));
}

export function askUploadDecision(opts: {
    filename: string;
    size: number;
    url: string;
    i18n: Record<string, string>;
}): Promise<UploadDecision> {
    const t = (key: string, fallback: string) => opts.i18n?.[key] || fallback;
    return new Promise((resolve) => {
        let settled = false;
        // 注意顺序：按钮回调必须先 settle 再 destroy，否则 destroyCallback 会抢先以“拒绝一次”结算
        const settle = (d: UploadDecision) => {
            if (!settled) {
                settled = true;
                resolve(d);
            }
        };

        const dlg = new Dialog({
            title: t("uploadDialogTitle", "上传确认"),
            width: "640px",
            content: `
<div class="b3-dialog__content">
    <div class="ft__on-surface ft__smaller">${escHtml(t("uploadDialogIntro", "Agent 请求将工作空间附件上传到外部地址"))}</div>
    <div class="fn__flex" style="align-items:baseline;gap:8px;margin:8px 0 12px">
        <b style="word-break:break-all">${escHtml(opts.filename)}</b>
        <span class="ft__on-surface ft__smaller">${formatSize(opts.size)}</span>
    </div>
    <label class="ft__smaller" style="display:block;margin-bottom:4px">${escHtml(t("uploadDialogTargetLabel", "目标地址（加入名单时可改为通配模式，路径不参与匹配）"))}</label>
    <input class="b3-text-field fn__block" spellcheck="false" style="font-family:var(--b3-font-family-code)" value="${escHtml(opts.url)}" data-da="rule" />
    <div class="ft__smaller ft__on-surface" style="margin-top:4px">${escHtml(t("uploadDialogHint", "如 https://*.example.com 匹配 example.com 及其所有子域"))}</div>
    <div class="ft__smaller" data-da="error" style="display:none;margin-top:4px;color:var(--b3-card-error-color)"></div>
    <div class="fn__hr"></div>
    <div class="fn__flex" style="gap:8px;justify-content:flex-end;flex-wrap:wrap">
        <button class="b3-button" data-action="deny">${escHtml(t("uploadBtnDeny", "拒绝"))}</button>
        <button class="b3-button b3-button--error" data-action="blacklist">${escHtml(t("uploadBtnBlacklist", "加黑名单"))}</button>
        <button class="b3-button" data-action="allow-once">${escHtml(t("uploadBtnAllowOnce", "放行一次"))}</button>
        <button class="b3-button" data-action="whitelist">${escHtml(t("uploadBtnWhitelist", "加白名单并上传"))}</button>
    </div>
</div>`,
            destroyCallback: () => settle({ action: "deny-once" }), // ESC/关闭视为拒绝一次
        });

        const root = dlg.element;
        const input = root.querySelector<HTMLInputElement>('[data-da="rule"]');
        const error = root.querySelector<HTMLElement>('[data-da="error"]');
        const showRuleError = (msg: string) => {
            if (error) {
                error.textContent = msg;
                error.style.display = "";
            }
        };

        const wire = (action: string, onClick: () => void) => {
            root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener("click", onClick);
        };
        wire("deny", () => {
            settle({ action: "deny-once" });
            dlg.destroy();
        });
        wire("allow-once", () => {
            settle({ action: "allow-once" });
            dlg.destroy();
        });
        for (const action of ["blacklist", "whitelist"] as const) {
            wire(action, () => {
                const { rule, error: parseError } = parseRule(input?.value ?? "");
                if (!rule) {
                    showRuleError(parseError ?? "");
                    return;
                }
                settle({ action, rule });
                dlg.destroy();
            });
        }
    });
}
