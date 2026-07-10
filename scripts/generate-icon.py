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


def bookmark(draw, box, fill):
    left, top, right, bottom = box
    width = right - left
    corner = round(width * 0.17)
    notch_y = round(bottom - width * 0.28)
    center_x = (left + right) / 2
    draw.rounded_rectangle((left, top, right, top + corner * 2), radius=corner, fill=fill)
    draw.rectangle((left, top + corner, right, notch_y), fill=fill)
    draw.polygon(((left, notch_y), (right, notch_y), (right, bottom), (center_x, notch_y), (left, bottom)), fill=fill)


def make_icon():
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # A high-contrast, flat mark that remains readable in the 16 px taskbar size.
    ink = (20, 27, 40, 255)
    cyan = (52, 199, 218, 255)
    pink = (226, 84, 128, 255)
    paper = (248, 250, 252, 255)
    yellow = (255, 205, 66, 255)

    draw.rounded_rectangle((30, 30, 994, 994), radius=224, fill=ink)
    bookmark(draw, (176, 232, 654, 800), cyan)
    bookmark(draw, (238, 182, 716, 824), pink)
    bookmark(draw, (300, 142, 824, 868), paper)
    draw.polygon(star_points(562, 423, 174, 78), fill=yellow)

    # One small accent gives the symbol a recognizable top-right silhouette.
    draw.ellipse((716, 202, 774, 260), fill=cyan)
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
