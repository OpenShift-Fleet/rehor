import { defineConfig } from "vite";

import pkg from "./package.json" with { type: "json" };

const external = Object.keys(pkg.dependencies ?? {}).flatMap((dep) => [
  dep,
  new RegExp(`^${dep}/`),
]);

export default defineConfig({
  build: {
    // ssr keeps this a Node build: without it Vite resolves browser
    // conditions and stubs node: builtins into a bundle that throws.
    ssr: true,
    target: "node22",
    lib: {
      entry: {
        index: "src/index.ts",
        cli: "src/cli.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => entryName,
    },
    rollupOptions: { external },
  },
});
