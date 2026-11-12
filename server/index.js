import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import config from './config.js';
import { attachUser } from './auth.js';
import router from './routes.js';
import { AppError } from './errors.js';
import { seedIfEmpty } from './seed.js';
import { startScheduler, stopScheduler } from './scheduler.js';

seedIfEmpty();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'",
  );
  next();
});
app.use(attachUser);

app.use('/api', router);
app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: '接口不存在' } });
});

app.use(express.static(config.publicDir, { index: 'index.html', maxAge: '1h' }));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/')) return next();
  const file = path.join(config.publicDir, 'index.html');
  if (!fs.existsSync(file)) return res.status(503).send('前端资源尚未构建');
  return res.sendFile(file);
});

app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details || null },
    });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: { code: 'bad_request', message: '请求体不是有效的 JSON' } });
  }
  console.error('[error]', err);
  return res.status(500).json({ error: { code: 'internal_error', message: '服务器处理失败，请稍后重试' } });
});

const server = app.listen(config.port, config.host, () => {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : config.port;
  console.log(`智慧自习室预约与管理系统已启动：http://${config.host}:${actualPort}`);
  console.log(`演示账号：u01 / 123456（学生），m1 / 123456（R1 场地管理员），s1 / 123456（系统管理员）`);
});

startScheduler();

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务...`);
  stopScheduler();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };