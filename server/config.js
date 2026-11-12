import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: path.join(root, 'data'),
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'studyroom.db'),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  // 演示模式：允许系统管理员通过界面调整业务时钟，便于演示签到窗口、到期等时间场景。
  demoMode: process.env.DEMO_MODE !== '0',
  sessionTtlMs: 12 * 60 * 60 * 1000,
  qrSecret: process.env.QR_SECRET || 'studyroom-demo-qr-secret-2026',
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS || 5000),
  // DEMO-1 参数（BR-04 / 5.2）：首版规则版本使用这些值，之后可由系统管理员发布新版本。
  defaultRule: {
    advanceDays: 7,
    checkinGraceMin: 15,
    awayMinutes: 15,
    minMinutes: 30,
    dailyCount: 4,
    dailyMinutes: 240,
  },
  cookieName: 'srb_session',
};

export default config;