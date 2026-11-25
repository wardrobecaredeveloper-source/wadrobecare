import { PrismaClient } from '@prisma/client'

/**
 * Wardrobecare Prisma client — runtime-aware.
 *
 *  - Local dev / Vercel: uses Prisma's built-in postgres driver over raw TCP.
 *                        This is the original behaviour; nothing changes.
 *  - Cloudflare Workers:  raw TCP is unavailable. We use the @prisma/adapter-pg
 *                        driver adapter with the `pg` package, which talks to
 *                        Neon via a Cloudflare Hyperdrive binding (TCP-over-
 *                        HTTP through Cloudflare's `nodejs_compat` socket API).
 *                        The Hyperdrive connection string is exposed at
 *                        `env.HYPERDRIVE.connectionString` and is preferred
 *                        over the raw `DATABASE_URL` secret when present.
 *
 * The exported `db` and the entire call surface (`db.user.findUnique`,
 * `db.order.findMany`, ...) stay identical — no query code changes.
 *
 * Implementation note: the `pg`, `@prisma/adapter-pg`, and
 * `cloudflare:workers` modules are loaded via a Function-constructed
 * dynamic importer. This hides the import paths from static bundlers
 * (webpack / Turbopack / rolldown), which would otherwise try to bundle
 * `pg` (a Node-only package with `net`/`tls` deps) into the browser
 * bundle when `db.ts` is reachable from any Client Component via
 * `queries.ts` / `seo.ts` / etc. The modules are still resolved
 * normally at runtime inside the Workers isolate.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Hide the dynamic import from the bundler. `new Function` is not statically
 * analyzable, so webpack/Turbopack/rolldown leave the import path alone.
 * This is the canonical escape hatch for runtime-only dynamic imports.
 */
const dynamicImport = new Function(
  'spec',
  'return import(spec)',
) as (spec: string) => Promise<any>

/**
 * Validate DATABASE_URL on Node/Vercel. Prisma's own error is cryptic and
 * points at `schema.prisma:14` which sends people hunting in the wrong place.
 * This pre-flight check logs a clear, actionable message before Prisma
 * ever sees the value.
 *
 * Accepted: `postgresql://...` and `postgres://...`
 * Rejected: anything else (notably `file:./db/custom.db` from .env.example,
 * which is the local SQLite fallback and would silently break the build
 * on Vercel if it leaked into the env var).
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

let db: PrismaClient

try {
  // `cloudflare:workers` only resolves inside the Workers runtime. On
  // Node/Vercel the dynamic import throws synchronously — caught below.
  const { env } = await dynamicImport('cloudflare:workers')
  const hyperdrive = (
    env as { HYPERDRIVE?: { connectionString?: string } }
  ).HYPERDRIVE

  if (hyperdrive?.connectionString) {
    // Workers + Hyperdrive path.
    const pgMod: typeof import('pg') = await dynamicImport('pg')
    const adapterMod: typeof import('@prisma/adapter-pg') =
      await dynamicImport('@prisma/adapter-pg')
    const pool = new pgMod.Pool({ connectionString: hyperdrive.connectionString })
    const adapter = new adapterMod.PrismaPg(pool)
    db = new PrismaClient({ adapter, log: ['error'] })
  } else {
    // Workers without Hyperdrive binding — fall back to DATABASE_URL secret.
    validateDatabaseUrl('Cloudflare Worker')
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'No Hyperdrive binding and no DATABASE_URL secret set on the Worker.',
      )
    }
    db = new PrismaClient({
      log: ['error'],
      datasources: { db: { url: process.env.DATABASE_URL } },
    })
  }
} catch {
  // Node / Vercel path — original behaviour preserved.
  // Log a clear pre-flight message so the user knows exactly what to fix
  // if the env var is missing or set to the wrong protocol.
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
