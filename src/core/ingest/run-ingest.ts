import type { NormalizedTransaction } from "../domain/transaction.js";
import { parseBancolombia, type ParseFailure } from "../parsers/bancolombia.js";
import { planTransactions, type PlanItem } from "../planning/plan.js";
import type { AccountRegistry } from "../resolution/account-registry.js";
import type { MailPort } from "../../ports/mail.js";
import type { YnabPort } from "../../ports/ynab.js";

// The whole unattended job as one use case over ports: read alerts -> parse -> plan -> write.
// It owns the "never silently lose a transaction" contract: every email ends up counted as
// written, a duplicate, a review item, or a parse failure — and the report says which.

export type NeedsReview = Extract<PlanItem, { status: "needs_review" }>;

export type IngestReport = {
  readonly emailsSeen: number;
  readonly transactionsParsed: number;
  readonly created: number;
  // Already in YNAB from an earlier run (same import_id) — the normal case on overlapping windows.
  readonly duplicates: number;
  // Parsed fine but cannot be written automatically (unknown card, card payment, ...).
  readonly needsReview: readonly NeedsReview[];
  // Emails whose wording matched no known template, or had an invalid field.
  readonly parseFailures: readonly ParseFailure[];
};

export type IngestDeps = {
  readonly mail: MailPort;
  readonly ynab: YnabPort;
  readonly registry: AccountRegistry;
};

// True when a human must look at something. A clean run (or an empty quiet day) is not loud;
// the caller decides separately what an empty business day means.
export const needsAttention = (report: IngestReport): boolean =>
  report.needsReview.length > 0 || report.parseFailures.length > 0;

export const runIngest = async (deps: IngestDeps, sinceIso: string): Promise<IngestReport> => {
  const alerts = await deps.mail.listAlertsSince(sinceIso);

  // Chronological order keeps the written batch (and the report) deterministic. import ids no
  // longer depend on it: they derive from the email itself.
  const ordered = [...alerts].sort(
    (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId),
  );

  const parsed: NormalizedTransaction[] = [];
  const parseFailures: ParseFailure[] = [];
  for (const alert of ordered) {
    const outcome = parseBancolombia({ messageId: alert.messageId, text: alert.text });
    if (outcome.ok) parsed.push(...outcome.value);
    else parseFailures.push(outcome.error);
  }

  const plan = planTransactions(parsed, deps.registry);
  const drafts = plan.flatMap((item) => (item.status === "ready" ? [item.draft] : []));
  const needsReview = plan.flatMap((item) => (item.status === "needs_review" ? [item] : []));

  // Throws on any YNAB failure: a failed write must fail the run, never look like success.
  const result = await deps.ynab.createTransactions(drafts);

  return {
    emailsSeen: alerts.length,
    transactionsParsed: parsed.length,
    created: result.createdIds.length,
    duplicates: result.duplicateImportIds.length,
    needsReview,
    parseFailures,
  };
};
