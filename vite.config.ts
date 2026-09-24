import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      fileName: () => "scripts/index.js",
      formats: ["es"],
    },
    rollupOptions: {
      external: [/^@minecraft\/.*/],
      output: {
        entryFileNames: "scripts/index.js",
        chunkFileNames: "scripts/[name].js",
      },
    },
    target: "es2022",
    minify: false,
    sourcemap: false,
  },
});
