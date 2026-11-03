import type { IngestReport } from "../ingest/run-ingest.js";
import type { HeartbeatPort } from "../../ports/heartbeat.js";
import type { NotifierPort } from "../../ports/notifier.js";
import type { ReviewQueuePort } from "../../ports/review-queue.js";
import { attentionItems, messageIdOfKey, toTicket } from "./attention.js";

// Every channel is optional: with none configured the job behaves exactly as before (any
// attention item fails the run). Channels fail SOFT here — a flaky push must not hide a run's
// result — but a failure to hand an item to a human always turns into a failed run.
export type OpsDeps = {
  readonly review: ReviewQueuePort | null;
  readonly notifier: NotifierPort | null;
  readonly heartbeat: HeartbeatPort | null;
  readonly log: (line: string) => void;
};

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const attempt = async <T>(
  ops: OpsDeps,
  label: string,
  action: () => Promise<T>,
): Promise<Attempt<T>> => {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    // Adapter errors carry a status or a short reason, never a URL, token or topic.
    ops.log(`${label} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { ok: false };
  }
};

export const summaryLine = (report: IngestReport, attentionCount: number): string =>
  `${String(report.emailsSeen)} emails, ${String(report.transactionsParsed)} transactions, ` +
  `${String(report.created)} created, ${String(report.duplicates)} already in YNAB, ` +
  `${String(attentionCount)} need attention`;

// What happens after the YNAB write: hand unresolved items to the owner (once each), close the
// tickets whose email is now handled, ping the heartbeat. Returns the process exit code.
export const finishRun = async (
  report: IngestReport,
  ops: OpsDeps,
  lookbackHours: number,
): Promise<number> => {
  const items = attentionItems(report);
  for (const item of items) ops.log(item.summary);

  // No bank alert at all across the whole window is itself suspicious (broken filter, revoked
  // token, bank format change).
  const noAlerts = report.emailsSeen === 0;
  if (noAlerts) ops.log(`no bank alerts in the last ${String(lookbackHours)}h — failing loudly`);

  let handedToHuman = items.length === 0;

  if (ops.review !== null) {
    const review = ops.review;
    const known = await attempt(ops, "listing review tickets", () => review.listKnown());
    if (known.ok) {
      const knownKeys = new Set(known.value.map((t) => t.key));

      const fresh = items.filter((item) => !knownKeys.has(item.key));
      let opened = 0;
      let openFailed = false;
      for (const item of fresh) {
        const result = await attempt(ops, "opening review ticket", () =>
          review.open(toTicket(item)),
        );
        if (result.ok) opened += 1;
        else openFailed = true;
      }
      // Every item has a ticket now (new or pre-existing, open or acknowledged-by-closing).
      handedToHuman = items.length === 0 || !openFailed;

      if (opened > 0 && ops.notifier !== null) {
        const notifier = ops.notifier;
        await attempt(ops, "sending push", () =>
          notifier.send({
            title: "YNAB: requiere tu revisión",
            message:
              `${String(opened)} movimiento(s) del banco no se pudieron registrar solos. ` +
              "Revisa los issues nuevos en GitHub.",
            priority: "high",
          }),
        );
      }

      // Resolved: the email now parses and every transaction in it was written.
      const handled = new Set(report.handledMessageIds);
      for (const ticket of known.value) {
        const messageId = messageIdOfKey(ticket.key);
        if (ticket.open && messageId !== null && handled.has(messageId)) {
          await attempt(ops, "closing review ticket", () =>
            review.close(ticket, "Resuelto: el correo ya se procesa y quedó en YNAB."),
          );
        }
      }
    } else {
      handedToHuman = items.length === 0;
    }
  }

  const healthy = !noAlerts && handedToHuman;
  if (ops.heartbeat !== null) {
    const heartbeat = ops.heartbeat;
    await attempt(ops, "heartbeat ping", () =>
      heartbeat.ping(healthy ? "ok" : "fail", summaryLine(report, items.length)),
    );
  }
  return healthy ? 0 : 1;
};
