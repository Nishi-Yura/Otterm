import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Tauri loads the dev server at a fixed port (crates/otterm-app/tauri.conf.json).
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
