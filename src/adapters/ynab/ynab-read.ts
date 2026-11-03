import { z } from "zod";
import { isPipelineImportId } from "../../core/domain/import-id.js";
import type { YnabReadPort } from "../../ports/ynab.js";

const API_BASE = "https://api.ynab.com/v1";
const TIMEOUT_MS = 20_000;

const UnapprovedResponseSchema = z.object({
  data: z.object({
    transactions: z.array(
      z.object({
        import_id: z.string().nullable().default(null),
        deleted: z.boolean().default(false),
      }),
    ),
  }),
});

export type YnabReadOptions = {
  readonly accessToken: string;
  readonly budgetId: string;
  readonly fetchImpl?: typeof fetch;
};

export const createYnabReadAdapter = (options: YnabReadOptions): YnabReadPort => {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    countUnapprovedImported: async () => {
      const response = await doFetch(
        `${API_BASE}/budgets/${encodeURIComponent(options.budgetId)}/transactions?type=unapproved`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${options.accessToken}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`YNAB read failed: HTTP ${String(response.status)}`);
      const parsed = UnapprovedResponseSchema.parse(await response.json());
      return parsed.data.transactions.filter(
        (t) => !t.deleted && t.import_id !== null && isPipelineImportId(t.import_id),
      ).length;
    },
  };
};
