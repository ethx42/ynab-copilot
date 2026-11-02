import { z } from "zod";
import type { YnabTransactionDraft } from "../../core/domain/ynab-draft.js";
import type { CreateResult, YnabPort } from "../../ports/ynab.js";

// YNAB REST adapter (PAT in v1). Impure edge: it only translates drafts to the wire format
// and validates what comes back — it never decides what to write.

const API_BASE = "https://api.ynab.com/v1";
// One request per chunk keeps us far below YNAB's 200 requests/hour limit.
const CHUNK_SIZE = 100;

// The one response shape we rely on; anything else is a loud failure, not a guess.
const CreateResponseSchema = z.object({
  data: z.object({
    transaction_ids: z.array(z.string()),
    duplicate_import_ids: z.array(z.string()).default([]),
  }),
});

export class YnabApiError extends Error {
  constructor(
    readonly status: number,
    // YNAB's own error name (e.g. "unauthorized_scope"). Never the request or the token.
    readonly errorName: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`YNAB API request failed: HTTP ${String(status)} ${errorName ?? "unknown_error"}`);
    this.name = "YnabApiError";
  }
}

const ErrorBodySchema = z.object({ error: z.object({ name: z.string() }) });

export type YnabHttpOptions = {
  readonly accessToken: string;
  readonly budgetId: string;
  // Injectable for tests; defaults to the platform fetch.
  readonly fetchImpl?: typeof fetch;
};

const toWire = (draft: YnabTransactionDraft): Record<string, unknown> => ({
  account_id: draft.accountId,
  date: draft.date,
  amount: draft.amountMilliunits,
  ...(draft.payeeName === null ? {} : { payee_name: draft.payeeName.slice(0, 200) }),
  ...(draft.memo === null ? {} : { memo: draft.memo.slice(0, 500) }),
  cleared: draft.cleared,
  approved: draft.approved,
  import_id: draft.importId,
});

const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export const createYnabHttpAdapter = (options: YnabHttpOptions): YnabPort => {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${API_BASE}/budgets/${encodeURIComponent(options.budgetId)}/transactions`;

  const postChunk = async (drafts: readonly YnabTransactionDraft[]): Promise<CreateResult> => {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transactions: drafts.map(toWire) }),
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const parsed = ErrorBodySchema.safeParse(body);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new YnabApiError(
        response.status,
        parsed.success ? parsed.data.error.name : null,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }

    const parsed = CreateResponseSchema.parse(await response.json());
    return {
      createdIds: parsed.data.transaction_ids,
      duplicateImportIds: parsed.data.duplicate_import_ids,
    };
  };

  return {
    createTransactions: async (drafts) => {
      const created: string[] = [];
      const duplicates: string[] = [];
      for (const part of chunk(drafts, CHUNK_SIZE)) {
        const result = await postChunk(part);
        created.push(...result.createdIds);
        duplicates.push(...result.duplicateImportIds);
      }
      return { createdIds: created, duplicateImportIds: duplicates };
    },
  };
};
