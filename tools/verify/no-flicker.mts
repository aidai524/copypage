// No-flicker proof: while a capture runs, the detail page must patch in place.
//   - the nodes that show status/progress/log keep their identity (no re-render)
//   - log lines only ever grow, and nothing already on screen is replaced
//   - no <img> is created or re-created during the run
// Run: npx tsx work/no-flicker.mts            (local, uses deploy/.admin-password)
//      BASE=https://kloon.dev ... npx tsx work/no-flicker.mts
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4400'
const creds = readFileSync(process.env.CREDS ?? 'deploy/.admin-password', 'utf8')
const email = creds.match(/admin:\s*(\S+)/)?.[1]
const password = creds.match(/password:\s*(\S+)/)?.[1]
if (!email || !password) throw new Error('credentials not parsed')

const browser = await chromium.launch(
  BASE.includes('kloon.dev') ? { args: ['--host-resolver-rules=MAP kloon.dev 103.3.62.56'] } : {},
)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
const page = await ctx.newPage()

await page.goto(`${BASE}/app`, { waitUntil: 'load' })
await page.waitForSelector('#login-form', { timeout: 30000 })
await page.fill('#login-email', email)
await page.fill('#login-password', password)
await page.click('#login-form button[type=submit]')
await page.waitForSelector('#tasks', { timeout: 30000 })
console.log('已登录，进入列表页:', await page.evaluate(() => !!document.querySelector('#tasks')))

// create through the UI: list -> 新建任务 -> form
await page.click('#create-btn')
await page.waitForSelector('#new-task', { timeout: 15000 })
console.log('新建表单已打开:', await page.evaluate(() => !!document.querySelector('#new-task')))
await page.fill('#source', 'https://example.com')
await page.fill('#viewports', '1440')
await page.click('#submit')
await page.waitForSelector('#progress-bar', { timeout: 30000 })
console.log('提交后跳到详情页:', page.url().replace(BASE, ''))

// mark the nodes we expect to survive, and watch for image churn
await page.evaluate(() => {
  const w = window as unknown as Record<string, unknown>
  w.__probe = {
    log: document.querySelector('#log'),
    bar: document.querySelector('#progress-bar'),
    note: document.querySelector('#progress-note'),
    block: document.querySelector('#log-block'),
    first: document.querySelector('#page')?.firstElementChild,
    images: 0,
  }
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && (n as Element).tagName === 'IMG') (w.__probe as { images: number }).images++
    }
  }).observe(document.body, { childList: true, subtree: true })
})

let lastLines = 0
let worstLines = 0
const samples = []
for (let i = 0; i < 40; i++) {
  const s = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const p = w.__probe as Record<string, unknown>
    const lines = document.querySelectorAll('#log .log-line').length
    return {
      logSame: p.log === document.querySelector('#log'),
      barSame: p.bar === document.querySelector('#progress-bar'),
      noteSame: p.note === document.querySelector('#progress-note'),
      blockSame: p.block === document.querySelector('#log-block'),
      firstSame: p.first === document.querySelector('#page')?.firstElementChild,
      lines,
      images: p.images as number,
      status: document.querySelector('#task-status')?.textContent ?? '',
      pct: (document.querySelector('#progress-bar') as HTMLElement)?.style.width ?? '',
    }
  })
  if (s.lines < lastLines) worstLines++
  lastLines = s.lines
  samples.push(s)
  if (/完成|失败/.test(s.status)) break
  await page.waitForTimeout(400)
}
const last = samples.at(-1)!
const identityOk = samples.every((s) => s.logSame && s.barSame && s.noteSame && s.blockSame && s.firstSame)
const linesOk = worstLines === 0 && last.lines >= 2
const imagesOk = last.images === 0
console.log(`采样 ${samples.length} 次 · 状态=${last.status} · 进度=${last.pct} · 日志行=${last.lines}`)
console.log(`${identityOk ? '✅' : '❌'} 关键节点全程未被重建(日志/进度条/进度行/日志块/页面首子节点)`)
console.log(`${linesOk ? '✅' : '❌'} 日志行数单调递增(${samples[0].lines} → ${last.lines}，回退次数 ${worstLines})`)
console.log(`${imagesOk ? '✅' : '❌'} 运行期间新建 <img> 节点数 = ${last.images}(应为 0，图片只在结果出现时加载一次)`)
await page.screenshot({ path: '/tmp/no-flicker.png' })
await browser.close()
process.exit(identityOk && imagesOk && samples.length > 2 ? 0 : 1)
