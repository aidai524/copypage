# @copypage/server — 捕获与验证服务

把 CopyPage 工具链封装成 HTTP 服务：提交 URL/图片/视频 → 后台串行捕获 → 提交还原工程验证（构建 + 探测 + 差异 + 报告 + 收敛判定），全程 SSE 实时进度。

## 运行

```bash
npm run serve                                  # http://127.0.0.1:4400，数据在 work/server
npx tsx packages/server/src/cli.ts --port 4400 --data-dir work/server
```

UI 为单页应用（`public/index.html`，零依赖）：新建捕获、任务列表、进度日志、截图预览、产物链接、验证面板（指标 / 收敛历史 / 报告 / 热力图 / 差异清单）。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/tasks` | `{ type: "url"\|"image"\|"video", source, options? }` 创建捕获任务并入队 |
| `GET` | `/api/tasks` | 任务列表 + 队列长度 |
| `GET` | `/api/tasks/:id` | 单个任务（含 capture 结果、收敛状态、全部验证记录） |
| `POST` | `/api/tasks/:id/verifications` | 创建验证任务，见下 |
| `GET` | `/api/events` | SSE：任务任意变更时推送完整任务 JSON |
| `GET` | `/api/tasks/:id/artifacts/<rel>` | 原始快照文件（orig/ 下的截图、DOM、dynamic.json…） |
| `GET` | `/api/tasks/:id/files/<rel>` | 任务目录下任意文件（报告、热力图、repro-snap…） |
| `GET` | `/api/health` | `{ ok, tasks, queue }` |

### 创建验证

两种方式，二选一：

```bash
# 1) 服务器本地路径（单租户阶段允许，公网部署必须收紧）
curl -X POST localhost:4400/api/tasks/<taskId>/verifications \
  -H 'content-type: application/json' \
  -d '{"repro":{"type":"path","source":"/abs/path/to/repro"}}'

# 2) zip 上传（自动解压；单顶层目录会自动下钻）
curl -X POST localhost:4400/api/tasks/<taskId>/verifications \
  -H 'content-type: application/zip' -H 'x-filename: my-repro.zip' \
  --data-binary @my-repro.zip
```

验证需要原捕获任务已完成（否则 409）。

## 流水线（与本地命令行完全一致）

```
captureRepro(reproDir)          # 有 package.json 则 npm run build；静态目录直接服务
  → 同一套 Playwright 探测脚本（states/dynamic 关闭）
diffSnapshots(orig, reproSnap)  # 像素 + DOM 双层；自动应用 dynamic.json 遮罩
writeReport(...)                # report.html（并排滑块 + 差异清单）
decide(loop, metrics)           # pass / continue / escalate / stagnant-stop / cap-stop
```

- 捕获阶段的任务选项（viewports / maxNodes / states / dynamic / assetsBudgetMs）会原样传给验证
- `loop` 随每次验证推进：`history` 追加指标，`escalate` 一旦触发保持
- 构建失败（`BuildError`）会记录完整构建输出，验证状态置为 failed

## 质量基线

同一份输入（本地快照 + 本地还原工程）经服务端流水线验证，指标与本地命令行逐位一致：

| 输入 | SSIM | 像素差 | 动态区域 |
|---|---|---|---|
| pump.fun 首页快照 + 还原工程 | 0.9203 | 1.53% | 8.18% |

服务端与本地共用同一批函数与默认参数（动态遮罩、冻结、字体/资产策略），不存在"线上降级"路径。

## 磁盘布局

```
<data-dir>/tasks/<taskId>/
├── task.json                     # 任务 + 收敛状态 + 验证记录
├── orig/                         # 捕获快照
└── verifications/<vid>/
    ├── upload.zip / repro/       # zip 验证
    ├── repro-snap/               # 还原页探测结果
    ├── diffs/r<N>/               # diff.json + 热力图 + VLM 请求
    └── report.html               # 人眼终审报告
```

## 阶段边界（当前为单租户本地服务）

- 无认证/配额；`/files` 允许任务目录下任意文件
- 验证支持服务器本地路径（设计如此，Phase 4 公网部署前必须约束）
- `npm run build` 在服务进程的子进程中执行，未做容器隔离（Phase 4）
- 队列串行（一次一个浏览器任务），适合单机；扩容需要 worker 池 + 容器化浏览器
