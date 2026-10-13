# CopyPage 部署(两种方式)

| 方式 | 适用 | 需要 |
|---|---|---|
| **systemd 用户服务** | 本机/工作站常驻,继承 `~/.pi` 凭据,无需 sudo | 无(一条命令安装) |
| **Docker Compose** | 独立服务器/隔离环境,带反代与数据卷 | 用户在 `docker` 组 |

---

## 方式 A:systemd 用户服务(推荐本机)

```bash
./deploy/install-systemd.sh     # 生成 deploy/.env + 随机令牌,安装并启动
```

- 地址 `http://127.0.0.1:4400`(默认只听本机;远程访问用 SSH 隧道或改 `--host`)
- 日志:`journalctl --user -u copypage -f`(含请求日志、任务进度)
- 令牌:`deploy/.env` 中的 `COPYPAGE_TOKEN`,UI 右上角填入
- 停止/卸载:`systemctl --user disable --now copypage`
- 重启后仍运行:登录会话内有效;需要登出后继续运行则 `loginctl enable-linger $USER`

常用开关直接改 `deploy/.env`(与 Docker 共用同一份配置):

```ini
COPYPAGE_ALLOW_AGENT=true          # 开启自动生成(agent 有 shell 权限)
COPYPAGE_AGENT_MODEL=sonnet:high   # 生成用模型
COPYPAGE_ALLOW_BUILD=false         # 服务端构建上传工程 = RCE,保持关闭
COPYPAGE_RATE_LIMIT_PER_MINUTE=120
```

---

## 方式 B:Docker Compose(独立服务器)

单机私有部署:capture/verify/generate 服务 + Caddy 反向代理 + 持久化数据卷。
镜像基于**与 package-lock 完全同版本**的 Playwright 官方镜像,保证线上探测/截图与本地同口径(即质量基线不变)。

```
deploy/
├── install-systemd.sh        # 方式 A:一条命令安装用户服务
├── systemd/copypage.service.in
├── Dockerfile                # 方式 B:Playwright 基础镜像 + pi CLI + bsdtar
├── docker-compose.yml        # copypage 服务 + caddy,数据卷,健康检查
├── .env.example              # 两种方式共用的策略开关与密钥模板
└── caddy/Caddyfile           # 反代(SSE 流式),可选自动 HTTPS
```

## 1. 准备

前置:把用户加入 docker 组(需重新登录生效):

```bash
sudo usermod -aG docker $USER && newgrp docker   # 或注销重登
```

```bash
cd deploy
cp .env.example .env
# 生成并写入令牌(必须改,否则拒绝非 loopback 启动)
sed -i "s/^COPYPAGE_TOKEN=.*/COPYPAGE_TOKEN=$(openssl rand -hex 32)/" .env
```

## 2. 启动

```bash
docker compose up -d --build     # 首次构建:拉取 Playwright 镜像 + npm ci
docker compose ps                # copypage 应为 healthy
docker compose logs -f copypage  # 查看启动与请求日志
```

访问 `http://<主机>:8080`,在右上角填入 `COPYPAGE_TOKEN` 即可使用。

| 端口 | 用途 |
|---|---|
| `HTTP_PORT`(默认 8080) | Caddy → 服务(明文 HTTP,适合内网/VPN) |
| `HTTPS_PORT`(默认 8443) | 仅当 `SITE_ADDRESS` 设为真实域名时用于自动 HTTPS |

应用端口 4400 **只在 compose 网络内暴露**,外部只能经 Caddy 访问。

## 3. 可选:开启 agent 自动生成

生成功能需要容器内能运行 `pi`(镜像已安装)并携带其配置与凭据。直接挂载宿主的 pi 目录即可:

```bash
sed -i "s|^PI_CONFIG_PATH=.*|PI_CONFIG_PATH=$HOME/.pi|" .env
sed -i 's/^COPYPAGE_ALLOW_AGENT=.*/COPYPAGE_ALLOW_AGENT=true/' .env
sed -i 's/^COPYPAGE_AGENT_MODEL=.*/COPYPAGE_AGENT_MODEL=sonnet:high/' .env   # 可选

docker compose up -d
```

容器以 uid 1000 运行,挂载目录与数据卷的所有者保持一致,不会在宿主 pi 目录里产生 root 属主的文件。

> ⚠ `COPYPAGE_ALLOW_AGENT=true` 意味着 agent 在容器内拥有 shell 访问权(执行命令、装依赖、跑构建)。只在信任环境开启,并留意凭据过期会导致生成失败(任务里会给出错误)。

## 4. 日常运维

```bash
docker compose logs -f copypage                  # 请求日志(含状态码与耗时)
docker compose restart copypage                  # 重启(运行中的任务标记为失败,不会丢数据)
docker compose down                              # 停止(数据卷保留)
docker compose down -v                           # 连数据一起删除,谨慎
docker compose up -d --build                     # 升级:git pull 后重建
```

