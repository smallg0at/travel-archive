"""Instance Noto Serif SC at Semibold and subset it for the share card.

Run with the fontTools on this machine:
  python scripts/build-card-font.py

The editorial card needs a Chinese serif that exists on every phone. Android's
WebView has none it will pick for `serif` — the glyphs silently fall back to the
sans-serif Noto Sans CJK, which is exactly the look the style was chosen to
avoid. So the app ships a subset: the characters a caption in Chinese is made
of, not the whole 20k-glyph family.

Two steps, because a variable font cannot be subset by weight:
  1. pin the weight axis at 600 (Semibold),
  2. keep only the characters listed below.
"""

import pathlib
import subprocess
import sys

# GB2312 level 1 (3,755 characters) plus level 2, i.e. the 6,763 hanzi of the
# national standard, plus Latin, punctuation and the symbols a card can carry.
CHARS = [chr(c) for c in range(0x20, 0x7F)]
CHARS += list("，。、；：？！“”‘’（）《》〈〉【】〔〕—…·～￥％＆＊＋－／＝＜＞＠＃＄")
CHARS += list("°′″№±×÷√∞≠≤≥≈→←↑↓℃㎡①→")[:1]
for high in range(0xB0, 0xF8):
    for low in range(0xA1, 0xFF):
        try:
            CHARS.append(bytes([high, low]).decode("gb2312"))
        except UnicodeDecodeError:
            continue

root = pathlib.Path(__file__).resolve().parent.parent
source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\small\AppData\Local\Temp\opencode\NotoSerifSC-var.ttf")
out_dir = root / "public" / "fonts"
out_dir.mkdir(parents=True, exist_ok=True)

text = "".join(dict.fromkeys(CHARS))
# Passed as a file: the character set is a few thousand code points and the
# Windows command line is not the place for it.
charset_file = source.with_name("card-charset.txt")
charset_file.write_text(text, encoding="utf-8")

pinned = source.with_name("NotoSerifSC-SemiBold.ttf")
subprocess.run(
    [sys.executable, "-m", "fontTools.varLib.instancer", str(source), "wght=600", "-o", str(pinned)],
    check=True,
)

target = out_dir / "NotoSerifSC-SemiBold.woff2"
subprocess.run(
    [
        sys.executable, "-m", "fontTools.subset", str(pinned),
        f"--text-file={charset_file}",
        "--layout-features=*",
        "--flavor=woff2",
        f"--output-file={target}",
    ],
    check=True,
)
print(f"{target.name}: {len(text)} characters, {target.stat().st_size / 1024 / 1024:.2f} MB")
