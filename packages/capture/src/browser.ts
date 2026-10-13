/**
 * Extra Chromium flags from the environment, e.g. `--no-sandbox` inside
 * containers (Chromium refuses to start as root with its sandbox enabled).
 * `COPYPAGE_CHROMIUM_ARGS="--no-sandbox --disable-dev-shm-usage"`
 */
export function chromiumArgs(): string[] {
  const raw = process.env.COPYPAGE_CHROMIUM_ARGS
  if (!raw) return []
  return raw
    .split(/\s+/)
    .map((a) => a.trim())
    .filter(Boolean)
}
