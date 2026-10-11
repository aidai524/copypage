---
name: copypage
description: 一比一还原网站为 React+Tailwind 代码。触发："还原网站", "clone this page", "截图克隆", "根据图片/视频/URL 复刻网页"。使用 copypage 工具链执行 Capture→Generate→Verify→Iterate→Report 闭环。
---

# CopyPage — 网站一比一还原编排

工具链在 `<repo>/packages/`（capture / render / diff）。你（agent）是眼睛和大脑：写代码、看截图、填 brief、按差异清单修复。工具链是手和尺子：探测、截图、像素比对、收敛判定。

## 主循环

```bash
TASK=work/$(date +%Y%m%d-%H%M%S)
```

### 0. 分流

确认输入类型：URL / 图片 / 视频。用户未说明就先问。

### 1. Capture

```bash
# URL 输入：
npx tsx packages/capture/src/cli.ts <url> --out $TASK/orig
# 图片 / 视频：
npx tsx packages/capture/src/cli.ts --image <file> --out $TASK/orig
npx tsx packages/capture/src/cli.ts --video <file> --out $TASK/orig
```

视觉输入时：读 `$TASK/orig/brief-prompt.md`，用 vlmChat（`@copypage/core`，`.env` 已配 GPT-4o）观察图片/帧，把结构化描述写入 `$TASK/orig/visual-brief.json`，然后运行 `validateBrief` 校验。

### 2. 初始化任务状态

```bash
echo '{"round":1,"history":[],"escalated":false}' > $TASK/state.json
```

### 3. Generate（写代码）

在 `$TASK/repro/` 创建 Vite + React + Tailwind 工程。**两轮生成**：

1. **骨架轮**：按 snapshot 元素树/visual-brief 划区域，只布局+间距+层级
2. **组件填充轮**：逐组件，每个组件只看自己的特写 + 子树样式（`snapshot-query`）

**硬性规则（违反=细节崩坏的根因）：**

1. **禁止 Tailwind 档位取整** — computed style 是 `12px` 就写 `rounded-[12px]`，不许写 `rounded-lg`。所有几何值 arbitrary value
2. 颜色用精确 hex/rgba，不用 `blue-500` 近似
3. 交互态落地：`states/` 里的 hover/focus/active 样式必须写成对应 Tailwind 变体
4. 资产直用 `$TASK/orig/assets/` 原文件；SVG 图标内联源码
5. 图表：URL 输入若 `charts.json` 有真实配置，直接用 Recharts/ECharts 重建；否则 `<ChartPlaceholder>` 占位并在 notes 标注

每个组件文件头注释区域 id 映射：`/** @region 0/1/0 (hero > button.cta) */` — diff 路由回文件靠它。

### 3b. 自适应行为（若 snapshot 有 adaptive.json）

capture 自动探测两类视口自适应，生成时必须按标记处理：

1. **`heightAdaptiveSections`（100vh 类元素）**：这些 section 用 `h-screen`（或 `h-[100svh]`），**禁止写死像素高度**；其内部用 `object-cover` 居中，不要用 object-position 硬调
2. **`fluidFont.enabled`（rem 流式缩放站）**：所有尺寸按 `perVw` 曲线做视口缩放，典型实现：内容区包 `.fluid-zoom`，CSS 用 `zoom: min(calc(100vw / 1440px), cap)`，cap = `atWide/atBase`。检测方法：两个宽度读 html font-size

没有 adaptive.json 或标记为 false 时，按固定像素还原（捕捉视口即真相）。

### 3c. 可点击交互（若 snapshot 有 interactions.json）

capture 会逐个点击候选触发器（button / [role=tab] / 分页点等）并用 MutationObserver 记录点击后页面变化。生成时：

