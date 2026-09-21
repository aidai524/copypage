# CopyPage 核心还原引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 CopyPage 子项目 1 — 单页面还原核心闭环（Capture → Generate → Verify → Iterate → Report），双输入（URL / 图片 / 视频），Node 工具链 + skill 编排。

**Architecture:** npm workspaces monorepo：`@copypage/core`（类型/IO/静态服务/VLM 客户端）、`@copypage/capture`（Playwright 探测 + 视觉输入）、`@copypage/render`（还原页构建服务）、`@copypage/diff`（三层比对 + diff.json + 报告）。VLM 用 GPT-4o（apimart，OpenAI 兼容端点），工具链默认产出 VLM 请求队列、由 agent 填写答案，保持确定性。

**Tech Stack:** Node ≥20、TypeScript（ESM）、Playwright、pngjs + pixelmatch + ssim.js、sharp、zod、vitest + tsx、ffmpeg（系统命令，视频路径）。

**Spec:** `docs/superpowers/specs/2026-09-21-copypage-core-engine-design.md`

## Global Constraints

- 收敛阈值：SSIM ≥ 0.98 且 pixelDiffPct ≤ 2%；停滞判定：连续 2 轮 pixelDiffPct 下降 < 0.5；硬上限 8 轮
- 每轮喂回 severity 前 10 条差异
- 视口默认 [1440, 768, 375]；测试用 [800]
- 视频抽帧上限 200 帧；场景阈值 0.35
- 还原工程：Vite + React + Tailwind；几何值一律 arbitrary value（禁档位取整）
- VLM：model `gpt-4o`，baseURL `https://api.apimart.ai/v1`，key 只存 `.env`（`APIMART_API_KEY`），不进 git；apimart 强制 SSE 流式，客户端必须能累积 delta
- DOM 探测节点上限 4000；几何容差 1px；颜色通道容差 4
- 元素对齐失败率 > 30% 时 DOM diff 降级为特写 + VLM 队列

## Review Focus

1. **懒加载内容** — 滚动后才渲染的元素必须被抓到 → T3 测试：滚动触发型 fixture
2. **截图尺寸不一致** — 必须产出 layout-error 条目而非崩溃 → T12 测试
3. **颜色格式差异**（`rgb(255,0,0)` vs `#ff0000`）不得误报 → T14 测试
4. **对齐失败率 > 30% 降级** — 必须产出 vlm-requests.json → T15 测试
5. **视频无场景切换** — 均匀采样兜底，帧数 ≤ 上限 → T8 测试

---

### Task 1: 脚手架 + core 类型与 snapshot IO

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env`
- Create: `packages/core/package.json`, `packages/core/src/types.ts`, `packages/core/src/io.ts`, `packages/core/src/server.ts`
- Test: `packages/core/test/io.test.ts`, `packages/core/test/server.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `BoxModel`, `ComputedStyles`(19 个属性见 spec §4.1), `ElementNode{id,tag,selector,box,styles,text?,children[]}`, `DomSnapshot{url,viewport,capturedAt,root}`, `SnapshotMeta{title,favicon?,backgroundColor,colorScheme}`, `Snapshot{input:{type:'url'|'image'|'video',source},viewports:number[],screenshots:Record<string,string>,dom?:DomSnapshot[],assetsDir?,frames?:{file,t}[],brief?,charts?}`
  - `io.ts`: `writeSnapshot(dir, s: Snapshot): Promise<void>`（写 snapshot.json + 保证子目录）、`readSnapshot(dir): Promise<Snapshot>`
  - `server.ts`: `serveStatic(dir): Promise<{url:string, close():Promise<void>}>`（随机端口，node:http）

- [ ] **Step 1:** 初始化 monorepo

