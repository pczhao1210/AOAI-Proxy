import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(process.cwd(), "admin-ui"),
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  base: "/admin/",
  build: {
    outDir: path.resolve(process.cwd(), "public/admin-app"),
    emptyOutDir: true
  }
});
