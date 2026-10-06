import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

// Sign-in responses and the sign-in, setup, and invite/reset pages must never be kept by a browser
// or proxy cache. Next.js leaves a Cache-Control set here alone.
const noStore = [{ key: "Cache-Control", value: "no-store" }];
const noStorePaths = ["/api/auth/:path*", "/login", "/setup", "/invite/:path*"];

const nextConfig: NextConfig = {
  output: "standalone",
  // Loaded from node_modules at runtime rather than bundled: both have optional native parts.
  serverExternalPackages: ["dockerode", "ssh2"],
  // STORAGE_ROOT is resolved from an environment variable, so the tracer conservatively copies the
  // local storage directory (worlds, backups, restic passwords) into the build. Never ship it.
  outputFileTracingExcludes: { "**": ["./storage/**/*", "./panel/**/*", "./servers/**/*", "./backups/**/*", "./caddy/**/*", "./.env*"] },
  allowedDevOrigins: process.env.BLOCKY_DEV_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, ...noStorePaths.map((source) => ({ source, headers: noStore }))];
  },
};

export default nextConfig;
