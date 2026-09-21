# CopyPage 核心还原引擎 — 设计规格（子项目 1）

- 日期：2026-09-21
- 状态：待用户终审
- 父项目：CopyPage — 根据图片/视频/URL 一比一还原网站
- 本子项目：核心还原引擎（单页面，双输入管线）

## 1. 背景与目标

根据图片、视频或可访问的网站 URL，一比一还原出 React + Tailwind 实现的可交互网页。
已知痛点：动画、图表、按钮细节还原不到位。根因是流程缺少**精细观察**与**校验回路**，
差异没有被量化测量并反馈给生成端。

本子项目交付核心闭环：Capture → Generate → Verify → Iterate → Report。
后续子项目（动画逆向、图表逆向深化、整站还原、skill 完整封装）在本闭环之上扩展。

## 2. 已确认的决策（来自头脑风暴）

| 维度 | 决策 |
|---|---|
| 输入 | 双管线：可访问原站 URL / 纯图片 / 纯视频；入口分流，下游统一 |
| 输出 | React + Tailwind（Vite 工程），可交互单页 |
| 交付形态 | 混合：确定性 Node 工具链 + pi skill 编排层 |
| 图表 | 数据驱动重建（Recharts/ECharts）；URL 输入直读图表库配置，视觉输入反推数据 |
| 动画 | 参数级还原（duration/easing/delay 精确提取与拟合）——本体在子项目 2，本引擎预留接口 |
| 交互 | 视觉态（hover/active/focus/disabled）+ 组件行为（轮播/下拉/Tab/弹窗） |
| 验收 | 双闸门：机器阈值自动收敛 → 人眼终审 + 差异清单 |
| 收敛阈值（默认） | SSIM ≥ 0.98 且像素差异 ≤ 2%；动画逐帧相似度 ≥ 0.95（子项目 2 启用） |
| 运行环境 | Mac 本地 + 顶级视觉模型；目标均为公开可访问页面，无登录/反爬 |

## 3. 总体架构

```
输入分流
   │
   ├─ URL ──→ SiteCapture    （DOM 探测 + 多视口截图 + 资产）
   ├─ 图片 ─→ VisualCapture  （多尺度图 + VLM 结构化描述）
   └─ 视频 ─→ VisualCapture  （ffmpeg 抽帧 + 关键帧序列 + VLM 描述）
                    │
                    ▼  统一 Snapshot（schema 一致，字段按输入类型可缺省）
              GENERATE（agent：骨架轮 → 组件填充轮）
                    │
                    ▼
              VERIFY（渲染还原页 → 三层比对 → diff.json）
                    │
        未达标 ◀────┴────▶ 达标/停滞
          ▼                    ▼
    回到 GENERATE          REPORT（report.html → 人眼终审）
```

### 核心设计决策：校验三层比对

1. **像素层**：SSIM + pixelmatch → "哪里不像"，产出热力图与收敛指标
2. **DOM 层**（仅 URL 输入）：原站与还原页跑同一探测脚本，逐元素对比几何与 computed style → "为什么不像"
3. **特写层**（视觉输入，或 DOM 层解释不了的像素差异）：高差异区域裁切放大，VLM 输出结构化区域差异

### 目录结构

```
copypage/
  packages/capture/   # 观察层 CLI：URL/图片/视频 → snapshot/
  packages/diff/      # 校验层 CLI：两份 snapshot → diff.json + 热力图
  packages/render/    # 还原页构建 + 截图
  skill/              # pi skill：编排循环
  work/<task-id>/     # 每次任务的产物：snapshot/、repro/、diffs/、report.html、state.json
  docs/superpowers/specs/
```

## 4. Capture 层

### 4.1 SiteCapture（URL 输入）

`copypage-capture <url> --out work/<task>/snapshot/`

Playwright headless，产出：

| 产物 | 内容 |
|---|---|
| `screenshots/` | desktop 1440 / tablet 768 / mobile 375 三视口全页截图 |
| `dom-snapshot.json` | 遍历可见元素：tag、bounding box、全套 computed style（盒模型、字体、字号/字重/行高、颜色、圆角、阴影、边框、渐变、transform、z-index）、元素层级树 |
| `assets/` | 页面引用的图片、字体、图标（SVG 存源码） |
| `meta.json` | title、favicon、背景色、暗色模式检测 |

关键技术点：

1. **交互态捕获**：对按钮/链接/输入框自动触发 hover / focus / active，每状态各截特写 + 抓 computed style
2. **图表识别钩子**：探测已知图表库实例（`window.echarts`、Highcharts、D3、canvas 聚类），导出配置项原文

### 4.2 VisualCapture（图片/视频输入）

`copypage-capture --image <file>` / `--video <file>`

| 产物 | 内容 |
|---|---|
| 图片 | 原图 + 多尺度版本 |
| 视频 | ffmpeg 抽帧：场景切换检测 + 固定间隔采样（默认 4fps，动画段加密），关键帧序列 + 时间戳；帧数上限默认 200 |
| `visual-brief.json` | VLM 结构化描述：布局区域划分、组件清单（类型/位置/可见样式）、配色提取、字体猜测、图表识别 |

**`visual-brief.json` 是待验证假设而非事实**；纯视觉输入的精度靠 Verify 迭代收敛获得。

两个实现写统一 schema 的 `snapshot/`；字段缺省显式标记，下游据此降级。

## 5. Generate 层

### 两轮生成

1. **骨架轮**：按 snapshot 元素树划分区域，生成页面骨架（布局、尺寸、间距、层级），色块占位
2. **组件填充轮**：逐组件生成。URL 输入给 agent 该组件特写 + DOM 子树样式；视觉输入给区域特写 + visual-brief 对应条目

