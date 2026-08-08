import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy in dev so the browser sees one origin and SSE needs no CORS dance.
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
