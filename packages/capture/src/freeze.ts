import type { Page } from 'playwright'

/**
 * Freeze dynamic behavior for deterministic captures:
 * - pause CSS animations/transitions
 * - pause videos
 * - stop swiper autoplay instances
 * - stop timers, WebSocket/EventSource messages and fetch/XHR polling
 *
 * registerTimerHooks must run before page scripts (addInitScript) so every
 * timer/socket created by the app is observable and gated on __cpFrozen.
 */
export async function registerTimerHooks(page: Page): Promise<void> {
  await page.addInitScript(`
    (() => {
      window.__cpTimers = []
      window.__cpFrozen = false
      const si = window.setInterval.bind(window)
      const st = window.setTimeout.bind(window)
      const oraf = window.requestAnimationFrame.bind(window)
      window.__cpRafs = []
      window.requestAnimationFrame = (cb) => {
        const wrapped = (t) => { if (window.__cpFrozen) return; return cb(t) }
        const id = oraf(wrapped)
        window.__cpRafs.push(id)
        return id
      }
      window.setInterval = (fn, ms, ...a) => {
        const wrapped = (...args) => { if (window.__cpFrozen) return; return fn(...args) }
        const id = si(wrapped, ms, ...a)
        window.__cpTimers.push({ type: 'i', id })
        return id
      }
      window.setTimeout = (fn, ms, ...a) => {
        const wrapped = (...args) => { if (window.__cpFrozen) return; return fn(...args) }
        const id = st(wrapped, ms, ...a)
        window.__cpTimers.push({ type: 't', id })
        return id
      }

      // WebSocket: swallow message delivery once frozen; sockets created after
      // the freeze become non-connecting stubs so reconnects cannot inject data.
      const OrigWS = window.WebSocket
      if (OrigWS) {
        const proto = OrigWS.prototype
        const add = proto.addEventListener
        proto.addEventListener = function (type, listener, opts) {
          if (type === 'message' && typeof listener === 'function') {
            const wrapped = function (ev) { if (!window.__cpFrozen) return listener.call(this, ev) }
            return add.call(this, type, wrapped, opts)
          }
          return add.call(this, type, listener, opts)
        }
        const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage')
        if (desc && desc.set) {
          Object.defineProperty(proto, 'onmessage', {
            get: desc.get,
            set(fn) {
              desc.set.call(this, typeof fn === 'function'
                ? function (ev) { if (!window.__cpFrozen) return fn.call(this, ev) }
                : fn)
            },
            configurable: true,
            enumerable: desc.enumerable,
          })
        }
        function FrozenWS(url, protocols) {
          if (window.__cpFrozen) {
            return {
              url: String(url), readyState: 0, bufferedAmount: 0,
              close() {}, send() {}, addEventListener() {}, removeEventListener() {},
              dispatchEvent() { return true },
            }
          }
          return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols)
        }
        FrozenWS.prototype = proto
        FrozenWS.CONNECTING = 0
        FrozenWS.OPEN = 1
        FrozenWS.CLOSING = 2
        FrozenWS.CLOSED = 3
        window.WebSocket = FrozenWS
      }

      // EventSource: close immediately when created after the freeze.
      const OrigES = window.EventSource
      if (OrigES) {
        function FrozenES(url, opts) {
          const es = opts === undefined ? new OrigES(url) : new OrigES(url, opts)
          if (window.__cpFrozen) { try { es.close() } catch {} }
          return es
        }
        FrozenES.prototype = OrigES.prototype
        window.EventSource = FrozenES
      }

      // fetch/XHR polling: never resolve / never send once frozen, so a
      // polling loop cannot repaint the page while we screenshot + probe.
      const origFetch = window.fetch
      if (origFetch) {
        window.fetch = function (...args) {
          if (window.__cpFrozen) return new Promise(() => {})
          return origFetch.apply(this, args)
        }
      }
      const origSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.send = function (...args) {
        if (window.__cpFrozen) return
        return origSend.apply(this, args)
      }
    })()
  `)
}

/** Call after load + autoscroll, right before screenshot/probe. */
export async function freezeDynamic(page: Page, opts: { settleMs?: number } = {}): Promise<void> {
  await page.evaluate(`(() => {
    // 0. close the data gates first: no new websocket/polling messages from here on
    window.__cpFrozen = true
    // 1. timers + animation frames
    const timers = window.__cpTimers || []
    for (const t of timers) {
      try {
        if (t.type === 'i') clearInterval(t.id); else clearTimeout(t.id)
      } catch {}
    }
    for (const id of window.__cpRafs || []) {
      try { cancelAnimationFrame(id) } catch {}
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
  // in-flight requests started before the freeze still resolve and repaint;
  // let them land so screenshot + probe see the same settled DOM
  await page.waitForTimeout(opts.settleMs ?? 300)
}

/**
 * Lift the data gate so interaction-state / interaction discovery captures can
 * still trigger app behavior (hover-triggered fetches etc). Frozen timers stay
 * cleared — this only reopens network delivery.
 */
export async function unfreezeDynamic(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    window.__cpFrozen = false
    const style = document.getElementById('cp-freeze')
    if (style) style.remove()
  })()`)
}
