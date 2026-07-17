import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'nonce-signalcraft-reader'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: http: https:",
    "font-src 'self'",
    "connect-src 'self' ws:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function securityHeaders(): Plugin {
  return {
    name: "signalcraft-security-headers",
    configureServer(server) {
      server.middlewares.use((_request, response, next) => {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
          response.setHeader(name, value);
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_request, response, next) => {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
          response.setHeader(name, value);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [securityHeaders(), tanstackStart(), react()],
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
  },
});