数据与清理:

- 任务与产物在 `copypage-data` 卷(`/data`),按 `COPYPAGE_RETENTION_HOURS` 自动清理过期任务
- 备份:`docker run --rm -v copypage-data:/data -v "$PWD":/backup alpine tar czf /backup/copypage-backup.tgz -C /data .`
- 单次 pump.fun 规模捕获约 150MB,按 `COPYPAGE_MAX_TASKS` 与保留时长估算容量

## 5. 公开多租户模式

```bash
# deploy/.env
COPYPAGE_ALLOW_REGISTRATION=true
COPYPAGE_ADMIN_EMAIL=you@example.com
COPYPAGE_ADMIN_PASSWORD=强密码
COPYPAGE_TOKEN=仍然保留(运维/健康检查用,持有者等同管理员)
COPYPAGE_WORKER_CONCURRENCY=4        # 按 CPU/内存调整:每任务一个浏览器进程
COPYPAGE_WORKER_MEMORY_MB=3072       # 单 worker 堆上限
```

重启后:

- 访客可在 UI 自助注册;首登管理员的账号是上面配置的邮箱
- UI 顶部出现「管理」标签:用户列表(暂停/恢复、切换套餐 free/pro/unlimited)、域名封禁、审计日志、统计
- 配额默认:free 10 任务 / 500MB / 每日 1 次自动生成;pro 200 / 20GB / 20。单用户可在管理页用 PATCH 覆盖
- 每个任务在独立 worker 进程执行(崩溃隔离、内存上限),失败任务在 UI 里可见原因

运营建议:

- 先用「域名封禁」阻断被滥用的站点;对可疑账号直接「暂停」(全站 403)
- `copypage.db`(SQLite,在数据卷内)与任务产物一起备份;保留时长由 `COPYPAGE_RETENTION_HOURS` 控制
- 生成功能成本高:保持 `COPYPAGE_ALLOW_AGENT=false`,或在 free 套餐把「今日生成」设为 0/1

## 6. 邮件(Resend)、监控、沙箱

**邮件**:注册验证 / 找回密码 / 用户提醒 / 运维告警都走 Resend:

```ini
COPYPAGE_RESEND_API_KEY=re_xxx
COPYPAGE_EMAIL_FROM=CopyPage <no-reply@your-domain>
COPYPAGE_APP_URL=https://your-domain        # 邮件里的链接基址
COPYPAGE_REQUIRE_EMAIL_VERIFICATION=true    # 未验证邮箱不能提交任务
COPYPAGE_ADMIN_ALERT_EMAIL=ops@your-domain  # 告警收件人
```

未配置 key 时邮件只打印到日志(本地开发可用)。

**监控**:`GET /metrics` 输出 Prometheus 文本(HTTP/任务/队列/存储/告警计数;loopback 免鉴权,外部需管理员令牌或 `COPYPAGE_METRICS_OPEN=true`):

```yaml
scrape_configs:
  - job_name: copypage
    static_configs: [{ targets: ['copypage-host:4400'] }]
```

内置告警规则(每 60s 评估,30 分钟内去重,写审计并邮件通知):队列积压 ≥10、近窗口失败率 ≥50%(样本 ≥5)、磁盘 ≥85%。`COPYPAGE_LOG_FORMAT=json` 可直接对接日志采集。

**横向扩展**:同一数据目录可跑多个实例(任务队列已落库、原子认领,SSE 跨实例轮询),前面挂负载均衡即可;跨主机需要 Postgres 适配 + 共享产物存储,详见 `packages/server/README.md` 的「横向扩展」。

**容器沙箱**:`COPYPAGE_SANDBOX=docker` 后每个任务在独立容器里执行(内存/CPU/pids 限制、只读 /app、可写 /data、独立网络),API 进程被击穿不影响宿主:

```bash
docker build -t copypage-server:local -f deploy/Dockerfile .
COPYPAGE_SANDBOX=docker COPYPAGE_WORKER_IMAGE=copypage-server:local npm run serve
```

> ⚠ 该模式要求进程能访问 Docker(通常需要 `docker` 组)。**在 compose 里跑会需要挂载 `/var/run/docker.sock`,等于把宿主 root 权限交出去** —— 推荐 systemd 方式部署,或把 worker 放到独立主机。

## 7. 公网暴露前

- `SITE_ADDRESS=你的域名`,发布 443;Caddy 会自动申请证书
- 确认 `COPYPAGE_TOKEN` 为强随机值、必要时轮换
- 保持 `COPYPAGE_ALLOW_BUILD=false`(上传工程用预构建 `dist/`)
- 视风险决定是否开启 `COPYPAGE_ALLOW_AGENT`
- 本机防火墙只放行反代端口

仍属"单租户"形态:单一令牌、无计费/多用户隔离。要做公开服务还需要账号体系、容器化多租户隔离、滥用审核与监控告警(见仓库 README 的阶段边界)。
