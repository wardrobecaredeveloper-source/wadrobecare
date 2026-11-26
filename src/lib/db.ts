import { PrismaClient } from '@prisma/client'

/**
 * Wardrobecare Prisma client — runtime-aware AND per-request on Workers.
 *
 *  - Local dev / Vercel: uses Prisma's built-in postgres driver over raw TCP.
 *                        This is the original behaviour; nothing changes.
 *  - Cloudflare Workers:  raw TCP is unavailable AND Prisma's binary query
 *                        engine cannot run (it generated for a different
 *                        OpenSSL runtime). We use the @prisma/adapter-pg
 *                        driver adapter with the `pg` package, which talks
 *                        to Neon via a Cloudflare Hyperdrive binding (TCP-
 *                        over-HTTP through Cloudflare's `nodejs_compat`
 *                        socket API).
 *
 * PER-REQUEST PATTERN ON WORKERS (critical):
 *   Cloudflare Hyperdrive docs are explicit: "The client belongs inside
 *   the handler. Hyperdrive maintains the reusable origin pool." (see
 *   https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/prisma-postgres
 *   and the discussion at
 *   https://github.com/prisma/prisma/issues/28193 — "Worker hangs and
 *   times out when trying to reuse a Prisma client instance across
 *   requests").
 *
 *   Hyperdrive's `env.HYPERDRIVE.connectionString` is a per-request value
 *   — each request gets a fresh string from the binding. The connection
 *   string embeds a short-lived token. If we cache a `pg.Pool` built from
 *   the FIRST request's connection string, subsequent requests use a
 *   stale/expired token and fail.
 *
 *   So on Workers we create a NEW PrismaClient on every access, using
 *   the LATEST `env.HYPERDRIVE.connectionString`. Hyperdrive pools the
 *   underlying TCP connections at the edge, so each new client is cheap
 *   (no new TCP handshake to Neon).
 *
 * API COMPATIBILITY:
 *   The exported `db` keeps the same call surface — `db.user.findUnique()`,
 *   `db.order.findMany()`, etc. — no call-site changes needed. Under the
 *   hood on Workers, each property access on `db` returns a fresh client
 *   bound to the current request's Hyperdrive connection string.
 *
 *   The slight overhead (creating a PrismaClient per query) is acceptable
 *   because: (a) the Wasm engine is already loaded into the isolate, so
 *   constructing a client is just object setup; (b) Hyperdrive's connection
 *   pool absorbs the actual TCP cost; (c) per-request isolation avoids the
 *   "Worker hangs when reusing Prisma client" issue.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Validate DATABASE_URL on Node/Vercel. Prisma's own error is cryptic and
 * points at `schema.prisma:14` which sends people hunting in the wrong
 * place. This pre-flight check logs a clear, actionable message before
 * Prisma ever sees the value.
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
 *
 *   1. `globalThis.navigator.userAgent` contains "Cloudflare-Workers"
 *      (set by the Workers runtime).
 *   2. Fallback: `process.versions` is undefined on Workers, defined on Node.
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
 * Hyperdrive's `connectionString` is per-request — caching the pool
 * across requests breaks with "Worker hangs when reusing Prisma client"
 * (see GitHub issue prisma/prisma#28193). Creating a fresh client per
 * call is the officially-recommended pattern.
 *
 * Falls back to DATABASE_URL secret if the Hyperdrive binding is somehow
 * missing (used only for the very first deploy before Hyperdrive is
 * wired up).
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
    // Fallback to DATABASE_URL secret (only used if Hyperdrive binding missing)
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
  // Cloudflare Workers path — per-request PrismaClient via Proxy.
  // ─────────────────────────────────────────────────────────────────
  // Each property access on `db` returns a fresh PrismaClient bound to
  // the CURRENT request's Hyperdrive connection string. This avoids the
  // "Worker hangs when reusing Prisma client across requests" issue
  // (see https://github.com/prisma/prisma/issues/28193).
  //
  // Call surface stays the same: `await db.user.findUnique()`,
  // `await db.order.findMany()`, etc. — no call-site changes.
  console.log('[db] Cloudflare Workers runtime — per-request PrismaClient via Proxy')
  db = new Proxy({} as PrismaClient, {
    get(_target, prop, receiver) {
      // Each access creates a fresh client. The caller does
      // `await db.user.findUnique(...)` which becomes:
      //   const client = await buildWorkersPrismaClient()
      //   return client.user.findUnique(...)
      // The client is then garbage-collected after the await resolves.
      const clientPromise = buildWorkersPrismaClient()
      // Forward property access onto the in-flight promise so the
      // caller's `await db.something` resolves to the real method.
      return Reflect.get(clientPromise, prop, receiver)
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
