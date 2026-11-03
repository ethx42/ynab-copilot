// Composition root helpers: the only place that wires adapters to the pure core. Shared by the
// hourly ingest (src/index.ts) and the daily digest (src/digest.ts).
import { createGithubReviewQueue } from "./adapters/github/github-issues.js";
import { createGoogleGmailApi, createGmailMailPort } from "./adapters/gmail/gmail-mail.js";
import { createHealthchecksHeartbeat } from "./adapters/healthchecks/healthchecks-http.js";
import { createNtfyNotifier } from "./adapters/ntfy/ntfy-http.js";
import { createYnabHttpAdapter } from "./adapters/ynab/ynab-http.js";
import { createYnabReadAdapter } from "./adapters/ynab/ynab-read.js";
import type { IngestEnv } from "./config/ingest-env.js";
import type { OpsDeps } from "./core/reporting/finish-run.js";
import type { MailPort } from "./ports/mail.js";
import type { YnabPort, YnabReadPort } from "./ports/ynab.js";

export type Context = {
  readonly mail: MailPort;
  readonly ynab: YnabPort;
  readonly ynabRead: YnabReadPort;
  readonly ops: OpsDeps;
};

export const buildContext = (env: IngestEnv): Context => ({
  mail: createGmailMailPort(
    createGoogleGmailApi({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
    }),
    env.SMS_FORWARD_FROM === undefined ? {} : { smsForwardFrom: env.SMS_FORWARD_FROM },
  ),
  ynab: createYnabHttpAdapter({ accessToken: env.YNAB_PAT, budgetId: env.YNAB_BUDGET_ID }),
  ynabRead: createYnabReadAdapter({ accessToken: env.YNAB_PAT, budgetId: env.YNAB_BUDGET_ID }),
  ops: {
    review:
      env.GITHUB_TOKEN !== undefined && env.GITHUB_REPOSITORY !== undefined
        ? createGithubReviewQueue({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY })
        : null,
    notifier:
      env.NTFY_TOPIC === undefined
        ? null
        : createNtfyNotifier({ server: env.NTFY_SERVER, topic: env.NTFY_TOPIC }),
    heartbeat:
      env.HEALTHCHECK_URL === undefined
        ? null
        : createHealthchecksHeartbeat({ pingUrl: env.HEALTHCHECK_URL }),
    // stderr, because GitHub shows it in the failure annotations.
    log: (line) => {
      console.error(line);
    },
  },
});
