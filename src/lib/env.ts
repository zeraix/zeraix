import { z } from "zod";

/**
 * Server-side environment variable validation schema.
 * Note: API_BASE_URL is chosen dynamically between the dev/prod address based on NODE_ENV.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_BASE_URL_DEV: z.string().url().default("https://api.zeraix.com/api-dev"),
  API_BASE_URL_PROD: z.string().url().default("https://api.zeraix.com/api"),
  AI_API_KEY: z.string().min(1).default("your-ai-api-key"),
});

/**
 * Client-side environment variable validation schema.
 * Variables must be prefixed with NEXT_PUBLIC_ to be accessible on the client.
 */
const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default("Zeraix"),
  NEXT_PUBLIC_IMAGE_CDN: z.string().url().optional(),
  NEXT_PUBLIC_PPR_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  NEXT_PUBLIC_YUNXIN_APPKEY: z.string().min(1).default(""),
  /** Backend API address (client-accessible, used for pure static export scenarios). */
  NEXT_PUBLIC_API_BASE_URL: z.string().url().default("https://api.zeraix.com/api-dev"),
  NEXT_PUBLIC_ICP: z.string().optional(),
});

/**
 * Raw environment variables.
 */
const rawServerEnv = {
  NODE_ENV: process.env.NODE_ENV,
  API_BASE_URL_DEV: process.env.API_BASE_URL_DEV,
  API_BASE_URL_PROD: process.env.API_BASE_URL_PROD,
  AI_API_KEY: process.env.AI_API_KEY,
};

const rawClientEnv = {
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_IMAGE_CDN: process.env.NEXT_PUBLIC_IMAGE_CDN,
  NEXT_PUBLIC_PPR_ENABLED: process.env.NEXT_PUBLIC_PPR_ENABLED,
  NEXT_PUBLIC_YUNXIN_APPKEY: process.env.NEXT_PUBLIC_YUNXIN_APPKEY,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_ICP:process.env.NEXT_PUBLIC_ICP
};

/**
 * Validate and parse the environment variables.
 */
const parsedServerEnv = serverEnvSchema.parse(rawServerEnv);
const parsedClientEnv = clientEnvSchema.parse(rawClientEnv);

/**
 * Get the corresponding API_BASE_URL for the current environment.
 */
const getApiBaseUrl = (): string => {
  return parsedServerEnv.NODE_ENV === "development"
    ? parsedServerEnv.API_BASE_URL_DEV
    : parsedServerEnv.API_BASE_URL_PROD;
};

/**
 * Unified exported environment variable object.
 * Contains all server-side and client-side environment variables.
 */
const env = {
  // Server-side environment variables
  NODE_ENV: parsedServerEnv.NODE_ENV,
  API_BASE_URL: getApiBaseUrl(),
  API_BASE_URL_DEV: parsedServerEnv.API_BASE_URL_DEV,
  API_BASE_URL_PROD: parsedServerEnv.API_BASE_URL_PROD,
  AI_API_KEY: parsedServerEnv.AI_API_KEY,
  // Client-side environment variables
  NEXT_PUBLIC_APP_NAME: parsedClientEnv.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_IMAGE_CDN: parsedClientEnv.NEXT_PUBLIC_IMAGE_CDN,
  NEXT_PUBLIC_PPR_ENABLED: parsedClientEnv.NEXT_PUBLIC_PPR_ENABLED,
  NEXT_PUBLIC_YUNXIN_APPKEY: parsedClientEnv.NEXT_PUBLIC_YUNXIN_APPKEY,
  NEXT_PUBLIC_API_BASE_URL: parsedClientEnv.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_ICP:parsedClientEnv.NEXT_PUBLIC_ICP
};

/**
 * Server-only environment variable export.
 * Used for scenarios that need to import it separately on the server.
 */
export const serverEnv = {
  NODE_ENV: parsedServerEnv.NODE_ENV,
  API_BASE_URL: getApiBaseUrl(),
  API_BASE_URL_DEV: parsedServerEnv.API_BASE_URL_DEV,
  API_BASE_URL_PROD: parsedServerEnv.API_BASE_URL_PROD,
  AI_API_KEY: parsedServerEnv.AI_API_KEY,
};

/**
 * Client-only environment variable export.
 * Used for scenarios that need to import it separately on the client.
 */
export const clientEnv = {
  NEXT_PUBLIC_APP_NAME: parsedClientEnv.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_IMAGE_CDN: parsedClientEnv.NEXT_PUBLIC_IMAGE_CDN,
  NEXT_PUBLIC_PPR_ENABLED: parsedClientEnv.NEXT_PUBLIC_PPR_ENABLED,
  NEXT_PUBLIC_YUNXIN_APPKEY: parsedClientEnv.NEXT_PUBLIC_YUNXIN_APPKEY,
  NEXT_PUBLIC_API_BASE_URL: parsedClientEnv.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_ICP:parsedClientEnv.NEXT_PUBLIC_ICP
};

export { env };
