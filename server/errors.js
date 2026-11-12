/** 业务异常：携带 HTTP 状态码与稳定错误码，供接口统一返回。 */
class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
const unauthorized = (message = '请先登录') => new AppError(401, 'unauthorized', message);
const forbidden = (message = '没有权限执行该操作') => new AppError(403, 'forbidden', message);
const notFound = (message = '对象不存在') => new AppError(404, 'not_found', message);
const conflict = (message, details) => new AppError(409, 'conflict', message, details);
const unprocessable = (message, details) => new AppError(422, 'unprocessable', message, details);
const tooMany = (message = '请求过于频繁，请稍后再试') => new AppError(429, 'too_many_requests', message);

export {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooMany,
};