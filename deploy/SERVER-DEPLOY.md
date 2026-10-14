# Kloon 服务器部署手册

> 面向一台**全新的生产服务器**。全程复制粘贴即可,每一步都有验收命令。
> 目标形态:`https://kloon.dev` + 管理员账号 + Resend 邮件 + 后台管理。

---

## 0. 前置条件(先确认,不满足别往下走)

| 项 | 要求 |
|---|---|
| 系统 | Ubuntu 22.04+ / Debian 12+ / 其他支持 Docker 的 Linux |
| 规格 | **≥ 2 vCPU / 4 GB 内存 / 40 GB 磁盘**(镜像约 4 GB;单次捕获产物 10~150 MB) |
| 域名 | `kloon.dev` 的 **A 记录**指向本机公网 IP(`www` 可选) |
| 端口 | 安全组/防火墙放行 **80**(证书签发)和 **443** |
| 账号 | 已注册 Resend,`kloon.dev` 已 **Verified**,有 `re_…` API key |

**服务器上先做这两件事**(Ubuntu/Debian 示例):

```bash
# 1) 装 Docker + compose 插件
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker    # 让当前用户能用 docker
docker compose version                               # 应输出 v2.x

# 2) 确认 DNS 已生效(必须能解析到本机 IP)
getent hosts kloon.dev
```

---

## 1. 把代码放到服务器

### 方式 A:从开发机直接打包(scp,推荐,最稳)

```bash
# --- 开发机上执行 ---
cd /home/joe/.paseo/worktrees/2cgsf6yq/loved-hound
git archive --format=tar.gz -o /tmp/kloon-src.tar.gz HEAD     # 188 KB,不含 node_modules
scp /tmp/kloon-src.tar.gz root@<服务器IP>:/tmp/

# --- 服务器上执行 ---
sudo mkdir -p /srv/kloon && sudo chown "$USER" /srv/kloon
tar xzf /tmp/kloon-src.tar.gz -C /srv/kloon
ls /srv/kloon      # 应看到 packages/ deploy/ skill/ package.json
```

### 方式 B:走 GitHub(便于以后 `git pull` 升级)

```bash
# --- 开发机:先把分支推上去(当前工作分支 loved-hound 还没 push) ---
git push -u origin loved-hound

# --- 服务器(私有库需要 PAT) ---
git clone -b loved-hound https://<用户名>:<PAT>@github.com/aidai524/copypage.git /srv/kloon
```

---

## 2. 写配置 `deploy/.env`

```bash
cd /srv/kloon/deploy
cp .env.example .env

# 必填:访问令牌(自己保存好,UI 登录/API 都用它)
TOKEN=$(openssl rand -hex 32)
sed -i "s|^COPYPAGE_TOKEN=.*|COPYPAGE_TOKEN=$TOKEN|" .env

# 必填:管理员账号(首次启动自动创建)
sed -i "s|^COPYPAGE_ADMIN_EMAIL=.*|COPYPAGE_ADMIN_EMAIL=aidai524@gmail.com|" .env
ADMIN_PW=$(openssl rand -base64 18)
sed -i "s|^COPYPAGE_ADMIN_PASSWORD=.*|COPYPAGE_ADMIN_PASSWORD=\"$ADMIN_PW\"|" .env

# 必填:Resend(建议给 kloon.dev 单独建一把 sending-access key)
sed -i "s|^COPYPAGE_RESEND_API_KEY=.*|COPYPAGE_RESEND_API_KEY=re_你的KEY|" .env
sed -i "s|^COPYPAGE_ADMIN_ALERT_EMAIL=.*|COPYPAGE_ADMIN_ALERT_EMAIL=aidai524@gmail.com|" .env

# 按服务器规格调资源(见下表)
sed -i "s|^COPYPAGE_WORKER_CONCURRENCY=.*|COPYPAGE_WORKER_CONCURRENCY=2|" .env
sed -i "s|^COPYPAGE_WORKER_MEMORY_MB=.*|COPYPAGE_WORKER_MEMORY_MB=3072|" .env

# 域名(默认已填好,确认即可)
grep -E "^(SITE_ADDRESS|COPYPAGE_APP_URL|COPYPAGE_EMAIL_FROM)=" .env

# 把管理员密码单独存一份(600),登录后请改密码并删除
umask 077 && printf 'admin: aidai524@gmail.com\npassword: %s\n' "$ADMIN_PW" > /root/kloon-admin-password.txt
echo "管理员密码已存到 /root/kloon-admin-password.txt"
```

