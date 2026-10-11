"""Art for README.md / README.en.md, made from the mascot grids in scripts/mascot.py.

Writes to assets/readme/:
  banner-ja.png, banner-en.png   the header: Kotsume, "otterm" and the tagline, on the river teal
  kotsume.gif                    Kotsume going through the four moods (1 px of art = 8 px)
  moods-ja.png, moods-en.png     the four moods side by side with their names

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


def main():
    os.makedirs(OUT, exist_ok=True)
    banner("初心者にやさしく、上級者にも速いターミナル", "カワウソのコツメが住んでいる、mod で育つターミナル", "ja")
    banner("Kind to beginners. Fast for everyone.", "A terminal with Pebble the river otter, grown with mods", "en")
    gif()
    moods({"calm": "ふだん", "thinking": "考え中", "alert": "注意", "happy": "よろこび"}, "ja")
    moods({"calm": "Calm", "thinking": "Thinking", "alert": "Alert", "happy": "Happy"}, "en")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
