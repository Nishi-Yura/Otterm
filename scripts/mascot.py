"""Kotsume (Pebble), the otter of otterm (docs/08): every mascot asset comes from the grids here.

Writes, under assets/mascot/:
  palette.toml            the fixed colors (decision E2) and the CSS variable each one is exposed as
  src/<mood>.svg          16x16, one rect per run of pixels, grouped by outfit slot (<g id="body">,
                          "face", "hand"), colors as var(--ot-mascot-*, <hex>) so the UI can recolor
  png/<mood>-<size>.png   48, 96, 256 and 512 px (nearest neighbor, never smoothed)
  icon-source.png         1024 px app icon source (decision E3: the icon is Kotsume)
and crates/otterm-app/icons/ (32x32, 128x128, 128x128@2x, icon.png, icon.ico, source.png) at whole-number
scales, so small icons stay sharp; icon.icns comes from `pnpm tauri icon assets/mascot/icon-source.png`.
  logo.svg                the logotype: Kotsume and the word "otterm"
and the bundled developer outfit under mods/outfit-developer/assets/.

Usage: python scripts/mascot.py   (needs Pillow; run from anywhere)
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# key: (hex, css variable name, slot). Body and face colors never follow the theme (docs/08 §3.1).
PAL = {
    "O": ("#3b2414", "outline", None),
    "B": ("#8a5a3b", "body", None),
    "b": ("#74492e", "body-shade", None),
    "L": ("#ecd9c0", "face", None),
    "E": ("#24150c", "eye", None),
    "W": ("#ffffff", "eye-light", None),
    "N": ("#24150c", "nose", None),
    "M": ("#5a3420", "mouth", None),
    "K": ("#f0a8a0", "blush", None),
    "P": ("#a7b0b8", "pebble", None),
    "p": ("#7d868e", "pebble-shade", None),
    "H": ("#d6dde3", "pebble-light", None),
    "R": ("#d0303a", "brow", None),
    # developer outfit
    "G": ("#2c3e50", "glasses", None),
    "C": ("#f5f1e8", "mug", None),
    "c": ("#3fb8b0", "mug-band", None),
}

# Which slot a pixel belongs to (docs/08 §6.4): the face parts, the pebble in the paws, the rest.
FACE_KEYS = set("EWNMKR")
HAND_KEYS = set("PpH")

BASE = [
    "................",
    "................",
    ".....OOOOOO.....",
    "...OOBBBBBBOO...",
    "..OBBBBBBBBBBO..",
    ".ObOBBBBBBBBObO.",
    None,
    None,
    None,
    None,
    None,
    None,
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
MOODS = ["calm", "thinking", "alert", "happy"]

# The developer outfit (docs/08 §6.4): glasses on the face slot, a mug instead of the pebble.
OUTFIT_DEVELOPER = {
    "face": [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...GGGG..GGGG...",
        "...G..GGGG..G...",
        "...G..G..G..G...",
        "...GGGG..GGGG...",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ],
    "hand": [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....CCCCCO.....",
        ".....cccccC.....",
        "......CCCCO.....",
        "................",
    ],
}


def grid(mood):
    rows = list(BASE)
    rows[6:12] = FACES[mood]
    assert all(len(r) == 16 for r in rows), mood
    return rows


def slot_of(key):
    if key in FACE_KEYS:
        return "face"
    if key in HAND_KEYS:
        return "hand"
    return "body"


def rects(rows, keep=lambda k: True):
    out = []
    for y, row in enumerate(rows):
        x = 0
        while x < 16:
            k = row[x]
            if k == "." or not keep(k):
                x += 1
                continue
            run = 1
            while x + run < 16 and row[x + run] == k:
                run += 1
            hexcolor, var, _ = PAL[k]
            out.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="var(--ot-mascot-{var}, {hexcolor})"/>')
            x += run
    return "".join(out)


def svg_layers(rows, title):
    groups = "".join(
        f'<g id="{slot}">{rects(rows, lambda k, s=slot: slot_of(k) == s)}</g>' for slot in ("body", "face", "hand")
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'
        f"<title>{title}</title>{groups}</svg>\n"
    )


def svg_layer(rows, slot):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'
        f'<title>outfit layer: {slot}</title><g id="{slot}">{rects(rows)}</g></svg>\n'
    )


def png(rows, scale, overlay=()):
    img = Image.new("RGBA", (16 * scale, 16 * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for layer in (rows, *overlay):
        for y, row in enumerate(layer):
            for x, k in enumerate(row):
                if k != ".":
                    d.rectangle([x * scale, y * scale, (x + 1) * scale - 1, (y + 1) * scale - 1], fill=PAL[k][0])
    return img


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def icon(rows):
    """1024 px: a river-teal rounded square with Kotsume on it, 1 px of the art = 48 px. Teal, not dark:
    Kotsume's dark outline must stand out on the icon itself, whatever the taskbar color."""
    size, scale = 1024, 48
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([64, 64, size - 64, size - 64], radius=200, fill="#3e8f8a")
    art = png(rows, scale)
    img.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2 + 24))
    return img


