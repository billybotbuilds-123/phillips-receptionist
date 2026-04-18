import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    env: {
      SETTINGS_MASTER_KEY: "a".repeat(64),
      SESSION_SECRET: "b".repeat(64),
      DATABASE_URL: "postgresql://localhost/test",
      NODE_ENV: "test",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: "$2b$12$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.x",
      PUBLIC_URL: "http://localhost:3000",
    },
  },
});
