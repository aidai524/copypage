import type { Page } from 'playwright'

export interface ChartFinding {
  library: 'echarts' | 'highcharts' | 'd3' | 'canvas-cluster'
  selector?: string
  /** the chart's live options/config object, when the library exposes it */
  options?: unknown
}

// string source — avoids TS transpile helpers leaking into the browser
const DETECT_SRC = `() => {
  const findings = []

  // echarts
  const ec = window.echarts
  if (ec && ec.getInstanceByDom) {
    for (const el of Array.from(document.querySelectorAll('div[_echarts_instance_], div, section'))) {
      try {
        const inst = ec.getInstanceByDom(el)
        if (inst && inst.getOption) {
          const idPart = el.id ? '#' + el.id : ''
          findings.push({
            library: 'echarts',
            selector: el.tagName.toLowerCase() + idPart,
            options: inst.getOption(),
          })
        }
      } catch {}
    }
  }

  // Highcharts
  const hc = window.Highcharts
  if (hc && hc.charts) {
    for (const chart of hc.charts) {
      if (chart && chart.options) findings.push({ library: 'highcharts', options: chart.options })
    }
  }

  // d3 heuristic: svg with many generated shapes under g elements
  if (findings.length === 0) {
    for (const svg of Array.from(document.querySelectorAll('svg'))) {
      const shapes = svg.querySelectorAll('g path, g rect, g circle').length
      if (shapes >= 5) {
        const idPart = svg.id ? '#' + svg.id : ''
        findings.push({ library: 'd3', selector: 'svg' + idPart })
      }
    }
  }

  // canvas clusters (chart.js etc. render to canvas)
  const canvases = Array.from(document.querySelectorAll('canvas')).filter((c) => {
    const r = c.getBoundingClientRect()
    return r.width >= 100 && r.height >= 80
  })
  for (const c of canvases) {
    findings.push({ library: 'canvas-cluster', selector: c.id ? 'canvas#' + c.id : 'canvas' })
  }

  return findings
}`

/**
 * Detect known chart library instances on the page and export their live configs.
 * echarts: window.echarts.getInstanceByDom per container; Highcharts: window.Highcharts.charts;
 * d3 / canvas: heuristic density detection (no config export possible).
 */
export async function detectCharts(page: Page): Promise<ChartFinding[]> {
  return page.evaluate(`(${DETECT_SRC})()`) as Promise<ChartFinding[]>
}
