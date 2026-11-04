"""Create two tiny synthetic animation fixtures; Pillow is a development tool only."""
from pathlib import Path
from PIL import Image

root = Path(__file__).parent
frames = [Image.new("RGB", (4, 4), color) for color in ("#cd5a45", "#457acd")]
for name, fmt in [("oss031-animated.png", "PNG"), ("oss031-animated.webp", "WEBP")]:
    frames[0].save(root / name, format=fmt, save_all=True, append_images=frames[1:], duration=120, loop=0, lossless=True)
    with Image.open(root / name) as decoded:
        assert decoded.n_frames == 2 and decoded.size == (4, 4)
