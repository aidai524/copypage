# Kloon 交接文档(HANDOFF)

> 最后更新:**2026-10-14**(owner + Claude 会话)
> 这份文档的目的:换一个人(或换一个 agent)接过来时,能在不改任何代码的前提下**看懂、跑起来、部署、排错**。

---

## 0. 一句话状态

**已上线可用** —— <https://kloon.dev> 是公开落地页,<https://kloon.dev/app> 是控制台(开放注册、邮箱验证、按计划配额、管理台、监控告警),服务器 `103.3.62.56` 上以 Docker 容器运行,由既有 Plane 的边缘 Caddy 终结 TLS。
代码在 GitHub `aidai524/copypage`(`main` 分支 = 线上版本)。测试 158 项全绿,闸门(lint + 渲染检查)0 FAIL。

---

## 1. 产品与仓库

| 项 | 值 |
|---|---|
| 产品名 | **Kloon**(对外);仓库/包名仍是 `copypage`,不改名 |
| 做什么 | 把一个可公开访问的网页捕获成快照,收敛到像素级一致,产出可运行的 React + Tailwind 工程,并交付一份验证报告(SSIM / 像素差异 / 热力图) |
| 仓库 | `https://github.com/aidai524/copypage`(默认分支 `main`) |
| 开发机工作树 | `/home/joe/.paseo/worktrees/2cgsf6yq/loved-hound`(分支 `loved-hound`,推送后与 `main` 同步) |
| 运行时 | 仓库用 mise 固定 `node@22` + `npm@11`(`.mise.toml`);本机日常跑在 node 26 也能过测试,CI/镜像是权威 |
| 依赖 | 无前端框架(原生 HTML/CSS/JS)、无构建步骤;Playwright 驱动捕获;SQLite(默认)或 Postgres(多主机) |
| 测试 | `npm test` → vitest,**42 文件 / 158 用例** |

包结构:

```
packages/core      类型与静态服务
packages/capture   Playwright 捕获(冻结数据流、动态区域、交互态、资产本地化)
packages/diff      DOM/样式/像素比对与收敛判定
packages/render    还原页渲染
packages/generator agent 驱动的工程生成
packages/server    HTTP API + 队列 + 多租户 + 邮件 + 监控 + 控制台前端(public/)
deploy/            Dockerfile、compose、.env.example、check.sh、部署手册、Caddyfile 样例
docs/              需求书(ui-requirements.md)、设计与计划文档
tools/verify/      端到端验收脚本(已入库,可直接跑,见 §7.3)
work/              本地草稿区(**gitignored**,不入库)
```

---

## 2. 线上环境

| 项 | 值 |
|---|---|
| 域名 | `kloon.dev`(apex 提供服务);`www.kloon.dev` → **301** 到 apex |
| DNS | Porkbun(`*.ns.porkbun.com`),`A kloon.dev → 103.3.62.56`,另有一条 `www` A 记录 |
| 服务器 | `root@103.3.62.56`(免密 SSH 已配),Alpine 3.24 / 2 vCPU / 4 GB / 8.6 GB swap |
| Docker | 29.5.3 + Compose v5.1.4 |
| 应用容器 | `copypage-copypage-1`(healthy),源码在 `/srv/kloon` |
| 端口 | 容器 4400 → 宿主 `172.18.0.1:8081`(**只绑 docker 桥网关**,不直接暴露公网) |
| 边缘反代 | **Plane 的 Caddy**:`/root/plane-selfhost/plane-app/Caddyfile.ai`(80/443 被 Plane 占用,所以不自带 Caddy) |
| 证书 | Let's Encrypt,由 Caddy 自动签发/续期(`kloon.dev`、`www.kloon.dev`) |
| 数据 | Docker 卷 `copypage_copypage-data` → 容器内 `/data`(SQLite `copypage.db` + `tasks/` 产物) |
| 邮件 | Resend;`Kloon <no-reply@kloon.dev>`;域名 `kloon.dev` 已验证(region ap-northeast-1) |
| 监控 | `/metrics`(Prometheus 格式,非 loopback 需管理员令牌)、JSON 日志开关、三条告警规则、运维告警收件人 `aidai524@gmail.com` |

### 2.1 路线/入口

