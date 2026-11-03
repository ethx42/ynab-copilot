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

// Only what a transfer needs: each account's transfer payee. YNAB creates the counterpart leg
// when a transaction is posted to that payee.
const AccountsResponseSchema = z.object({
  data: z.object({
    accounts: z.array(
      z.object({
        id: z.string(),
        closed: z.boolean().default(false),
        deleted: z.boolean().default(false),
        transfer_payee_id: z.string().nullable().default(null),
      }),
    ),
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

type TransferPayees = ReadonlyMap<string, string>;

const requireTransferPayee = (payees: TransferPayees, accountId: string): string => {
  const payeeId = payees.get(accountId);
  // Never fall back to a plain payee name: that would book an expense where a transfer belongs.
  if (payeeId === undefined) {
    throw new Error("YNAB has no open account with a transfer payee for a transfer target");
  }
  return payeeId;
};

const toWire = (
  draft: YnabTransactionDraft,
  transferPayees: TransferPayees,
): Record<string, unknown> => ({
  account_id: draft.accountId,
  date: draft.date,
  amount: draft.amountMilliunits,
  ...(draft.transferAccountId === null
    ? {}
    : { payee_id: requireTransferPayee(transferPayees, draft.transferAccountId) }),
  ...(draft.payeeName === null ? {} : { payee_name: draft.payeeName.slice(0, 200) }),
  ...(draft.categoryId === null ? {} : { category_id: draft.categoryId }),
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

  const accountsUrl = `${API_BASE}/budgets/${encodeURIComponent(options.budgetId)}/accounts`;

  const throwApiError = async (response: Response): Promise<never> => {
    const body: unknown = await response.json().catch(() => null);
    const parsed = ErrorBodySchema.safeParse(body);
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new YnabApiError(
      response.status,
      parsed.success ? parsed.data.error.name : null,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  };

  const loadTransferPayees = async (): Promise<TransferPayees> => {
    const response = await doFetch(accountsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.accessToken}` },
    });
    if (!response.ok) return throwApiError(response);
    const parsed = AccountsResponseSchema.parse(await response.json());
    const payees = new Map<string, string>();
    for (const account of parsed.data.accounts) {
      if (!account.closed && !account.deleted && account.transfer_payee_id !== null) {
        payees.set(account.id, account.transfer_payee_id);
      }
    }
    return payees;
  };

  const postChunk = async (
    drafts: readonly YnabTransactionDraft[],
    transferPayees: TransferPayees,
  ): Promise<CreateResult> => {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transactions: drafts.map((d) => toWire(d, transferPayees)) }),
    });

    if (!response.ok) return throwApiError(response);

    const parsed = CreateResponseSchema.parse(await response.json());
    // Every submitted draft must come back either created or reported as a duplicate. Fewer
    // outcomes than drafts means some were neither written nor acknowledged: fail the run
    // instead of reporting a smaller `created` count as success. (Lower bound, not equality:
    // YNAB does not document a strict one-to-one mapping.)
    const accounted = parsed.data.transaction_ids.length + parsed.data.duplicate_import_ids.length;
    if (accounted < drafts.length) {
      throw new Error(
        `YNAB accounted for ${String(accounted)} of ${String(drafts.length)} submitted transactions`,
      );
    }
    return {
      createdIds: parsed.data.transaction_ids,
      duplicateImportIds: parsed.data.duplicate_import_ids,
    };
  };

  return {
    createTransactions: async (drafts) => {
      const created: string[] = [];
      const duplicates: string[] = [];
      // Looked up once per run, and only when a transfer is actually being written.
      const transferPayees = drafts.some((d) => d.transferAccountId !== null)
        ? await loadTransferPayees()
        : new Map<string, string>();
      for (const part of chunk(drafts, CHUNK_SIZE)) {
        const result = await postChunk(part, transferPayees);
        created.push(...result.createdIds);
        duplicates.push(...result.duplicateImportIds);
      }
      return { createdIds: created, duplicateImportIds: duplicates };
    },
  };
};
