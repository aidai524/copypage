// Public end-to-end check on https://kloon.dev
//   1. the landing page a visitor sees
//   2. login through the console
//   3. one real capture from the public site, watched until it finishes
// Run: npx tsx work/e2e-live.mts
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const creds = readFileSync('/tmp/kloon-admin-creds.txt', 'utf8')
const email = creds.match(/admin:\s*(\S+)/)?.[1]
const password = creds.match(/password:\s*(\S+)/)?.[1]
if (!email || !password) throw new Error('credentials not parsed')

const results: { step: string; ok: boolean; note: string }[] = []
const check = (step: string, ok: boolean, note = '') => {
  results.push({ step, ok, note })
  console.log(`${ok ? '✅' : '❌'} ${step}${note ? ` — ${note}` : ''}`)
}

const browser = await chromium.launch({
  args: ['--host-resolver-rules=MAP kloon.dev 103.3.62.56', '--ignore-certificate-errors'],
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
const page = await ctx.newPage()
const errors: string[] = []
// a session probe on /app answers 401 for a visitor who is not logged in: that is the
// correct HTTP answer and the console renders the login form without showing any error.
const EXPECTED_NOISE = /401|Unauthorized|Failed to load resource/i
page.on('console', (m) => {
  if (m.type() !== 'error') return
  if (awaitingLogin && EXPECTED_NOISE.test(m.text())) return
  errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))
let awaitingLogin = true

// ---------- 1. landing ----------
await page.goto('https://kloon.dev/', { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(2000)
const h1 = (await page.locator('h1').first().innerText()).trim()
check('落地页标题', h1.includes('把网页读成代码'), h1)

const art = await page.evaluate(() =>
  [...document.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth })),
)
check('落地页真实产物图已加载', art.length >= 4 && art.every((a) => a.w > 0), `${art.length} 张: ${art.map((a) => a.src).join(', ')}`)

const split = await page.locator('#split').count()
const splitBefore = await page.evaluate(() => getComputedStyle(document.querySelector('#compare')).getPropertyValue('--split').trim())
await page.locator('#split').fill('80')
await page.waitForTimeout(200)
const splitAfter = await page.evaluate(() => getComputedStyle(document.querySelector('#compare')).getPropertyValue('--split').trim())
check('对比滑块可用(可键盘/拖动)', split === 1 && splitBefore === '50%' && splitAfter === '80%', `${splitBefore} → ${splitAfter}`)

const loginCta = await page.locator('a.action[href="/app"]').count()
check('首屏有主行动(指向 /app)', loginCta >= 1, `${loginCta} 个`)
await page.screenshot({ path: '/tmp/e2e-landing.png' })

// ---------- 2. console login ----------
await page.goto('https://kloon.dev/app', { waitUntil: 'load', timeout: 60000 })
await page.waitForSelector('#login-form', { timeout: 30000 })
const visibleForms = await page.evaluate(() =>
  ['#login-form', '#register-form', '#reset-form'].filter((s) => {
    const el = document.querySelector(s)
    return el && el.getBoundingClientRect().height > 0
  }),
)
check('访客页只出现一个表单', visibleForms.length === 1 && visibleForms[0] === '#login-form', visibleForms.join(','))
await page.screenshot({ path: '/tmp/e2e-auth.png' })

await page.fill('#login-email', email)
await page.fill('#login-password', password)
await page.click('#login-form button[type=submit]')
await page.waitForSelector('#tasks', { timeout: 30000 })
awaitingLogin = false
const listed = await page.evaluate(() => ({
  rows: document.querySelectorAll('#tasks .task-row').length,
  hasCreate: !!document.querySelector('#create-btn'),
  url: location.pathname,
}))
check('登录后先看到任务列表 + 新建按钮', listed.hasCreate && listed.url === '/app', `${listed.rows} 行 · ${listed.url}`)
await page.screenshot({ path: '/tmp/e2e-console.png' })

// ---------- 3. a real capture, through list -> new -> detail ----------
await page.click('#create-btn')
await page.waitForSelector('#new-task', { timeout: 15000 })
check('「新建任务」打开表单', page.url().endsWith('/app/new'), page.url().replace('https://kloon.dev', ''))

const source = 'https://example.com'
await page.fill('#source', source)
await page.fill('#viewports', '1440')
await page.click('#submit')
await page.waitForSelector('#progress-bar', { timeout: 30000 })
check('提交后进入该任务详情页', /\/app\/tasks\//.test(page.url()), page.url().replace('https://kloon.dev', ''))

// the run must patch in place: mark the nodes and check they survive
await page.evaluate(() => {
  const w = window as unknown as Record<string, unknown>
  w.__probe = { log: document.querySelector('#log'), bar: document.querySelector('#progress-bar'), first: document.querySelector('#page')?.firstElementChild, images: 0 }
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && (n as Element).tagName === 'IMG') (w.__probe as { images: number }).images++
  }).observe(document.body, { childList: true, subtree: true })
})
const t0 = Date.now()
let status = ''
let title = ''
let stable = true
let images = 0
let imagesWhileRunning = 0
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1500)
  const s = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const p = w.__probe as Record<string, unknown>
    return {
      badge: document.querySelector('#task-status')?.textContent?.trim() ?? '',
      same: p.log === document.querySelector('#log') && p.bar === document.querySelector('#progress-bar') && p.first === document.querySelector('#page')?.firstElementChild,
      images: p.images as number,
      pct: (document.querySelector('#progress-bar') as HTMLElement)?.style.width ?? '',
    }
  })
  if (!s.same) stable = false
  images = s.images
  if (!/完成|失败/.test(s.badge)) imagesWhileRunning = s.images
  status = s.badge
  title = `${s.badge} · ${s.pct}`
  if (/完成|失败/.test(s.badge)) break
}
check('运行中详情页原地更新(节点未被重建)', stable, `新建 <img> ${images} 个`)
check('运行中未重复加载图片(无闪烁)', imagesWhileRunning === 0, `运行期间新建 ${imagesWhileRunning} 个`)
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
const detail = await page.evaluate(() => ({
  images: document.querySelectorAll('#result-block img').length,
  logLines: document.querySelectorAll('#log .log-line').length,
  facts: document.querySelectorAll('.facts div').length,
}))
check('详情页展示结果(图片/日志/字段)', detail.images >= 1 && detail.logLines >= 2 && detail.facts >= 4, `${detail.images} 图 · ${detail.logLines} 行日志 · ${detail.facts} 字段`)
check('公网真实捕获到终态', /完成|失败/.test(status), `${status} · ${elapsed}s · ${title.slice(0, 80)}`)
check('捕获成功(非失败)', /完成/.test(status), status)
await page.screenshot({ path: '/tmp/e2e-capture.png' })

check('页面无意外 console 报错(登录前的 401 探测除外)', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
