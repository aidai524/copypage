# 验收脚本(可直接跑)

这些脚本对**运行中的实例**做端到端验证。默认打本机 `http://127.0.0.1:4400`;
打公网时用环境变量覆盖(见下)。

| 脚本 | 验什么 | 用法 |
|---|---|---|
| `e2e-live.mts` | 落地页 → 登录 → 任务列表 → 新建 → 详情 → 真实捕获到终态,共 14 项断言;顺带断言"运行期节点未被重建、未重复加载图片" | `npx tsx tools/verify/e2e-live.mts` |
| `no-flicker.mts` | 防闪烁实证:运行中采样,断言关键 DOM 节点身份不变、日志行单调递增、运行期新建 `<img>` 数为 0 | `BASE=https://kloon.dev CREDS=/tmp/kloon-admin-creds.txt npx tsx tools/verify/no-flicker.mts` |
| `no-js-check.mts` | 禁用 JavaScript 时:落地页内容仍可见,`/app` 给出 noscript 提示 | `npx tsx tools/verify/no-js-check.mts` |
| `console-smoke.mts` | 四个控制台路由(列表/新建/详情/管理)能渲染且无 console 报错 | `npx tsx tools/verify/console-smoke.mts` |

## 凭据(不要提交)

需要管理员账号的脚本从文件读取,默认路径 `deploy/.admin-password`,可用 `CREDS=` 覆盖:

```bash
ssh root@103.3.62.56 'cat /root/kloon-admin-password.txt' > /tmp/kloon-admin-creds.txt
chmod 600 /tmp/kloon-admin-creds.txt
```

公网地址 `kloon.dev` 需要直连服务器 IP(若本机 DNS 未刷新):脚本已在 `BASE` 含 `kloon.dev` 时自动加
`--host-resolver-rules=MAP kloon.dev 103.3.62.56`;`curl` 则用 `--resolve kloon.dev:443:103.3.62.56`。

> `work/` 目录是本地草稿区(已 gitignore),验证脚本的正式副本在 `tools/verify/`。