| 路径 | 内容 |
|---|---|
| `/` | 公开落地页(`packages/server/public/landing.html`) |
| `/app` | 控制台 · **任务列表**(默认页);邮件里的 `?verify=` / `?reset=` 也落在这里 |
| `/app/new` | 控制台 · 新建任务表单 |
| `/app/tasks/<id>` | 控制台 · 任务详情(进行中 / 已完成) |
| `/app/admin` | 控制台 · 管理台(仅管理员) |
| `/base.css` | 两个页面共用的 tokens/控件/动效(**三把锁的唯一来源**) |
| `/demo/*.jpg` | 落地页与访客页展示的真实产物图(工具自己在 fixture 上的运行结果) |

控制台内部是 History API 路由:服务端对 `/app` 与 `/app/*` 一律返回同一份 `index.html`,页面内路由决定画哪个视图。**加视图不用改服务端。**

---

## 3. 账号与密钥(不在仓库里)

| 用途 | 位置 |
|---|---|
| 管理员账号 | `aidai524@gmail.com`,密码在服务器 `/root/kloon-admin-password.txt`(600) |
| …的**唯一真实来源** | `/srv/kloon/deploy/.env` 的 `COPYPAGE_ADMIN_PASSWORD`(改密码流程见 `deploy/SERVER-DEPLOY.md` 附录 H) |
| 运维/API/监控令牌 | `/srv/kloon/deploy/.env` 的 `COPYPAGE_TOKEN`(**界面永不需要它**,只给 check.sh、/metrics、API 自动化) |
| Resend key | 同 `.env` 的 `COPYPAGE_RESEND_API_KEY` |
| 开发机本机实例 | `deploy/.env` + `deploy/.admin-password`(均 600、gitignored);systemd 用户服务 `copypage` 跑在 `127.0.0.1:4400` |

> 仓库永不包含 `.env` / `.admin-password` / `~/.pi`。`git archive` 打包时这些也不会进去(gitignored)。

---

## 4. 关键实现(接手时最该知道的)

1. **捕获冻结(A+B)** —— 捕获阶段冻结 `fetch/WebSocket/timer/rAF`,把会动的区域记进 `dynamic.json`;比对时用这些区域做遮罩,避免把"实时数据"算成差异。
2. **队列与多租户** —— SQLite(node:sqlite)或 Postgres(`PgDb`,`FOR UPDATE SKIP LOCKED` 原子认领);worker 子进程/容器隔离;每任务配额与内存上限。
3. **横向扩展** —— jobs 表原子认领 + 跨实例 SSE 轮询 + NFS 共享产物卷(已验证适配器;**未真机跑过多主机**)。
4. **沙箱** —— `COPYPAGE_SANDBOX=process`(默认,每任务独立进程)或 `docker`(每任务容器,需 docker 组;本机无 docker 组,仅单测覆盖)。
5. **配置优先级** —— `命令行 flag > 环境变量 > 默认值`。启动横幅打印的是**生效值**,排查配置时先看横幅。
   (曾经有个 bug:CLI 把每个开关都算成默认值传下去,导致 `.env` 全被忽略 —— 已修并有回归测试 `test/cli-env.test.ts`。)
6. **安全基线** —— scrypt 密码、httpOnly 会话 cookie、邮箱验证门禁、域名封禁、审计日志、SSRF 防护(`--allow-private-network` 仅本地 fixture 用)、`--allow-build` 默认关闭(服务端不执行上传项目的 build)。
7. **鉴权限流** —— `/api/auth/register|login|forgot-password` 有独立限流(10 / 30 / 10 次每 10 分钟每 IP),指标 `copypage_auth_rate_limited_total`。
8. **控制台前端** —— 三个视图各自 paint 一次,之后**只做原地 patch**(状态文字/进度条仅在值变化时写、日志只追加新行、重内容区按"内容签名"重建 → 运行期不重新加载图片)。防闪烁实证见 §7。
9. **失败语义色** —— `--danger` 只用于失败状态与错误文本;品牌 accent 仍只有 `#4ade80` 一个。

---

## 5. 常用操作

### 5.1 部署 / 升级(改任何源文件都必须 `--build`)

```bash
# 开发机
cd <工作树>
git archive --format=tar.gz -o /tmp/kloon-src.tar.gz HEAD
scp /tmp/kloon-src.tar.gz root@103.3.62.56:/tmp/

# 服务器
ssh root@103.3.62.56
cd /srv/kloon && tar xzf /tmp/kloon-src.tar.gz -C /srv/kloon
cd deploy && docker compose up -d --build copypage     # 约 1~3 分钟
docker compose ps                                       # 期望:healthy
```