```jsonc
// package.json (root)
{ "name": "copypage", "private": true, "type": "module",
  "workspaces": ["packages/*"],
  "scripts": { "test": "vitest run", "capture": "tsx packages/capture/src/cli.ts", "diff": "tsx packages/diff/src/cli.ts" },
  "devDependencies": { "typescript": "^5", "tsx": "^4", "vitest": "^3", "vite-tsconfig-paths": "^5", "@types/node": "^22", "@types/pngjs": "^6" } }
// tsconfig.json: module NodeNext, target ES2022, strict, paths { "@copypage/*": ["packages/*/src"] }
// vitest.config.ts: plugins: [tsconfigPaths()], test.timeout 60000, hookTimeout 120000
// .gitignore: node_modules, work/, .env, dist
```

```bash
npm i && npm i -w @copypage/capture playwright sharp && npm i -w @copypage/diff pngjs pixelmatch ssim.js && npm i -w @copypage/core zod && npx playwright install chromium
printf 'APIMART_API_KEY=<key>\nAPIMART_BASE_URL=https://api.apimart.ai/v1\nVLM_MODEL=gpt-4o\n' > .env
```

- [ ] **Step 2:** 写 types.ts（按 Interfaces 定义全量类型）

- [ ] **Step 3:** 写失败测试 `io.test.ts`：writeSnapshot→readSnapshot 往返相等；缺字段时 readSnapshot 抛错

- [ ] **Step 4:** 实现 io.ts + server.ts（serveStatic 用 node:http，content-type 按扩展名表）

- [ ] **Step 5:** 跑测试通过；`server.test.ts`：serveStatic fixtures 目录，fetch 200 且内容一致

- [ ] **Step 6:** Commit `feat: scaffold monorepo with core types and snapshot io`

---

### Task 2: capture — DOM probe 提取

**Files:**
- Create: `fixtures/site/index.html`（已知样式 fixture：button 圆角 12px、box-shadow `0 4px 14px rgba(99,102,241,0.4)`、padding `16px 32px`、含懒加载段落）
- Create: `packages/capture/src/probe.ts`
- Test: `packages/capture/test/probe.test.ts`

**Interfaces:**
- Consumes: `serveStatic`（T1）
- Produces: `probeDom(page: Page): Promise<ElementNode>`；`autoScroll(page): Promise<void>`（滚到底触发懒加载再回顶）

probe 核心（`page.evaluate` 内执行，节点上限 4000）：

```ts
const STYLE_PROPS = ['fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','backgroundImage','borderRadius','boxShadow','border','padding','margin','transform','opacity','zIndex','display','position'] as const
// walk(el, path): display:none / visibility:hidden / 宽高<1 → null
// selector: tag + 前两个 class + nth-of-type 兜底
// text: 仅自有文本节点，截 80 字符
```

- [ ] **Step 1:** 写 fixture（内联 CSS，值全部已知）
- [ ] **Step 2:** 写失败测试：serveStatic fixtures → chromium 打开 → autoScroll → probeDom → 断言 button 的 styles.borderRadius === '12px'、boxShadow 含 'rgba(99, 102, 241'、懒加载元素存在于树中
- [ ] **Step 3:** 实现 probe.ts
- [ ] **Step 4:** 测试通过
- [ ] **Step 5:** Commit `feat(capture): dom probe with autoscroll`

---

### Task 3: capture — captureSite 主流程（视口截图 + meta）

**Files:**
- Create: `packages/capture/src/site.ts`
- Test: `packages/capture/test/site.test.ts`

**Interfaces:**
- Consumes: `probeDom`, `autoScroll`, `writeSnapshot`
- Produces: `captureSite(url: string, outDir: string, opts?: { viewports?: number[] }): Promise<void>` — 写 `screenshots/<w>.png`、`dom/<w>.json`、`meta.json`、`snapshot.json`

流程：每视口新开 page → 监听 console 错误忽略 → autoScroll → 全页截图 → probeDom → 收集 meta（title、favicon link、body 背景色、`matchMedia('(prefers-color-scheme: dark)')`）。

- [ ] **Step 1:** 失败测试：captureSite(fixtureUrl, tmp) → 三文件存在；meta.title 正确；`dom/800.json` 根节点 tag==='body'；snapshot.json 可 readSnapshot
- [ ] **Step 2:** 实现 site.ts
- [ ] **Step 3:** 通过；Commit `feat(capture): captureSite viewports+meta`

