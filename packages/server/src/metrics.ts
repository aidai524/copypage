/**
 * Tiny dependency-free metrics registry: counters, gauges and simple
 * summaries, exported in Prometheus text format at GET /metrics.
 */

type Labels = Record<string, string | number>

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/"/g, '')}"`)
    .join(',')

export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>()
  private gauges = new Map<string, { help: string; value: number }>()
  private summaries = new Map<string, { help: string; count: number; sum: number; max: number }>()

  counter(name: string, help = ''): void {
    if (!this.counters.has(name)) this.counters.set(name, { help, values: new Map() })
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const entry = this.counters.get(name) ?? { help: '', values: new Map() }
    this.counters.set(name, entry)
    const key = labelKey(labels)
    entry.values.set(key, (entry.values.get(key) ?? 0) + by)
  }

  gauge(name: string, value: number, help = ''): void {
    this.gauges.set(name, { help, value })
  }

  observe(name: string, value: number, help = ''): void {
    const entry = this.summaries.get(name) ?? { help, count: 0, sum: 0, max: 0 }
    this.summaries.set(name, entry)
    entry.count++
    entry.sum += value
    entry.max = Math.max(entry.max, value)
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, entry] of this.counters) {
      for (const [labels, value] of entry.values) out[`${name}{${labels}}`] = value
    }
    for (const [name, entry] of this.gauges) out[name] = entry.value
    for (const [name, entry] of this.summaries) out[`${name}_count`] = entry.count
    return out
  }

  /** Prometheus text exposition format */
  render(): string {
    const lines: string[] = []
    for (const [name, entry] of this.counters) {
      if (entry.help) lines.push(`# HELP ${name} ${entry.help}`)
      lines.push(`# TYPE ${name} counter`)
      for (const [labels, value] of entry.values) {
        lines.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`)
      }
    }
    for (const [name, entry] of this.gauges) {
      if (entry.help) lines.push(`# HELP ${name} ${entry.help}`)
      lines.push(`# TYPE ${name} gauge`)
      lines.push(`${name} ${entry.value}`)
    }
    for (const [name, entry] of this.summaries) {
      if (entry.help) lines.push(`# HELP ${name} ${entry.help}`)
      lines.push(`# TYPE ${name} summary`)
      lines.push(`${name}_count ${entry.count}`)
      lines.push(`${name}_sum ${entry.sum}`)
      lines.push(`${name}_max ${entry.max}`)
    }
    return `${lines.join('\n')}\n`
  }
}
