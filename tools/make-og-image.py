"""Generate the 1200x630 Open Graph card for sermon-scribe.com.

    pip install Pillow && python tools/make-og-image.py

Re-run whenever the headline changes, then re-scrape the URL in Facebook's
Sharing Debugger so the new image replaces the cached one.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
MARGIN = 84

CREAM = "#fdfaf4"
INK = "#1a1208"
MUTED = "#7a6e5f"
GOLD = "#c9912a"
BORDER = (201, 145, 42, 60)

SERIF_B = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf"
SERIF_I = "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf"
SERIF_R = "/System/Library/Fonts/Supplemental/Georgia.ttf"


def font(path: str, size: int):
    return ImageFont.truetype(path, size) if Path(path).exists() else ImageFont.load_default(size)


def wrap(draw, text, f, max_w):
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=f) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


img = Image.new("RGB", (W, H), CREAM)
d = ImageDraw.Draw(img)

# Warm border, echoing the site's --border token.
d.rectangle([(0, 0), (W - 1, H - 1)], outline=(201, 145, 42), width=1)
d.rectangle([(14, 14), (W - 15, H - 15)], outline=(232, 201, 122), width=1)

eyebrow = font(SERIF_R, 26)
d.text((MARGIN, MARGIN - 8), "S E R M O N   S C R I B E", font=eyebrow, fill=GOLD)

# Headline mirrors the site's h1, italic on the emphasized word like the page.
head_r = font(SERIF_B, 68)
head_i = font(SERIF_I, 68)
y = 188

line1 = [("Spend less time ", head_r), ("outlining.", head_i)]
x = MARGIN
for text, f in line1:
    d.text((x, y), text, font=f, fill=INK)
    x += d.textlength(text, font=f)

y += 88
d.text((MARGIN, y), "More time in the Word.", font=head_r, fill=INK)

# Gold rule
y += 112
d.line([(MARGIN, y), (MARGIN + 96, y)], fill=GOLD, width=3)

# Subline
sub = font(SERIF_R, 30)
y += 34
for line in wrap(
    d,
    "Structured sermon outlines in minutes — not hours.",
    sub,
    W - 2 * MARGIN - 40,
):
    d.text((MARGIN, y), line, font=sub, fill=MUTED)
    y += 42

url = font(SERIF_R, 26)
d.text((MARGIN, H - MARGIN - 14), "sermon-scribe.com", font=url, fill=GOLD)

out = Path(__file__).resolve().parent.parent / "cersom-latest" / "og-image.png"
img.save(out, optimize=True)
print(f"wrote {out} ({out.stat().st_size // 1024} KB, {img.width}x{img.height})")
