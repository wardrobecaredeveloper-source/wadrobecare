import { PrismaClient } from '@prisma/client'

/**
 * Wardrobecare Prisma client — runtime-aware AND per-request on Workers.
 *
 * PER-REQUEST PATTERN ON WORKERS (critical):
 *   Cloudflare Hyperdrive docs: "The client belongs inside the handler.
 *   Hyperdrive maintains the reusable origin pool."
 *   (https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/prisma-postgres)
 *
 *   Hyperdrive's `env.HYPERDRIVE.connectionString` is a per-request value
 *   — each request gets a fresh string from the binding. The connection
 *   string embeds a short-lived token. If we cache a `pg.Pool` built from
 *   the FIRST request's connection string, subsequent requests use a
 *   stale/expired token and fail.
 *
 *   So on Workers we create a NEW PrismaClient on every query, using
 *   the LATEST `env.HYPERDRIVE.connectionString`. Hyperdrive pools the
 *   underlying TCP connections at the edge, so each new client is cheap
 *   (no new TCP handshake to Neon).
 *
 * API COMPATIBILITY:
 *   The exported `db` keeps the same call surface — `db.user.findUnique()`,
 *   `db.order.findMany()`, etc. — no call-site changes needed. Under the
 *   hood on Workers, `db` is a thenable Proxy. When the caller does
 *   `await db.user.findUnique(...)`, the Proxy intercepts the property
 *   access `db.user`, builds a fresh PrismaClient (which is a Promise
 *   because the import + adapter setup is async), and forwards the
 *   `.user` access onto the resolved client.
 *
 *   The Proxy pattern works because:
 *     - `db.user` returns a Promise that resolves to `client.user`
 *     - Calling `.findUnique(...)` on that Promise returns a Promise
 *       (because Promises forward property accesses onto their resolved
 *       value via `.then(x => x.user.findUnique(...))`)
 *     - `await` on the outer Promise resolves to the query result
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Validate DATABASE_URL on Node/Vercel. Prisma's own error is cryptic.
 */
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

/**
 * Detect if we're running on Cloudflare Workers.
 */
function isCloudflareWorkers(): boolean {
  try {
    const nav = (
      globalThis as { navigator?: { userAgent?: string } }
    ).navigator
    const ua = nav?.userAgent ?? ''
    if (ua.includes('Cloudflare-Workers')) return true
  } catch {
    // navigator might not exist in some environments — ignore
  }
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
 * On Workers: build a fresh PrismaClient using the LATEST Hyperdrive
 * connection string from `cloudflare:workers` `env.HYPERDRIVE`.
 *
 * Falls back to DATABASE_URL secret if the Hyperdrive binding is missing.
 */
async function buildWorkersPrismaClient(): Promise<PrismaClient> {
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
  const pool = new pgMod.Pool({ connectionString })
  const adapter = new adapterMod.PrismaPg(pool)
  return new PrismaClient({ adapter, log: ['error'] })
}

let db: PrismaClient

if (isCloudflareWorkers()) {
  // ─────────────────────────────────────────────────────────────────
  // Cloudflare Workers path — per-request PrismaClient via async Proxy.
  // ─────────────────────────────────────────────────────────────────
  // `db` is a Proxy that forwards every property access onto a Promise
  // that builds a fresh PrismaClient. Callers do `await db.user.findUnique()`
  // which becomes:
  //   1. `db.user` → Proxy.get('user') returns a "thenable" that, when awaited,
  //      resolves to `client.user`
  //   2. `(...).findUnique(...)` calls findUnique on the resolved value
  //   3. The whole expression is awaited → resolves to the query result
  //
  // This avoids the "Worker hangs when reusing Prisma client across
  // requests" issue (https://github.com/prisma/prisma/issues/28193).
  console.log('[db] Cloudflare Workers runtime — per-request PrismaClient via async Proxy')

  // Helper: build a "thenable" that resolves to the named property of a
  // freshly-built PrismaClient. The property access itself is deferred
  // until the caller awaits, so the import + adapter setup is lazy.
  const accessProp = (prop: string | symbol) =>
    new Promise((resolve, reject) => {
      buildWorkersPrismaClient()
        .then((client) => {
          const value = (client as any)[prop]
          if (value === undefined) {
            reject(new Error(`PrismaClient has no property '${String(prop)}'`))
          } else {
            resolve(value)
          }
        })
        .catch(reject)
    })

  db = new Proxy({} as PrismaClient, {
    get(_target, prop, _receiver) {
      // Forward known Promise protocol properties so the Proxy itself
      // can be awaited/inspected if needed (shouldn't be, but safe).
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        return undefined
      }
      // For any other property (e.g. `user`, `order`, `product`),
      // return a Promise that resolves to that property on a fresh client.
      return accessProp(prop)
    },
  }) as PrismaClient
} else {
  // ─────────────────────────────────────────────────────────────────
  // Node / Vercel path — original behaviour preserved.
  // ─────────────────────────────────────────────────────────────────
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
