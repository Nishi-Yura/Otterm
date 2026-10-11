"""Draft E, rounder: a 16x16 pixel otter holding a pebble, in four moods.

Writes SVGs to assets/mascot/e-round/ and a preview sheet (light and dark background).
Usage: python scripts/mascot-e-round.py <repo root> <preview.png>  (needs Pillow)
"""
import os
import sys

from PIL import Image, ImageDraw

PAL = {
    "O": "#3b2414",  # outline
    "B": "#8a5a3b",  # body
    "b": "#74492e",  # body shade
    "L": "#ecd9c0",  # face / throat
    "E": "#24150c",  # eyes, nose
    "W": "#ffffff",  # eye highlight
    "N": "#24150c",  # nose
    "M": "#5a3420",  # mouth line
    "K": "#f0a8a0",  # blush
    "P": "#a7b0b8",  # pebble
    "p": "#7d868e",  # pebble shade
    "H": "#d6dde3",  # pebble highlight
    "R": "#d0303a",  # alert brows (red-brown would be too dark at 16 px)
}

# The round head, ears and paws around a pebble; the face rows (6-11) differ per mood.
BASE = [
    "................",
    "................",
    ".....OOOOOO.....",
    "...OOBBBBBBOO...",
    "..OBBBBBBBBBBO..",
    ".ObOBBBBBBBBObO.",
    None,  # 6 brows / top of eyes
    None,  # 7 eyes
    None,  # 8 eyes
    None,  # 9 muzzle + nose
    None,  # 10 mouth
    None,  # 11 chin
    ".OBbOHPPPPPObBO.",
    "..OBOPPPPPpOBO..",
    "...OOOPPppOOO...",
    ".....OOOOOO.....",
]

FACES = {
    "calm": [
        "OBBBBBBBBBBBBBBO",
        "OBBBEEBBBBEEBBBO",
        "OBBBEWBBBBEWBBBO",
        "OBLLLLLNNLLLLLBO",
        ".OLLLLMLLMLLLLO.",
        ".OBLLLLMMLLLLBO.",
    ],
    "happy": [
        "OBBBBBBBBBBBBBBO",
        "OBBBEEBBBBEEBBBO",
        "OBBEBBEBBEBBEBBO",
        "OKLLLLLNNLLLLLKO",
        ".OLLLLMMMMLLLLO.",
        ".OBLLLLMMLLLLBO.",
    ],
    "thinking": [
        "OBBBBBBBBBBBBBBO",
        "OBBBBEEBBBBEEBBO",
        "OBBBBWEBBBBWEBBO",
        "OBLLLLLNNLLLLLBO",
        ".OLLLLLLLMMLLLO.",
        ".OBLLLLLLLLLLBO.",
    ],
    "alert": [
        "OBBRRBBBBBBRRBBO",
        "OBBBEEBBBBEEBBBO",
        "OBBBEEBBBBEEBBBO",
        "OBLLLLLNNLLLLLBO",
        ".OLLLLMMMMLLLLO.",
        ".OBLLLLLLLLLLBO.",
    ],
}


def grid(mood):
    rows = list(BASE)
    rows[6:12] = FACES[mood]
    assert all(len(r) == 16 for r in rows), mood
    return rows


def svg(rows, title):
    rects = []
    for y, row in enumerate(rows):
        x = 0
        while x < 16:
            c = row[x]
            if c == ".":
                x += 1
                continue
            run = 1
            while x + run < 16 and row[x + run] == c:
                run += 1
            rects.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="{PAL[c]}"/>')
            x += run
    body = "".join(rects)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="96" height="96" '
        f'shape-rendering="crispEdges"><title>{title}</title>{body}</svg>\n'
    )


def png(rows, scale):
    img = Image.new("RGBA", (16 * scale, 16 * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            if c != ".":
                d.rectangle([x * scale, y * scale, (x + 1) * scale - 1, (y + 1) * scale - 1], fill=PAL[c])
    return img


def main(repo, preview):
    out = os.path.join(repo, "assets", "mascot", "e-round")
    os.makedirs(out, exist_ok=True)
    moods = ["calm", "happy", "thinking", "alert"]
    sheet = Image.new("RGBA", (4 * 200 + 50, 2 * 200 + 40), "#fafafa")
    dark = Image.new("RGBA", (4 * 200 + 50, 220), "#1b1d23")
    for i, mood in enumerate(moods):
        rows = grid(mood)
        with open(os.path.join(out, f"{mood}.svg"), "w", encoding="utf-8", newline="\n") as f:
            f.write(svg(rows, f"Kotsume (draft E, round): {mood}"))
        big = png(rows, 10)
        sheet.alpha_composite(big, (20 + i * 200, 20))
        sheet.alpha_composite(png(rows, 2), (20 + i * 200, 200))  # 32 px
        sheet.alpha_composite(png(rows, 1), (70 + i * 200, 200))  # 16 px
        dark.alpha_composite(big, (20 + i * 200, 20))
    full = Image.new("RGBA", (sheet.width, sheet.height + dark.height), "#fafafa")
    full.alpha_composite(sheet, (0, 0))
    full.alpha_composite(dark, (0, sheet.height))
    full.save(preview)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
