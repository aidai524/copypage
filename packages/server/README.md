# @copypage/server — 捕获与验证服务

把 CopyPage 工具链封装成 HTTP 服务：提交 URL/图片/视频 → 后台串行捕获 → 提交还原工程验证（构建 + 探测 + 差异 + 报告 + 收敛判定），全程 SSE 实时进度。

## 运行

```bash
npm run serve                                  # http://127.0.0.1:4400，数据在 work/server
npx tsx packages/server/src/cli.ts --port 4400 --data-dir work/server
```

### 启动参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` / `--port` | 127.0.0.1 / 4400 | 非 loopback 绑定必须配 token |
| `--token` | 无 | 所有 `/api/*` 需要 `Authorization: Bearer <token>`(SSE 用 `?token=`) |
| `--allow-build` | **关** | 允许对提交的工程执行 `npm run build`(= 任意代码执行,仅本地信任环境开启) |
| `--allow-private-network` | **关** | 关闭 SSRF 防护(本地 fixture 测试用) |
| `--max-tasks` | 50 | 任务数上限,超出返回 507 |
| `--max-upload-mb` | 200 | zip 上传大小上限 |
| `--retention-hours` | 168 | 完成任务的保留时长,过期自动删除 |

环境变量同名:`COPYPAGE_TOKEN`、`COPYPAGE_ALLOW_BUILD`、`COPYPAGE_ALLOW_PRIVATE_NETWORK`、`COPYPAGE_MAX_TASKS`、`COPYPAGE_MAX_UPLOAD_MB`、`COPYPAGE_RETENTION_HOURS`。

### 安全默认值

- 未配 token 启动时**拒绝**绑定非 loopback 地址
- 构建默认禁用:验证需要提交**已构建好的 `dist/`**(或纯静态目录),服务器不执行提交的代码
- URL 捕获默认做 SSRF 校验:仅 http/https,域名解析后所有地址必须是公网(禁环回/内网/链路本地/云元数据/IPv4-mapped)
- 令牌比较为常数时间(sha256 + timingSafeEqual)
- zip 解压防 zip-slip;上传/任务/保留时长均有上限

> SSRF 校验发生在提交时,浏览器加载时会再次解析域名。要做到对 DNS rebinding 的完全防护,部署时还需在网络层限制出站(只允许白名单端口/网段)。

UI 为单页应用(`public/index.html`,零依赖):右上角可填访问令牌(存 localStorage),其余功能包括新建捕获、任务列表、进度日志、截图预览、产物链接、验证面板(指标 / 收敛历史 / 报告 / 热力图 / 差异清单)。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/tasks` | `{ type: "url"\|"image"\|"video", source, options? }` 创建捕获任务并入队 |
| `GET` | `/api/tasks` | 任务列表 + 队列长度 |
| `GET` | `/api/tasks/:id` | 单个任务(含 capture 结果、收敛状态、全部验证记录) |
| `POST` | `/api/tasks/:id/verifications` | 创建验证任务,见下 |
| `GET` | `/api/events` | SSE:任务任意变更时推送完整任务 JSON |
| `GET` | `/api/tasks/:id/artifacts/<rel>` | 原始快照文件(orig/ 下的截图、DOM、dynamic.json…) |
| `GET` | `/api/tasks/:id/files/<rel>` | 任务目录下任意文件(报告、热力图、repro-snap…) |
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

验证需要原捕获任务已完成(否则 409)。**默认构建禁用**:上传的工程需要已经包含 `dist/index.html`(或本身就是静态目录),否则验证会以 `server-side build is disabled` 失败。本地信任环境可用 `--allow-build` 开启服务端构建。

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

## 阶段边界(当前为单租户私有服务)

- 无多用户/配额计费/滥用审核:适合本机或内网 + 单令牌使用
- 验证接受服务器本地路径,且 `/files` 可访问任务目录(部署到可被他人访问的环境前必须收紧)
- 构建默认禁用(见上);即使开启也在服务进程子进程中执行,未做容器隔离
- 队列串行(一次一个浏览器任务),适合单机;扩容需要 worker 池 + 容器化浏览器
- DNS rebinding 的完全防护依赖网络层出站限制

公网部署前建议完成:反向代理 + TLS、容器化构建沙箱、出站网络策略、多租户隔离、限流与滥用处置通道。
