import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["logo.svg", "icons/favicon-16x16.png", "icons/favicon-32x32.png"],
      manifest: {
        name: "Let's Carpool",
        short_name: "Carpool",
        description: "Connect with drivers and passengers near you. Split gas costs and travel smarter.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f3f6f5",
        theme_color: "#08805a",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
