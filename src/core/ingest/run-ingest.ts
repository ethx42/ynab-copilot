import { EMPTY_CATEGORY_RULES, type CategoryRules } from "../categorization/category-rules.js";
import type { NormalizedTransaction } from "../domain/transaction.js";
import type { YnabTransactionDraft } from "../domain/ynab-draft.js";
import { parseBancoDeBogotaSms } from "../parsers/bancodebogota-sms.js";
import { parseBancolombia, type ParseFailure, type ParseOutcome } from "../parsers/bancolombia.js";
import { planTransactions, type PlanItem } from "../planning/plan.js";
import type { AccountRegistry } from "../resolution/account-registry.js";
import type { AlertEmail, MailPort } from "../../ports/mail.js";
import type { YnabPort } from "../../ports/ynab.js";

// The whole unattended job as one use case over ports: read alerts -> parse -> plan -> write.
// It owns the "never silently lose a transaction" contract: every email ends up counted as
// written, a duplicate, a review item, or a parse failure — and the report says which.

export type NeedsReview = Extract<PlanItem, { status: "needs_review" }>;

// The source decides the parser; an exhaustive switch makes a new source a compile error here.
const parseAlert = (alert: AlertEmail): ParseOutcome => {
  const input = { messageId: alert.messageId, text: alert.text };
  switch (alert.source) {
    case "bancolombia":
      return parseBancolombia(input);
    case "bancodebogota_sms":
      return parseBancoDeBogotaSms(input);
  }
};

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
  // Emails that parsed AND whose every transaction was written: the only ones whose review
  // tickets may be closed automatically (an email that merely aged out of the window is not
  // resolved).
  readonly handledMessageIds: readonly string[];
};

export type IngestDeps = {
  readonly mail: MailPort;
  readonly ynab: YnabPort;
  readonly registry: AccountRegistry;
  // Optional: without rules every row is written uncategorized.
  readonly rules?: CategoryRules;
};

// True when a human must look at something. A clean run (or an empty quiet day) is not loud;
// the caller decides separately what an empty business day means.
export const needsAttention = (report: IngestReport): boolean =>
  report.needsReview.length > 0 || report.parseFailures.length > 0;

export type Analysis = {
  readonly parsed: readonly NormalizedTransaction[];
  readonly drafts: readonly YnabTransactionDraft[];
  readonly needsReview: readonly NeedsReview[];
  readonly parseFailures: readonly ParseFailure[];
  readonly handledMessageIds: readonly string[];
};

// Everything the job decides, with no I/O: shared by the hourly ingest (which then writes) and
// the daily digest (which only reports).
export const analyzeAlerts = (
  alerts: readonly AlertEmail[],
  registry: AccountRegistry,
  rules: CategoryRules = EMPTY_CATEGORY_RULES,
): Analysis => {
  // Chronological order keeps the written batch (and the report) deterministic. import ids no
  // longer depend on it: they derive from the email itself.
  const ordered = [...alerts].sort(
    (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId),
  );

  const parsed: NormalizedTransaction[] = [];
  const parseFailures: ParseFailure[] = [];
  const parsedOk = new Set<string>();
  for (const alert of ordered) {
    const outcome = parseAlert(alert);
    if (outcome.ok) {
      parsed.push(...outcome.value);
      parsedOk.add(alert.messageId);
    } else parseFailures.push(outcome.error);
  }

  const plan = planTransactions(parsed, registry, rules);
  const drafts = plan.flatMap((item) => (item.status === "ready" ? [item.draft] : []));
  const needsReview = plan.flatMap((item) => (item.status === "needs_review" ? [item] : []));
  const reviewed = new Set(needsReview.map((item) => item.tx.sourceMessageId));
  const handledMessageIds = [...parsedOk].filter((id) => !reviewed.has(id));
  return { parsed, drafts, needsReview, parseFailures, handledMessageIds };
};

export const runIngest = async (deps: IngestDeps, sinceIso: string): Promise<IngestReport> => {
  const alerts = await deps.mail.listAlertsSince(sinceIso);
  const analysis = analyzeAlerts(alerts, deps.registry, deps.rules);

  // Throws on any YNAB failure: a failed write must fail the run, never look like success.
  const result = await deps.ynab.createTransactions(analysis.drafts);

  return {
    emailsSeen: alerts.length,
    transactionsParsed: analysis.parsed.length,
    created: result.createdIds.length,
    duplicates: result.duplicateImportIds.length,
    needsReview: analysis.needsReview,
    parseFailures: analysis.parseFailures,
    handledMessageIds: analysis.handledMessageIds,
  };
};
