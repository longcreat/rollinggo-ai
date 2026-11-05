# 补充主链路代码注释

## Goal

用户要逐块精读 apps 的核心实现，需要代码里有足够的中文注释支撑自读，之后由 AI 出题考察理解。本次只做注释补充，不改任何运行时行为。

## Requirements

* 范围：一次行程请求的主链路，按目录从入口往下钻
  1. 入口层（`apps/server/src/index.ts` 等启动与路由挂载）
  2. `routes/`（HTTP 契约与鉴权边界）
  3. `chat/`（理解、编辑操作、提示词）
  4. `generation/`（orchestrator、agents/runner、tools、scheduling）
  5. `services/`（业务服务）
  6. `integrations/` 与 `db/`
* 粒度：文件头说明文件职责 + 关键函数 JSDoc（入参、返回值、副作用、调用方）；不逐行翻译代码
* 注释语言：简体中文；术语保留英文原名
* 每完成一个模块，AI 出 3-5 道考察题，答错则回到该处补注释

## Acceptance Criteria

* [ ] 每个改动文件只增加注释，`git diff` 中不出现逻辑行变化
* [ ] `npm run typecheck` 与 `npm run lint` 通过
* [ ] 每模块交付时给出：改了哪些文件、新增注释讲清了什么、考察题

## Definition of Done

* 主链路六大模块注释完成，用户可独立读懂
* 改动停在提交前，等用户验收

## Technical Approach

按上表顺序逐模块推进：先读全模块文件，再批量补注释，最后跑 typecheck/lint。已有良好注释的文件不重写，只补缺口。跨文件的数据流（如 `PlaceFacts`、`Draft` 的生成与消费）在首次出现处讲清，后续引用不再重复。
