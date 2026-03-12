const limits = new Map<string, { count: number; start: number }>()

export function checkRateLimit(ip: string | null): boolean {
  const key = ip ?? "unknown"

  const now = Date.now()
  const windowMs = 60000
  const limit = 20

  const entry = limits.get(key) || { count: 0, start: now }

  if (now - entry.start > windowMs) {
    entry.count = 0
    entry.start = now
  }

  entry.count++

  limits.set(key, entry)

  return entry.count <= limit
}