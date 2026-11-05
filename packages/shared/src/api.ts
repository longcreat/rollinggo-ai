import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** 0 表示成功；错误保留业务字符串码，无业务码时使用 HTTP 状态码。 */
export const ApiResponseSchema = Type.Object({
  code: Type.Union([Type.Integer(), Type.String({ minLength: 1 })]),
  message: Type.String(),
  data: Type.Unknown(),
}, { additionalProperties: false });

export type ApiCode = Static<typeof ApiResponseSchema>['code'];
export type ApiResponse<T = unknown> = Omit<Static<typeof ApiResponseSchema>, 'data'> & { data: T };

export function isApiResponse(value: unknown): value is ApiResponse {
  return Value.Check(ApiResponseSchema, value);
}
