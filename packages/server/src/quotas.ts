import type { Quota, ServerConfig } from './config.js'
import type { Db, UserRow } from './db.js'
import type { Identity } from './auth.js'

export type UsageKind = 'capture' | 'verify' | 'generate'

export interface QuotaUsage {
  tasks: number
  storageBytes: number
  today: Record<string, number>
  active: number
}

export type QuotaCheck =
  | { ok: true; quota: Quota; usage: QuotaUsage }
  | { ok: false; code: string; message: string; quota: Quota; usage: QuotaUsage }

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** plan defaults + per-user overrides (users.quota_json) */
export function resolveQuota(user: UserRow | undefined, config: ServerConfig): Quota {
  const plan = user?.plan ?? 'free'
  const base = config.plans[plan] ?? config.plans.free
  let overrides: Partial<Quota> = {}
  if (user?.quota_json) {
    try {
      overrides = JSON.parse(user.quota_json) as Partial<Quota>
    } catch {
      overrides = {}
    }
  }
  return { ...base, ...overrides }
}

/**
 * Quota for a task owner id. The legacy single-token/system identity always
 * runs unlimited — it is the operator, not a tenant.
 */
export async function resolveQuotaForOwner(db: Db, ownerId: string, config: ServerConfig): Promise<Quota> {
  if (ownerId === 'system') return config.plans.unlimited ?? config.plans.free
  return resolveQuota(await db.getUserById(ownerId), config)
}

export async function quotaUsage(db: Db, userId: string): Promise<QuotaUsage> {
  return {
    tasks: await db.countTasks(userId),
    storageBytes: await db.sumStorage(userId),
    today: await db.getUsage(userId, today()),
    active: await db.countActiveTasks(userId),
  }
}

/**
 * Enforce plan limits before a job is enqueued. Admins and the `unlimited`
 * plan bypass every check.
 */
export async function checkQuota(
  db: Db,
  identity: Identity,
  kind: UsageKind,
  config: ServerConfig,
): Promise<QuotaCheck> {
  const user = await db.getUserById(identity.userId)
  const quota = resolveQuota(user, config)
  const usage = await quotaUsage(db, identity.userId)
  if (identity.role === 'admin' || identity.plan === 'unlimited' || identity.legacy) {
    return { ok: true, quota, usage }
  }

  const fail = (code: string, message: string): QuotaCheck => ({ ok: false, code, message, quota, usage })
  const day = usage.today

  if (usage.tasks >= quota.maxTasks) {
    return fail('quota_tasks', `任务数已达上限(${quota.maxTasks}),删除旧任务或升级计划`)
  }
  if (usage.storageBytes >= quota.maxStorageBytes) {
    return fail(
      'quota_storage',
      `存储已满(${Math.round(usage.storageBytes / 1048576)}MB / ${Math.round(quota.maxStorageBytes / 1048576)}MB)`,
    )
  }
  if (usage.active >= quota.maxConcurrent) {
    return fail('quota_concurrent', `同时运行的任务已达上限(${quota.maxConcurrent}),请等待当前任务完成`)
  }
  if (kind === 'capture' && (day.capture ?? 0) >= quota.maxCapturesPerDay) {
    return fail('quota_captures_per_day', `今日捕获次数已达上限(${quota.maxCapturesPerDay})`)
  }
  if (kind === 'verify' && (day.verify ?? 0) >= quota.maxVerificationsPerDay) {
    return fail('quota_verifications_per_day', `今日验证次数已达上限(${quota.maxVerificationsPerDay})`)
  }
  if (kind === 'generate' && (day.generate ?? 0) >= quota.maxGenerationsPerDay) {
    return fail('quota_generations_per_day', `今日生成次数已达上限(${quota.maxGenerationsPerDay})`)
  }
  return { ok: true, quota, usage }
}
