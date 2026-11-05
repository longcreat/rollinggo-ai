# 放宽 Pexels 封面闸门（候选池 + 核心词匹配）

## Goal

Pexels 是封面链路的第二级，它的命中率直接决定有多少候选落到第三级高德 —— 而高德 `v5/place/text` 属「基础搜索服务」，个人认证只有 5,000/月。闸门太严 = 白白消耗稀缺配额。本次放宽两处（候选池、匹配形式），目标是在**不引入错图**的前提下提高 Pexels 命中率。

## What I already know

* 收紧时的实测（20 个真实景点名，北京 10 + 杭州 10）：Pexels 命中 9/20（45%）。
* 三种失败模式（来自三轮实测）：同义词（搜 `Lama Temple` 命中 alt `Yonghe Temple`）、名字被截断（搜 `Longjing Village` 命中 alt `Longjing tea plantations`）、alt 从不提专名（`Nanluoguxiang` → `Beijing's local neighborhood`）。
* 第三种无解 —— Pexels 的 alt 是摄影师写的描述，不保证含地名。本次只针对前两种。
* 当前实现：`per_page=5`；命中条件 = `alt` / 照片页 slug 含**完整**归一地名（`lib/placeKey.ts` 的 `normalizePlaceKey`）。
* `normalizePlaceKey` 只剥机构后缀（博物院/公园/景区/…），**不剥**「村/街/路/寺/塔/山/湖/园」—— 所以「龙井村」要求 alt 里出现完整「龙井村」。

## Decision (ADR-lite)

**Context**：闸门是纯文本匹配，两个可调旋钮 —— 候选池大小、匹配的宽松度。

**Decision**：

1. **候选池 `per_page` 5 → 15**：实测「景山公园」这类地点，正确的图排在 5 条之外。API 调用次数不变，只多一点响应体积。
2. **匹配允许「核心词」**：把归一地名再剥一层通用尾缀（`村/街/路/寺/塔/山/湖/园` 等，仍保留 ≥2 字）后，只要核心词出现在 alt / slug 里就算命中。「龙井村」→「龙井」能对上 alt「杭州龙井茶园」。
3. **不做的事**：不取「第一条」、不引入拼音/翻译层、不维护逐景点别名表 —— 都会把错图放进来或带来维护负担。

**Consequences**：「虎跑公园」的核心词是「虎跑」（`normalizePlaceKey` 已剥「公园」），所以 alt 里出现泛化的「公园」不会蒙中；但核心词越短越容易巧合命中（例如 2 字专名与 alt 中无关片段重合）—— 用 `≥2 字` 且只剥**一层**尾缀来约束。

## Requirements

* `apps/server/src/integrations/pexels/cover.ts`：
  * `PER_PAGE` 由 5 改为 15。
  * 新增 `GENERIC_SUFFIXES`（`村/街/路/寺/塔/山/湖/园/公园/景区/庙/宫/馆`）与 `coreKey()`：剥一层尾缀且保留 ≥2 字。
  * `pickCover` 的命中条件改为「含完整归一地名 **或** 含核心词」，完整地名仍优先（同一循环内先扫完整键）。
* 不改动：请求参数（`locale=zh-CN`）、缓存、配额窗口、单次生成上限、URL 接受规则。
* 不改动前端与其它来源。

## Acceptance Criteria

* [ ] `pickCover`：`「杭州龙井茶园」` 命中地点名「龙井村」。
* [ ] `pickCover`：泛化 alt（「一名男子在城市公园里跑步」）对「虎跑公园」仍返回 null；「秋日树木倒映在湿地池塘上」对「西溪湿地」仍返回 null。
* [ ] 收紧前的 9 个命中项全部保持命中（无回归）。
* [ ] 入口 20 个真实景点名重测，命中数不低于 9/20，且无「过→拒」。
* [ ] `npm run typecheck` / 全量测试 / `npm run build` 全绿。

## Definition of Done

* `pexelsCover.test.ts` 补两条：核心词命中、泛化词不误放。
* Spec 更新：`.trellis/spec/server/backend/integration-guidelines.md` 的 Pexels 闸门段（记录核心词规则、`per_page=15` 与实测数字）。
* 实测结论追加进 `research/`。

## Out of Scope

* 反向（放宽到「取第一条」）、拼音/英文翻译层、逐景点别名表。
* alt 从不提专名的那一类（Nanluoguxiang / Xixi Wetland / Jiuxi 等）—— 无解，交给高德那一级。
* 高德闸门与链路顺序（本轮不动）。

## Risks

* 核心词越短越容易巧合命中。当前用「≥2 字 + 只剥一层」约束；实测 20 个名字未出现误放，但**样本只有 20 个**，冷门地点仍需观察。
* `per_page=15` 让单次响应更大（约 3 倍），但调用次数与配额不变。

## Technical Notes

* `apps/server/src/integrations/pexels/cover.ts`（`PER_PAGE`、`pickCover`、`slugOf`）
* `apps/server/src/lib/placeKey.ts` 的 `normalizePlaceKey`（只剥机构后缀，与本次的 `GENERIC_SUFFIXES` 互补）
* `apps/server/src/__tests__/pexelsCover.test.ts`

## Research References

* 实测数据（三轮：中文 / 加城市 / 英文，以及本轮放宽前后）记于本轮 `research/pexels-gate.md` 与归档任务 `09-27-pexels-cover`。
