import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  plugins: [react()],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
