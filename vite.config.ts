import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
  // Tell Vite to use the 'workerd' export condition when resolving
  // packages in the SSR/RSC environments. Without this, Vite uses the
  // 'node' condition by default and @prisma/client resolves to its
  // index.js entry — which uses `fs.readFileSync(__dirname +
  // 'query_compiler_bg.wasm')` and fails on Cloudflare Workers.
  //
  // We use a regex alias that ONLY matches the bare `@prisma/client`
  // specifier (with a string-end anchor) — subpath imports like
  // `@prisma/client/runtime/wasm-compiler-edge.js` still resolve
  // through the package's exports map.
  //
  // The wasm.js entry uses `import('#wasm-compiler-loader')` which
  // Prisma's generated package.json routes to `wasm-worker-loader.mjs`,
  // which does `import('./query_compiler_bg.wasm')` — a native
  // WebAssembly ES module import that Workers supports natively.
  resolve: {
    conditions: ["workerd", "node", "module"],
    alias: [
      {
        // Match only the bare `@prisma/client` specifier (end of string),
        // not subpath imports like `@prisma/client/runtime/...`.
        find: /^@prisma\/client$/,
        replacement: resolve(__dirname, "node_modules/.prisma/client/wasm.js"),
      },
    ],
  },
  environments: {
    rsc: {
      resolve: {
        conditions: ["workerd", "node", "module"],
      },
    },
    ssr: {
      resolve: {
        conditions: ["workerd", "node", "module"],
      },
    },
  },
  build: {
    rolldownOptions: {
      external: ["cloudflare:workers", "cloudflare:sockets"],
    },
  },
  ssr: {
    external: ["cloudflare:workers", "cloudflare:sockets"],
  },
});
