"""Build the selected Youran font as complete, cache-versioned WOFF2 subsets.

Requires fonttools[woff]. Source and permission: apps/web/public/fonts/handwriting/NOTICE.md.

分片顺序：先读 scripts/handwriting-chunks.json（由 scripts/extract-handwriting-corpus.mts
按真实文案共现聚类生成：公共字片在前，文案聚类片其次），剩下的字形再按码位每 CHUNK 字一片。
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / 'apps/web/public/fonts/handwriting'
CSS = ROOT / 'apps/web/src/styles/tailwind.css'
PLAN = ROOT / 'scripts/handwriting-chunks.json'
SOURCE_SHA256 = '10a92c32d388f119db8a975fe6f0507ec48d15e3050e7ff2971c3784ad878580'
# CORE_BLOCKS 只在没有 scripts/handwriting-chunks.json 时作为回退使用。
CORE_BLOCKS = (
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ·，。！？、：；（）—',
    # 城市名与景点词放最前优先占位：目的地、地点名几乎每个页面都出现，
    # 让它们落在同一片，一次标题只拉一片。
    '北京杭州上海成都重庆广州深圳南京苏州厦门西安武汉长沙昆明贵阳哈尔滨呼和浩特大理',
    '沿轴走宫故博院楼黄昏南鼓巷坛殿园湖胡同咖啡馆街烟火秋寻味京城最后收集安排程',
    '做必战先回则任取据处理世车象步景风光旅慢漫游泉塔听溪谷苑麓雍颐榭锣祈簋罍',
    '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年'
    '动同工也能下过子说产种面而方后多定行学法所民得经之进着等部度家电力里如水化高自',
    '理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政日社'
    '相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解',
    '问意建月公无系情者最立代想已通并提直题程展果料象员位入常文总次品式活设及管特件'
    '长求老头基资边流路级少图山统接知较将组见别她手角期根论运农指几九区强放决西被干',
)
# 剩余字形按码位分组的每片字数；手写体每字约 1KB，96 字 ≈ 96KB。
CHUNK = 96


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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise SystemExit('Source differs from the reviewed Youran font; review before updating the pinned hash.')
    with TTFont(args.source) as font:
        original = codepoints(font)
    groups = []
    if PLAN.exists():
        plan = json.loads(PLAN.read_text(encoding='utf-8'))
        covered = set()
        for text in plan['chunks']:
            block = sorted({ord(character) for character in text
                            if ord(character) in original and ord(character) not in covered})
            covered.update(block)
            if block:
                groups.append(block)
        remaining = sorted(original.difference(covered))
    else:
        # 回退：没有语料分片计划时按手工核心字块 + 码位切分。
        core = set()
        for text in CORE_BLOCKS:
            block = sorted({cp for cp in map(ord, text) if cp in original and cp not in core})
            core.update(block)
            if block:
                groups.append(block)
        remaining = sorted(original.difference(core))
    groups += [remaining[start:start + CHUNK] for start in range(0, len(remaining), CHUNK)]
    faces, paths, shipped = [], set(), set()
    for index, selected in enumerate(groups):
        with TTFont(args.source, recalcTimestamp=False) as font:
            options = subset.Options()
            options.name_IDs = ['*']
            options.name_legacy = True
            options.name_languages = ['*']
            worker = subset.Subsetter(options=options)
            worker.populate(unicodes=selected)
            worker.subset(font)
            for name in font['name'].names:
                if name.nameID in (1, 3, 4, 6, 16):
                    name.string = 'Youran-Handwriting'.encode(name.getEncoding())
            font.flavor = 'woff2'
            temporary = FONT_DIR / f'youran-{index:02d}.tmp'
            font.save(temporary)
            digest = hashlib.sha256(temporary.read_bytes()).hexdigest()[:10]
            path = FONT_DIR / f'youran-{index:02d}-{digest}.woff2'
            temporary.replace(path)
            paths.add(path)
        with TTFont(path) as deployed:
            actual = codepoints(deployed)
            if actual != set(selected):
                raise RuntimeError(f'Subset coverage mismatch: {path.name}')
            shipped.update(actual)
        faces.append(f"""@font-face {{
  font-family: 'Youran Handwriting';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/handwriting/{path.name}') format('woff2');
  unicode-range: {unicode_ranges(selected)};
}}""")
    if shipped != original:
        raise RuntimeError('Shipped font must preserve every source character')
    css = CSS.read_text(encoding='utf-8')
    pattern = r"@font-face\s*\{[^}]*font-family:\s*'(?:QianTuBiFeng|Youran) Handwriting';[^}]*\}\s*"
    matches = list(re.finditer(pattern, css))
    if not matches:
        raise RuntimeError('Handwriting font-face block not found')
    css = css[:matches[0].start()] + re.sub(pattern, '', css[matches[0].start():])
    css = css[:matches[0].start()] + '\n'.join(faces) + '\n' + css[matches[0].start():]
    CSS.write_text(css, encoding='utf-8')
    # Only obsolete generated Youran files in this fixed directory; never recurse.
    for path in FONT_DIR.glob('youran-*.woff2'):
        if path not in paths:
            path.unlink()
    print(f'{len(paths)} subsets, {len(shipped)} Unicode characters, {sum(p.stat().st_size for p in paths):,} bytes')
