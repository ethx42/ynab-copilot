// Daily digest (run via `tsx src/digest.ts`): one push a day summarising the last 24 hours.
// If it stops arriving, the system itself is the problem. Read-only: it writes nothing to YNAB.
import { buildContext } from "./composition.js";
import { formatIngestEnvIssues, IngestEnvSchema } from "./config/ingest-env.js";
import { analyzeAlerts } from "./core/ingest/run-ingest.js";
import { buildDigest, factsFrom } from "./core/reporting/digest.js";
import type { KnownTicket } from "./ports/review-queue.js";

const WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;

const main = async (): Promise<number> => {
  const issues = formatIngestEnvIssues(process.env);
  if (issues !== null) {
    console.error("Invalid environment:\n" + issues.map((i) => `  - ${i}`).join("\n"));
    return 1;
  }
  const env = IngestEnvSchema.parse(process.env);
  const { mail, ynabRead, ops } = buildContext(env);
  if (ops.notifier === null) {
    console.error("digest needs NTFY_TOPIC: nothing to send it with");
    return 1;
  }

  const alerts = await mail.listAlertsSince(
    new Date(Date.now() - WINDOW_HOURS * HOUR_MS).toISOString(),
  );
  const analysis = analyzeAlerts(alerts, env.ACCOUNT_REGISTRY_JSON, env.CATEGORY_RULES_JSON);

  let known: readonly KnownTicket[] = [];
  if (ops.review !== null) {
    try {
      known = await ops.review.listKnown();
    } catch (error) {
      ops.log(
        `listing review tickets failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  let unapproved: number | null = null;
  try {
    unapproved = await ynabRead.countUnapprovedImported();
  } catch (error) {
    ops.log(
      `reading unapproved rows failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  await ops.notifier.send(
    buildDigest(factsFrom(WINDOW_HOURS, alerts, analysis, known, unapproved)),
  );
  console.log(`digest sent (${String(alerts.length)} emails in ${String(WINDOW_HOURS)}h)`);
  return 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`digest failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  },
);
