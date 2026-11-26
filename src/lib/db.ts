import { PrismaClient } from '@prisma/client'

/**
 * Wardrobecare Prisma client — runtime-aware.
 *
 *  - Local dev / Vercel: uses Prisma's built-in postgres driver over raw TCP.
 *  - Cloudflare Workers: uses @prisma/adapter-pg + pg + Hyperdrive binding.
 *
 * WORKERS POOL STRATEGY:
 *   Hyperdrive's `env.HYPERDRIVE.connectionString` is per-request, but
 *   the string is stable for the lifetime of a Worker isolate. We cache
 *   the PrismaClient keyed by connection string — when the string
 *   matches, we reuse the cached client (no rebuild, no reconnect).
 *   When the string changes (new isolate, or Hyperdrive rotates the
 *   token), we build a fresh client + pool with the new string.
 *
 *   This avoids two failure modes:
 *     1. Caching a single client built from the FIRST request's
 *        connection string → fails on subsequent requests with
 *        "timeout exceeded when trying to connect" when the token expires.
 *     2. Building a fresh client per query → CPU/memory exhaustion
 *        (exceededResources) on heavy pages, because each Pool leaks
 *        until idleTimeoutMillis fires.
 *
 *   Per-isolate caching matches Hyperdrive's per-isolate connection
 *   pooling model: each isolate gets ONE connection to Hyperdrive's
 *   edge pool, which itself pools real TCP connections to Neon.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __workersPrismaByConnStr?: Map<string, { client: PrismaClient; pool: any }>
}

function validateDatabaseUrl(label: string): void {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error(
      `\n[db] FATAL: DATABASE_URL is not set (${label}).\n` +
        `        Set it in your hosting platform's environment variables to your Neon Postgres pooled URL,\n` +
        `        e.g. postgresql://user:pass@host-pooler.region.aws.neon.tech/neondb?sslmode=require\n`,
    )
    return
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    const preview = url.length > 40 ? url.slice(0, 40) + '...' : url
    console.error(
      `\n[db] FATAL: DATABASE_URL is not a Postgres URL (${label}).\n` +
        `        Current value starts with: "${preview}"\n` +
        `        Prisma's datasource is configured for provider = "postgres" and requires a URL\n` +
        `        starting with postgresql:// or postgres://.\n` +
        `        The local SQLite fallback "file:./db/custom.db" is NOT valid in production.\n` +
        `        Update DATABASE_URL in your hosting platform's environment variables to your Neon\n` +
        `        Postgres pooled URL.\n`,
    )
  }
}

function isCloudflareWorkers(): boolean {
  try {
    const nav = (
      globalThis as { navigator?: { userAgent?: string } }
    ).navigator
    const ua = nav?.userAgent ?? ''
    if (ua.includes('Cloudflare-Workers')) return true
  } catch {}
  try {
    const versions = (process as { versions?: Record<string, string> }).versions
    if (!versions || Object.keys(versions).length === 0) {
      return true
    }
  } catch {
    return true
  }
  return false
}

/**
 * Get the current Hyperdrive connection string from cloudflare:workers.
 * On Workers, env.HYPERDRIVE.connectionString is exposed via the
 * `cloudflare:workers` module's `env` export. The string is per-request
 * but stable within an isolate — we cache the client keyed by it.
 */
async function getCurrentConnectionString(): Promise<string> {
  try {
    const cfModule: any = await import('cloudflare:workers')
    const cs = cfModule?.env?.HYPERDRIVE?.connectionString
    if (cs) return cs
  } catch (e: any) {
    console.error('[db] cloudflare:workers import failed:', e?.message)
  }
  // Fallback to DATABASE_URL secret
  const cs = process.env.DATABASE_URL
  if (!cs) {
    throw new Error(
      'No Hyperdrive binding and no DATABASE_URL secret set on the Worker.',
    )
  }
  return cs
}

/**
 * On Workers: get-or-build a PrismaClient keyed by connection string.
 * Reuses cached client when string matches (common case within an isolate).
 * Builds fresh when string changes (new isolate, rotated token).
 */
