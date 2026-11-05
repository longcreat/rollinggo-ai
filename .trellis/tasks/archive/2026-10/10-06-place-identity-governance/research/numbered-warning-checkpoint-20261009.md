# 编号原评价协议与武侯祠／锦里检查点

实体69之后完成编号标题原评价协议安装与只读研究：上游743通过/1真实地图检查排除，暂存及已安装警示专项各28通过，编号夹具实际双导入/移除/旧版本拒绝/幂等/逆序回滚通过。真实note948两段完整原评价通过、10变体拒绝，未创建业务scope。武侯祠/锦里2源43提及、27直接正文及补充948已逐项记录；武侯祠150分钟为含锦里路线，锦里75分钟含打车，住宿片区描述和主巷粒度待正式治理。已复现未绑定web profile被替换及静态planning补回主巷。两点实际facts/lookup均无图，mock2/真实队列0仅为预检。成都review06仍0完整/113未完成（3部分scope、4位置部分、1类别部分、105其余），47分配不变；未应用发现4→6。实体69/flow71/audit68、济南review45、原范围和无待同步状态保持。扩展typecheck通过；不看图、地图凭据待轮换，未验收不提交归档。

## 已安装与验证

[协议设计](numbered-warning-design-20261009.md)保留七字段、原指纹和存储；允许严格编号格式的主体标题，quote不改写。已安装65文件中3文件更新，无迁移、无上游web重启。真实[两段原文校验](priority-cities/成都/numbered-warning-real-proof-01.json)与[合成编号端到端验证](note-warning-preview-1791510212253/numbered/downstream-verification-1791510309579.json)分别留证；后者是隔离夹具，不是成都业务scope应用。

测试：上游743通过/1真实地图检查排除；暂存及已安装警示专项各28通过；实际下游编号协议1项通过；实际媒体预检1项通过；新增预检已纳入扩展tsconfig并通过类型检查。日志名与文件hash见[校验记录](priority-cities/成都/numbered-warning-checkpoint-verification-01.json)。本轮没有改动生产TypeScript；全仓typecheck沿用第69批成功记录。

## 逐提及研究与下一步

[43条逐项结论](priority-cities/成都/wuhou-jinli-source-review-01.md)及[带日期/指纹的JSON](priority-cities/成都/wuhou-jinli-source-review-01.json)记录27篇直接正文与补充note948。原正反意见、日期、历史教师优惠和note900的null分析保留。没有查看图片或把所有分析字段宣称已审。

1. 武侯祠150分钟路线包含锦里，住宿片区reason/evidence需按主体排除。完整scope前必须保全3条网页看点，现行开放时间冲突仍未定；不直接给缓存补绑定。
2. 锦里主巷为子项。已[复现静态补名](priority-cities/成都/wuhou-jinli-content-preflight-01.json)，先治理最终导出的主巷入口，再做正式scope。住宿reason和含打车75分钟应分别处置；当前导出无独立时长，不得因scope引入该75分钟。
3. 两处实际facts与专用lookup无图，武侯祠5个独立来源均不eligible，锦里0来源；[媒体预检](priority-cities/成都/wuhou-jinli-photo-preflight-01.json)只是按假设scope门禁比较，正式应用仍需真实导出、双导入、字段/旧ID/媒体/行程核对。

不创建batch70、不重放68/69。下一实体批次70、flow72、audit69，成都下次review07。当前实体仍69，累计flow71为338正例/113边界/52撤回零失败，audit68为313 PENDING；本次未重跑这两份未变数据的历史验证。冻结范围978主体+56依赖/1135源、183范围待审及4必去缺口不变。没有用户验收，不提交、归档或标记完成。
