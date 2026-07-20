from PIL import Image, ImageDraw
import math

def make_icon(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background rounded square
    bg = (11, 15, 20, 255)
    radius = size * 0.22
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=bg)

    cx, cy = size / 2, size / 2

    # Loop arrow ring (two arcs) in accent blue
    ring_r = size * 0.30
    ring_w = max(2, int(size * 0.07))
    accent = (125, 211, 252, 255)
    bbox = [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r]
    d.arc(bbox, start=-40, end=200, fill=accent, width=ring_w)

    # Arrowhead at the end of the arc (~200 degrees)
    ang = math.radians(200)
    tip_x = cx + ring_r * math.cos(ang)
    tip_y = cy + ring_r * math.sin(ang)
    ah = size * 0.09
    perp = ang + math.pi / 2
    p1 = (tip_x + ah * math.cos(ang + 2.6), tip_y + ah * math.sin(ang + 2.6))
    p2 = (tip_x + ah * math.cos(ang - 2.6), tip_y + ah * math.sin(ang - 2.6))
    d.polygon([p1, (tip_x, tip_y), p2], fill=accent)

    # Center record dot in red
    dot_r = size * 0.14
    d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=(239, 68, 68, 255))

    img.save(path)

make_icon(192, "icons/icon-192.png")
make_icon(512, "icons/icon-512.png")
print("done")