---

### Task 4: capture — 资产下载

**Files:**
- Create: `packages/capture/src/assets.ts`（fixture 加本地 img + 外链 SVG icon + Google-font 式 link）
- Test: `packages/capture/test/assets.test.ts`

**Interfaces:**
- Produces: `downloadAssets(page, outDir): Promise<{ files: string[]; failed: {url:string,reason:string}[] }>` — page 内收集 `img[src]`、`link[rel=icon]`、`svg`（内联存 `.svg`）、`source[srcset]`；fetch 逐个下载到 `assets/`，失败进 failed 清单（防盗链场景）

- [ ] **Step 1:** 失败测试：fixture 资产全部落盘；svg 存源码；故意 404 的 img 进 failed
- [ ] **Step 2:** 实现（page.evaluate 收集清单 → node 侧 fetch 下载，referer 带原页）
- [ ] **Step 3:** 通过；接入 captureSite（snapshot.assetsDir 写入）；Commit `feat(capture): asset download with failure list`

---

### Task 5: capture — 交互态捕获

**Files:**
- Create: `packages/capture/src/states.ts`（fixture button 加 `:hover` 变深色、`:focus-visible` 加 outline）
- Test: `packages/capture/test/states.test.ts`

**Interfaces:**
- Produces: `captureStates(page, outDir): Promise<StateCapture[]>`；`StateCapture = { selector, state: 'hover'|'focus'|'active', styles: ComputedStyles, crop: string }` — 对 `button, a, input, [role=button]` 前 50 个，逐状态触发（`hover()`、`focus()`、mouse down/up），抓 computed style + 元素 boundingbox 截图（`states/<i>.<state>.png`）

- [ ] **Step 1:** 失败测试：button 的 hover styles.backgroundColor ≠ 基态；focus 有 outline；crop 文件存在
- [ ] **Step 2:** 实现
- [ ] **Step 3:** 通过；接入 captureSite 写 `states/`；Commit `feat(capture): interaction state capture`

---

### Task 6: capture — 图表配置钩子

**Files:**
- Create: `packages/capture/src/charts.ts`（fixture 加 `window.Highcharts={charts:[{options:{...真实配置}}]}` 模拟）
- Test: `packages/capture/test/charts.test.ts`

**Interfaces:**
- Produces: `detectCharts(page): Promise<ChartFinding[]>`；`ChartFinding = { library: 'echarts'|'highcharts'|'d3'|'canvas-cluster', selector?: string, options?: unknown }` — 检测 `window.echarts`（遍历 dom 试 `getInstanceByDom`）、`window.Highcharts.charts`、`document.querySelectorAll('svg > g > path')` 密度粗判 d3、canvas 聚类计数

- [ ] **Step 1:** 失败测试：fixture 检出 highcharts 且 options 深等于注入配置
- [ ] **Step 2:** 实现
- [ ] **Step 3:** 通过；captureSite 写 `charts.json`；Commit `feat(capture): chart library detection hook`

---

### Task 7: capture — 图片输入

**Files:**
- Create: `packages/capture/src/image.ts`
- Test: `packages/capture/test/image.test.ts`

**Interfaces:**
- Produces: `captureImage(file, outDir): Promise<void>` — 拷贝原图；sharp 生成 `scales/0.5x.png`、`scales/2x.png`（长边上限 4096）；写 snapshot.json（input.type='image'，screenshots.original 指原图）

- [ ] **Step 1:** 失败测试：sharp 生成 100x60 测试图 → captureImage → 产物存在且 2x 尺寸正确
- [ ] **Step 2:** 实现
- [ ] **Step 3:** 通过；Commit `feat(capture): image input`

---

### Task 8: capture — 视频抽帧

**Files:**
- Create: `packages/capture/src/video.ts`
- Test: `packages/capture/test/video.test.ts`

