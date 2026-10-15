// Regenerates packages/server/public/demo/*.jpg from tools/demo-assets/sample.html.
// Both pages are original (fictional brand). The comparison is Kloon's own pixelDiff,
// so the heatmap and the numbers are measured, not drawn.
// Run: npx tsx tools/demo-assets/build.mts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { pixelDiff } from '../../packages/diff/src/pixel.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const sample = pathToFileURL(path.join(here, 'sample.html')).href
const out = path.join(here, '../../packages/server/public/demo')
const tmp = await mkdtemp(path.join(tmpdir(), 'kloon-demo-'))

const browser = await chromium.launch()
async function shoot(width: number, repro: boolean): Promise<{ file: string; nodes: number }> {
  const page = await (await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })).newPage()
  await page.goto(sample + (repro ? '#repro' : ''), { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const nodes = await page.evaluate(() => document.querySelectorAll('*').length)
  const file = path.join(tmp, `${repro ? 'repro' : 'orig'}-${width}.png`)
  await page.screenshot({ path: file, fullPage: true })
  await page.context().close()
  return { file, nodes }
}

try {
  await mkdir(out, { recursive: true })
  const orig = await shoot(1440, false)
  const repro = await shoot(1440, true)
  const orig768 = await shoot(768, false)
  const heat = path.join(tmp, 'heatmap.png')
  const r = await pixelDiff(orig.file, repro.file, heat)
  if ('layoutError' in r) throw new Error('layout mismatch between original and reproduction')

  // 1200 wide keeps the files small and matches the <img> width/height in the pages
  const jpg = (src: string, name: string, width: number) =>
    sharp(src).resize({ width }).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(out, name))
  await jpg(orig.file, 'capture.jpg', 1200)
  await jpg(repro.file, 'repro.jpg', 1200)
  await jpg(heat, 'heatmap.jpg', 1200)
  await jpg(orig768.file, 'capture-768.jpg', 768)

  const meta = await sharp(path.join(out, 'capture.jpg')).metadata()
  const metrics = { ssim: +r.ssim.toFixed(4), pixelDiffPct: r.pixelDiffPct, domNodes: orig.nodes, size: `${meta.width}x${meta.height}` }
  await writeFile(
    path.join(out, 'README.txt'),
    [
      'Demo assets for the Kloon landing page and the ?demo=1 console.',
      'Source: tools/demo-assets/sample.html, an original page for a fictional brand (no third-party content).',
      'capture = the page, repro = a hand-made reproduction with a few style details drifted,',
      'heatmap = Kloon pixelDiff of the two (red = differing pixels).',
      `Measured: ${JSON.stringify(metrics)}`,
      'Regenerate with: npx tsx tools/demo-assets/build.mts',
      '',
    ].join('\n'),
  )
  console.log(JSON.stringify(metrics))
} finally {
  await browser.close()
  await rm(tmp, { recursive: true, force: true })
}
