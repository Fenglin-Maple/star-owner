import math
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SIZE = 1024


def star_points(center_x, center_y, outer_radius, inner_radius, points=5):
    vertices = []
    for index in range(points * 2):
        angle = -math.pi / 2 + index * math.pi / points
        radius = outer_radius if index % 2 == 0 else inner_radius
        vertices.append((
            center_x + math.cos(angle) * radius,
            center_y + math.sin(angle) * radius,
        ))
    return vertices


def bookmark(draw, box, fill, radius_ratio=0.17):
    left, top, right, bottom = box
    width = right - left
    corner = round(width * radius_ratio)
    notch_y = round(bottom - width * 0.28)
    center_x = (left + right) / 2
    draw.rounded_rectangle((left, top, right, top + corner * 2), radius=corner, fill=fill)
    draw.rectangle((left, top + corner, right, notch_y), fill=fill)
    draw.polygon(((left, notch_y), (right, notch_y), (right, bottom), (center_x, notch_y), (left, bottom)), fill=fill)


def make_icon():
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # White mobile-app tile plus a compact bookmark/star mark that stays clear at 16 px.
    ink = (28, 39, 58, 255)
    cyan = (42, 190, 216, 255)
    pink = (222, 82, 127, 255)
    paper = (255, 255, 255, 255)
    outline = (220, 226, 234, 255)
    yellow = (255, 198, 48, 255)

    draw.rounded_rectangle((40, 40, 984, 984), radius=218, fill=paper, outline=outline, width=18)
    bookmark(draw, (205, 258, 588, 778), cyan)
    bookmark(draw, (436, 218, 819, 778), pink)
    bookmark(draw, (282, 180, 742, 838), ink, radius_ratio=0.15)
    draw.polygon(star_points(512, 410, 168, 76), fill=yellow)

    # A tiny white glint keeps the star lively without adding visual noise.
    draw.polygon(star_points(620, 288, 31, 13, points=4), fill=paper)
    return image


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    source = make_icon()
    source.resize((512, 512), Image.Resampling.LANCZOS).save(ASSETS / "star-note.png")
    source.save(
        ASSETS / "star-note.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
