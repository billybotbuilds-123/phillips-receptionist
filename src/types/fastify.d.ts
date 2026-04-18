// Augment FastifyContextConfig to allow the skipAuth flag used on public routes.
// This is set per-route via { config: { skipAuth: true } } and read in
// the auth preHandler in src/index.ts.
import "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
}
