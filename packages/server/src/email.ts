import type { ServerConfig } from './config.js'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailClient {
  readonly kind: 'resend' | 'log'
  send(msg: EmailMessage): Promise<{ id?: string }>
}

export class EmailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailError'
  }
}

/**
 * Resend-backed mail. Without an API key the client logs messages to stdout
 * (dev / tests) so the whole flow stays usable locally.
 */
export function createEmailClient(config: ServerConfig): EmailClient {
  const key = config.resendApiKey
  if (!key) {
    return {
      kind: 'log',
      async send(msg) {
        console.log(`[email:log] to=${msg.to} subject=${msg.subject}\n${msg.text}`)
        return {}
      },
    }
  }
  return {
    kind: 'resend',
    async send(msg) {
      const res = await fetch(`${config.resendBaseUrl}/emails`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: config.emailFrom,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const body = await res.text()
      if (!res.ok) throw new EmailError(`resend ${res.status}: ${body.slice(0, 300)}`)
      try {
        return JSON.parse(body) as { id?: string }
      } catch {
        return {}
      }
    },
  }
}

function layout(opts: { title: string; intro: string; cta?: { label: string; url: string }; footer?: string }) {
  const cta = opts.cta
    ? `<p style="margin:24px 0"><a href="${opts.cta.url}" style="background:#4ade80;color:#052e16;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${opts.cta.label}</a></p>
       <p style="color:#71717a;font-size:12px">按钮无效时复制链接到浏览器:${opts.cta.url}</p>`
    : ''
  const html = `<!doctype html><div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">
    <h2 style="margin:0 0 12px">${opts.title}</h2>
    <p style="margin:0 0 8px">${opts.intro}</p>
    ${cta}
    <p style="color:#71717a;font-size:12px;margin-top:24px">${opts.footer ?? 'Kloon — 网站一比一还原工具'}</p>
  </div>`
  const text = [opts.title, '', opts.intro, ...(opts.cta ? ['', `${opts.cta.label}: ${opts.cta.url}`] : [])].join('\n')
  return { html, text }
}

export function verificationEmail(config: ServerConfig, to: string, token: string): EmailMessage {
  const url = `${config.appUrl}/?verify=${encodeURIComponent(token)}`
  const rendered = layout({
    title: '验证你的邮箱',
    intro: '点击下面的按钮完成邮箱验证,之后即可提交捕获/验证/生成任务。链接 24 小时内有效。',
    cta: { label: '验证邮箱', url },
  })
  return { to, subject: 'Kloon 邮箱验证', ...rendered }
}

export function resetEmail(config: ServerConfig, to: string, token: string): EmailMessage {
  const url = `${config.appUrl}/?reset=${encodeURIComponent(token)}`
  const rendered = layout({
    title: '重置密码',
    intro: '点击下面的按钮设置新密码。链接 1 小时内有效;如果不是你本人操作,请忽略本邮件。',
    cta: { label: '设置新密码', url },
  })
  return { to, subject: 'Kloon 密码重置', ...rendered }
}

export function warningEmail(to: string, message: string): EmailMessage {
  const rendered = layout({
    title: '账户提醒',
    intro: message,
    footer: 'Kloon — 如有疑问请回复本邮件联系管理员',
  })
  return { to, subject: '[Kloon] 账户提醒', ...rendered }
}

export function alertEmail(to: string, title: string, lines: string[]): EmailMessage {
  const rendered = layout({
    title,
    intro: lines.map((l) => `<span>${l}</span>`).join('<br>'),
    footer: 'Kloon 运维告警',
  })
  return { to, subject: `[Kloon 告警] ${title}`, ...rendered }
}
