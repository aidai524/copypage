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

## 5. 公网暴露前

- `SITE_ADDRESS=你的域名`,发布 443;Caddy 会自动申请证书
- 确认 `COPYPAGE_TOKEN` 为强随机值、必要时轮换
- 保持 `COPYPAGE_ALLOW_BUILD=false`(上传工程用预构建 `dist/`)
- 视风险决定是否开启 `COPYPAGE_ALLOW_AGENT`
- 本机防火墙只放行反代端口

仍属"单租户"形态:单一令牌、无计费/多用户隔离。要做公开服务还需要账号体系、容器化多租户隔离、滥用审核与监控告警(见仓库 README 的阶段边界)。