**Interfaces:**
- Produces: `captureVideo(file, outDir, opts?: { maxFrames?: number }): Promise<void>` — `ffmpeg -vf "select='gt(scene,0.35)',showinfo" -f null -` 解析场景点；`fps=4` 均匀采样；合并去重排序，超 maxFrames（默认 200）时均匀稀释；`ffprobe` 取时长；写 frames/<i>.png + snapshot.json(frames 含 t)

ffmpeg 缺失时抛带 `brew install ffmpeg` 提示的错。测试用 lavfi 生成 2 秒双色拼接视频；无 ffmpeg 则 `test.skipIf`。

- [ ] **Step 1:** 失败测试：生成测试视频 → captureVideo → frames ≥ 2、含场景切换时间戳（±0.5s）、总数 ≤ maxFrames；纯单色视频均匀采样兜底 ≥ 3 帧
- [ ] **Step 2:** 实现
- [ ] **Step 3:** 通过；Commit `feat(capture): video frame extraction`

---

### Task 9: capture — visual-brief 脚手架与校验

**Files:**
- Create: `packages/capture/src/brief.ts`, `packages/core/src/vlm.ts`
- Test: `packages/capture/test/brief.test.ts`

**Interfaces:**
- Produces:
  - `brief.ts`: `writeBriefScaffold(outDir, inputType)` — 写 `visual-brief.schema.json`（zod 导出 JSON schema：regions[]、components[]{type,box,styles}、palette[]、fonts[]、charts[]{type,box}）+ `brief-prompt.md`（含图片/帧引用与输出格式要求）；`validateBrief(dir): Brief`（zod 校验 agent 填写的 visual-brief.json）
  - `vlm.ts`: `vlmChat(messages: {role, content: (text|image_url)[]}[]): Promise<string>` — fetch `${APIMART_BASE_URL}/chat/completions`，stream 兼容（SSE 累积 delta），key 读 `APIMART_API_KEY`，缺 key 抛提示

- [ ] **Step 1:** 失败测试：writeBriefScaffold 产物存在；合法 brief 通过校验、缺 regions 的被拒
- [ ] **Step 2:** 实现 brief.ts + vlm.ts（vlm 不进单元测试，手动验证）
- [ ] **Step 3:** 通过；captureImage/captureVideo 末尾自动 writeBriefScaffold；Commit `feat(capture): visual brief scaffold + vlm client`

---

### Task 10: core — snapshot-query CLI

**Files:**
- Create: `packages/core/src/query.ts`
- Test: `packages/core/test/query.test.ts`

**Interfaces:**
- Consumes: `readSnapshot` + `dom/<w>.json`
- Produces: `queryRegion(dom: ElementNode, regionId): ElementNode | undefined`（按 id 路径精确找）；`querySelector(node, cssLike): ElementNode[]`（tag/class 简化匹配）；CLI `tsx packages/core/src/query.ts <snapshotDir> --viewport 1440 --region 0/2/1` 输出该子树 JSON

- [ ] **Step 1-4:** 失败测试（构造小树）→ 实现 → 通过 → Commit `feat(core): snapshot query`

---

### Task 11: render — 静态服务 + repro capture

**Files:**
- Create: `packages/render/package.json`, `packages/render/src/index.ts`
- Test: `packages/render/test/render.test.ts`

**Interfaces:**
- Consumes: `serveStatic`, `captureSite`
- Produces: `captureRepro(reproDir, outDir, opts?): Promise<void>` — 若 `reproDir/dist` 不存在先 `npm run build`（失败抛带原文的 BuildError）；serveStatic(dist) → captureSite(localUrl, outDir)

- [ ] **Step 1:** 失败测试：repro fixture（纯静态 dist 目录）→ captureRepro → repro snapshot 存在
- [ ] **Step 2:** 实现（build 用 execFile npm，stdout/stderr 透传进 BuildError.message）
- [ ] **Step 3:** 通过；Commit `feat(render): build-serve-capture repro`

---

### Task 12: diff — 像素层

