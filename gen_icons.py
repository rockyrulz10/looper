"""Generate the PWA icons in the app's mint/coral branding:
dark rounded square, mint loop-arrow ring, coral record dot."""
from PIL import Image, ImageDraw
import math

BG = (12, 17, 20, 255)        # --bg #0c1114
MINT = (47, 211, 166, 255)    # --mint
CORAL = (240, 87, 76, 255)    # --coral


def make_icon(size, path):
    # Draw at 4x for clean anti-aliasing, then downsample.
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = S * 0.22
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=BG)

    cx, cy = S / 2, S / 2

    # Mint loop ring with an arrowhead (the "loop" glyph).
    ring_r = S * 0.30
    ring_w = max(4, int(S * 0.065))
    bbox = [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r]
    d.arc(bbox, start=-35, end=205, fill=MINT, width=ring_w)

    ang = math.radians(205)
    tip_x = cx + ring_r * math.cos(ang)
    tip_y = cy + ring_r * math.sin(ang)
    ah = S * 0.085
    p1 = (tip_x + ah * math.cos(ang + 2.5), tip_y + ah * math.sin(ang + 2.5))
    p2 = (tip_x + ah * math.cos(ang - 2.5), tip_y + ah * math.sin(ang - 2.5))
    d.polygon([p1, (tip_x, tip_y), p2], fill=MINT)

    # Coral record dot with a soft highlight.
    dot_r = S * 0.135
    d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=CORAL)
    hl_r = dot_r * 0.45
    d.ellipse(
        [cx - dot_r * 0.35 - hl_r, cy - dot_r * 0.4 - hl_r,
         cx - dot_r * 0.35 + hl_r, cy - dot_r * 0.4 + hl_r],
        fill=(255, 158, 150, 160),
    )

    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)


make_icon(192, "icons/icon-192.png")
make_icon(512, "icons/icon-512.png")
print("icons regenerated")