def framed(rows, size, scale, radius):
    """Kotsume at a whole-number scale on the teal rounded square, for one icon size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pad = max(1, size // 16)
    ImageDraw.Draw(img).rounded_rectangle([pad, pad, size - pad - 1, size - pad - 1], radius=radius, fill="#3e8f8a")
    art = png(rows, scale)
    img.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2 + scale // 2))
    return img


def app_icons(rows):
    """The app's icons; 16 and 32 px show the sprite alone, at 1x and 2x, where a frame would not fit."""
    d = os.path.join(ROOT, "crates", "otterm-app", "icons")
    sizes = {
        16: png(rows, 1),
        24: framed(rows, 24, 1, 5),
        32: png(rows, 2),
        48: framed(rows, 48, 2, 10),
        64: framed(rows, 64, 3, 13),
        128: framed(rows, 128, 6, 25),
        256: framed(rows, 256, 12, 50),
    }
    sizes[32].save(os.path.join(d, "32x32.png"))
    sizes[128].save(os.path.join(d, "128x128.png"))
    sizes[256].save(os.path.join(d, "128x128@2x.png"))
    framed(rows, 512, 24, 100).save(os.path.join(d, "icon.png"))
    order = sorted(sizes)
    sizes[256].save(
        os.path.join(d, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in order],
        append_images=[sizes[s] for s in order if s != 256],
    )
    icon(rows).save(os.path.join(d, "source.png"))


def logo(rows):
    """The logotype: the sprite at 4x, then the word, laid out for 48 px of height."""
    art = rects(rows)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 64" width="440" height="128" '
        'role="img" aria-label="otterm">'
        '<g transform="translate(0 0) scale(4)" shape-rendering="crispEdges">' + art + "</g>"
        '<text x="74" y="45" font-family="ui-monospace, \'Cascadia Code\', Menlo, monospace" '
        'font-size="38" font-weight="700" fill="#8a5a3b">otterm</text></svg>\n'
    )


def main():
    out = os.path.join(ROOT, "assets", "mascot")
    lines = [
        "# Kotsume's colors (docs/08 §3.4, decision E2). Fixed: they do not follow the UI theme.",
        "# The UI exposes each as --ot-mascot-<name>; outfits may override them.",
        "",
        "[colors]",
    ]
    for _, (hexcolor, var, _) in PAL.items():
        lines.append(f'{var.replace("-", "_")} = "{hexcolor}"')
    write(os.path.join(out, "palette.toml"), "\n".join(lines) + "\n")
    os.makedirs(os.path.join(out, "png"), exist_ok=True)
    for mood in MOODS:
        rows = grid(mood)
        write(os.path.join(out, "src", f"{mood}.svg"), svg_layers(rows, f"Kotsume: {mood}"))
        for size in (48, 96, 256, 512):
            png(rows, size // 16).save(os.path.join(out, "png", f"{mood}-{size}.png"))
    icon(grid("calm")).save(os.path.join(out, "icon-source.png"))
    app_icons(grid("calm"))
    write(os.path.join(out, "logo.svg"), logo(grid("calm")))
    dev = os.path.join(ROOT, "mods", "outfit-developer", "assets")
    for slot, rows in OUTFIT_DEVELOPER.items():
        write(os.path.join(dev, f"{slot}.svg"), svg_layer(rows, slot))
    png(grid("calm"), 16, (OUTFIT_DEVELOPER["face"], OUTFIT_DEVELOPER["hand"])).save(
        os.path.join(out, "png", "developer-256.png")
    )
    print("wrote", out)


if __name__ == "__main__":
    main()
