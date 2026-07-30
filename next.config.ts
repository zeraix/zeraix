import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./src/lib/env";

/**
 * App version, baked into the renderer bundle at build time so the Settings → About section can show it
 * outside Electron too (browser / `next dev`). Inside the packaged app the authoritative number is
 * app.getVersion() via the updater bridge; this is the fallback, and the two come from the same package.json.
 */
// Read via cwd rather than import.meta.url: Next may evaluate this config as CommonJS, where import.meta is absent.
const appVersion: string = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version;

/**
 * Securely Retrieve Images in Remote Mode
 */
const getRemotePatterns = () => {
  const patterns: Array<{ protocol: "https" | "http"; hostname: string }> = [
    { protocol: "https", hostname: "pubimg.zeraix.com" },
    { protocol: "https", hostname: "pubimg.yingjianai.com" },
    { protocol: "https", hostname: "yingjian-market-files.oss-cn-hangzhou.aliyuncs.com" },
    { protocol: "https", hostname: "yingjian-user-files.oss-cn-hangzhou.aliyuncs.com" },
  ];

  if (env.NEXT_PUBLIC_IMAGE_CDN) {
    try {
      const url = new URL(env.NEXT_PUBLIC_IMAGE_CDN);
      patterns.push({
        protocol: url.protocol === "https:" ? "https" : "http",
        hostname: url.hostname,
      });
    } catch {
      console.warn("Invalid NEXT_PUBLIC_IMAGE_CDN URL");
    }
  }
  return patterns;
};

const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
  typescript: {
    ignoreBuildErrors: true, 
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: getRemotePatterns(),
    unoptimized: true,
  },
  reactStrictMode: false,
  experimental: {
    serverActions: {
      allowedOrigins: [env.API_BASE_URL, '*.oss-cn-hangzhou.aliyuncs.com'], 
    },
  },
  compress: true,
  output: "export", 
  // output:"standalone",
  distDir: "Zeraix",

  devIndicators:false, 

  /**
   * Turbopack loader rules.
   * Import `*.md` files as their raw text (default export = string), so the
   * agent system prompts can live in Markdown (see src/app/agent/chat/system/*.md)
   * instead of inline TS string constants. Applies to both `next dev` and `next build`.
   */
  turbopack: {
    rules: {
      "*.md": {
        loaders: ["raw-loader"],
        as: "*.js",
      },
    },
  },

  /**
   * The same *.md raw-text import, for webpack. `turbopack.rules` above is read ONLY by the
   * Turbopack bundler, so `next dev --webpack` has no loader for Markdown and fails with
   * "Module parse failed: Unexpected character '#'" on src/app/agent/chat/system/*.md.
   *
   * Turbopack is the default for dev and build; webpack is the escape hatch behind
   * `pnpm electron:dev:webpack` / `pnpm dev:webpack`. It exists because Turbopack's dev server
   * leaked multi-GB on Apple Silicon (vercel/next.js#92052, fixed in 16.3 by evicting the compile
   * cache to disk). Keep the two rule sets in step - a loader added to one must be added to both,
   * or the escape hatch breaks exactly when it is needed.
   */
  // nextConfig is not annotated as NextConfig, so the parameter gets no contextual type - take it
  // from Next's own signature rather than `any`, so it tracks upstream instead of drifting.
  webpack: (config: Parameters<NonNullable<NextConfig["webpack"]>>[0]) => {
    config.module.rules.push({ test: /\.md$/, use: "raw-loader" });
    return config;
  },
};

export default nextConfig;