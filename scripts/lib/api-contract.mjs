import assert from 'node:assert/strict';

/** 测试夹具也使用正式传输契约，业务对象不需要重复包装。 */
export const apiSuccess = (data) => ({ code: 0, message: '成功', data });
export const apiFailure = (status, message, data = null, code = status) => ({ code, message, data });

/** 成功解包业务值，失败保留完整错误外层供断言。拒绝旧格式。 */
export async function readApiResponse(response) {
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'data', 'message']);
  assert.equal(typeof body.message, 'string');
  assert.ok(typeof body.code === 'string' || Number.isInteger(body.code));
  if (response.ok) assert.equal(body.code, 0);
  else assert.notEqual(body.code, 0);
  return body.code === 0 ? body.data : body;
}
