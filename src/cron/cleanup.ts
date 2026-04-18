import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";

export async function runCleanup(): Promise<void> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [expiredSessions, expiredTokens, oldAttempts, oldJobs] = await Promise.all([
    db.session.deleteMany({ where: { expires_at: { lt: now } } }),
    db.passwordResetToken.deleteMany({ where: { expires_at: { lt: now } } }),
    db.loginAttempt.deleteMany({ where: { created_at: { lt: thirtyDaysAgo } } }),
    db.failedJob.deleteMany({
      where: { completed_at: { lt: sevenDaysAgo }, NOT: { completed_at: null } },
    }),
  ]);

  logger.info(
    {
      expired_sessions: expiredSessions.count,
      expired_tokens: expiredTokens.count,
      old_login_attempts: oldAttempts.count,
      old_failed_jobs: oldJobs.count,
    },
    "cleanup complete",
  );
}
