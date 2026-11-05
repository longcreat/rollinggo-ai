# 联合来源实施与验证记录

## 当前状态

联合来源治理已安装，成员表迁移完成，尚无实城联合批次。实城冻结`joint-coffee-source-1791338728505852300.json`：scope2、scope_source0、assignment3；四条咖啡提及未变。最新audit/run-22为139行/138实体对，全uncertain，提及/图片待审0、异常0。最新完整消费链路仍是flow/run-24，仅两组4条目录歧义；本记录不宣称全城通过。

## 安装与迁移

39暂存文件中8文件变化：models、migrate_place_identity、aggregate/mention_identity、aggregate/summary、clean/mention_identity、clean/scoped_place_export、test_mention_identity_db和新增test_joint_mention_identity_db。哈希安装成功，清单冻结为`upstream-install-joint-20261007.json`，逐版本备份保留。

迁移预览仅缺place_identity_scope_source；apply创建，二次apply missing=[]。迁移原输出在前轮工具记录，本轮不伪造独立执行日志；实城只读冻结证明表存在且0行。不重复安装或迁移。

## 验证

- 专项152通过：upstream-stage-place_identity_test_1791337652369.log。
- 最终完整381通过：upstream-full-place_identity_test_1791338475884.log；覆盖REVIEW来源可纳管但不能作目标。
- 23旧批次幂等/倒序回滚23/23：scope-batch-regression-1791338445170.json。
- batch24暂存模块兼容：all-cities/batch-24/scope-preview-1791338328258320000；日志upstream-stage-place_identity_test_1791338325898.log。
- 合成真实导出：all-cities/joint-scope/run-1791338090345872300，文件哈希、幂等和倒序回滚见report.json。
- 真实下游脚本/SQL/双旧ID/金集缓存图片向量清理/行程保存编辑/全空撤回/恢复/旧版拒绝/倒序审计通过：downstream-place_identity_test_1791338206537.log。
- 专用tsconfig.verify-joint.json与全仓npm run typecheck退出0。运行器均已清理专用数据库。

## Bug Analysis: 联调探针错误

### 1. 根因分类

B跨层契约和E隐含假设：生成器假定无坐标也能普通导出，探针假定任意JSON文件名可导入、groups是一维地点数组、事实Map使用展示名。这些均为验证脚本错误，不是产品修复。

### 2. 失败轨迹

1. upstream-stage-place_identity_test_1791337924294.log：合成初态0行；仅补合成坐标。
2. downstream-place_identity_test_1791338064553.log：before.json未被实际导入器接受；生成器改为xhs-places前缀，新目录留证。
3. downstream-place_identity_test_1791338108210.log：groups结构误解；使用flatMap。
4. downstream-place_identity_test_1791338167107.log：事实键错误；使用shared placeNameKey。

### 3. 预防措施

|优先级|措施|状态|
|---|---|---|
|P0|读取实际导入入口、索引与Map签名，不按调用想象构造探针|已修正|
|P0|研究测试新增专用静态检查|已通过|
|P1|生成工件前缀和哈希固定，失败目录不覆盖|已落实|

### 4. 同类扩展

scope-only批次城市必须从scope请求读取；全城探针只遍历verified目录会遗漏撤回主体，须新增独立撤回核验再应用实城联合批次。不能让4条歧义消失就算完成。

### 5. 知识固化

已更新place-identity.md第14、15节。本项目无对应src/templates/markdown/spec目录，不虚构模板同步。用户验收前禁止提交覆盖技能自动提交要求。

## 未完成范围

实城四提及的门店定位仍缺证据；新分店创建正式审计入口、独立图库逐图绑定、逐提及关系挖掘仍未实现。合成测试预建分店不能证明这些能力。完整任务未验收。
