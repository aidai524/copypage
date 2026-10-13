import { randomUUID } from 'node:crypto'
import type { Db } from './db.js'

/**
 * Abuse / quota warnings. Deduplicated per user+kind so a struggling tenant
 * produces one clear signal instead of a storm, and surfaced to the operator
 * through the audit log, the admin console and (optionally) email.
 */

export type WarningKind =
  | 'quota'
  | 'blocked_domain'
  | 'repeated_failures'
  | 'manual'
  | 'account_suspended'

export interface WarnResult {
  created: boolean
  message: string
}

export function warnUser(
  db: Db,
  userId: string | null,
  kind: WarningKind,
  message: string,
  opts: { dedupeHours?: number } = {},
): WarnResult {
  const dedupeHours = opts.dedupeHours ?? 24
  if (db.recentWarning(userId, kind, dedupeHours)) return { created: false, message }
  db.createWarning({
    id: randomUUID(),
    user_id: userId,
    kind,
    message,
    acknowledged: 0,
    created_at: new Date().toISOString(),
  })
  db.audit(userId, `warning.${kind}`, { message })
  return { created: true, message }
}

/** warn once when a tenant crosses 80% of a quota */
export function maybeQuotaWarning(
  db: Db,
  userId: string,
  kind: string,
  used: number,
  limit: number,
  label: string,
): WarnResult {
  if (limit <= 0 || used / limit < 0.8) return { created: false, message: '' }
  return warnUser(
    db,
    userId,
    'quota',
    `${label}已用 ${used}/${limit},接近上限;超出后新任务会被拒绝`,
    { dedupeHours: 24 },
  )
}
