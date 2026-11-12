import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.js'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // API 测试通过子进程启动真实服务，V8 进程内覆盖率无法统计服务端；
      // 这里只统计在测试进程内直接 import 的工具模块。
      include: [
        'server/time.js',
        'public/js/api.js',
        'public/js/state.js',
        'public/js/util.js',
        'public/js/seatmap.js',
        'public/js/charts.js',
      ],
    },
  },
});