# 静阅 · 智慧自习室预约与管理系统

依据《智慧自习室预约与管理系统需求规格说明书》V2.5.6 实现的课程项目。单体应用：Node.js + Express 5 + SQLite（Node 内置 `node:sqlite`），前端为无构建步骤的原生 ES Modules SPA。

## 运行

```bash
pnpm install
pnpm seed     # 重置并写入演示数据
pnpm start    # http://127.0.0.1:3000
```

要求 Node.js ≥ 22.5、pnpm ≥ 9。

## 演示账号（密码均为 123456）

| 账号 | 角色 | 说明 |
|---|---|---|
| u01 / u02 / u03 | 学生 | 本人预约、签到、投诉与评价 |
| m1 | 场地管理员 | 仅管理图书馆二层 |
| m2 | 场地管理员 | 仅管理图书馆三层 |
| s1 | 系统管理员 | 账号、规则、审计、业务复核与统计 |

## 测试

```bash
pnpm test           # Vitest：单元 / API / 浏览器端到端
pnpm test:unit
pnpm test:e2e
pnpm test:coverage
```

`tests/unit/server` 使用真实 HTTP 与临时 SQLite，`tests/unit/client` 使用 happy-dom，`tests/e2e` 使用 playwright-core 驱动本机 Chrome/Edge。当前 57 项通过、1 项按环境跳过。

演示历史数据为近 7 天、约 25%—30% 的使用率。

## 性能数据（可选）

```bash
pnpm seed:perf      # 500 座位 + 1 万条历史预约的性能数据集
```

本机 20 次顺序请求：统计接口中位 135.5ms / P95 243.0ms；可用性查询中位 71.7ms / P95 137.6ms。

## 文档

架构、API 清单、数据模型、需求映射、业务不变量、已知问题与后续计划见 **[docs/交接文档.md](docs/交接文档.md)**。