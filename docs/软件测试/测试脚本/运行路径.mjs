import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function requiredDirectory(name) {
  const value = process.env[name];
  if (!value) throw new Error('请按报告附录设置环境变量 ' + name);
  return path.resolve(value);
}

export const project = requiredDirectory('TEST_PROJECT');
export const outputDir = requiredDirectory('TEST_OUTPUT');
fs.mkdirSync(outputDir, { recursive: true });
export const baseline = new URL('../测试结果/测试版本文件校验清单.json', import.meta.url);
export const projectFile = name => pathToFileURL(path.join(project, name));
