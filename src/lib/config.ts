import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  SETTINGS_MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/, "must be 32-byte hex"),
  SESSION_SECRET: z.string().regex(/^[0-9a-f]{64}$/),
  ADMIN_USERNAME: z.string().min(3),
  ADMIN_PASSWORD_HASH: z.string().startsWith("$2b$12$"),
  PUBLIC_URL: z.string().url(),
  SENTRY_DSN: z.string().url().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

export const config = envSchema.parse(process.env);

export type Config = z.infer<typeof envSchema>;
