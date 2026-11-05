import path from 'node:path';
import { campaignReport } from './campaignReport';
const directory = process.argv[2];
if (!directory) throw new Error('用法：npm run eval:campaign:report -- <活动目录>');
const result = campaignReport(path.resolve(directory));
console.log(result);
process.exitCode = result.pass ? 0 : 1;
