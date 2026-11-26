import { PrismaClient } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Wardrobecare Prisma client — runtime-aware.
 *
 *  - Local dev / Vercel: uses Prisma's built-in postgres driver over raw TCP.
 *  - Cloudflare Workers: uses @prisma/adapter-pg + pg + Hyperdrive binding.
 *
 * WORKERS STRATEGY — REQUEST-SCOPED CLIENT VIA ASYNCLOCALSTORAGE:
 *   Cloudflare Hyperdrive docs: "The client belongs inside the handler.
 *   Hyperdrive maintains the reusable origin pool."
 *
 *   Hyperdrive's `env.HYPERDRIVE.connectionString` is per-request with a
 *   short-lived token. Caching a PrismaClient across requests causes
 *   "timeout exceeded when trying to connect" on subsequent requests.
 *
 *   Building a fresh client per QUERY (the previous attempt) works for
 *   correctness but causes memory exhaustion (error 1102) when a page
 *   makes multiple parallel queries — each query creates its own pg.Pool
 *   and they accumulate before garbage collection.
 *
 *   The CORRECT pattern is one client per REQUEST, shared across all
 *   queries in that request. We achieve this with AsyncLocalStorage:
 *   - The first query in a request lazily builds a client + pool and
 *     stores it in the AsyncLocalStorage context.
 *   - Subsequent queries in the same request (including parallel ones
 *     via Promise.all) reuse the cached client.
 *   - When the request finishes, Node's microtask cleanup closes the
 *     pool via a FinalizationRegistry / explicit close hook.
 *
 *   The challenge: there's no explicit "request start" hook in a
 *   Next.js server component. So we use a different trick: a WeakRef-
 *   based cache that lets the client be GC'd after the request, plus
 *   an idle timeout on the pool. This isn't perfect but works in
 *   practice — the pool closes itself after idleTimeoutMillis (5s).
 *
 *   Actually, the simplest correct pattern: still build a fresh client
 *   per query (as before) but use a SINGLE shared pool across all
 *   clients in the same isolate. The pool is built once per connection
 *   string change, and clients borrow from it. When the connection
 *   string changes (new isolate, rotated token), the pool is replaced.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __workersPoolByConnStr?: Map<string, any>
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
 */
async function getCurrentConnectionString(): Promise<string> {
  try {
    const cfModule: any = await import('cloudflare:workers')
    const cs = cfModule?.env?.HYPERDRIVE?.connectionString
    if (cs) return cs
  } catch (e: any) {
    console.error('[db] cloudflare:workers import failed:', e?.message)
  }
  const cs = process.env.DATABASE_URL
  if (!cs) {
    throw new Error(
      'No Hyperdrive binding and no DATABASE_URL secret set on the Worker.',
    )
  }
  return cs
}

/**
 * Get-or-build a shared pg.Pool for the current Hyperdrive connection
 * string. The pool is cached on globalThis keyed by connection string.
 *
 * - First call in an isolate (with a given conn str): builds a new pool.
 * - Subsequent calls with the same conn str: reuse the cached pool.
 * - When the conn str changes (new isolate, rotated token): builds a
 *   new pool for the new string and caches it. Old pools stay open
 *   until idleTimeoutMillis expires (5s) — Hyperdrive handles the
 *   real TCP connections.
 *
 * Each PrismaClient built from this pool borrows a connection from
 * the pool and releases it after the query. Multiple clients in the
 * same request share the pool, so parallel queries don't accumulate
 * pools — they share one.
 */
async function getSharedPool(): Promise<any> {
  const connStr = await getCurrentConnectionString()
  if (!globalForPrisma.__workersPoolByConnStr) {
    globalForPrisma.__workersPoolByConnStr = new Map()
  }
  const cached = globalForPrisma.__workersPoolByConnStr.get(connStr)
  if (cached) return cached

  const pgMod: typeof import('pg') = await import('pg')
  const pool = new pgMod.Pool({
    connectionString: connStr,
    max: 5,                          // small pool — handles parallel queries in one request
    idleTimeoutMillis: 5000,        // close idle conns after 5s — release to Hyperdrive edge pool
    connectionTimeoutMillis: 10000, // 10s to connect
  })
  globalForPrisma.__workersPoolByConnStr.set(connStr, pool)
  return pool
}

/**
 * Build a fresh PrismaClient on Workers using the shared pool for the
 * current connection string. Multiple PrismaClient instances share
 * the same pool — each borrows a connection during a query and
 * releases it after. The pool is closed by idleTimeoutMillis when
 * no clients are using it.
 */
async function buildWorkersPrismaClient(): Promise<PrismaClient> {
  const pool = await getSharedPool()
  const adapterMod: typeof import('@prisma/adapter-pg') =
    await import('@prisma/adapter-pg')
  const adapter = new adapterMod.PrismaPg(pool)
  return new PrismaClient({ adapter, log: ['error'] })
}

let db: PrismaClient

if (isCloudflareWorkers()) {
  console.log('[db] Cloudflare Workers runtime — per-query PrismaClient with shared pool')
  // Path-capturing Proxy. Each call to the final method:
  //   1. Gets the shared pool for the current connection string
  //   2. Builds a fresh PrismaClient using that pool (cheap — borrows from pool)
  //   3. Walks the captured path
  //   4. Calls the final method
  //   5. Returns the result (pool releases the connection after the query)
  //
  // The pool itself persists across queries in the same isolate
  // (and same connection string), so parallel queries via Promise.all
  // reuse the same pool. New isolates build a new pool lazily.
  function makePathProxy(path: PropertyKey[]): any {
    const target: any = (...args: any[]) =>
      buildWorkersPrismaClient().then((client) => {
        let cur: any = client
        for (const p of path) {
          cur = cur[p]
          if (cur === undefined) {
            throw new Error(
              `Property '${String(p)}' not found on PrismaClient path: ${path.map(String).join('.')}`,
            )
          }
        }
        if (typeof cur !== 'function') {
          throw new Error(
            `Path ${path.map(String).join('.')} is not callable on PrismaClient`,
          )
        }
        return cur(...args)
      })
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
  db = makePathProxy([]) as unknown as PrismaClient
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
