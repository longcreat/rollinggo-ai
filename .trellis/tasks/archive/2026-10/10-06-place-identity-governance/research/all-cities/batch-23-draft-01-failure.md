# batch-23首轮草稿失败

- 三项字段决策生成成功；build-reviews重建batch-13时缺少其补充实体，报undefined.revision，审核请求未生成。
- 隔离预演同样因缺少batch-13补充实体失败，日志为`../upstream-stage-place_identity_test_1791329105567.log`。临时库finally已清理，未触及实库。
- 原batch-23-selections、decisions和prerequisites保持不变。补加`batch-23-supplements.json`引用已有冻结`xian-batch13-supplement.json`后，只重新生成审核请求，再完整预演。
- 主脚本已同步修正，禁止直接重跑覆盖现有草稿。后续步骤必须检查前一个命令成功退出，生成失败不能继续依赖预演。
