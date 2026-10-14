import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DiffResult } from './index.js'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Human-review report: side-by-side screenshots with a drag slider,
 * plus the unresolved diff entries table (severity desc).
 */
export async function writeReport(
  outDir: string,
  result: DiffResult,
  origShots: string[],
  reproShots: string[],
): Promise<string> {
  const comparisons = origShots.map((orig, i) => {
    const repro = reproShots[i] ?? ''
    return `
    <div class="compare" data-repro="${esc(repro)}">
      <h3>视口对比 ${i + 1}</h3>
      <div class="slider-wrap">
        <img class="base" src="${esc(orig)}" alt="original">
        <div class="overlay"><img src="${esc(repro)}" alt="repro"></div>
        <input class="slider" type="range" min="0" max="100" value="50">
      </div>
      <p class="legend">左：原站 · 拖动滑块对比还原页（overlay）</p>
    </div>`
  }).join('\n')

  const rows = result.entries.map((e) => `
    <tr>
      <td>${e.severity}</td>
      <td>${esc(e.element)}</td>
      <td>${esc(e.property)}</td>
      <td class="exp">${esc(e.expected)}</td>
      <td class="act">${esc(e.actual)}</td>
      <td>${e.component ? esc(e.component) : '—'}</td>
    </tr>`).join('\n')

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Kloon 还原报告</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 32px; color: #1a1a2e; }
  .metrics { display: flex; gap: 24px; margin-bottom: 24px; }
  .metric { background: #f3f4f6; border-radius: 8px; padding: 12px 20px; }
  .metric b { font-size: 22px; }
  .slider-wrap { position: relative; display: inline-block; max-width: 100%; }
  .slider-wrap img { max-width: 100%; display: block; }
  .overlay { position: absolute; inset: 0; overflow: hidden; width: 50%; }
  .overlay img { max-width: none; }
  .slider { position: absolute; inset: auto 0 8px 0; width: 100%; }
  table { border-collapse: collapse; width: 100%; margin-top: 24px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; font-size: 13px; text-align: left; }
  th { background: #f9fafb; }
  .exp { color: #047857; } .act { color: #b91c1c; }
  .legend { color: #6b7280; font-size: 12px; }
</style></head>
<body>
  <h1>Kloon 还原报告</h1>
  <div class="metrics">
    <div class="metric">SSIM<br><b>${result.metrics.ssim}</b></div>
    <div class="metric">像素差异<br><b>${result.metrics.pixelDiffPct}%</b></div>
    <div class="metric">未解决差异<br><b>${result.entries.length}</b></div>
  </div>
  ${comparisons}
  <h2>差异清单（按严重度降序）</h2>
  <table>
    <thead><tr><th>severity</th><th>元素</th><th>属性</th><th>原站值</th><th>还原值</th><th>组件</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
    document.querySelectorAll('.slider-wrap').forEach((wrap) => {
      const slider = wrap.querySelector('.slider')
      const overlay = wrap.querySelector('.overlay')
      const img = overlay.querySelector('img')
      const base = wrap.querySelector('.base')
      function sync() { img.style.width = base.clientWidth + 'px' }
      new ResizeObserver(sync).observe(base)
      slider.addEventListener('input', () => { overlay.style.width = slider.value + '%' })
    })
  </script>
</body></html>`

  const htmlPath = path.join(outDir, 'report.html')
  await writeFile(htmlPath, html)
  return htmlPath
}
