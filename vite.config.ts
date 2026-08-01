import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Generated compositions and frozen repair attempts are runtime data, not Studio source.
    // Watching them reloads the UI mid-stream and makes a healthy render look stalled.
    watch: {ignored: ["**/data/**", "**/out/**"]},
    proxy: {
      "/api": "http://127.0.0.1:5174",
      "/files": "http://127.0.0.1:5174",
    },
  },
  build: {outDir: "dist"},
});
