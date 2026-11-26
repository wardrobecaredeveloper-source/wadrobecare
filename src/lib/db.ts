import { PrismaClient } from '@prisma/client'

/**
 * Wardrobecare Prisma client — runtime-aware.
 *
 *  - Local dev / Vercel: uses Prisma's built-in postgres driver over raw TCP.
 *  - Cloudflare Workers: uses @prisma/adapter-pg + pg + Hyperdrive binding.
 *
 * On Workers we cache a SINGLE PrismaClient at module load. The
 * connection string from env.HYPERDRIVE.connectionString is read once
 * at module load. Per the Cloudflare Hyperdrive docs, this works in
 * practice because the string is stable for the lifetime of the
 * Worker isolate. Hyperdrive pools the underlying TCP connections to
 * Neon at the edge, so the pool is fast even after idle periods.
 *
 * Pool config:
 *   - idleTimeoutMillis: 10000  (close idle conns after 10s — Workers
 *     invocations may have long gaps between them; don't hold conns open)
 *   - connectionTimeoutMillis: 5000  (fail fast if Hyperdrive unreachable)
 *   - max: 10  (Hyperdrive's edge pool already caps real DB connections)
 *
 * The cached client survives across requests in the same isolate. New
 * isolates (after Worker restart) get a fresh client with a fresh
 * connection string — handled automatically by the module-level
 * instantiation.
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

let db: PrismaClient

if (isCloudflareWorkers()) {
  // ─────────────────────────────────────────────────────────────────
  // Cloudflare Workers path
  // ─────────────────────────────────────────────────────────────────
  // Use @prisma/adapter-pg + pg + Hyperdrive. The pg.Pool is configured
  // with a short idleTimeout so connections don't go stale between
  // Worker invocations (Hyperdrive closes them after a period anyway).
  //
  // Bindings on Workers are accessed via `cloudflare:workers` `env`.
  // vite.config.ts externalizes this module so the bundler leaves the
  // import alone; the Workers runtime resolves it natively.
  console.log('[db] Cloudflare Workers runtime — using PrismaPg + Hyperdrive (cached)')
  try {
    const cfModule: any = await import('cloudflare:workers')
    const hyperdrive = cfModule?.env?.HYPERDRIVE
    if (!hyperdrive?.connectionString) {
      throw new Error(
        'HYPERDRIVE binding not found on the Worker. Check cloudflare.config.ts has HYPERDRIVE: bindings.hyperdrive({ id: "..." }).',
      )
    }
    const pgMod: typeof import('pg') = await import('pg')
    const adapterMod: typeof import('@prisma/adapter-pg') =
      await import('@prisma/adapter-pg')
    // Pool config: short idle timeout so connections don't go stale
    // between Worker invocations. Hyperdrive's edge pool handles the
    // real connection reuse; our local pool is mostly a pass-through.
    const pool = new pgMod.Pool({
      connectionString: hyperdrive.connectionString,
      max: 10,                          // small pool — Hyperdrive caps real DB conns
      idleTimeoutMillis: 10000,        // close idle conns after 10s
      connectionTimeoutMillis: 5000,   // fail fast if Hyperdrive unreachable
    })
    const adapter = new adapterMod.PrismaPg(pool)
    db = new PrismaClient({ adapter, log: ['error'] })
  } catch (e: any) {
    console.error('[db] Workers path failed:', e?.message)
    // Fallback to DATABASE_URL secret (only used if Hyperdrive missing)
    if (process.env.DATABASE_URL) {
      const pgMod: typeof import('pg') = await import('pg')
      const adapterMod: typeof import('@prisma/adapter-pg') =
        await import('@prisma/adapter-pg')
      const pool = new pgMod.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 10,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      })
      const adapter = new adapterMod.PrismaPg(pool)
      db = new PrismaClient({ adapter, log: ['error'] })
    } else {
      throw e
    }
  }
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