**按规格选并发/内存**(超配会导致容器被杀):

| 服务器 | `COPYPAGE_WORKER_CONCURRENCY` | `COPYPAGE_WORKER_MEMORY_MB` |
|---|---|---|
| 2 vCPU / 2 GB | 1 | 1024 |
| 2 vCPU / 4 GB | 1 | 2048 |
| 4 vCPU / 8 GB | 2 | 3072 |
| 8 vCPU / 16 GB | 4 | 3072 |

> ⚠️ 含空格/尖括号的值**必须加引号**(如 `COPYPAGE_EMAIL_FROM="Kloon <no-reply@kloon.dev>"`),否则 systemd/容器解析会报错。

---

## 3. 构建并启动

```bash
cd /srv/kloon/deploy
docker compose up -d --build      # 首次:拉 Playwright 基础镜像 + npm ci,约 5~15 分钟
docker compose ps                 # copypage 状态应为 healthy

# 自带 Caddy 在 profile "edge" 里,默认不启动(避免与机器上已有反代抢 80/443)。
# 只有服务器的 80/443 空闲、想让本栈自己终结 TLS 时才需要:
# docker compose --profile edge up -d
```

---

## 4. 验收(4 项,逐项过)

```bash
# ① 自检脚本:配置 + 令牌 + 指标 + 队列(经反代)
cd /srv/kloon && COPYPAGE_CHECK_URL=http://127.0.0.1:8080 ./deploy/check.sh
#    期望:8 项通过、0 失败

# ② 域名与证书(自动签发,首次约 10 秒)
curl -sI https://kloon.dev | head -3          # 期望 200/301 + server: Caddy
COPYPAGE_CHECK_URL=https://kloon.dev ./deploy/check.sh

# ③ 页面与捕获
#    浏览器打开 https://kloon.dev → 右上角「登录」→ 用 aidai524@gmail.com + 步骤2的密码
#    → 新建捕获 https://example.com → 看截图与产物链接
```

```bash
# ④ 邮件全链路(临时开注册,用另一个邮箱注册一次)
sed -i 's|^COPYPAGE_ALLOW_REGISTRATION=.*|COPYPAGE_ALLOW_REGISTRATION=true|' /srv/kloon/deploy/.env
docker compose up -d                # env 变更需要重建容器
# → 用你的第二个邮箱注册 → 应收到 "Kloon 邮箱验证" → 点链接 → 才能提交任务
```

验收通过后按需关闭注册:
```bash
sed -i 's|^COPYPAGE_ALLOW_REGISTRATION=.*|COPYPAGE_ALLOW_REGISTRATION=false|' .env && docker compose up -d
```

---

## 5. 日常运维

