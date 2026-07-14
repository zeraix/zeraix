import type { NextConfig } from "next";
import { env } from "./src/lib/env";

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
};

export default nextConfig;