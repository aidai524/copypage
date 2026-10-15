import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
const errs: string[] = []
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
p.on('pageerror', (e) => errs.push(String(e)))
for (const url of [
  'http://127.0.0.1:4400/app?demo=1',
  'http://127.0.0.1:4400/app/new?demo=1',
  'http://127.0.0.1:4400/app/tasks/demo-20261014-1204?demo=1',
  'http://127.0.0.1:4400/app/admin?demo=1',
]) {
  errs.length = 0
  await p.goto(url, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  const shape = await p.evaluate(() => ({
    view: document.querySelector('#tasks') ? 'list' : document.querySelector('#new-task') ? 'new' : document.querySelector('#progress-bar') ? 'task' : document.querySelector('#admin-body') ? 'admin' : '?',
    rows: document.querySelectorAll('#tasks .task-row').length,
    logLines: document.querySelectorAll('#log .log-line').length,
    progress: document.querySelector('.progress i')?.style.width ?? '',
  }))
  console.log(`${errs.length ? '❌' : '✅'} ${url.replace('http://127.0.0.1:4400', '')} → view=${shape.view} rows=${shape.rows} logLines=${shape.logLines} bar=${shape.progress}`)
  if (errs.length) console.log('   ', errs.slice(0, 3).join(' | '))
}
await p.screenshot({ path: '/tmp/new-list.png', fullPage: false })
await p.goto('http://127.0.0.1:4400/app/tasks/demo-20261014-1204?demo=1', { waitUntil: 'load' })
await p.waitForTimeout(1500)
await p.screenshot({ path: '/tmp/new-detail.png', fullPage: false })
await b.close()
