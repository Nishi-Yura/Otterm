"""Art for README.md / README.en.md, made from the mascot grids in scripts/mascot.py.

Writes to assets/readme/:
  banner-ja.png, banner-en.png   the header: Kotsume, "otterm" and the tagline, on the river teal
  kotsume.gif                    Kotsume going through the four moods (1 px of art = 8 px)
  moods-ja.png, moods-en.png     the four moods side by side with their names
  keep-ja.png, keep-en.png       a shell outliving its window (decision M26), in three panels

Usage: python scripts/readme-art.py   (needs Pillow; uses fonts that ship with Windows, falling back to
Pillow's default font elsewhere)
"""
import importlib.util
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "readme")

spec = importlib.util.spec_from_file_location("mascot", os.path.join(ROOT, "scripts", "mascot.py"))
mascot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mascot)

TEAL = "#3e8f8a"
TEAL_DARK = "#2f6f6b"
CREAM = "#f5ecdc"
BROWN = "#3b2414"


def font(names, size):
    for name in names:
        for folder in ("C:/Windows/Fonts", "/usr/share/fonts/truetype", "/Library/Fonts"):
            path = os.path.join(folder, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def banner(tagline, sub, lang):
    w, h = 1600, 480
    img = Image.new("RGBA", (w, h), TEAL)
    d = ImageDraw.Draw(img)
    # Soft river bands.
    for i, y in enumerate(range(404, h, 30)):
        d.rectangle([0, y, w, y + 14], fill=TEAL_DARK if i % 2 == 0 else "#357f7a")
    art = mascot.png(mascot.grid("happy"), 20)
    img.alpha_composite(art, (110, (h - art.height) // 2 - 10))
    title = font(["CascadiaCode.ttf", "DejaVuSansMono-Bold.ttf"], 132)
    jp = ["YuGothB.ttc", "NotoSansJP-VF.ttf", "meiryob.ttc"] if lang == "ja" else ["segoeuib.ttf", "DejaVuSans-Bold.ttf"]
    tag = font(jp, 46)
    small = font(["YuGothM.ttc", "segoeui.ttf"] if lang == "ja" else ["segoeui.ttf", "DejaVuSans.ttf"], 30)
    x = 110 + art.width + 70
    d.text((x + 4, 92 + 4), "otterm", font=title, fill=BROWN)
    d.text((x, 92), "otterm", font=title, fill=CREAM)
    d.text((x, 262), tagline, font=tag, fill=CREAM)
    d.text((x, 330), sub, font=small, fill="#d8efe9")
    img.save(os.path.join(OUT, f"banner-{lang}.png"))


def gif():
    frames = []
    order = ["calm", "thinking", "thinking", "happy", "calm", "alert", "calm"]
    for mood in order:
        frame = Image.new("RGBA", (16 * 8 + 32, 16 * 8 + 32), (0, 0, 0, 0))
        frame.alpha_composite(mascot.png(mascot.grid(mood), 8), (16, 16))
        frames.append(frame)
    frames[0].save(
        os.path.join(OUT, "kotsume.gif"),
        save_all=True,
        append_images=frames[1:],
        duration=[900, 500, 500, 900, 600, 900, 600],
        loop=0,
        disposal=2,
        transparency=0,
    )


def moods(labels, lang):
    cell, pad = 160, 24
    w = len(mascot.MOODS) * (cell + pad) + pad
    img = Image.new("RGBA", (w, cell + 70), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = font(["YuGothB.ttc", "meiryob.ttc"] if lang == "ja" else ["segoeuib.ttf", "DejaVuSans-Bold.ttf"], 26)
    for i, mood in enumerate(mascot.MOODS):
        x = pad + i * (cell + pad)
        d.rounded_rectangle([x, 0, x + cell, cell], radius=22, fill=CREAM)
        img.alpha_composite(mascot.png(mascot.grid(mood), 8), (x + 16, 16))
        label = labels[mood]
        tw = d.textlength(label, font=f)
        d.text((x + (cell - tw) / 2, cell + 18), label, font=f, fill="#8a5a3b")
    img.save(os.path.join(OUT, f"moods-{lang}.png"))


def keep(texts, lang):
    """Three panels: the window with a shell, the window gone while the shell runs on, a new window
    showing the same lines. Drawn flat and square, like the mascot."""
    w, h = 1600, 470
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    jp = ["YuGothB.ttc", "meiryob.ttc"] if lang == "ja" else ["segoeuib.ttf", "DejaVuSans-Bold.ttf"]
    head = font(jp, 30)
    mono = font(["CascadiaMono.ttf", "consola.ttf", "DejaVuSansMono.ttf"], 24)
    note = font(["YuGothM.ttc", "meiryo.ttc"] if lang == "ja" else ["segoeui.ttf", "DejaVuSans.ttf"], 24)
    pw, gap, top = 460, 70, 70
    # The build goes on while the window is away: 42 % before, 78 % after.
    progress = ["42%", None, "78%"]
    for i in range(3):
        x = 40 + i * (pw + gap)
        d.text((x, 0), texts["steps"][i], font=head, fill="#8a5a3b")
        if i == 1:
            # The window is gone: a dashed outline where it was.
            for k in range(x, x + pw, 24):
                d.line([k, top, min(k + 12, x + pw), top], fill="#b9a58f", width=4)
                d.line([k, top + 250, min(k + 12, x + pw), top + 250], fill="#b9a58f", width=4)
            for k in range(top, top + 250, 24):
                d.line([x, k, x, min(k + 12, top + 250)], fill="#b9a58f", width=4)
                d.line([x + pw, k, x + pw, min(k + 12, top + 250)], fill="#b9a58f", width=4)
            d.text((x + 24, top + 100), texts["gone"], font=note, fill="#8a5a3b")
        else:
            d.rectangle([x, top, x + pw, top + 250], fill="#1f1712", outline=BROWN, width=4)
            d.rectangle([x, top, x + pw, top + 34], fill=BROWN)
            for j, c in enumerate(["#e8826f", "#e6bf78", "#a3c48a"]):
                d.rectangle([x + 14 + j * 22, top + 11, x + 26 + j * 22, top + 23], fill=c)
            for j, line in enumerate(["PS> npm run build", f"building... {progress[i]}"]):
                d.text((x + 22, top + 56 + j * 40), line, font=mono, fill=CREAM)
        # The daemon below, the same in all three panels: that is the point.
        dy = top + 290
        d.rectangle([x + 40, dy, x + pw - 40, dy + 90], fill=TEAL, outline=TEAL_DARK, width=4)
        d.text((x + 64, dy + 14), texts["daemon"], font=note, fill=CREAM)
        d.text((x + 64, dy + 50), "npm run build", font=mono, fill="#d8efe9")
        if i < 2:
            ax = x + pw + 12
            d.polygon([(ax, top + 115), (ax + 40, top + 125), (ax, top + 135)], fill="#8a5a3b")
    img.save(os.path.join(OUT, f"keep-{lang}.png"))


def main():
    os.makedirs(OUT, exist_ok=True)
    banner("アプリが落ちても、シェルは動き続けるターミナル", "Windows 版。カワウソのコツメが住んでいます", "ja")
    banner("A terminal whose shells outlive the window", "For Windows. Pebble the river otter lives here.", "en")
    gif()
    moods({"calm": "ふだん", "thinking": "考え中", "alert": "注意", "happy": "よろこび"}, "ja")
    moods({"calm": "Calm", "thinking": "Thinking", "alert": "Alert", "happy": "Happy"}, "en")
    keep({"steps": ["1. いつもどおり作業中", "2. ウィンドウが落ちた", "3. 開き直すと、そのまま"],
          "gone": "ウィンドウはない", "daemon": "シェルは動き続けている"}, "ja")
    keep({"steps": ["1. Working as usual", "2. The window crashed", "3. Open it again: still there"],
          "gone": "No window", "daemon": "The shell keeps running"}, "en")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
