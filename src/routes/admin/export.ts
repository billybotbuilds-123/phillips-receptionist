import type { FastifyInstance } from "fastify";
import archiver from "archiver";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";

function escapeCsv(value: string | null | undefined | number | Date | boolean): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCallsCsvRow(call: {
  id: string;
  vapi_call_id: string;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  parent_name: string | null;
  child_grade: string | null;
  urgency_level: string | null;
  doc_url: string | null;
  recording_url: string | null;
  booked_at: Date | null;
  escalated: boolean;
  flagged: boolean;
  raw_transcript?: string | null;
}, includeTranscripts: boolean): string {
  const cols = [
    call.id,
    call.vapi_call_id,
    call.started_at.toISOString(),
    call.ended_at?.toISOString() ?? "",
    call.duration_seconds ?? "",
    call.parent_name ?? "",
    call.child_grade ?? "",
    call.urgency_level ?? "",
    call.doc_url ?? "",
    call.recording_url ?? "",
    call.booked_at?.toISOString() ?? "",
    call.escalated ? "yes" : "no",
    call.flagged ? "yes" : "no",
    ...(includeTranscripts ? [call.raw_transcript ?? ""] : []),
  ];
  return cols.map(escapeCsv).join(",");
}

export async function adminExportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/export.zip", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const from = query["from"] ? new Date(query["from"]) : new Date(0);
    const to = query["to"] ? new Date(query["to"]) : new Date();
    const includeTranscripts = query["transcripts"] === "1";

    logger.info(
      { from: from.toISOString(), to: to.toISOString(), includeTranscripts, by: request.user?.username },
      "admin export requested",
    );

    const calls = await db.call.findMany({
      where: { started_at: { gte: from, lte: to } },
      orderBy: { started_at: "asc" },
      select: {
        id: true,
        vapi_call_id: true,
        started_at: true,
        ended_at: true,
        duration_seconds: true,
        parent_name: true,
        child_grade: true,
        urgency_level: true,
        doc_url: true,
        recording_url: true,
        booked_at: true,
        escalated: true,
        flagged: true,
        ...(includeTranscripts ? { raw_transcript: true } : {}),
      },
    });

    const messages = await db.messageLog.findMany({
      where: { sent_at: { gte: from, lte: to } },
      orderBy: { sent_at: "asc" },
    });

    const callsHeader = [
      "id",
      "vapi_call_id",
      "started_at",
      "ended_at",
      "duration_seconds",
      "parent_name",
      "child_grade",
      "urgency_level",
      "doc_url",
      "recording_url",
      "booked_at",
      "escalated",
      "flagged",
      ...(includeTranscripts ? ["raw_transcript"] : []),
    ].join(",");

    const callsCsv = [
      callsHeader,
      ...calls.map((c) => buildCallsCsvRow(c as Parameters<typeof buildCallsCsvRow>[0], includeTranscripts)),
    ].join("\n");

    const messagesHeader = "id,call_id,channel,direction,template,recipient,status,sent_at";
    const messagesCsv = [
      messagesHeader,
      ...messages.map((m) =>
        [m.id, m.call_id, m.channel, m.direction, m.template, m.recipient, m.status, m.sent_at.toISOString()]
          .map(escapeCsv)
          .join(","),
      ),
    ].join("\n");

    reply.raw.setHeader("Content-Type", "application/zip");
    reply.raw.setHeader(
      "Content-Disposition",
      `attachment; filename="export-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.zip"`,
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(reply.raw);
    archive.append(callsCsv, { name: "calls.csv" });
    archive.append(messagesCsv, { name: "messages.csv" });
    await archive.finalize();
  });
}