> `.ts` 改动必须 `--build`(烘进镜像);`public/` 下的 HTML/CSS 通过只读挂载(`docker-compose.override.yml`)读取宿主文件,覆盖即生效。
> 想只改前端不重建:把文件同步到 `/srv/kloon/packages/server/public/` 即可(刷新页面就变)。

### 5.2 巡检 / 验收

```bash
ssh root@103.3.62.56 'cd /srv/kloon && COPYPAGE_CHECK_URL=https://kloon.dev ./deploy/check.sh'
# 期望:8 项通过 / 0 失败(注意:在服务器上跑,它用 .env 里的真实令牌;在开发机跑会因为令牌不同而报"令牌无效")
```

### 5.3 看日志 / 重启 / 备份

```bash
cd /srv/kloon/deploy
docker compose logs -f --tail=100 copypage
docker compose restart copypage                       # 只是重启,不改代码
VOL=$(docker volume ls --format '{{.Name}}' | grep copypage-data | head -1)
docker run --rm -v "$VOL":/data -v "$PWD":/backup alpine tar czf /backup/kloon-data-$(date +%F).tgz -C /data .
```

### 5.4 改管理员密码

见 `deploy/SERVER-DEPLOY.md` 附录 H(必须用应用自己的 `hashPassword` 写库,并同步 `.env` 与密码文件 —— 三处分叉过一次,导致登录被锁)。

### 5.5 边缘 Caddy(加域名 / www)

`Caddyfile.ai` 是只读挂载到容器的配置。改完必须**先校验再平滑重载**(不要重启,Plane 在同一个 Caddy 上):

```bash
cd /root/plane-selfhost/plane-app
cp Caddyfile.ai Caddyfile.ai.bak-$(date +%Y%m%d-%H%M%S)
docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile
docker compose exec -T proxy caddy reload   --config /etc/caddy/Caddyfile
```

---

## 6. 部署环境里的坑(都踩过)

| 坑 | 说明与应对 |
|---|---|
| 浏览器仍显示旧界面 | 控制台是单文件(HTML 内联 JS)。静态资源现在带 `ETag` + `cache-control: no-cache`,会自动重校验;**用户只需强刷一次**。以前没有缓存头,浏览器会长期用旧副本。 |
| `.env` 里的行内注释 | compose `env_file` 传进来的是干净值;但如果用 dotenv 直接读带 `# 注释` 的文件,数值会带注释(GitHub 上有人踩)。排查时看容器内 `process.env.X`。 |
| 2 核 4 GB 的资源 | `.env` 里必须是 `COPYPAGE_WORKER_CONCURRENCY=1` + `COPYPAGE_WORKER_MEMORY_MB=1536`;启动横幅会打印生效值,务必核对(曾经被 CLI 默认值覆盖成 2 × 3072MB,会 OOM)。 |
| 容器内 Chromium | 必须 `COPYPAGE_CHROMIUM_ARGS=--no-sandbox`。 |
| `curl -I` 得到 401 | 已修:静态资源现在响应 HEAD。若重现,检查 api.ts 的静态分支条件。 |
| 交互态捕获会点外链 | 已修:`discoverInteractions` 在"文档重建中"读到 `document.body === null` 曾让整次捕获失败;现在有守卫 + 步骤隔离,可选增强不再拖垮捕获。 |
| `pg-db.test.ts` 在全量并发下偶发超时 | 单独跑 `npx vitest run packages/server/test/pg-db.test.ts` 全绿(7/7);这是负载导致的偶发,非回归。 |
| `packages/diff` 有 4 个 `tsc` 报错 | 历史遗留(PNG 元数据类型与测试 fixture 类型),`vitest` 与运行时都不受影响;要做 CI 时顺手修。 |

---

## 7. 验收:闸门与实证

### 7.1 源文件闸门(lint)

```bash
node ~/.pi/agent/skills/design-taste-frontend/scripts/lint.mjs packages/server/public
# 期望:0 FAIL, 0 WARN
```

### 7.2 渲染闸门(inspect,1440/768/390)

```bash
S=~/.pi/agent/skills/design-taste-frontend/scripts/inspect.mjs
node $S "http://127.0.0.1:4400/"                              --widths 1440,768,390 --allow no-footage                       # 落地页
node $S "http://127.0.0.1:4400/app"                           --widths 1440,768,390 --allow no-footage                       # 访客页
node $S "http://127.0.0.1:4400/app?demo=1"                    --widths 1440,768,390 --allow no-footage,few-pictures          # 列表
node $S "http://127.0.0.1:4400/app/new?demo=1"                --widths 1440,768,390 --allow no-footage,few-pictures          # 新建
node $S "http://127.0.0.1:4400/app/tasks/demo-20261014-1204?demo=1" --widths 1440,768,390 --allow no-footage                 # 详情(完成)
```

