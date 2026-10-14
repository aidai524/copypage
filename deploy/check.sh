#!/usr/bin/env bash
# CopyPage 部署自检:配置完整性 → 服务可达性 → 指标 → 邮件/数据库/沙箱
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO/deploy/.env"
BASE="${COPYPAGE_CHECK_URL:-http://127.0.0.1:4400}"
ok=0; warn=0; fail=0
pass() { echo "  ✅ $1"; ok=$((ok+1)); }
note() { echo "  ⚠️  $1"; warn=$((warn+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }

echo "== 1. 配置文件 =="
if [[ ! -f "$ENV_FILE" ]]; then
  bad "缺少 $ENV_FILE(先 cp deploy/.env.example deploy/.env)"
else
  if ! bash -n "$ENV_FILE" 2>/tmp/copypage-env-error; then
    bad "$ENV_FILE 语法错误(值里有空格/尖括号时要用引号): $(head -1 /tmp/copypage-env-error)"
  fi
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  pass "已加载 $ENV_FILE"
  if [[ "${COPYPAGE_TOKEN:-}" == change-me* || -z "${COPYPAGE_TOKEN:-}${COPYPAGE_ADMIN_EMAIL:-}" ]]; then
    bad "需要 COPYPAGE_TOKEN(openssl rand -hex 32)或 COPYPAGE_ADMIN_EMAIL/PASSWORD"
  else
    pass "访问控制已配置"
  fi
  if [[ -n "${COPYPAGE_RESEND_API_KEY:-}" ]]; then
    if [[ "${COPYPAGE_EMAIL_FROM:-}" == *your-domain* || -z "${COPYPAGE_EMAIL_FROM:-}" ]]; then
      bad "已配 Resend key,但 COPYPAGE_EMAIL_FROM 还是占位符"
    else
      pass "Resend 已配置(from: ${COPYPAGE_EMAIL_FROM})"
    fi
  else
    note "未配 Resend:邮件会打印到服务日志(本地测试可用)"
  fi
  case "${COPYPAGE_SANDBOX:-process}" in
    docker)
      if docker version >/dev/null 2>&1; then pass "sandbox=docker 且 daemon 可达"
      else bad "sandbox=docker 但当前用户无法访问 Docker(需 usermod -aG docker)"; fi ;;
    *) pass "sandbox=process(每任务独立进程)" ;;
  esac
  [[ -n "${COPYPAGE_DATABASE_URL:-}" ]] && note "使用 Postgres(${COPYPAGE_DATABASE_URL%%@*}@…);确认 dataDir 已挂共享卷" \
                                       || pass "单主机模式(SQLite)"
fi

echo "== 2. 服务可达性($BASE)=="
HEALTH=$(curl -s -m 5 "$BASE/api/health" || true)
if [[ -z "$HEALTH" ]]; then
  bad "无法连接服务(确认 systemd/容器在运行: journalctl --user -u copypage -f)"
else
  if [[ -n "${COPYPAGE_TOKEN:-}" ]]; then
    CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/api/tasks")
    [[ "$CODE" == "401" ]] && pass "未带令牌被拒绝(401)" || bad "匿名访问未被拒绝(HTTP $CODE)"
    ME=$(curl -s -m 5 -H "Authorization: Bearer $COPYPAGE_TOKEN" "$BASE/api/auth/me" || true)
    if echo "$ME" | grep -q '"user"'; then
      pass "令牌可用:$(echo "$ME" | grep -o '"plan":"[^"]*"' | head -1)"
    else
      bad "令牌无效(检查 COPYPAGE_TOKEN 与服务是否一致)"
    fi
  else
    note "无令牌模式:确认只绑定了 loopback 或已被反代保护"
  fi
  # /metrics 只对 loopback 免鉴权;经反代/网关访问时需要令牌
  if [[ -n "${COPYPAGE_TOKEN:-}" ]]; then
    METRICS=$(curl -s -m 5 -H "Authorization: Bearer $COPYPAGE_TOKEN" "$BASE/metrics" || true)
  else
    METRICS=$(curl -s -m 5 "$BASE/metrics" || true)
  fi
  if echo "$METRICS" | grep -q "copypage_"; then
    pass "/metrics 可读($(echo "$METRICS" | grep -c '^copypage_') 条指标)"
  else
    note "/metrics 无可读数据(刚启动需等 30s 生成 gauge;非 loopback 需令牌)"
  fi
fi

echo "== 3. 队列与最近任务 =="
if [[ -n "${COPYPAGE_TOKEN:-}" ]]; then
  TASKS=$(curl -s -m 5 -H "Authorization: Bearer $COPYPAGE_TOKEN" "$BASE/api/tasks" || echo '{"tasks":[]}')
  echo "  队列:$(echo "$TASKS" | grep -o '"queue":[0-9]*' | head -1)  任务数:$(echo "$TASKS" | grep -o '"id"' | wc -l | tr -d ' ')"
fi

echo
echo "结果:${ok} 项通过,${warn} 项提醒,${fail} 项失败"
if [[ $fail -gt 0 ]]; then
  echo "先修复 ❌ 项再继续。完整说明见 deploy/README.md"
  exit 1
fi
echo "可以开始:$BASE/app 注册或登录(令牌只给 API 与巡检用)"