**Files:**
- Create: `packages/diff/src/pixel.ts`
- Test: `packages/diff/test/pixel.test.ts`

**Interfaces:**
- Produces: `pixelDiff(aPath, bPath, heatmapOut): Promise<{ ssim: number; pixelDiffPct: number } | { layoutError: true }>` — pngjs 解码；尺寸不同返回 layoutError；pixelmatch(threshold 0.1) 计差异占比；ssim.js 算 mssim；热力图=差异像素红色叠加原图 50% 透明

- [ ] **Step 1:** 失败测试：程序生成 A=纯白 200x100，B=右半涂黑 → pixelDiffPct≈50（±2）、ssim<1、heatmap 存在且右侧有红像素；尺寸不同的 C → layoutError
- [ ] **Step 2:** 实现
- [ ] **Step 3:** 通过；Commit `feat(diff): pixel layer with heatmap`

---

### Task 13: diff — 元素对齐

**Files:**
- Create: `packages/diff/src/align.ts`
- Test: `packages/diff/test/align.test.ts`

**Interfaces:**
- Produces: `alignTrees(orig: ElementNode, repro: ElementNode, idMap?: Map<string,string>): { pairs: [ElementNode,ElementNode][], missing: ElementNode[], extra: ElementNode[], failureRate: number }` — idMap 优先；否则递归贪心：子节点按 tag 相同 + IoU≥0.5 最佳优先配对；failureRate = (missing+extra)/(orig节点数+repro节点数)

- [ ] **Step 1:** 失败测试：全同树全配对；移动元素 IoU<0.5 进 missing/extra；idMap 强制配对
- [ ] **Step 2:** 实现（IoU 计算、贪心匹配 O(n²) 可接受，节点≤4000）
- [ ] **Step 3:** 通过；Commit `feat(diff): element alignment`

---

### Task 14: diff — 属性比较 + severity

**Files:**
- Create: `packages/diff/src/compare.ts`
- Test: `packages/diff/test/compare.test.ts`

**Interfaces:**
- Produces: `comparePair(orig: ElementNode, repro: ElementNode, pageArea: number): DiffEntry[]`；`DiffEntry = { id?, component?, element, property, expected, actual, severity, evidence? }`；`normalizeColor(s): [r,g,b,a] | null`

规则：几何四值容差 1px；px 类属性解析数值比较（deviation = |d|/max(10,|exp|)，cap 1）；颜色按通道差/255 平均；box-shadow/渐变等字符串归一化空白后不等即差异（deviation 1）；`severity = +(100 * (w*h/pageArea) * deviation).toFixed(1)`。

- [ ] **Step 1:** 失败测试：圆角 12 vs 8 出条目且 expected/actual 正确；`rgb(255,0,0)` vs `#ff0000` 不出条目；大面积差异 severity > 小面积
- [ ] **Step 2:** 实现
- [ ] **Step 3:** 通过；Commit `feat(diff): property comparison with severity`

---

### Task 15: diff — 装配 diff.json + 特写裁切 + VLM 队列（自参照集成测试）

**Files:**
- Create: `fixtures/site-mutated/index.html`（button 圆角 8px、删 box-shadow）
- Create: `packages/diff/src/index.ts`, `packages/diff/src/crops.ts`, `packages/diff/src/cli.ts`
- Test: `packages/diff/test/integration.test.ts`

**Interfaces:**
- Consumes: 以上全部 + captureSite
- Produces: `diffSnapshots(origDir, reproDir, outDir): Promise<DiffResult>`；`DiffResult = { metrics: {ssim, pixelDiffPct}, entries: DiffEntry[] }`；`vlm-requests.json` 格式 `{ requests: [{ id, crop, reproCrop, prompt }] }`

流程：逐视口 pixelDiff（layoutError → entry property='layout'）→ 有 DOM 则 align+compare → failureRate>0.3 或无 DOM 时，热力图连通区域裁切（pngjs 框选差异 bbox 外扩 20px）写 vlm-requests.json → entries 按 severity 降序取前 50 写 diff.json。