现状:**全部 0 FAIL**;列表/新建/运行中详情各有一条 `still-page` WARN(8~11 个动效元素 <16 记 WARN)。
声明的例外与理由写在 `docs/ui-requirements.md` §10.4:
- `few-pictures` 是**营销页**图片配额,应用列表/表单没有"主体的世界"可拍;详情页在有结果时按真实素材给 4 张。
- `still-page` 的运行页动效 = 进度条 + 逐行日志 + 行内进度 + 分区入场,不堆装饰动画凑数。
- `no-footage`:全站没有视频,展示素材全部是工具自己的运行结果。

### 7.3 端到端与防闪烁(公网真机)

```bash
# 需要管理员凭据(不要写进任何提交):
ssh root@103.3.62.56 'cat /root/kloon-admin-password.txt' > /tmp/kloon-admin-creds.txt && chmod 600 /tmp/kloon-admin-creds.txt

npx tsx tools/verify/e2e-live.mts                 # 落地页 → 登录 → 列表 → 新建 → 详情 → 真实捕获(14 项断言)
BASE=https://kloon.dev CREDS=/tmp/kloon-admin-creds.txt npx tsx tools/verify/no-flicker.mts   # 运行期原地更新实证
npx tsx tools/verify/no-js-check.mts              # 禁用 JS:落地页可读,/app 给出 noscript 提示
npx tsx tools/verify/console-smoke.mts            # 四个控制台路由无 console 报错
```

`no-flicker` 的断言(公网 21 次采样、本机 18 次采样,均通过):
1. 日志/进度条/进度行/日志块/页面首子节点**身份不变**(没被重建)
2. 日志行数**单调递增**(1 → 6,回退 0 次)
3. 运行期间新建 `<img>` 节点数 = **0**

---

## 8. 下一步待办(按价值排序)

1. **CI**(GitHub Actions):`npm test` + `lint.mjs` + 4 个 `inspect` 路由。顺手修 `packages/diff` 的 4 个 `tsc` 报错。
2. **开启自动生成**:`COPYPAGE_ALLOW_AGENT=true` + `PI_CONFIG_PATH` 指向宿主 `~/.pi`(2 核 4 GB 建议先只跑捕获/验证)。
3. **多主机**:Postgres + NFS 共享产物卷(适配器已就绪,未真机跑过)。
4. **可选**:kloon.dev 专属 Resend sending key(现与其它域共用)、`www` 之外的子域策略、按用户套餐的可视化配额页。
5. **明确不做**:支付(owner 已确认本期跳过)。

---

## 9. 本次会话(2026-10-14)改了什么

| 主题 | 提交 |
|---|---|
| 公开落地页 + 控制台迁到 `/app` + 恢复原品牌色(深底 + 绿 accent)+ 系统字体 + 共享 `base.css` | `f972e0e` |
| 渐进增强(禁用 JS 也不隐藏内容)+ 详情块改色阶面(修下半天"空屏") | `78aae6c` |
| 无 JS 提示 | `f2c09d2` |
| 开放注册 + 界面去掉访问令牌(改"忘记密码")+ 鉴权端点独立限流 | `fd0d7cd` |
| 修 CLI 默认值覆盖 `.env`(导致注册开关失效、TRUST_PROXY 失效、worker 2×3072MB 有 OOM 风险) | `a7a5dd5` |
| 静态资源 ETag + `no-cache` + HEAD(修"改了页面浏览器还是旧的")、交互态捕获导航后崩溃 | `b921cc8` |
| `www.kloon.dev` 301 归一到 apex(DNS 已存在,只加 Caddy 块) | `7960ded` |
| 控制台 IA 改造:列表 / 新建 / 详情三视图 + 原地更新(进度条 + 流式日志) | `9056920` |
| 文档:控制台 IA、闸门例外、防闪烁实证、管理员密码单一来源 | `9986aa5` |

过程中发现并修掉的"登录被锁":管理员密码在 `.env`、数据库、密码文件三处分叉,记录在案的两个值都登不上 —— 已轮换并用应用自己的哈希函数对齐三处,登录验证 200。
