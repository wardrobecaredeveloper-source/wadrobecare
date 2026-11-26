import { PrismaClient } from '@prisma/client'

/**
 * Wardrobecare Prisma client — runtime-aware AND per-request on Workers.
 *
 * PER-REQUEST PATTERN ON WORKERS (critical):
 *   Cloudflare Hyperdrive docs: "The client belongs inside the handler.
 *   Hyperdrive maintains the reusable origin pool."
 *
 *   Hyperdrive's `env.HYPERDRIVE.connectionString` is a per-request value
 *   containing a short-lived token. Caching a pg.Pool built from the FIRST
 *   request's connection string causes all subsequent requests to time
 *   out with "timeout exceeded when trying to connect".
 *
 *   So on Workers we create a NEW PrismaClient on every query, using the
 *   LATEST `env.HYPERDRIVE.connectionString`. Hyperdrive pools the
 *   underlying TCP connections at the edge, so each new client is cheap.
 *
 * API COMPATIBILITY:
 *   `db` is a Proxy that returns a thenable for every property access.
 *   When the caller does `await db.user.findUnique(...)`:
 *     1. `db.user` → Proxy.get('user') returns a thenable P
 *     2. `P.findUnique(...)` → P is thenable, but we need to call
 *        findUnique on the RESOLVED value. So we make P.thenable resolve
 *        to `client.user`, AND we wrap the call site so .findUnique is
 *        called after the await.
 *
 *   To make this work without changing call sites, we use a Proxy that
 *   returns a "deferred call" object. The object is thenable — when
 *   awaited, it resolves to the property on a freshly-built client.
 *   AND it has the same properties as the resolved client (because the
 *   Proxy forwards all property accesses via then()).
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
 * Build a fresh PrismaClient on Workers using the latest Hyperdrive
 * connection string. Falls back to DATABASE_URL secret if Hyperdrive
 * binding is missing.
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
  const pool = new pgMod.Pool({
    connectionString,
    max: 1,                          // single connection — Worker isolate
    idleTimeoutMillis: 5000,          // close idle after 5s
    connectionTimeoutMillis: 10000,  // 10s timeout for Hyperdrive
  })
  const adapter = new adapterMod.PrismaPg(pool)
  return new PrismaClient({ adapter, log: ['error'] })
}

/**
 * Create a "deferred" PrismaClient proxy. Each property access returns a
 * Promise that resolves to that property on a freshly-built client. The
 * Promise is "deeply thenable" — any further property accesses on it
 * also return Promises that resolve to the nested property.
 *
 * Usage pattern (unchanged from a regular PrismaClient):
 *   await db.user.findUnique({ where: { id: 'x' } })
 *   await db.order.findMany({ where: { status: 'PAID' } })
 *
 * Internally becomes:
 *   const client = await buildWorkersPrismaClient()
 *   return client.user.findUnique({ where: { id: 'x' } })
 *
 * The Proxy captures the chain of property accesses and replays them
 * on the freshly-built client when the final call is invoked.
 */
function makePerRequestPrismaClient(): PrismaClient {
  // The trick: build a fresh client for each "access chain" and return
  // a thenable that resolves to the result of the call.
  //
  // We use a recursive Proxy that captures the property access path.
  // When the caller awaits the final result, we build a client, walk
  // the path, call the final function with the args, and return the
  // result.

  // Each Proxy represents "client + accumulated path". When the caller
  // calls .findUnique(args) on it, we build a client and execute the
  // path. When they access another property, we extend the path.

  function makeProxy(path: PropertyKey[]): any {
    const target = async (...args: any[]) => {
      // The caller called us as a function — they did
      // `await db.user.findUnique(args)`. We need to build a client,
      // walk the path, call the function with args, and return the result.
      const client = await buildWorkersPrismaClient()
      let cur: any = client
      for (const p of path) {
        cur = cur[p]
        if (cur === undefined) {
          throw new Error(`Property '${String(p)}' not found on PrismaClient path`)
        }
      }
      if (typeof cur !== 'function') {
        throw new Error(`Path ${path.join('.')} is not callable on PrismaClient`)
      }
      return cur(...args)
    }
    // Make the target thenable so `await db.user.findUnique(args)` works
    // when findUnique returns a Promise.
    target.then = (onfulfilled: any, onrejected: any) =>
      Promise.resolve().then(() => target()).then(onfulfilled, onrejected)

    return new Proxy(target, {
      get(_t, prop: string | symbol) {
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') {
          // Return the target's own properties for these
          return (target as any)[prop]
        }
        // Extend the path
        return makeProxy([...path, prop])
      },
      apply(_t, _thisArg, args) {
        return target(...args)
      },
    })
  }

  return makeProxy([]) as unknown as PrismaClient
}

let db: PrismaClient

if (isCloudflareWorkers()) {
  console.log('[db] Cloudflare Workers runtime — per-request PrismaClient via path-capturing Proxy')
  db = makePerRequestPrismaClient()
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
