import { PrismaClient } from '@prisma/client'

/**
 * Wardrobecare Prisma client — runtime-aware.
 *
 *  - Local dev / Vercel: uses Prisma's built-in postgres driver over raw TCP.
 *  - Cloudflare Workers: uses @prisma/adapter-pg + pg + Hyperdrive binding.
 *
 * WORKERS STRATEGY — FRESH CLIENT PER REQUEST, PROPER CLEANUP:
 *   Cloudflare Hyperdrive docs are explicit:
 *     "The client belongs inside the handler. Hyperdrive maintains the
 *     reusable origin pool."
 *     — https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/prisma-postgres
 *
 *   And the GitHub issue prisma/prisma#28193 confirms:
 *     "Worker hangs and times out when trying to reuse a Prisma client
 *     instance across requests."
 *
 *   The reason: Hyperdrive's `env.HYPERDRIVE.connectionString` is per-request
 *   with a short-lived token. Caching a pg.Pool built from one request's
 *   token causes subsequent requests (which get a fresh token) to fail
 *   with "timeout exceeded when trying to connect".
 *
 *   Per Cloudflare docs, the correct pattern is to create a NEW pg.Client
 *   (or Pool) per request, and explicitly close it after the response.
 *   Hyperdrive pools the real TCP connections at the edge, so creating
 *   a new client is cheap.
 *
 *   We use a path-capturing Proxy to preserve the call surface
 *   (`await db.user.findUnique(...)` etc.) while building a fresh
 *   client per query and closing the pool after each call.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
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
 * Build a fresh PrismaClient on Workers using the current Hyperdrive
 * connection string. Returns the client AND its pool, so the caller
 * can close the pool after the request completes.
 */
async function buildWorkersPrismaClient(): Promise<{
  client: PrismaClient
  pool: any
}> {
  let connectionString: string | undefined
  try {
    const cfModule: any = await import('cloudflare:workers')
    connectionString = cfModule?.env?.HYPERDRIVE?.connectionString
  } catch (e: any) {
    console.error('[db] cloudflare:workers import failed:', e?.message)
  }
  if (!connectionString) {
    connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error(
        'No Hyperdrive binding and no DATABASE_URL secret set on the Worker.',
      )
    }
  }
  const pgMod: typeof import('pg') = await import('pg')
  const adapterMod: typeof import('@prisma/adapter-pg') =
    await import('@prisma/adapter-pg')
  const pool = new pgMod.Pool({
    connectionString,
    max: 1,                          // single conn — Hyperdrive pools real TCP
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  })
  const adapter = new adapterMod.PrismaPg(pool)
  const client = new PrismaClient({ adapter, log: ['error'] })
  return { client, pool }
}

let db: PrismaClient

if (isCloudflareWorkers()) {
  console.log('[db] Cloudflare Workers runtime — per-request PrismaClient with explicit pool cleanup')
  // Path-capturing Proxy. Each call to the final method:
  //   1. Builds a fresh client + pool using the current connection string
  //   2. Walks the captured path
  //   3. Calls the final method
  //   4. Closes the pool (releases the Hyperdrive connection back to the edge pool)
  //   5. Returns the result
  //
  // Call surface unchanged: `await db.user.findUnique(...)` works.
  function makePathProxy(path: PropertyKey[]): any {
    const target: any = (...args: any[]) =>
      buildWorkersPrismaClient().then(({ client, pool }) => {
        let cur: any = client
        for (const p of path) {
          cur = cur[p]
          if (cur === undefined) {
            return pool.end().then(() => {
              throw new Error(
                `Property '${String(p)}' not found on PrismaClient path: ${path.map(String).join('.')}`,
              )
            })
          }
        }
        if (typeof cur !== 'function') {
          return pool.end().then(() => {
            throw new Error(
              `Path ${path.map(String).join('.')} is not callable on PrismaClient`,
            )
          })
        }
        // Call the final method, then close the pool, then return the result.
        // Use Promise.resolve to flatten if cur(...) returns a Promise.
        return Promise.resolve(cur(...args)).finally(() => pool.end())
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
