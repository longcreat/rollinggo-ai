// eval金集只补独立新地点；已声明名称、旧ID和撤回身份不重新创建。
// 可选：--snapshot-dir <目录> --dry-run；每城事务保存可回滚审计。
import { runGoldsetImport } from './lib/goldsetImport';

runGoldsetImport('seed').catch(error=>{
  console.error('[seed] 失败：',error);
  process.exitCode=1;
});