- **每条 interaction 都要落地为真实行为**：tab 切换内容、轮播箭头翻页、手风琴展开 —— 不允许只做视觉态
- 用 `interactions.json` 的 `summary`（点击后新出现的内容）确定每个触发器控制的区域和切换后的文案/图片
- 没被抓到的交互（interactions.json 为空或无文件）不代表现站没有交互 —— 生成时仍需对“看起来像可点的”元素（tab 状按钮、箭头、分页点）实现合理默认行为

### 3d. 实时数据（若 snapshot 有 dynamic.json）

capture 会先采样 2.5s 的 DOM 变更（文本更新 / 节点增删），把**固有动态区域**（行情、时间戳、live feed）记录到 `dynamic.json`（按视口存储）。随后冻结数据流（WebSocket / EventSource / fetch / XHR / timer / rAF）再截图 + 探测，保证截图与 DOM 来自同一状态。

生成与校验规则：

1. 动态区域只需**结构与静态样式**正确；文案/金额用快照值即可，不要试图复现实时数据
2. diff 自动按 dynamic.json 做像素遮罩（热力图中蓝色标注）：`ssim` / `pixelDiffPct` 只统计静态区域，`metrics.dynamicAreaPct` 是被遮罩占比
3. `dynamicAreaPct` > 60% 说明页面几乎整体动态，先人工确认还原范围再进入循环

### 4. Render + Diff

```bash
npx tsx -e "import {captureRepro} from '@copypage/render'; await captureRepro('$TASK/repro', '$TASK/repro-snap')"
npm run diff -- --orig $TASK/orig --repro $TASK/repro-snap --out $TASK/diffs/r<N> --round <N>
```

- **build 失败**：把报错原文当作 severity=∞ 的 diff 条目，本轮必修
- **有 vlm-requests.json**：用 vlmChat 处理每条（crop=原站，reproCrop=还原），把返回的 JSON 数组合并为 diff 条目（结构同 diff.json entries）
- **metrics.dynamicAreaPct**：被遮罩的动态区域占比；收敛阈值只对静态区域生效

### 5. 收敛判定

```bash
npx tsx packages/diff/src/converge-cli.ts --state $TASK/state.json --diff $TASK/diffs/r<N>/diff.json
```

| 输出 | 动作 |
|---|---|
| `pass` | 生成 report.html → 人眼终审 |
| `continue` | 取 diff.json 前 10 条修复 → 回 4 |
| `escalate` | 对剩余差异区域：附**原站特写截图 + computed style 原文**进修复上下文，再修 → 回 4 |
| `stagnant-stop` / `cap-stop` | 生成 report.html，差异清单原样交人终审 |

### 6. Report

```bash
npx tsx -e "import {writeReport} from '@copypage/diff/src/report.ts'; const r=await import('$TASK/diffs/r<N>/diff.json',{with:{type:'json'}}); await writeReport('$TASK', r.default, ['orig/screenshots/1440.png'], ['repro-snap/screenshots/1440.png'])"
open $TASK/report.html
```

向用户展示：并排对比 + 未解决差异清单。

## 查询工具

```bash
# 按区域 id 取 DOM 子树样式：
npx tsx packages/core/src/query.ts $TASK/orig --viewport 1440 --region 0/1/0
# 按选择器找元素：
npx tsx packages/core/src/query.ts $TASK/orig --viewport 1440 --selector button.cta
```

## 错误处理速查

| 情况 | 处理 |
|---|---|
| assets-failed.json 有内容 | 截图裁切该区域作 fallback 资产，清单里标注 |
| 还原页 build 失败 | severity=∞ 条目，下轮必修 |
| vlm-requests.json 非空 | DOM 对齐不可用，逐条 VLM 特写比对 |
| converge 输出 escalate | 差异区域附原站特写 + style 原文再试 |

## Smoke Checklist（每次任务结束自检）

- [ ] snapshot.json / dom/*.json / screenshots 存在且非空
- [ ] diff.json entries 按 severity 降序
- [ ] state.json round 递增
- [ ] report.html 能打开、滑块可用
