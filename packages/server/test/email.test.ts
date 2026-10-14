import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src/index.js'

interface CapturedEmail {
  from: string
  to: string[]
  subject: string
  html: string
  text: string
}

/** minimal Resend-compatible endpoint that records outgoing mail */
function fakeResend(): { server: Server; emails: CapturedEmail[]; url: () => string } {
  const emails: CapturedEmail[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        try {
          emails.push(JSON.parse(body) as CapturedEmail)
        } catch {
          // ignore
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"fake-1"}')
        return
      }
      res.writeHead(404).end()
    })
  })
  return { server, emails, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

function tokenFrom(text: string, param: 'verify' | 'reset'): string | undefined {
  const match = text.match(new RegExp(`[?&]${param}=([A-Za-z0-9_-]+)`))
  return match?.[1]
}

describe('email flows (Resend)', () => {
  let resend: ReturnType<typeof fakeResend>
  let server: RunningServer
  let dataDir: string

  beforeAll(async () => {
    resend = fakeResend()
    await new Promise<void>((resolve) => resend.server.listen(0, '127.0.0.1', resolve))
    dataDir = await mkdtemp(path.join(tmpdir(), 'cp-email-'))
    server = await startServer({
      port: 0,
      dataDir,
      allowRegistration: true,
      requireEmailVerification: true,
      resendApiKey: 'test-key',
      resendBaseUrl: resend.url(),
      appUrl: 'http://app.test',
      adminEmail: 'admin@email.test',
      adminPassword: 'adminpass123',
      adminAlertEmail: 'ops@email.test',
    })
  }, 60_000)

  afterAll(async () => {
    await server.close()
    await new Promise<void>((resolve) => resend.server.close(() => resolve()))
    await rm(dataDir, { recursive: true, force: true })
  })

  it('sends a verification email and gates jobs until verified', async () => {
    const register = await fetch(`${server.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mail-user@email.test', password: 'mailpass123' }),
    })
    expect(register.status).toBe(201)
    const body = (await register.json()) as { verificationSent: boolean; user: { emailVerified: boolean } }
    expect(body.verificationSent).toBe(true)
    expect(body.user.emailVerified).toBe(false)
    const cookie = (register.headers.get('set-cookie') ?? '').split(';')[0]

    expect(resend.emails).toHaveLength(1)
    const mail = resend.emails[0]
    expect(mail.to).toEqual(['mail-user@email.test'])
    expect(mail.subject).toContain('邮箱验证')
    expect(mail.from).toContain('Kloon')

    // job routes are blocked until the address is verified
    const blocked = await fetch(`${server.url}/api/tasks`, { headers: { cookie } })
    expect(blocked.status).toBe(403)
    expect(((await blocked.json()) as { code: string }).code).toBe('email_unverified')

    const token = tokenFrom(mail.text, 'verify')
    expect(token, 'verification token in email').toBeTruthy()
    const badToken = await fetch(`${server.url}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token' }),
    })
    expect(badToken.status).toBe(400)

    const verify = await fetch(`${server.url}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(verify.status).toBe(200)

    // the same session can now use the API
    const allowed = await fetch(`${server.url}/api/tasks`, { headers: { cookie } })
    expect(allowed.status).toBe(200)
  }, 60_000)

  it('resets a password through email and invalidates old sessions', async () => {
    const register = await fetch(`${server.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reset-user@email.test', password: 'oldpassword123' }),
    })
    const cookie = (register.headers.get('set-cookie') ?? '').split(';')[0]

    const forgot = await fetch(`${server.url}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reset-user@email.test' }),
    })
    expect(forgot.status).toBe(200)

    const mail = resend.emails.find((m) => m.to[0] === 'reset-user@email.test' && m.subject.includes('密码重置'))
    expect(mail).toBeTruthy()
    const token = tokenFrom(mail!.text, 'reset')!
    expect(token).toBeTruthy()

    const reset = await fetch(`${server.url}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'newpassword123' }),
    })
    expect(reset.status).toBe(200)

    // old session is gone, old password rejected, new password works
    expect((await fetch(`${server.url}/api/tasks`, { headers: { cookie } })).status).toBe(401)
    const oldLogin = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reset-user@email.test', password: 'oldpassword123' }),
    })
    expect(oldLogin.status).toBe(401)
    const newLogin = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reset-user@email.test', password: 'newpassword123' }),
    })
    expect(newLogin.status).toBe(200)

    // a token cannot be replayed
    const replay = await fetch(`${server.url}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'anotherpass123' }),
    })
    expect(replay.status).toBe(400)
  }, 60_000)

  it('alerts the operator when a blocked domain is attempted', async () => {
    const login = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@email.test', password: 'adminpass123' }),
    })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

    const block = await fetch(`${server.url}/api/admin/blocks`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'domain', value: 'example.com' }),
    })
    expect(block.status).toBe(201)

    const attempt = await fetch(`${server.url}/api/tasks`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url', source: 'https://example.com/page' }),
    })
    expect(attempt.status).toBe(403)

    // alert delivery is async best-effort
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !resend.emails.some((m) => m.subject.includes('告警'))) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const alert = resend.emails.find((m) => m.subject.includes('告警'))
    expect(alert, 'alert email sent').toBeTruthy()
    expect(alert!.to).toEqual(['ops@email.test'])
    expect(alert!.text).toContain('example.com')
  }, 60_000)
})
