import { z } from "zod";
import { TICKET_TITLE_PREFIX } from "../../core/reporting/attention.js";
import type { KnownTicket, ReviewQueuePort } from "../../ports/review-queue.js";

// GitHub issues as the review queue. The repo is PUBLIC, so issues carry only ids, reason codes
// and instructions (see core/reporting/attention.ts) — never transaction data.
const API_BASE = "https://api.github.com";
const LABEL = "needs-review";
const PAGE_SIZE = 100;
// 10 pages x 100 is far above any realistic backlog; hitting it is a loud failure, not a guess.
const MAX_PAGES = 10;
const TIMEOUT_MS = 15_000;

const IssuesSchema = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    // The issues endpoint also returns pull requests; they carry this field.
    pull_request: z.unknown().optional(),
  }),
);

export type GithubReviewQueueOptions = {
  readonly token: string;
  // `owner/name`
  readonly repository: string;
  readonly fetchImpl?: typeof fetch;
};

export const createGithubReviewQueue = (options: GithubReviewQueueOptions): ReviewQueuePort => {
  const doFetch = options.fetchImpl ?? fetch;
  const repoUrl = `${API_BASE}/repos/${options.repository}`;

  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await doFetch(`${repoUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`GitHub request failed: HTTP ${String(response.status)}`);
    }
    return response;
  };

  return {
    listKnown: async () => {
      const known: KnownTicket[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await call(
          `/issues?labels=${LABEL}&state=all&per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
        );
        const issues = IssuesSchema.parse(await response.json());
        for (const issue of issues) {
          if (issue.pull_request !== undefined || !issue.title.startsWith(TICKET_TITLE_PREFIX)) {
            continue;
          }
          known.push({
            key: issue.title.slice(TICKET_TITLE_PREFIX.length),
            open: issue.state === "open",
            ref: String(issue.number),
          });
        }
        if (issues.length < PAGE_SIZE) return known;
      }
      throw new Error("too many review tickets to list safely");
    },

    open: async (ticket) => {
      await call("/issues", {
        method: "POST",
        body: JSON.stringify({ title: ticket.title, body: ticket.body, labels: [LABEL] }),
      });
    },

    close: async (ticket, note) => {
      const number = encodeURIComponent(ticket.ref);
      await call(`/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: note }),
      });
      await call(`/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      });
    },
  };
};
