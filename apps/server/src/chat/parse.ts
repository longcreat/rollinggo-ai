// LLM 原始输出的防御性读取基元（自 chat/models.ts 下沉；models.ts 其余「对话理解契约」已随
// understanding 链路删除，foodSearch / brief 的归一化读取仍需要这两个函数）。

/** 把 LLM 工具参数/JSON 输出收敛成可按键读取的对象；非对象一律当空对象 */
export function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function readStringArray(raw: unknown, key: string): string[] {
  const value = asRecord(raw)[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
