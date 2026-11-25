import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { responseStoreServiceBinding } from "./cloudflare.config";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";

export default defineConfig({
  plugins: [
    vinext({
      cache: responseStoreAdapter(),
    }),
    cloudflare({
      auxiliaryWorkers: [{ config: responseStoreServiceBinding }],
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