async function getWorkersPrismaClient(): Promise<PrismaClient> {
  const connStr = await getCurrentConnectionString()
  if (!globalForPrisma.__workersPrismaByConnStr) {
    globalForPrisma.__workersPrismaByConnStr = new Map()
  }
  const cached = globalForPrisma.__workersPrismaByConnStr.get(connStr)
  if (cached) return cached.client

  const pgMod: typeof import('pg') = await import('pg')
  const adapterMod: typeof import('@prisma/adapter-pg') =
    await import('@prisma/adapter-pg')
  const pool = new pgMod.Pool({
    connectionString: connStr,
    max: 1,                          // single conn per isolate — Hyperdrive pools real TCP at the edge
    idleTimeoutMillis: 30000,        // 30s idle (longer than typical gap between isolate invocations)
    connectionTimeoutMillis: 10000,  // 10s to connect to Hyperdrive
  })
  const adapter = new adapterMod.PrismaPg(pool)
  const client = new PrismaClient({ adapter, log: ['error'] })
  globalForPrisma.__workersPrismaByConnStr.set(connStr, { client, pool })
  return client
}

let db: PrismaClient

if (isCloudflareWorkers()) {
  console.log('[db] Cloudflare Workers runtime — per-isolate PrismaClient cached by connection string')
  // `db` is a Proxy that lazily resolves to the cached client for the
  // current connection string on every property access. This means:
  //   - First access in an isolate: builds a fresh client + pool
  //   - Subsequent accesses in same isolate (same conn str): reuse cache
  //   - After isolate restart or token rotation: builds fresh
  //
  // Call surface unchanged: `await db.user.findUnique()`,
  // `await db.order.findMany()`, etc.
  db = new Proxy({} as PrismaClient, {
    get(_target, prop, _receiver) {
      // Return a thenable that resolves to client[prop].
      // The caller does `await db.user.findUnique(...)`:
      //   1. db.user → Proxy.get('user') returns Promise P
      //   2. P.findUnique(...) → P is thenable; .findUnique is undefined
      //      on Promise.prototype. So we need a different approach.
      //
      // Instead: return a thenable that resolves to client[prop].
      // When the caller awaits it then accesses .findUnique, the await
      // resolves to client.user (an object), then .findUnique works.
      //
      // But callers don't await db.user — they do `db.user.findUnique()`
      // and await the result. So we need a "Promise whose properties
      // work after await" — i.e., return the actual client property
      // via a chained thenable.
      //
      // Trick: return a thenable whose .then callback resolves to
      // client[prop]. But we still need the caller to await BEFORE
      // accessing .findUnique. They don't.
      //
      // So instead we use the path-capturing approach: build the client
      // when the final method is called, not when properties are accessed.
      return makePathProxy([prop])
    },
  }) as PrismaClient

  function makePathProxy(path: PropertyKey[]): any {
    const target: any = (...args: any[]) => {
      // Build/retrieve cached client, walk path, call final method
      return getWorkersPrismaClient().then((client) => {
        let cur: any = client
        for (const p of path) {
          cur = cur[p]
          if (cur === undefined) {
            throw new Error(`Property '${String(p)}' not found on PrismaClient path: ${path.map(String).join('.')}`)
          }
        }
        if (typeof cur !== 'function') {
          throw new Error(`Path ${path.map(String).join('.')} is not callable on PrismaClient`)
        }
        return cur(...args)
      })
    }
    target.then = (onFulfilled: any, onRejected: any) =>
      Promise.resolve().then(() => target()).then(onFulfilled, onRejected)
    target.catch = (onRejected: any) =>
      Promise.resolve().then(() => target()).catch(onRejected)
    target.finally = (onFinally: any) =>
      Promise.resolve().then(() => target()).finally(onFinally)

    return new Proxy(target, {
      get(_t, prop: string | symbol) {
        if (typeof prop === 'symbol') return (target as any)[prop]
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return (target as any)[prop]
        }
        return makePathProxy([...path, prop])
      },
      apply(_t, _thisArg, args) {
        return target(...args)
      },
    })
  }
} else {
  console.log('[db] Node/Vercel runtime — using default Prisma postgres driver')
  validateDatabaseUrl('Node / Vercel')
  db =
    globalForPrisma.prisma ??
    new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
      datasources: process.env.DATABASE_URL
        ? { db: { url: process.env.DATABASE_URL } }
        : undefined,
    })
  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
}

export { db }
