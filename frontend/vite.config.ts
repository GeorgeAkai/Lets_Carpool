import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite's dev dependency optimizer pre-bundles maplibre-gl into
  // node_modules/.vite/deps/ but doesn't carry its worker file along, so the
  // worker 404s and no vector tiles ever get parsed (the map paints blank —
  // markers still show since those are plain DOM overlays, not tile-derived).
  // Excluding it serves the package straight from node_modules, where the
  // worker's relative path actually resolves.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["logo.svg", "icons/favicon-16x16.png", "icons/favicon-32x32.png"],
      // maplibre-gl (replacing Leaflet for the vector-tile map) pushes the main
      // bundle past workbox's 2 MiB default precache limit.
      workbox: { maximumFileSizeToCacheInBytes: 5 * 1024 * 1024 },
      manifest: {
        name: "Let's Carpool",
        short_name: "Carpool",
        description: "Connect with drivers and riders near you. Split gas costs and travel smarter.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f2f4fd",
        theme_color: "#2848c8",
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
