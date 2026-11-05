# 济南超然楼独立图库及完整自查

实体批次仍截至34，没有batch35。独立图片第三批已正式应用，禁止重放01至03；超然楼两条原入选记录完成AI自查，整体任务未验收，不提交或归档。

## 四张确认图片

完整来源冻结在`priority-cities/济南/tower-photo-sources-01.json`；10张视觉副本、字节摘要及联系表在`tower-photos-01/`，逐图结论在`independent-photo-batch-03/visual-review.json`。

- T03：正面夜景，匾额可读，楼体结构与白天图一致。
- T04：高德关联航拍，主楼、两侧亭阁与白色连廊的形制经视觉核对；保留原官方URL及已下载字节摘要，不声称今后远端内容不可改变。
- T07：白天正面，匾额与楼体可辨；不改变原审美排序。
- T10：园林与济南天际线，画面无楼体。Commons作品页明确Sprt98自摄“从超然楼望济南01”，作为登楼视角确认，不把大明湖或摄影点合并为超然楼。

其余六图为南京牌坊/秦淮河/灵谷寺、韩国水原华城、福建土楼等原拒绝图，保持拒绝，不重复写null，以免影响其他目录同资产的正确归属。四张确认图的同资产来源均检查无其他目录冲突。

来源命令：`smart-search fetch 'https://commons.wikimedia.org/wiki/File:%E4%BB%8E%E8%B6%85%E7%84%B6%E6%A5%BC%E6%9C%9B%E6%B5%8E%E5%8D%9701.jpg' --format json --output .trellis/tasks/10-06-place-identity-governance/research/priority-cities/济南/tower-fetch-commons-t10-01.json`。抓取成功，未改署名与许可。

## 应用及验证

`prepare-tower-photo-decisions.mjs`生成新key `independent-photo-batch-03-jinan-20261008`，目标超然楼revision2，四图初始分配revision0。`apply-tower-photos.mts`先事务预演再正式应用；预演和应用均检查原目录摘要、7张业务表摘要、旧图片审计与13条已有分配。全局独立分配13→17，济南5→9，201历史行程摘要保持`e01d67cbf42a62fc595f4ef052f99e75`。

隔离实图测试`verify-tower-photos.test.mts`在专用PG复制真实城市目录与已有5分配，执行新批次、幂等、生产图片入口及回滚。四绑定分别可用，保留署名，主名及大明湖超然楼均展示同一组三图；其他主体不借用超然楼图，博物馆和教堂旧图片仍可消费。应用后第二次测试从实库读回四分配并与隔离结果一致。没有补图入队或Unsplash请求。

应用前日志`downstream-place_identity_test_1791400025259.log`，应用后日志`downstream-place_identity_test_1791400232518.log`，均通过并由runner删除临时库。

`check-jinan-cultural-sources.py --tower`重新核查5365/5368两源24提及、完整同名及别名集合；全城冻结107原源、662提及、82原文保持。`verify-jinan-cultural.mts --tower 02`验证两个名称SQL首位、真实向量used、旧ID重定向、四项独立边界、24条关系来源及原导出身份。上游管理图库0，独立10图/4绑定，与实际目录分别核验。

首轮`tower-downstream-check-01.json`报告参考点比较失败：原源36.675236146160806/117.0320776418472与导出36.675236/117.032078不同精度。已核对上游`export_to_tripweaver.py`六位小数规则，修正探针后02通过；实体及位置未改，失败工件保留。

## 教堂位置补证及后续

中英文百科fetch确认洪家楼1号、山东大学洪家楼校区西侧及西侧双塔立面，但属于同一百科来源体系，不能视为独立交叉验证。原参考点与geo-05候选约57米差异尚无建筑范围证据；未更改位置。

主搜索此前返回供应商模型不可用（grok-4.7 / model_not_found），OSM边界fetch无正文。本轮`smart-search zhipu-search`与`exa-search`分别报告ZHIPU_API_KEY、EXA_API_KEY未配置，错误工件保留，没有更改配置。已知页面fetch可用，但不能据地址或距离推断点落入楼体。

最新review-08：98原入选行，4非地点、6行AI自查（4现行主体）、88未完成；原7待定位、教堂位置、4行泉池/公园部分治理继续。50实体对与56提及待审及4必去缺口保持，不将图库批次成功作为城市完成。下一步普通重点地点：解放阁、泉城广场、济南府学文庙，再继续余下城市。
