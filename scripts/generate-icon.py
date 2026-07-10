from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SIZE = 1024


def make_icon():
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = (
            round(15 + 10 * t),
            round(28 + 18 * t),
            round(55 + 30 * t),
            255,
        )
        draw.line((0, y, SIZE, y), fill=color)

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((20, 20, 1004, 1004), radius=220, fill=255)
    image.putalpha(mask)
    draw = ImageDraw.Draw(image)

    # Framing accents and small star-note motifs.
    draw.rounded_rectangle((72, 72, 952, 952), radius=180, outline=(87, 210, 255, 150), width=18)
    draw.polygon([(166, 176), (183, 220), (228, 237), (183, 254), (166, 300), (149, 254), (104, 237), (149, 220)], fill=(255, 120, 180, 255))
    draw.polygon([(832, 116), (844, 147), (876, 159), (844, 171), (832, 203), (820, 171), (788, 159), (820, 147)], fill=(121, 231, 255, 255))

    # Hair silhouette and shoulders.
    draw.ellipse((206, 135, 788, 760), fill=(37, 118, 207, 255))
    draw.polygon([(236, 430), (168, 848), (430, 832), (508, 648), (620, 844), (842, 848), (760, 410)], fill=(32, 97, 181, 255))
    draw.rounded_rectangle((296, 708, 704, 986), radius=150, fill=(45, 166, 223, 255))
    draw.polygon([(318, 787), (500, 930), (685, 785), (634, 958), (364, 958)], fill=(19, 56, 102, 255))

    # Face and neck.
    skin = (255, 222, 211, 255)
    draw.rounded_rectangle((442, 620, 584, 790), radius=52, fill=skin)
    draw.ellipse((302, 236, 712, 704), fill=skin)
    draw.ellipse((315, 498, 378, 554), fill=(249, 153, 166, 100))
    draw.ellipse((636, 498, 699, 554), fill=(249, 153, 166, 100))

    # Cel-shaded fringe.
    draw.pieslice((244, 154, 760, 590), 178, 360, fill=(55, 150, 224, 255))
    draw.polygon([(314, 280), (400, 204), (394, 422), (474, 238), (492, 432), (574, 222), (594, 408), (686, 270), (654, 200), (368, 176)], fill=(55, 150, 224, 255))
    draw.polygon([(385, 214), (432, 193), (405, 382)], fill=(99, 211, 248, 255))

    # Headphones.
    pink = (246, 91, 149, 255)
    draw.arc((244, 180, 770, 650), 188, 352, fill=pink, width=34)
    draw.rounded_rectangle((244, 386, 326, 584), radius=34, fill=pink)
    draw.rounded_rectangle((688, 386, 770, 584), radius=34, fill=pink)
    draw.rounded_rectangle((263, 412, 301, 554), radius=18, fill=(255, 186, 212, 255))
    draw.rounded_rectangle((713, 412, 751, 554), radius=18, fill=(255, 186, 212, 255))

    # Anime eyes, brows, and a small smile.
    ink = (25, 43, 74, 255)
    draw.arc((362, 420, 454, 480), 195, 345, fill=ink, width=13)
    draw.arc((558, 420, 650, 480), 195, 345, fill=ink, width=13)
    draw.ellipse((382, 464, 430, 530), fill=ink)
    draw.ellipse((578, 464, 626, 530), fill=ink)
    draw.ellipse((394, 470, 410, 489), fill=(255, 255, 255, 255))
    draw.ellipse((590, 470, 606, 489), fill=(255, 255, 255, 255))
    draw.arc((470, 548, 548, 606), 15, 165, fill=(180, 70, 104, 255), width=10)

    # A bright note card makes the purpose readable at small sizes.
    draw.rounded_rectangle((600, 650, 902, 912), radius=46, fill=(247, 252, 255, 255), outline=(113, 225, 255, 255), width=12)
    draw.rounded_rectangle((642, 708, 815, 730), radius=11, fill=(53, 139, 206, 255))
    draw.rounded_rectangle((642, 760, 848, 780), radius=10, fill=(153, 197, 224, 255))
    draw.rounded_rectangle((642, 810, 790, 830), radius=10, fill=(153, 197, 224, 255))
    draw.polygon([(842, 642), (856, 678), (892, 692), (856, 706), (842, 742), (828, 706), (792, 692), (828, 678)], fill=pink)

    return image


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    source = make_icon()
    png = source.resize((512, 512), Image.Resampling.LANCZOS)
    png.save(ASSETS / "star-note.png")
    source.save(
        ASSETS / "star-note.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
