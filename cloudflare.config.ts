import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "wardrobecare",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-24",
    // `nodejs_compat` is required for `pg` to talk to Hyperdrive over
    // Cloudflare's socket API. Without it, the PrismaPg driver adapter
    // throws on first query.
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      // Hyperdrive binding — pools + caches queries to Neon Postgres.
      // The Hyperdrive config id is read from the HYPERDRIVE_ID env var
      // so it can be set as a GitHub secret in CI without committing it.
      // Create the config once with:
      //   wrangler hyperdrive create wardrobecare-db \
      //     --connection-string="postgresql://…-pooler…/neondb?sslmode=require"
      // Then copy the printed `id` into HYPERDRIVE_ID (GitHub secret +
      // .env for local builds). Left empty, the worker will start but
      // every DB query will fail with a Hyperdrive-not-configured error.
      HYPERDRIVE: bindings.hyperdrive({
        id: process.env.HYPERDRIVE_ID ?? "",
      }),
    },
  }),
});
