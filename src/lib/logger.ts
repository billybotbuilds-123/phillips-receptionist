import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
  redact: {
    paths: [
      "parent_email",
      "parent_phone",
      "raw_transcript",
      "value",
      "password",
      "token",
      "secret",
      "auth_token",
      "api_key",
    ],
    censor: "[REDACTED]",
  },
});

export type Logger = typeof logger;
