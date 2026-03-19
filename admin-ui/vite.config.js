import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(process.cwd(), "admin-ui"),
  plugins: [react()],
  base: "/admin/",
  build: {
    outDir: path.resolve(process.cwd(), "public/admin-app"),
    emptyOutDir: true
  }
});
