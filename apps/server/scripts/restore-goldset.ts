// 从eval快照恢复金集来源，保留当前身份、受控提及和图库等治理字段。
// 可选：--snapshot-dir <目录> --dry-run；每城事务保存可回滚审计。
import { runGoldsetImport } from './lib/goldsetImport';

runGoldsetImport('restore').catch(error=>{
  console.error('[restore] 失败：',error);
  process.exitCode=1;
});
