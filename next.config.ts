import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["dockerode"],
  // STORAGE_ROOT is resolved from an environment variable, so the tracer conservatively copies the
  // local storage directory (worlds, backups, restic passwords) into the build. Never ship it.
  outputFileTracingExcludes: { "**": ["./storage/**/*", "./panel/**/*", "./servers/**/*", "./backups/**/*", "./.env*"] },
  allowedDevOrigins: process.env.BLOCKY_DEV_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
