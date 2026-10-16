import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The QR and ABI modules are shared with the backend (../src); use this package's copies of deps.
  resolve: { dedupe: ["viem", "zod"] },
  server: { port: 5173, fs: { allow: [".."] } },
  preview: { port: 4173 },
});