```bash
cd /srv/kloon/deploy

docker compose logs -f copypage          # 应用日志(请求日志/任务进度/邮件错误)
docker compose logs -f caddy             # 证书/反代日志
docker compose restart copypage          # 重启(运行中任务会被标记失败,数据不丢)

# 指标(Prometheus 可直接抓)
curl -s http://127.0.0.1:8080/metrics | grep copypage_
#   scrape_configs: [{ job_name: kloon, static_configs: [{ targets: ['kloon.dev'] }] }]

# 备份(数据库 + 全部产物)。卷名带 compose 项目前缀,动态取以免写死
VOL=$(docker volume ls --format '{{.Name}}' | grep copypage-data | head -1)
docker run --rm -v "$VOL":/data -v "$PWD":/backup alpine \
  tar czf /backup/kloon-$(date +%F).tgz -C /data .
ls -lh backup/kloon-*.tgz

# 恢复(先停服务,再整体覆盖;务必先用测试环境验证过一次)
# docker compose stop copypage
# docker run --rm -v "$VOL":/data -v "$PWD":/backup alpine \
#   sh -c 'rm -rf /data/* && tar xzf /backup/kloon-YYYY-MM-DD.tgz -C /data'
# docker compose start copypage

# 升级
cd /srv/kloon && git pull            # 方式 B
# 方式 A:重新打包 scp 覆盖后:
cd deploy && docker compose up -d --build
```

### 路由与静态资源(2026-10-14 起)

| 路径 | 内容 |
|---|---|
| `/` | 公开落地页(`packages/server/public/landing.html`) |
| `/app` | 控制台(`packages/server/public/index.html`),邮件里的 `?verify=` / `?reset=` 也落在这里 |
| `/base.css` | 两页共用的 tokens/控件/动效(**三把锁的单一来源**) |
| `/demo/*.jpg` | 落地页与访客页展示的真实产物图 |

> 改配色/圆角/字体/控件只改 `packages/server/public/base.css` 一处,两个页面同时生效。
> 改 `.html` 或 `.css` 都属于源文件改动 —— 仍然必须 `--build`。

> ⚠️ **改动了源文件(含 `packages/server/public/index.html`)必须 `--build`**。
> `docker compose restart` 只是重启容器,镜像里烘焙的是构建时的源码 —— 改完前端后只 restart
> 会出现"文件明明改了、页面还是旧的"。想改前端立即生效,可在 `docker-compose.override.yml` 里挂载:
> ```yaml
> services:
>   copypage:
>     volumes:
>       - ../packages/server/public:/app/packages/server/public:ro
> ```

建议加一条每日备份 cron:
```bash
( crontab -l 2>/dev/null; echo '30 3 * * * cd /srv/kloon/deploy && VOL=$(docker volume ls --format "{{.Name}}" | grep copypage-data | head -1) && docker run --rm -v "$VOL":/data -v "$PWD":/backup alpine tar czf /backup/kloon-$(date +\%F).tgz -C /data .' ) | crontab -
```

---

## 6. 排错表

| 现象 | 原因 / 处理 |
|---|---|
| `check.sh` 连不上 | `docker compose ps`;`docker compose logs copypage` |
| 证书失败 | DNS 未生效或 80 未放行;`docker compose logs caddy` |
| 邮件发不出去 | `EMAIL_FROM` 域名必须与 Resend 已验证域名一致;看 `logs copypage` 里的 `[email] … failed` |
| 任务一直 `queued` | 并发被占满,或 worker 起不来 → 看任务详情里的错误与 `logs copypage` |
| 任务 `failed` | 任务详情里有原因(目标站拒绝/超时/资产下载超限),重试或调 `COPYPAGE_MAX_UPLOAD_MB`、`COPYPAGE_RETENTION_HOURS` |
| 容器反复重启 | 多半是内存不够 → 调小 `WORKER_CONCURRENCY`/`WORKER_MEMORY_MB` |
| 磁盘增长快 | 调小 `COPYPAGE_RETENTION_HOURS`(默认 168h);检查 `du -sh` 卷 |
| 生成不可用 | 未开 `COPYPAGE_ALLOW_AGENT` 或容器里没有 pi 凭据(见附录 B) |

---

## 7. 上线安全清单(逐项打勾)

