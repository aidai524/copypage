# @copypage/server — 捕获与验证服务(多租户)

把 CopyPage 工具链封装成 HTTP 服务：提交 URL/图片/视频 → 后台 worker 进程捕获 → 提交还原工程验证（构建 + 探测 + 差异 + 报告 + 收敛判定）或让 agent 自动生成，全程 SSE 实时进度。支持单租户与多租户（账号、配额、审核、管理后台）两种形态。

## 运行

```bash
npm run serve                                  # http://127.0.0.1:4400，数据在 work/server
# 公开多租户模式
npx tsx packages/server/src/cli.ts --host 0.0.0.0 \
  --token "$COPYPAGE_TOKEN" --allow-registration \
  --admin-email you@example.com --admin-password '...' \
  --worker-concurrency 4
```

### 启动参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` / `--port` | 127.0.0.1 / 4400 | 非 loopback 绑定必须配 token |
| `--token` | 无 | 所有 `/api/*` 需要 `Authorization: Bearer <token>`(SSE 用 `?token=`) |
| `--allow-build` | **关** | 允许对提交的工程执行 `npm run build`(= 任意代码执行,仅本地信任环境开启) |
| `--allow-agent` | **关** | 允许 agent 自动生成(agent 拥有 shell 访问权,等价于代你执行命令) |
| `--agent-command` | pi | agent 可执行文件 |
| `--agent-model` | pi 默认 | 传给 agent 的模型,如 `sonnet:high` |
| `--agent-max-rounds` | 8 | 生成–验证循环轮数上限 |
| `--agent-timeout-min` | 30 | 单轮 agent 墙钟超时 |
| `--allow-private-network` | **关** | 关闭 SSRF 防护(本地 fixture 测试用) |
| `--max-tasks` | 50 | 任务数上限,超出返回 507 |
| `--max-upload-mb` | 200 | zip 上传大小上限 |
| `--retention-hours` | 168 | 完成任务的保留时长,过期自动删除 |
| `--rate-limit-per-minute` | 120 | 每调用方每分钟 /api 请求上限(登录后按用户,否则按 IP;0 关闭) |
| `--trust-proxy` | 关 | 信任 `X-Forwarded-For`(仅当所有请求都经反代) |
| `--allow-registration` | **关** | 开放自助注册(公开模式) |
| `--admin-email` / `--admin-password` | 无 | 首次启动创建引导管理员 |
| `--worker-concurrency` | 2 | 全局并行任务数(每个任务一个 worker 进程) |
| `--worker-memory-mb` | 3072 | worker 进程 V8 堆上限 |

环境变量同名:`COPYPAGE_TOKEN`、`COPYPAGE_ALLOW_BUILD`、`COPYPAGE_ALLOW_PRIVATE_NETWORK`、`COPYPAGE_ALLOW_AGENT`、`COPYPAGE_AGENT_COMMAND`、`COPYPAGE_AGENT_MODEL`、`COPYPAGE_AGENT_MAX_ROUNDS`、`COPYPAGE_AGENT_TIMEOUT_MIN`、`COPYPAGE_MAX_TASKS`、`COPYPAGE_MAX_UPLOAD_MB`、`COPYPAGE_RETENTION_HOURS`、`COPYPAGE_RATE_LIMIT_PER_MINUTE`、`COPYPAGE_TRUST_PROXY`、`COPYPAGE_CHROMIUM_ARGS`。

容器内运行需 `COPYPAGE_CHROMIUM_ARGS=--no-sandbox`(Chromium 以 root 运行时拒绝启动沙箱)。部署方式见 `deploy/README.md`(systemd 用户服务 / Docker Compose 两种)。

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
| `POST` | `/api/tasks/:id/generate` | 启动 agent 自动生成(需 `--allow-agent`) |
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

## 多租户

| 能力 | 说明 |
|---|---|
| 账号 | 邮箱 + 密码(scrypt);会话 cookie(HttpOnly/SameSite)或 API 令牌(`cp_…`,仅存哈希) |
| 角色 | `user` / `admin`;引导管理员首次启动自动创建 |
| 隔离 | 任务、产物、SSE 均按 owner 过滤;跨租户读写返回 404;服务器本地路径验证仅限管理员 |
| 配额 | 套餐(`free`/`pro`/`unlimited`)限制任务数/存储/每日捕获·验证·生成次数/并发;超限 403 + `code`/`quota`/`usage` |
| 审核 | 域名封禁(含子域)在捕获入口拦截;用户暂停即全站 403 |
| 审计 | 注册、登录、令牌、封禁、配额、删除写入 `audit_log` |

状态存 SQLite(`node:sqlite`,`dataDir/copypage.db`,WAL),产物仍在 `dataDir/tasks/<id>/`。

### 认证与管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/register` / `/api/auth/login` / `/api/auth/logout` | 注册/登录/退出 |
| `GET` | `/api/auth/me` | 身份 + 配额 + 用量 |
| `GET/POST` | `/api/tokens` · `DELETE /api/tokens/:id` | API 令牌 |
| `GET/PATCH` | `/api/admin/users(/:id)` | 用户列表 / 改状态·套餐·配额·密码 |
| `GET/POST/DELETE` | `/api/admin/blocks(/:id)` | 域名封禁 |
| `GET` | `/api/admin/audit` / `/api/admin/stats` | 审计 / 统计 |

默认套餐:free 10 任务/500MB/每日 1 次生成;pro 200/20GB/20;unlimited 不限制。可按用户覆盖单项配额。

## 任务执行(worker 进程隔离)

```
API 进程 ──enqueue──▶ 队列(全局并发 + 每租户并发)
                         │ spawn tsx worker.ts(独立进程,NODE_OPTIONS 堆上限)
                         ▼
              jobs.ts: capture / verify / generate
                         │ JSONL 事件(stdout):进展 · 验证 · 循环 · 结果
                         ▼
              调度器写入 SQLite → SSE 推送
```

- 每任务一个 worker 进程:崩溃不影响 API,内存有上限,超时 SIGTERM→SIGKILL
- worker 不碰数据库,状态统一由调度器落库;重启后一致
- 容器化隔离(每租户独立容器/网络)只需把 `queue.ts` 的 spawn 换成 `docker run`,接口不变

## 自动生成

```bash
curl -X POST localhost:4400/api/tasks/<taskId>/generate
```

服务端驱动、agent 执行的闭环(与本地手工迭代完全同构):

```
runGenerationLoop:
  轮 1  agent(pi --mode json --skill skill/ --session-id <id>)
        └─ 读取 orig 快照(DOM/截图/adaptive/interactions/states/assets)
        └─ 在 <taskDir>/generated-repro 写 React 工程
  服务端 verify:  captureRepro → diffSnapshots(动态遮罩)→ report → decide
  └─ pass/stagnant/cap → 结束;否则把 severity 前 10 条差异写进下一轮 prompt
  轮 N  agent 继续同一 session(保留上下文)修差异
```

- 每轮生成一条 `Verification` 记录(report.html / 热力图 / 差异清单都在 UI 可见)
- `task.loop` 与手工验证共用同一收敛状态
- agent 进程 stdout 为 JSONL 事件流:文本增量与工具调用实时进任务进度(SSE)
- 取消/中断:杀掉任务即终止 agent 子进程(超时自动 SIGTERM→SIGKILL)

> ⚠ agent 拥有 shell 访问权(要跑构建、截图、改文件),`--allow-agent` 只应在信任环境开启。

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
