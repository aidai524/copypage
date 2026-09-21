import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type VlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface VlmMessage {
  role: 'user' | 'system' | 'assistant'
  content: string | VlmContentPart[]
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} not set — put it in .env (see .env.example)`)
  return v
}

/** Attach a local image file as a base64 data-url content part. */
export async function imagePart(file: string): Promise<VlmContentPart> {
  const buf = await readFile(file)
  const ext = path.extname(file).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }
}

/**
 * Call the VLM (gpt-4o via apimart, OpenAI-compatible chat completions).
 * apimart answers with SSE even without stream:true — handle both.
 */
export async function vlmChat(messages: VlmMessage[], opts: { maxTokens?: number } = {}): Promise<string> {
  const base = process.env.APIMART_BASE_URL ?? 'https://api.apimart.ai/v1'
  const model = process.env.VLM_MODEL ?? 'gpt-4o'
  const key = env('APIMART_API_KEY')

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
    }),
  })

  if (!res.ok) {
    throw new Error(`vlm request failed: http ${res.status} ${(await res.text()).slice(0, 300)}`)
  }

  const ctype = res.headers.get('content-type') ?? ''
  const raw = await res.text()

  if (ctype.includes('text/event-stream') || raw.startsWith('data:')) {
    // SSE accumulation
    let out = ''
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') break
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
        out += chunk.choices?.[0]?.delta?.content ?? ''
      } catch {
        // partial json line — ignore
      }
    }
    return out
  }

  const json = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] }
  return json.choices?.[0]?.message?.content ?? ''
}