- [ ] **Step 1:** 自参照失败测试：serveStatic fixtures/site + fixtures/site-mutated → 各自 captureSite（视口 [800]）→ diffSnapshots → 断言 entries 含 `{property:'border-radius', expected:'12px', actual:'8px'}` 和 `{property:'box-shadow', actual:'none'}`；metrics.pixelDiffPct>0
- [ ] **Step 2:** 实现
- [ ] **Step 3:** 对齐失败率用例：把 mutated fixture 结构打乱版本喂入，断言 vlm-requests.json 非空
- [ ] **Step 4:** 通过；Commit `feat(diff): full pipeline with self-referential integration test`

---

### Task 16: converge 判定 CLI

**Files:**
- Create: `packages/diff/src/converge.ts`
- Test: `packages/diff/test/converge.test.ts`

**Interfaces:**
- Produces: `LoopState = { round: number, history: {ssim,pixelDiffPct}[], escalated: boolean }`；`decide(state, m): 'pass'|'continue'|'escalate'|'stagnant-stop'|'cap-stop'`；CLI 读 state.json + diff.json，写回 state.json 并打印决策

规则按 Global Constraints（pass > cap > 停滞[2轮<0.5 → escalate 一次 → 再停滞 stagnant-stop] > continue）。

- [ ] **Step 1-4:** 失败测试（五种分支各一例）→ 实现 → 通过 → Commit `feat(diff): convergence decision`

---

### Task 17: report.html 生成

**Files:**
- Create: `packages/diff/src/report.ts`
- Test: `packages/diff/test/report.test.ts`

**Interfaces:**
- Produces: `writeReport(outDir, result: DiffResult, origShots: string[], reproShots: string[]): Promise<string>`（返回 html 路径）— 并排图 + range 滑块 clip-path 对比（内联 vanilla JS）+ 差异表（severity 降序、组件文件链接、evidence 图）

- [ ] **Step 1:** 失败测试：断言 html 含指标、差异行、滑块脚本
- [ ] **Step 2:** 实现
- [ ] **Step 3:** 通过；Commit `feat(diff): html report`

---

### Task 18: eval 确定性脚本

**Files:**
- Create: `eval/run-determinism.ts`, `eval/urls.txt`（5 个公开页）
- Test: `packages/diff/test/determinism.test.ts`（fixture 版）

**Interfaces:**
- Produces: `eval/run-determinism.ts <url>` — 同 URL capture 两次 → diffSnapshots → 打印 ssim/pixelDiffPct（期望 ssim ≥ 0.999）

- [ ] **Step 1:** 失败测试：fixture 自比 ssim ≥ 0.999
- [ ] **Step 2:** 实现脚本
- [ ] **Step 3:** 通过；Commit `feat(eval): determinism harness`

---

### Task 19: skill 编排

**Files:**
- Create: `skill/SKILL.md`

内容：输入分流 → capture CLI → （视觉输入：读 brief-prompt.md 调 vlmChat 填 visual-brief.json → validateBrief）→ 骨架轮/组件填充轮生成规范（spec §5 五条硬规则原文）→ captureRepro → diffSnapshots → converge CLI 决策分支（escalate 时附特写+computed style 原文）→ report.html 终审。附 state.json 管理与 build 失败=severity ∞ 条目规则。

- [ ] **Step 1:** 写 SKILL.md（frontmatter: name copypage, description 含触发词"还原网站/截图克隆"）
- [ ] **Step 2:** 人工 smoke checklist 附文末
- [ ] **Step 3:** Commit `feat(skill): orchestration loop`

---

## Self-Review 记录

- Spec 覆盖：§4.1→T2-T6，§4.2→T7-T9，§5→T10/T11/T19（生成规则在 skill），§6→T12-T15/T17，§7→T16/T18/T19 ✅
- 类型一致性：DiffEntry/LoopState/Snapshot 等全程同名 ✅
- Review Focus 五条均有归属测试 ✅
