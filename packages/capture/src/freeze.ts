import type { Page } from 'playwright'

/**
 * Freeze dynamic behavior for deterministic captures:
 * - pause CSS animations/transitions
 * - pause videos
 * - stop swiper autoplay instances
 * - clear all pending timers (registered via addInitScript hooks)
 *
 * registerTimerHooks must run before page scripts (addInitScript).
 */
export async function registerTimerHooks(page: Page): Promise<void> {
  await page.addInitScript(`
    (() => {
      window.__cpTimers = []
      const si = window.setInterval.bind(window)
      const st = window.setTimeout.bind(window)
      window.setInterval = (fn, ms, ...a) => { const id = si(fn, ms, ...a); window.__cpTimers.push({ type: 'i', id }); return id }
      window.setTimeout = (fn, ms, ...a) => { const id = st(fn, ms, ...a); window.__cpTimers.push({ type: 't', id }); return id }
    })()
  `)
}

/** Call after load + autoscroll, right before screenshot/probe. */
export async function freezeDynamic(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    // 1. timers
    const timers = window.__cpTimers || []
    for (const t of timers) {
      try {
        if (t.type === 'i') clearInterval(t.id); else clearTimeout(t.id)
      } catch {}
    }
    // 2. css animations & transitions
    const style = document.createElement('style')
    style.id = 'cp-freeze'
    style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'
    document.head.appendChild(style)
    // 3. videos
    for (const v of Array.from(document.querySelectorAll('video'))) {
      try { v.pause() } catch {}
    }
    // 4. swiper autoplay
    for (const el of Array.from(document.querySelectorAll('.swiper, .swiper-container'))) {
      try { el.swiper && el.swiper.autoplay && el.swiper.autoplay.stop() } catch {}
    }
  })()`)
}
