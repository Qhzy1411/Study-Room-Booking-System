import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 启动一个隔离的测试服务：独立临时数据库、随机端口、演示模式开启。
 * 服务启动时会自动写入演示数据。
 */
export async function startTestServer({ env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srb-test-'));
  const dbPath = path.join(dir, 'test.db');
  const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: '0',
      HOST: '127.0.0.1',
      DEMO_MODE: '1',
      TICK_INTERVAL_MS: '2000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`测试服务启动超时\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 40000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`测试服务提前退出（code=${code}）\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  return {
    base,
    port,
    dbPath,
    dir,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async close() {
      if (!child.killed) {
        child.kill();
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitForHealth(base) {
  const deadline = Date.now() + 30000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务健康检查失败：${lastError?.message || 'timeout'}`);
}