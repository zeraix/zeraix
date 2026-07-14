import type { NextConfig } from "next";
import { env } from "./src/lib/env";

/**
 * 固定的外部图片域名列表
 * 用于 next/image 组件加载外部图片
 */
const STATIC_IMAGE_DOMAINS = ["yingjianai.chat"];

/**
 * 安全获取图片 CDN 域名
 * 如果未配置则返回空数组
 */
const getImageDomains = (): string[] => {
  const domains = [...STATIC_IMAGE_DOMAINS];

  if (env.NEXT_PUBLIC_IMAGE_CDN) {
    try {
      domains.push(new URL(env.NEXT_PUBLIC_IMAGE_CDN).hostname);
    } catch {
      console.warn("Invalid NEXT_PUBLIC_IMAGE_CDN URL");
    }
  }
  return domains;
};

/**
 * 安全获取图片远程模式
 */
const getRemotePatterns = () => {
  const patterns: Array<{ protocol: "https" | "http"; hostname: string }> = [
    // 固定添加 yingjianai.chat 域名 
    { protocol: "https", hostname: "yingjianai.chat" },
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

// Next.js 16+ 核心配置（TS版，推荐）
const nextConfig = {
  typescript: {
    // ⚠️ 核心：允许生产环境打包即使存在 TS 类型错误
    ignoreBuildErrors: true, 
  },
  eslint: {
    // ⚠️ 核心：打包时忽略 ESLint 报错
    ignoreDuringBuilds: true,
  },
  /**
   * 图片优化（Next.js 16+ Asset Routing适配）
   */
  images: {
    /**
     * 官方文档已弃用 domains 配置，推荐使用 remotePatterns 进行更细粒度的控制
     * @see https://nextjs.org/docs/app/api-reference/components/image#remotepatterns#deprecated-configuration-options
     */
    // domains: getImageDomains(),
    formats: ["image/avif", "image/webp"],
    remotePatterns: getRemotePatterns(),
    unoptimized: true,
  },
  /**
   * React 19 兼容配置
   */
  reactStrictMode: false,
  experimental: {
    serverActions: {
      allowedOrigins: [env.API_BASE_URL, '*.oss-cn-hangzhou.aliyuncs.com'], // Server Actions 跨域允许
    },
  },
  /**
   * 构建优化（Next.js 16+）
   */
  compress: true,
  output: "export", // 纯静态 HTML 导出
  // output:"standalone",
  distDir: "Zeraix",

  devIndicators:false, // 禁用开发模式下的构建指示器

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