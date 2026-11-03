// Composition root (run via `tsx src/index.ts`): the only place that wires adapters to the
// pure core. Exit code 1 means "a human must look" — GitHub then emails the failed run.
//
// This repo is PUBLIC and so are its Actions logs: print only counts, ids and reason codes —
// never merchants, amounts, card digits or email excerpts.
import { createGoogleGmailApi, createGmailMailPort } from "./adapters/gmail/gmail-mail.js";
import { createYnabHttpAdapter } from "./adapters/ynab/ynab-http.js";
import { formatIngestEnvIssues, IngestEnvSchema } from "./config/ingest-env.js";
import { needsAttention, runIngest } from "./core/ingest/run-ingest.js";

const HOUR_MS = 3_600_000;

const main = async (): Promise<number> => {
  const issues = formatIngestEnvIssues(process.env);
  if (issues !== null) {
    console.error("Invalid environment:\n" + issues.map((i) => `  - ${i}`).join("\n"));
    return 1;
  }
  const env = IngestEnvSchema.parse(process.env);

  const mail = createGmailMailPort(
    createGoogleGmailApi({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
    }),
  );
  const ynab = createYnabHttpAdapter({ accessToken: env.YNAB_PAT, budgetId: env.YNAB_BUDGET_ID });

  const since = new Date(Date.now() - env.LOOKBACK_HOURS * HOUR_MS).toISOString();
  const report = await runIngest(
    { mail, ynab, registry: env.ACCOUNT_REGISTRY_JSON, rules: env.CATEGORY_RULES_JSON },
    since,
  );

  console.log(
    `ingest: ${String(report.emailsSeen)} emails, ${String(report.transactionsParsed)} transactions, ` +
      `${String(report.created)} created, ${String(report.duplicates)} already in YNAB`,
  );
  for (const item of report.needsReview) {
    // Reason, template and Gmail message id only: the import id and the transaction itself carry
    // card digits, date and amount, which must not reach these public logs.
    console.error(
      `needs review: ${item.reason} (template ${item.tx.template}, message ${item.tx.sourceMessageId})`,
    );
  }
  for (const failure of report.parseFailures) {
    console.error(`parse failure: ${failure.code} (message ${failure.messageId})`);
  }

  // Core value: a transaction is never silently lost. No bank alert at all across the whole
  // lookback window is itself suspicious (broken filter, revoked token, bank format change).
  if (report.emailsSeen === 0) {
    console.error(`no bank alerts in the last ${String(env.LOOKBACK_HOURS)}h — failing loudly`);
    return 1;
  }
  return needsAttention(report) ? 1 : 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Error name/message only: never the request, headers or env.
    console.error(`ingest failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  },
);
