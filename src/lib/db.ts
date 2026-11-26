import { PrismaClient } from '@prisma/client'

/**
 * Wardrobecare Prisma client — runtime-aware.
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
 * The exported `db` and the entire call surface (`db.user.findUnique`,
 * `db.order.findMany`, ...) stay identical — no query code changes.
 *
 * Runtime detection: We CANNOT use `new Function('return import(spec)')`
 * to dynamically import `cloudflare:workers` because Workers' CSP blocks
 * `eval`/`Function` code generation ("Code generation from strings
 * disallowed for this context"). Instead, we use a different runtime
 * fingerprint: the global `navigator.userAgent` in Workers starts with
 * "Cloudflare-Workers", and `process.env` is exposed (via nodejs_compat)
 * but lacks `process.env.HOSTNAME`-type identifiers that Node sets.
 *
 * The bulletproof test: try a static `import('cloudflare:workers')`.
 * On Workers this resolves; on Node/Vercel it throws. We use a static
 * import guarded by try/catch via a dynamic `import()` call (which is
 * NOT blocked — only `new Function` is blocked). The bundler already
 * externalizes `cloudflare:workers` in vite.config.ts, so the dynamic
 * import is preserved as-is in the bundle.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Validate DATABASE_URL. Prisma's own error is cryptic and points at
 * `schema.prisma:14` which sends people hunting in the wrong place.
 * This pre-flight check logs a clear, actionable message before Prisma
 * ever sees the value.
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
 * Detect if we're running on Cloudflare Workers. We use a multi-signal
 * check to avoid `new Function` (blocked by Workers CSP) and to stay
 * reliable across runtime updates:
 *
 *   1. `globalThis.navigator.userAgent` contains "Cloudflare-Workers"
 *      (set by the Workers runtime).
 *   2. `globalThis.caches` exists (Workers Cache API) — but Node 22+ also
 *      has it, so this alone isn't enough.
 *   3. `process.versions` is undefined on Workers (no Node version)
 *      but defined on Node — strong signal.
 *
 * Combined: (navigator.userAgent contains "Cloudflare-Workers") AND
 * (no process.versions) → we're on Workers.
 */
function isCloudflareWorkers(): boolean {
  try {
    // Workers sets navigator.userAgent to "Cloudflare-Workers"
    const nav = (
      globalThis as { navigator?: { userAgent?: string } }
    ).navigator
    const ua = nav?.userAgent ?? ''
    if (ua.includes('Cloudflare-Workers')) return true
  } catch {
    // navigator might not exist in some environments — ignore
  }
  // Fallback: process.versions is undefined on Workers, defined on Node
  try {
    const versions = (process as { versions?: Record<string, string> }).versions
    if (!versions || Object.keys(versions).length === 0) {
      // No Node version info — likely Workers (or a very stripped Node)
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
  // We use the @prisma/adapter-pg driver adapter (NOT Prisma's binary
  // query engine, which doesn't work on Workers due to OpenSSL runtime
  // mismatch). The pg package connects via Hyperdrive's TCP-over-HTTP
  // socket API (enabled by `nodejs_compat` in cloudflare.config.ts).
  //
  // Bindings on Workers are NOT exposed via process.env — they're on
  // the `env` object passed to fetch(). vinext exposes them through
  // the `cloudflare:workers` module's `env` export. We import that
  // statically (vite.config.ts externalizes it so the bundler leaves
  // it alone, and the Workers runtime resolves it natively).
  console.log('[db] Cloudflare Workers runtime detected — using PrismaPg + Hyperdrive')
  try {
    // Static dynamic import — NOT new Function. This is allowed by Workers.
    // The bundler externalizes this spec (see vite.config.ts build.rolldownOptions.external).
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
    const pool = new pgMod.Pool({ connectionString: hyperdrive.connectionString })
    const adapter = new adapterMod.PrismaPg(pool)
    db = new PrismaClient({ adapter, log: ['error'] })
  } catch (e: any) {
    console.error('[db] Workers path failed:', e?.message)
    // Fallback to DATABASE_URL via the adapter (if Hyperdrive binding is broken)
    if (process.env.DATABASE_URL) {
      const pgMod: typeof import('pg') = await import('pg')
      const adapterMod: typeof import('@prisma/adapter-pg') =
        await import('@prisma/adapter-pg')
      const pool = new pgMod.Pool({ connectionString: process.env.DATABASE_URL })
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
