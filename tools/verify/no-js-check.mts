// progressive enhancement: with scripting off nothing may stay hidden
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP kloon.dev 103.3.62.56'] })
const ctx = await b.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
const p = await ctx.newPage()
for (const url of ['https://kloon.dev/', 'https://kloon.dev/app']) {
  await p.goto(url, { waitUntil: 'load', timeout: 60000 })
  const r = await p.evaluate(() => {
    const h = document.querySelector('h1')
    const cs = h ? getComputedStyle(h) : null
    const span = h ? getComputedStyle(h.querySelector('span') || h) : null
    return { text: h?.innerText?.trim() ?? '', opacity: cs?.opacity, transform: span?.transform }
  })
  const hidden = r.opacity === '0' || (r.transform && r.transform !== 'none')
  console.log(`${hidden ? '❌' : '✅'} ${url} → h1="${r.text.slice(0, 20)}" opacity=${r.opacity} transform=${r.transform}`)
  await p.screenshot({ path: `/tmp/nojs-${url.includes('/app') ? 'app' : 'landing'}.png` })
}
await b.close()
