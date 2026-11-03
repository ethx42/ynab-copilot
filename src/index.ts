// Composition root (run via `tsx src/index.ts`): the only place that wires adapters to the
// pure core. Exit code 1 means "a human must look" — GitHub then emails the failed run.
//
// This repo is PUBLIC and so are its Actions logs: print only counts, ids and reason codes —
// never merchants, amounts, card digits or email excerpts.
import { buildContext } from "./composition.js";
import { formatIngestEnvIssues, IngestEnvSchema } from "./config/ingest-env.js";
import { runIngest } from "./core/ingest/run-ingest.js";
import { finishRun } from "./core/reporting/finish-run.js";

const HOUR_MS = 3_600_000;

const main = async (): Promise<number> => {
  const issues = formatIngestEnvIssues(process.env);
  if (issues !== null) {
    console.error("Invalid environment:\n" + issues.map((i) => `  - ${i}`).join("\n"));
    return 1;
  }
  const env = IngestEnvSchema.parse(process.env);
  const context = buildContext(env);

  const since = new Date(Date.now() - env.LOOKBACK_HOURS * HOUR_MS).toISOString();
  let report;
  try {
    report = await runIngest(
      {
        mail: context.mail,
        ynab: context.ynab,
        registry: env.ACCOUNT_REGISTRY_JSON,
        rules: env.CATEGORY_RULES_JSON,
      },
      since,
    );
  } catch (error) {
    // Error name/message only: never the request, headers or env.
    console.error(`ingest failed: ${error instanceof Error ? error.message : "unknown error"}`);
    // The run itself broke (Gmail or YNAB unreachable, bad token): tell the dead-man's switch
    // right away instead of letting it discover the silence hours later.
    try {
      await context.ops.heartbeat?.ping("fail", "run crashed before finishing");
    } catch {
      // Already failing; the non-zero exit below is the loud part.
    }
    return 1;
  }

  console.log(
    `ingest: ${String(report.emailsSeen)} emails, ${String(report.transactionsParsed)} transactions, ` +
      `${String(report.created)} created, ${String(report.duplicates)} already in YNAB`,
  );
  return finishRun(report, context.ops, env.LOOKBACK_HOURS);
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`ingest failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  },
);
