import { describe, expect, it, vi } from "vitest";
import { createYnabHttpAdapter, YnabApiError } from "../src/adapters/ynab/ynab-http.js";
import type { YnabTransactionDraft } from "../src/core/domain/ynab-draft.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const BUDGET = "99999999-9999-4999-8999-999999999999";
const TOKEN = "secret-token-value";

const draft = (overrides: Partial<YnabTransactionDraft> = {}): YnabTransactionDraft => ({
  accountId: ACCOUNT,
  date: "2026-11-02",
  amountMilliunits: -217375000,
  payeeName: "AMAZON MKTPLACE PMTS",
  memo: null,
  importId: "BC:8139:20261102T0800:217375:1",
  cleared: "cleared",
  approved: false,
  ...overrides,
});

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// A fetch double that answers each call with a freshly built Response (bodies are single-use).
const fakeFetch = (respond: (callNumber: number) => Response) => {
  let calls = 0;
  return vi.fn<typeof fetch>(() => {
    calls += 1;
    return Promise.resolve(respond(calls));
  });
};

const sentBody = (fetchImpl: ReturnType<typeof fakeFetch>, call = 0): unknown => {
  const body = fetchImpl.mock.calls[call]?.[1]?.body;
  if (typeof body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(body);
};

describe("YNAB HTTP adapter", () => {
  it("posts unapproved drafts with the wire field names and a bearer token", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(201, { data: { transaction_ids: ["t1"], duplicate_import_ids: [] } }),
    );
    const ynab = createYnabHttpAdapter({ accessToken: TOKEN, budgetId: BUDGET, fetchImpl });

    const result = await ynab.createTransactions([draft()]);

    expect(result).toEqual({ createdIds: ["t1"], duplicateImportIds: [] });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.ynab.com/v1/budgets/${BUDGET}/transactions`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(sentBody(fetchImpl)).toEqual({
      transactions: [
        {
          account_id: ACCOUNT,
          date: "2026-11-02",
          amount: -217375000,
          payee_name: "AMAZON MKTPLACE PMTS",
          cleared: "cleared",
          approved: false,
          import_id: "BC:8139:20261102T0800:217375:1",
        },
      ],
    });
  });

  it("omits the payee when absent and sends the memo when present", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(201, { data: { transaction_ids: [] } }));
    const ynab = createYnabHttpAdapter({ accessToken: TOKEN, budgetId: BUDGET, fetchImpl });
    await ynab.createTransactions([
      draft({ payeeName: null, memo: "Transferencia Bancolombia a *75639212378" }),
    ]);
    const body = sentBody(fetchImpl) as { transactions: Record<string, unknown>[] };
    expect(body.transactions[0]).not.toHaveProperty("payee_name");
    expect(body.transactions[0]).toHaveProperty("memo", "Transferencia Bancolombia a *75639212378");
  });

  it("reports import_ids YNAB already had (idempotent re-run)", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(209, {
        data: { transaction_ids: [], duplicate_import_ids: ["BC:8139:20261102T0800:217375:1"] },
      }),
    );
    const ynab = createYnabHttpAdapter({ accessToken: TOKEN, budgetId: BUDGET, fetchImpl });
    expect(await ynab.createTransactions([draft()])).toEqual({
      createdIds: [],
      duplicateImportIds: ["BC:8139:20261102T0800:217375:1"],
    });
  });

  it("splits large batches into several requests and merges the results", async () => {
    const fetchImpl = fakeFetch((n) =>
      jsonResponse(201, { data: { transaction_ids: [`t${String(n)}`] } }),
    );
    const ynab = createYnabHttpAdapter({ accessToken: TOKEN, budgetId: BUDGET, fetchImpl });
    const drafts = Array.from({ length: 101 }, (_v, i) => draft({ importId: `BC:X:${String(i)}` }));
    const result = await ynab.createTransactions(drafts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.createdIds).toEqual(["t1", "t2"]);
  });

  it("sends nothing for an empty batch", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(201, { data: { transaction_ids: [] } }));
    const ynab = createYnabHttpAdapter({ accessToken: TOKEN, budgetId: BUDGET, fetchImpl });
    expect(await ynab.createTransactions([])).toEqual({ createdIds: [], duplicateImportIds: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails loudly with YNAB's error name and never leaks the token", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(
        429,
        { error: { id: "429", name: "too_many_requests" } },
        { "retry-after": "60" },
      ),
    );
    const ynab = createYnabHttpAdapter({ accessToken: TOKEN, budgetId: BUDGET, fetchImpl });
    const failure = await ynab.createTransactions([draft()]).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(YnabApiError);
    expect(failure).toMatchObject({
      status: 429,
      errorName: "too_many_requests",
      retryAfterSeconds: 60,
    });
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it("rejects a response with an unexpected shape instead of assuming success", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(201, { ok: true }));
    const ynab = createYnabHttpAdapter({ accessToken: TOKEN, budgetId: BUDGET, fetchImpl });
    await expect(ynab.createTransactions([draft()])).rejects.toThrow();
  });
});
