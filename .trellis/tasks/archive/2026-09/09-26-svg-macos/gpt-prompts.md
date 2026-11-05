# GPT 生图提示词 —— 首页氛围背景图

用途：首页全屏背景，上方叠加 SVG 中国地图（淡色描边）+ 磨砂玻璃胶囊卡片（backdrop-blur）。
要求共性：**浅色高调、低对比、中央区域干净**（地图和文字都压在中央）、无文字无地标、16:9 横幅。

## 方案 A：macOS 原生壁纸风（推荐）

> A minimalist macOS-style abstract wallpaper, soft flowing gradient waves in pale sky blue, misty lavender and warm pearl white, smooth silky dunes of light, gentle depth of field, ultra-clean and airy, high-key lighting, large calm uncluttered center area, no text, no objects, no logos, 16:9 wallpaper, subtle film grain, 4K

中文释义：macOS 原生壁纸风抽象渐变，淡天蓝 + 雾紫 + 珍珠白，柔和丝滑的光浪，中央大面积干净留白。

## 方案 B：云海航拍（旅行氛围最强）

> A serene aerial view above a sea of clouds at dawn, soft pastel tones of pale blue, blush pink and cream white, dreamy layered mist, minimalist composition, soft diffused sunlight, high-key, large empty sky area in the center for UI overlay, no text, no landmarks, cinematic yet subtle, 16:9, 4K

中文释义：黎明时分云海之上航拍，淡蓝 + 腮红粉 + 奶油白，柔和薄雾分层，中央留空给 UI。

## 方案 C：抽象等高线地图（呼应地图主题）

> Minimalist abstract topographic map artwork, thin elegant contour lines in soft blue-grey on a pale ivory background, gentle gradient wash of sky blue and lavender, lots of negative space, airy and calm, flat design, no text, no icons, no labels, 16:9 wallpaper, subtle paper texture

中文释义：极简抽象等高线地图，灰蓝细线 + 象牙白底 + 淡蓝紫渐变晕染，大量留白。

## 方案 D：磨砂玻璃质感本体

> Abstract frosted glass texture background, translucent layers of white and pale blue, soft bokeh light spots glowing behind frosted glass, macOS Big Sur aesthetic, ultra minimal, high-key, clean center area, no text, 16:9, 4K

中文释义：磨砂玻璃质感抽象背景，半透明白蓝层叠，玻璃后透出柔和光斑，Big Sur 美学。

## 使用建议

1. 推荐顺序：A → B → D → C（A 最百搭，B 最贴旅行主题）
2. 尺寸：1920×1080 或以上，16:9
3. 若生成结果中央太乱，追加：`keep the center 60% of the image very clean and low-contrast`
4. 若太艳，追加：`reduce saturation, softer pastel palette`
5. 生成后存为 `apps/web/public/home-bg.jpg`，CSS 会以此为背景、渐变兜底
