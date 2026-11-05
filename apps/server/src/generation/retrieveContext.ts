// 检索核心接受只读依赖，独立探针不触发数据库迁移。
import { pool } from '../db/client';
import { embedQuery } from '../integrations/embedding';
import { createPlaceRetriever } from './placeRetrieval';

export type { EvidenceItem, RetrievedPlace, RetrieveOptions } from './placeRetrieval';
export const retrieveContext = createPlaceRetriever({ query: (sql, values) => pool.query(sql, values), embed: embedQuery });
