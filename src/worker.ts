import cron from "node-cron";
import { config } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { db } from "./db/client.js";
import { processFollowUps } from "./cron/followUp.js";
import { sendDailySummary } from "./cron/dailySummary.js";
import { runCleanup } from "./cron/cleanup.js";
import { createCallDoc, appendTranscriptToDoc } from "./services/googleDocs.js";
import { sendEmail } from "./services/gmail.js";
import { sendSms } from "./services/twilio.js";
import { nextRetryAt } from "./services/notifications.js";

const RETRY_POLL_MS = 30_000;

async function processFailedJobs(): Promise<void> {
  const jobs = await db.failedJob.findMany({
    where: {
      next_retry_at: { lt: new Date() },
      attempts: { lt: 5 },
      completed_at: null,
    },
    orderBy: { next_retry_at: "asc" },
    take: 20,
  });

  for (const job of jobs) {
    const payload = job.payload as Record<string, unknown>;
    logger.info({ job_id: job.id, type: job.type, attempt: job.attempts + 1 }, "retrying failed job");

    try {
      switch (job.type) {
        case "google_doc_create": {
          const docUrl = await createCallDoc({
            parentName: String(payload["parent_name"] ?? ""),
            parentEmail: String(payload["parent_email"] ?? ""),
            parentPhone: String(payload["parent_phone"] ?? ""),
            childName: String(payload["child_name"] ?? ""),
            childGrade: String(payload["child_grade"] ?? ""),
            summaryOfNeed: String(payload["summary_of_need"] ?? ""),
            urgencyLevel: String(payload["urgency_level"] ?? ""),
            callDate: new Date(),
          });
          await db.call.update({
            where: { id: String(payload["call_id"]) },
            data: { doc_url: docUrl, doc_creation_failed: false },
          });
          break;
        }

        case "google_doc_append":
          await appendTranscriptToDoc(
            String(payload["doc_url"]),
            String(payload["transcript"]),
          );
          break;

        case "email_send":
          await sendEmail({
            to: String(payload["to"]),
            subject: String(payload["subject"]),
            templateName: String(payload["templateName"]),
            vars: (payload["vars"] as Record<string, string>) ?? {},
          });
          break;

        case "sms_send":
          await sendSms({
            to: String(payload["to"]),
            templateName: String(payload["templateName"]),
            vars: (payload["vars"] as Record<string, string>) ?? {},
            callId: payload["callId"] ? String(payload["callId"]) : undefined,
          });
          break;

        default:
          logger.warn({ type: job.type }, "unknown failed job type");
      }

      await db.failedJob.update({
        where: { id: job.id },
        data: { completed_at: new Date(), attempts: job.attempts + 1 },
      });
      logger.info({ job_id: job.id, type: job.type }, "failed job completed");
    } catch (err) {
      const newAttempts = job.attempts + 1;
      const lastError = String(err).slice(0, 500);

      if (newAttempts >= 5) {
        logger.error({ job_id: job.id, type: job.type, err }, "failed job exhausted retries");
        await db.failedJob.update({
          where: { id: job.id },
          data: { attempts: newAttempts, last_error: lastError, next_retry_at: nextRetryAt(newAttempts) },
        });
      } else {
        await db.failedJob.update({
          where: { id: job.id },
          data: { attempts: newAttempts, last_error: lastError, next_retry_at: nextRetryAt(newAttempts) },
        });
        logger.warn({ job_id: job.id, type: job.type, nextAttempt: newAttempts, err }, "failed job will retry");
      }
    }
  }
}

async function startWorker() {
  await db.$connect();
  logger.info("worker started");

  // Every 15 minutes: follow-up processor
  cron.schedule("*/15 * * * *", async () => {
    logger.info("cron: follow-up processor");
    await processFollowUps().catch((err) => logger.error({ err }, "follow-up processor error"));
  });

  // Daily at 7am America/Los_Angeles
  cron.schedule(
    "0 7 * * *",
    async () => {
      logger.info("cron: daily summary");
      await sendDailySummary().catch((err) => logger.error({ err }, "daily summary error"));
    },
    { timezone: "America/Los_Angeles" },
  );

  // Daily at 3am: cleanup
  cron.schedule(
    "0 3 * * *",
    async () => {
      logger.info("cron: cleanup");
      await runCleanup().catch((err) => logger.error({ err }, "cleanup error"));
    },
    { timezone: "America/Los_Angeles" },
  );

  // Failed job retry loop — every 30 seconds
  const retryLoop = async () => {
    await processFailedJobs().catch((err) => logger.error({ err }, "failed job processor error"));
    setTimeout(retryLoop, RETRY_POLL_MS);
  };
  setTimeout(retryLoop, RETRY_POLL_MS);
}

startWorker().catch((err) => {
  logger.error(err, "failed to start worker");
  process.exit(1);
});
