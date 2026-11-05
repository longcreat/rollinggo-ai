"""Build the KingHwa OldSong title font as small, cache-versioned WOFF2 subsets.

Replaces the 13 x 600-character chunks with ~96-character chunks: a page title only
pulls the one or two chunks it needs instead of 300KB。Requires:  pip install fonttools[woff]
Source TTF comes from the @fontpkg package (see the NOTICE comment in tailwind.css).
"""
import hashlib
import re
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'node_modules/@fontpkg/king-hwa-old-song/京華老宋体v2.002.ttf'
FONT_DIR = ROOT / 'apps/web/public/fonts/kinghwa'
CSS = ROOT / 'apps/web/src/styles/tailwind.css'
# 手写体的字频块之外，标题字体也按码位分块；每字约 490B，96 字 ≈ 47KB。
CHUNK = 96


def common_chars() -> set[str]:
    """GB2312 全部可编码字符 + ASCII + 中文排版常用标点（与原分片脚本同一字集）。"""
    chars: set[str] = set()
    for b1 in range(0xA1, 0xF8):
        for b2 in range(0xA1, 0xFF):
            try:
                chars.add(bytes([b1, b2]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    chars.update(chr(c) for c in range(0x20, 0x7F))
    chars.update('·—…“”‘’、。，；：？！（）《》〈〉【】「」')
    return chars


def codepoints(font):
    return {cp for table in font['cmap'].tables if table.isUnicode()
            for cp, glyph in table.cmap.items() if font.getGlyphID(glyph) != 0}


def unicode_ranges(codes):
    runs = []
    start = end = codes[0]
    for code in codes[1:]:
        if code == end + 1:
            end = code
        else:
            runs.append(f'U+{start:X}' if start == end else f'U+{start:X}-{end:X}')
            start = end = code
    runs.append(f'U+{start:X}' if start == end else f'U+{start:X}-{end:X}')
    return ', '.join(runs)


if __name__ == '__main__':
    if not SOURCE.exists():
        raise SystemExit(f'source TTF not found: {SOURCE}')
    with TTFont(SOURCE, lazy=True) as font:
        allowed = {ord(c) for c in common_chars()}
        selected = sorted(cp for cp in codepoints(font) if cp in allowed)

    groups = [selected[i:i + CHUNK] for i in range(0, len(selected), CHUNK)]
    faces, paths, shipped = [], set(), set()
    for index, chunk in enumerate(groups):
        with TTFont(SOURCE, recalcTimestamp=False) as font:
            options = subset.Options()
            options.name_IDs = ['*']
            options.name_legacy = True
            options.name_languages = ['*']
            options.hinting = False
            options.desubroutinize = True
            worker = subset.Subsetter(options=options)
            worker.populate(unicodes=chunk)
            worker.subset(font)
            font.flavor = 'woff2'
            temporary = FONT_DIR / f'part-{index:02d}.tmp'
            font.save(temporary)
            digest = hashlib.sha256(temporary.read_bytes()).hexdigest()[:10]
            path = FONT_DIR / f'part-{index:02d}-{digest}.woff2'
            temporary.replace(path)
            paths.add(path)
        with TTFont(path) as deployed:
            # fontTools 会为复合字形的组件保留 cmap 条目，产出可能比预期多几个码位；
            # 只要求预期码位一个不少，多余映射不影响显示（同字形、同来源）。
            missing = set(chunk) - codepoints(deployed)
            if missing:
                raise RuntimeError(f'Subset lost {len(missing)} characters: {path.name} {[hex(c) for c in sorted(missing)[:5]]}')
            shipped.update(codepoints(deployed))
        faces.append(f"""@font-face {{
  font-family: 'KingHwa OldSong';
  font-style: normal;
  font-weight: 400 900;
  font-display: swap;
  src: url('/fonts/kinghwa/{path.name}') format('woff2');
  unicode-range: {unicode_ranges(chunk)};
}}""")
    if set(selected) - shipped:
        raise RuntimeError('Shipped font must preserve every selected character')

    css = CSS.read_text(encoding='utf-8')
    pattern = r"@font-face\s*\{[^}]*font-family:\s*'KingHwa OldSong';[^}]*\}\s*"
    matches = list(re.finditer(pattern, css))
    if not matches:
        raise RuntimeError('KingHwa font-face block not found')
    css = css[:matches[0].start()] + re.sub(pattern, '', css[matches[0].start():])
    css = css[:matches[0].start()] + '\n'.join(faces) + '\n' + css[matches[0].start():]
    CSS.write_text(css, encoding='utf-8')

    # 只清理这个固定目录里的旧分片，不递归。
    for path in FONT_DIR.glob('part-*.woff2'):
        if path not in paths:
            path.unlink()
    print(f'{len(paths)} subsets, {len(shipped)} characters, {sum(p.stat().st_size for p in paths):,} bytes')