- [ ] `COPYPAGE_TOKEN` 为强随机,且只发给内部人员
- [ ] 管理员密码已改(登录后 `PATCH /api/admin/users/:id`),`/root/kloon-admin-password.txt` 已删除
- [ ] 开放注册时 `COPYPAGE_REQUIRE_EMAIL_VERIFICATION=true`
- [ ] 保持 `COPYPAGE_ALLOW_BUILD=false`(不执行上传工程的构建脚本)
- [ ] `COPYPAGE_ADMIN_ALERT_EMAIL` 是**真实可收信**的邮箱(否则告警静默丢失)
- [ ] 每日备份 cron 已生效,并**验证过一次恢复**
- [ ] 监控已抓 `/metrics`,并有告警规则(队列积压/失败率/磁盘)
- [ ] 防火墙只放行 80/443(应用端口 4400 未对外)
- [ ] 服务端缓存/清理:`COPYPAGE_RETENTION_HOURS` 与配额符合预期

---

## 附录 A:不用 Docker(systemd + 宿主 Caddy)

```bash
# 依赖
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs libarchive-tools caddy git
cd /srv/kloon && npm ci && npx playwright install --with-deps chromium

# 配置(注意 CHROMIUM_ARGS 留空:非 root 可开沙箱)
cp deploy/.env.example deploy/.env && vim deploy/.env     # SITE_ADDRESS 用回环场景可不填
sed -i 's|^COPYPAGE_CHROMIUM_ARGS=.*|COPYPAGE_CHROMIUM_ARGS=|' deploy/.env

# 安装为用户服务(继承 ~/.pi 凭据)
./deploy/install-systemd.sh

# 宿主 Caddy 反代(自动 HTTPS)
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
kloon.dev {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4400 { flush_interval -1 }
}
EOF
sudo systemctl reload caddy
```
数据目录为 `/srv/kloon/work/server`(备份直接 tar 这个目录即可)。

## 附录 B:启用自动生成(agent)

1. 把开发机的 pi 配置与凭据复制到服务器:`~/.pi`(settings + credentials)
2. `.env`:
   ```ini
   COPYPAGE_ALLOW_AGENT=true
   COPYPAGE_AGENT_MODEL=sonnet:high
   ```
   Docker 部署补一行 `PI_CONFIG_PATH=<服务器上 pi 配置目录,如 /root/.pi>`(该目录会被挂到容器 `/home/pwuser/.pi`)
3. 重启后,任务页出现「启动自动生成」按钮。
   ⚠️ agent 会执行 shell 命令(装依赖、跑构建),只在信任环境开启;每次生成会消耗模型额度,free 套餐默认每天 1 次。

## 附录 C:迁移开发机的历史数据(可选)

```bash
# 开发机:先停服务,保证数据库一致
systemctl --user stop copypage
cd /home/joe/.paseo/worktrees/2cgsf6yq/loved-hound
tar czf /tmp/kloon-data.tgz -C work/server .        # copypage.db + tasks/
scp /tmp/kloon-data.tgz root@<服务器IP>:/tmp/
# 开发机可选:恢复服务
systemctl --user start copypage

# 服务器(首次启动前导入;先 up 一次让卷被创建,再停服务导入)
cd /srv/kloon/deploy && docker compose up -d && docker compose stop copypage
VOL=$(docker volume ls --format '{{.Name}}' | grep copypage-data | head -1)
docker run --rm -v "$VOL":/data -v /tmp:/backup alpine tar xzf /backup/kloon-data.tgz -C /data
docker compose start copypage
```
> 迁移过来后,历史任务归属 `system`(运维身份),管理员登录即可看到全部。

## 附录 D:多主机扩容(Postgres + 共享卷)

```ini
COPYPAGE_DATABASE_URL=postgres://kloon:***@db-host:5432/kloon
COPYPAGE_DATA_DIR=/srv/kloon-data        # NFS 共享卷,每台按相同路径挂载
COPYPAGE_TRUST_PROXY=true                # 前置负载均衡
```
每台机器跑同一份服务即可;任务队列在 Postgres 里原子认领,不会重复执行。验证:`COPYPAGE_TEST_DATABASE_URL=postgres://… npm test`。

