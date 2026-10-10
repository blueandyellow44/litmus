import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    server: {
        // Pinned to 5180 so we never fight the panda project for 5173/5174.
        port: 5180,
        strictPort: false,
        proxy: {
            // Proxy /api requests to the litmus-server during dev so we don't
            // fight CORS or hardcode http://localhost:8787 into client code.
            "/api": {
                target: "http://localhost:8787",
                changeOrigin: true,
            },
        },
    },
});
