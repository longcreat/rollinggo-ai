"""Extract the deployed handwriting font's Unicode cmap. Requires fonttools[woff]."""
import argparse
import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "apps/web/public/fonts/handwriting"
OUTPUT = ROOT / "apps/server/src/generation/titleFont.generated.ts"
SHARED_OUTPUT = ROOT / "packages/shared/src/handwriting.generated.ts"


def render():
    characters = set()
    sources = {}
    fonts = sorted(FONT_DIR.glob("*.woff2"))
    if not fonts:
        raise RuntimeError(f"No font files in {FONT_DIR}")
    for path in fonts:
        sources[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        with TTFont(path) as font:
            for table in font["cmap"].tables:
                if table.isUnicode():
                    characters.update(code for code, glyph in table.cmap.items()
                                      if font.getGlyphID(glyph) != 0)
    header = (
        "// Generated from deployed WOFF2 Unicode cmap tables; do not edit by hand.\n"
        "// Regenerate: python scripts/generate-title-font-coverage.py\n"
    )
    return {
        OUTPUT: header + "export const titleFontSources = " + json.dumps(sources, indent=2) + " as const;\n",
        SHARED_OUTPUT: header + "export const handwritingCharacters = "
        + json.dumps("".join(chr(code) for code in sorted(characters)), ensure_ascii=False) + ";\n",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for path, content in render().items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                raise SystemExit(f"Font coverage is stale; regenerate {path.relative_to(ROOT)}")
        else:
            path.write_text(content, encoding="utf-8")
            print(f"Generated {path.relative_to(ROOT)}")
    if args.check:
        print("Server and web font cmap coverage is current")