### 硬性生成规则

1. **禁止 Tailwind 档位取整**：computed style 为 12px 就写 `rounded-[12px]`，所有几何值用 arbitrary value
2. 颜色用精确 hex/oklch，不用色阶近似
3. 交互态必须落地为 `hover:` / `focus-visible:` / `active:` 变体
4. 资产直用原文件，SVG 图标内联，不重画
5. 图表区域先出 `<ChartPlaceholder type data/>`，由图表逆向子系统接管；URL 输入若已拿到真实配置则直接用 Recharts 实现

### 上下文工程

- `dom-snapshot.json` 可能数 MB，提供 `snapshot-query` CLI 按区域/选择器取子树，agent 按需取数
- 还原代码放 `work/<task>/repro/`（Vite + React + Tailwind），一组件一文件
- 文件头注释标注对应 snapshot 区域 id —— Verify 阶段把差异路由回具体文件的钥匙

## 6. Verify 层

`copypage-diff --orig work/<task>/snapshot/ --repro work/<task>/repro-snapshot/`

还原页用**同一 Capture 探测脚本**测量（口径一致）。

### ① 像素层
逐视口对齐截图（尺寸不一致先记为布局错误）；SSIM 全页分 + pixelmatch 差异占比 + 热力图。
收敛指标：`ssim`、`pixelDiffPct`、`perRegionSsim`。

### ② DOM 层（URL 输入）
- 元素对齐：优先文件头注释的区域 id 映射；否则按「位置重叠度 + 标签 + 层级路径」模糊匹配；未匹配标记缺失/多余
- 逐对对比：几何（容差 1px）→ 盒模型 → 字体 → 颜色/背景 → 圆角/阴影/边框 → transform

### ③ 特写层
热力图高差异区域裁切放大 + 还原页同区域截图 → VLM 按固定格式输出差异，转为与 DOM 层同构记录。

### diff.json 格式

```json
{
  "round": 3,
  "metrics": { "ssim": 0.962, "pixelDiffPct": 3.1 },
  "entries": [
    {
      "id": "d-041",
      "component": "src/components/PricingCard.tsx",
      "element": "button.cta",
      "property": "box-shadow",
      "expected": "0 4px 14px rgba(99,102,241,0.4)",
      "actual": "none",
      "severity": 8.2,
      "evidence": { "crop": "diffs/r3/crop-041.png", "heatmapRegion": [0,0,0,0] }
    }
  ]
}
```

- severity = 元素面积占比 × 属性偏差度，降序
- `component` 直接指向生成代码文件
- `evidence` 附差异区域图

### 收敛与停滞

| 条件 | 动作 |
|---|---|
| SSIM ≥ 0.98 且 pixelDiff ≤ 2% | 机器闸门通过 → REPORT |
| 连续 2 轮 pixelDiff 下降 < 0.5% | 停滞 → 剩余差异区域附原站特写 + computed style 原文，再试 2 轮 |
| 仍停滞 | 转人眼终审 |
| 硬上限 8 轮 | 强制终审 |

产出 `report.html`：并排对比 + 滑块 + 未达标清单，供人眼终审。

## 7. 编排 skill、错误处理、测试

### Skill 循环

任务状态 `work/<task>/state.json`（轮次、历史指标、停滞计数）：

1. 分流确认输入类型 → 对应 Capture
2. 骨架轮 → 组件填充轮
3. build 还原页（build 失败 = severity=∞ 差异，报错原文喂回）
4. 跑 diff → 读 diff.json
5. 达标/停滞 → report.html 终审；否则取 severity 前 10 条喂回修改，回 3

每轮喂回固定前 10 条差异。

### 错误处理

| 故障 | 处理 |
|---|---|
| 懒加载未抓全 | 自动滚动全页触发加载后回顶再截 |
| Cookie 弹窗/遮挡 | 常见模式自动关闭；关不掉则标注，终审人定 |
| 资产防盗链失败 | 截图裁切该区域作 fallback 资产，清单标注 |
| 还原页 build 失败 | 错误原文作最高优先级 diff 条目 |
| 元素对齐失败率 > 30% | DOM diff 降级为区域特写 + VLM |
| 视频帧数爆炸 | 场景检测 + 200 帧上限，超限告警 |
| 8 轮未收敛 | 强制终审，报告列未解决清单 |

### 测试策略

| 层 | 方法 |
|---|---|
| 单元 | 元素对齐、severity 打分、snapshot-query |
| 集成 | **自参照测试**：手写已知样式 fixture 页 → Capture → 故意改值（圆角 12→8、删阴影）→ diff → 断言精确报出且排序正确 |
| 端到端评估 | 5-10 个真实公开页面 eval 集，跑完整循环断言 SSIM ≥ 0.98；结果存档防回退 |

## 8. 范围边界（本子项目不做什么）

- 动画参数级逆向（子项目 2）：本引擎仅在 Capture 预留动画数据接口，生成侧用视觉近似
- 图表视觉反推数据的完整实现（子项目 3）：URL 输入的图表库配置直读在本范围内
- 整站爬取、多页路由、跨页状态（子项目 4/5）：本引擎处理单页面
- 需登录/反爬站点：明确不支持

## 9. 开放问题

- 视觉模型选型（Claude vs GPT vs Gemini）在实现期按 eval 集表现定
- 视频输入"动画段加密抽帧"的检测启发式在子项目 2 细化
- severity 的具体打分公式在实现期用自参照测试校准