## 附录 F:服务器已有反代占用 80/443(本机就是这种情况)

判断方法:
```bash
ss -tlnp | grep -E ':(80|443)\s'          # 或
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '0.0.0.0:(80|443)'
```
本服务器跑着自建 Plane(`plane-app-proxy-1` 是 Caddy,占 80/443,站点 `team.stableflow.ai`),
所以 **Kloon 不启动自带 Caddy**,改为挂在既有边缘上:

**1) 应用只发布到 docker 桥网关(非公网)**,在 `deploy/` 下建 `docker-compose.override.yml`:
```yaml
services:
  copypage:
    ports:
      - "172.18.0.1:8081:4400"    # 172.18.0.1 = ${NETWORK} 的网关;只绑网关,公网不可达
```
```bash
docker compose rm -sf caddy          # 不再需要自带 caddy
docker compose up -d copypage
curl -s http://172.18.0.1:8081/api/health          # 宿主自检
docker exec <既有反代容器> curl -s http://172.18.0.1:8081/api/health   # 边缘容器可达性
```
网关 IP 获取:`docker network inspect <plane-app_default> --format '{{(index .IPAM.Config 0).Gateway}}'`

**2) 在既有 Caddyfile 追加站点块**(先备份、校验、热重载,避免影响现有站点):
```bash
cd /root/plane-selfhost/plane-app
cp Caddyfile.ai "Caddyfile.ai.bak-$(date +%Y%m%d-%H%M%S)"
cat >> Caddyfile.ai <<'EOF'

kloon.dev {
	encode zstd gzip
	reverse_proxy 172.18.0.1:8081 { flush_interval -1 }
}
EOF
docker exec plane-app-proxy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec plane-app-proxy-1 caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile
curl -s -o /dev/null -w '%{http_code}\n' -k https://<既有站点>   # 确认没影响
docker logs plane-app-proxy-1 --tail 5                            # 看是否在申请 kloon.dev 证书
```
> DNS 未生效时日志会出现 `no valid A records found for kloon.dev` —— 这是预期的,Caddy 会自动重试;
> A 记录一生效,HTTPS 证书自动签发,无需再改配置。

**3) DNS 生效后**:把 `.env` 的 `COPYPAGE_APP_URL` 改成 `https://kloon.dev`(邮件链接),
`SITE_ADDRESS=kloon.dev`(若将来自己接管 80/443 时用),然后:
```bash
cd /srv/kloon/deploy && docker compose up -d copypage
COPYPAGE_CHECK_URL=https://kloon.dev /srv/kloon/deploy/check.sh
```

## 附录 E:在 Docker 部署里开启容器沙箱(可选,较复杂)

Compose 默认是**进程级隔离**。要「每个任务一个容器」需要:镜像内加 docker CLI、挂载宿主 socket、且宿主已构建 worker 镜像。

```bash
# 1) 宿主构建 worker 镜像
docker build -t copypage-server:local -f deploy/Dockerfile .

# 2) 在 deploy/ 下新建 docker-compose.override.yml
cat > docker-compose.override.yml <<'EOF'
services:
  copypage:
    environment:
      COPYPAGE_SANDBOX: docker
      COPYPAGE_WORKER_IMAGE: copypage-server:local
      COPYPAGE_WORKER_NETWORK: copypage_default
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    user: "0:0"
EOF

# 3) 镜像里需要 docker CLI(在 Dockerfile 中追加):
#    RUN apt-get update && apt-get install -y --no-install-recommends docker.io && rm -rf /var/lib/apt/lists/*
docker compose up -d --build
```
⚠️ 挂载 docker socket 等于把宿主 root 权限交给容器,**只在完全信任使用者时开启**;更安全的做法是把 worker 放到独立主机(systemd 方式)执行。
