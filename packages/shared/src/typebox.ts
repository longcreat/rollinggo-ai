import { Type, type TLiteral, type TUnion } from '@sinclair/typebox';

type LiteralTuple<T extends readonly string[]> = { -readonly [K in keyof T]: TLiteral<T[K] & string> };

/**
 * 字符串枚举辅助：把 `as const` 字符串数组构造成字面量 Union schema。
 * 类型收窄为字面量联合（标准 TypeBox 构造），供 schemas.ts 与 chat.ts 共用。
 */
export const StringEnum = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v))) as unknown as TUnion<LiteralTuple<T>>;
