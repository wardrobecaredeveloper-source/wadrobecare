import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    // Switched from response-store (which required an R2 bucket) to
    // workers-cache — uses the built-in Workers Cache API, needs no R2
    // bucket, no Durable Objects, no auxiliary Worker. Trade-off: the
    // Response Store has better cache invalidation semantics via
    // revalidateTag; workers-cache is simpler and works without setup.
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
  // `cloudflare:workers` is a runtime module exposed by the Workers runtime.
  // The bundler cannot resolve it statically — mark it as external so the
  // import is preserved as-is and resolved at runtime inside the Worker.
  build: {
    rolldownOptions: {
      external: ["cloudflare:workers"],
    },
  },
  ssr: {
    external: ["cloudflare:workers"],
  },
});
