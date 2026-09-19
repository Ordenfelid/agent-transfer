# 重新生成 icon.png / preview.png（发布物料），Pillow 直画，无外部依赖。
# 用法：python scripts/make_assets.py
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))

# 配色沿用旧版：靛蓝渐变主色、深色预览底
GRAD_TOP = (74, 92, 232)
GRAD_BOT = (128, 96, 236)
BG_TOP = (26, 30, 58)
BG_BOT = (15, 17, 38)
WHITE = (255, 255, 255)
LAVENDER = (199, 210, 254)
BODY = (196, 202, 230)
MUTED = (146, 152, 186)
CHIP_BG = (40, 45, 82)
CHIP_LINE = (88, 98, 165)
ACCENT = (140, 156, 255)


def font(path_candidates, size):
    for p in path_candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def v_gradient(w, h, top, bot):
    img = Image.new("RGB", (w, h))
    dr = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(h - 1, 1)
        dr.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img


def draw_arrow(dr, cx, cy, length, shaft_w, head_w, head_h, up, fill):
    """竖直双段箭头：矩形杆 + 三角头，整体以 (cx, cy) 为中心"""
    top, bot = cy - length / 2, cy + length / 2
    if up:
        tri = [(cx, top), (cx - head_w / 2, top + head_h), (cx + head_w / 2, top + head_h)]
        s_top, s_bot = top + head_h - 2, bot
    else:
        tri = [(cx, bot), (cx - head_w / 2, bot - head_h), (cx + head_w / 2, bot - head_h)]
        s_top, s_bot = top, bot - head_h + 2
    dr.rectangle([cx - shaft_w / 2, s_top, cx + shaft_w / 2, s_bot], fill=fill)
    dr.polygon(tri, fill=fill)


def text_center(dr, cx, y, s, f, fill):
    l, t, r, b = dr.textbbox((0, 0), s, font=f)
    dr.text((cx - (r - l) / 2 - l, y), s, font=f, fill=fill)


def make_icon():
    S = 160
    grad = v_gradient(S, S, GRAD_TOP, GRAD_BOT).convert("RGBA")
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=36, fill=255)
    icon.paste(grad, (0, 0), mask)
    dr = ImageDraw.Draw(icon)
    # 左上传右下载的双箭头，占位约 56% 宽
    draw_arrow(dr, 52, 82, 86, 15, 44, 26, up=True, fill=LAVENDER + (255,))
    draw_arrow(dr, 108, 82, 86, 15, 44, 26, up=False, fill=WHITE + (255,))
    icon.save(os.path.join(ROOT, "icon.png"), optimize=True)


def make_preview():
    W, H = 1024, 768
    img = v_gradient(W, H, BG_TOP, BG_BOT)
    dr = ImageDraw.Draw(img)
    zh = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]
    zh_bd = ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/simhei.ttf"]
    mono = ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/msyh.ttc"]
    f_title = font(zh_bd, 72)
    f_sub = font(zh, 32)
    f_tool = font(mono, 34)
    f_desc = font(zh, 26)
    f_foot = font(zh, 22)

    text_center(dr, W / 2, 96, "Agent Transfer", f_title, WHITE)
    text_center(dr, W / 2, 196, "让思源 Agent 上传 / 下载文件", f_sub, BODY)

    chips = [
        dict(x=64, up=False, tool="download_asset", desc="网络文件 → 工作空间附件"),
        dict(x=532, up=True, tool="upload_asset", desc="附件 → 外部链接 · 先弹窗确认"),
    ]
    for c in chips:
        box = [c["x"], 300, c["x"] + 428, 540]
        dr.rounded_rectangle(box, radius=28, fill=CHIP_BG, outline=CHIP_LINE, width=2)
        cx = (box[0] + box[2]) / 2
        draw_arrow(dr, cx, 372, 60, 10, 32, 20, up=c["up"], fill=ACCENT)
        text_center(dr, cx, 424, c["tool"], f_tool, WHITE)
        text_center(dr, cx, 480, c["desc"], f_desc, BODY)

    text_center(dr, W / 2, 620, "上传经白/黑名单与弹窗门控 · 凭据存于思源密钥库、不进对话与日志", f_foot, MUTED)
    text_center(dr, W / 2, 700, "SiYuan Agent Plugin · agent-transfer", f_foot, MUTED)

    out = os.path.join(ROOT, "preview.png")
    img.save(out, optimize=True)
    if os.path.getsize(out) > 200 * 1024:  # 官方上限 200KB，超限则降色深
        img.convert("P", palette=Image.ADAPTIVE, colors=256).save(out, optimize=True)
    print("preview.png", os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    make_icon()
    make_preview()
    print("icon.png", os.path.getsize(os.path.join(ROOT, "icon.png")) // 1024, "KB")
