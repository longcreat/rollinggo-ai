# 首页目的地图片

本目录复用项目现有已审核图库，图片文件与审核时的 SHA-256 完全一致。
`sources.json` 保存城市、具体景点、原目录、来源链接、摄影者、许可与完整审核结果。
不将搜索候选、`unknown`、`mismatch` 或用户已排除的图片作为首页照片。

| 城市 | 主体 | 作者 | 来源 |
| --- | --- | --- | --- |
| 北京 | 天坛祈年殿 | zhang kaiyv | [Pexels 7759763](https://www.pexels.com/photo/cars-on-the-road-near-a-tower-7759763/) |
| 杭州 | 雷峰塔 | bin bin | [Pexels 17787255](https://www.pexels.com/photo/leifeng-pagoda-in-hangzhou-17787255/) |
| 厦门 | 鼓浪屿 | toter yau | [Pexels 37714926](https://www.pexels.com/photo/scenic-view-of-gulangyu-island-china-coastline-37714926/) |

以上图片适用 [Pexels License](https://www.pexels.com/license/)。首页采用 CSS `object-cover` 显示裁切，未修改文件。
仅对接口返回的已覆盖城市提供入口；图片缺失时回退城市插画，再回退占位。
