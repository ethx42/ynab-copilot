import { describe, expect, it } from "vitest";
import { assignImportIds } from "../src/core/domain/import-id.js";
import type { NormalizedTransaction } from "../src/core/domain/transaction.js";
import { planTransactions } from "../src/core/planning/plan.js";
import { CategoryRulesSchema } from "../src/core/categorization/category-rules.js";
import { AccountRegistrySchema, resolveAccount } from "../src/core/resolution/account-registry.js";

const CARD_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const MAIN_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const SAVINGS_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const BOGOTA_ACCOUNT = "44444444-4444-4444-8444-444444444444";

const registry = AccountRegistrySchema.parse({
  entries: [
    { bank: "bancolombia", last4: ["8139", "0338"], ynabAccountId: CARD_ACCOUNT },
    { bank: "bancolombia", last4: ["1560"], ynabAccountId: MAIN_ACCOUNT },
  ],
  productFallbacks: [{ bank: "bancolombia", product: "savings", ynabAccountId: SAVINGS_ACCOUNT }],
  transferTargets: [{ counterparty: "Banco de Bogota", ynabAccountId: BOGOTA_ACCOUNT }],
});

const base: NormalizedTransaction = {
  bank: "bancolombia",
  template: "B-1",
  kind: "purchase",
  direction: "outflow",
  amountPesos: 217375,
  date: "2026-11-02",
  time: "08:00",
  account: { kind: "last4", last4: "8139" },
  counterparty: "AMAZON MKTPLACE PMTS",
  counterAccountLast4: null,
  sourceMessageId: "m1",
};

describe("import_id", () => {
  it("is `<BANK>:<32 hex>` and fits YNAB's 36-char limit whatever the amount", () => {
    const [first] = assignImportIds([base]);
    expect(first?.importId).toMatch(/^BC:[0-9a-f]{32}$/);
    const huge = assignImportIds([{ ...base, amountPesos: 9_999_999_999_999 }]);
    expect(huge[0]?.importId.length).toBeLessThanOrEqual(36);
    const bogota = assignImportIds([{ ...base, bank: "bancodebogota" }]);
    expect(bogota[0]?.importId).toMatch(/^BB:[0-9a-f]{32}$/);
  });

  it("gives two identical purchases in DIFFERENT emails different ids", () => {
    const ids = assignImportIds([base, { ...base, sourceMessageId: "m2" }]).map((x) => x.importId);
    expect(new Set(ids).size).toBe(2);
  });

  it("gives several transactions inside ONE email different ids", () => {
    const ids = assignImportIds([base, base, base]).map((x) => x.importId);
    expect(new Set(ids).size).toBe(3);
  });

  it("does not depend on what else is in the batch (lookback-window independent)", () => {
    const alone = assignImportIds([{ ...base, sourceMessageId: "later" }])[0]?.importId;
    const withEarlier = assignImportIds([
      { ...base, sourceMessageId: "earlier" },
      { ...base, sourceMessageId: "later" },
    ])[1]?.importId;
    expect(alone).toBe(withEarlier);
  });

  it("is stable for the same email and never depends on the printed amount or time", () => {
    const first = assignImportIds([base])[0]?.importId;
    expect(assignImportIds([base])[0]?.importId).toBe(first);
    expect(assignImportIds([{ ...base, time: "08:01" }])[0]?.importId).toBe(first);
  });
});

describe("account registry", () => {
  it("resolves by last4, allowing several last4 per YNAB account (reissued card)", () => {
    expect(resolveAccount(base, registry)).toEqual({
      status: "resolved",
      ynabAccountId: CARD_ACCOUNT,
    });
    expect(
      resolveAccount({ ...base, account: { kind: "last4", last4: "0338" } }, registry),
    ).toEqual({ status: "resolved", ynabAccountId: CARD_ACCOUNT });
  });

  it("resolves the AHORROS template through the product fallback", () => {
    const inflow: NormalizedTransaction = {
      ...base,
      template: "B-2",
      kind: "inflow",
      direction: "inflow",
      account: { kind: "product", product: "savings" },
    };
    expect(resolveAccount(inflow, registry)).toEqual({
      status: "resolved",
      ynabAccountId: SAVINGS_ACCOUNT,
    });
  });

  it("returns unresolved (never a guess) for an unknown last4 or a missing fallback", () => {
    expect(
      resolveAccount({ ...base, account: { kind: "last4", last4: "9999" } }, registry),
    ).toEqual({ status: "unresolved", reason: "unknown_last4" });
    const noFallback = AccountRegistrySchema.parse({ entries: registry.entries });
    expect(
      resolveAccount({ ...base, account: { kind: "product", product: "savings" } }, noFallback),
    ).toEqual({ status: "unresolved", reason: "no_product_fallback" });
  });

  it("rejects an ambiguous registry (one last4 -> two accounts) at load time", () => {
    const parsed = AccountRegistrySchema.safeParse({
      entries: [
        { bank: "bancolombia", last4: ["8139"], ynabAccountId: CARD_ACCOUNT },
        { bank: "bancolombia", last4: ["8139"], ynabAccountId: MAIN_ACCOUNT },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("planTransactions", () => {
  it("builds unapproved, signed, cleared drafts for resolvable transactions", () => {
    const [item] = planTransactions([base], registry);
    const expectedImportId: unknown = expect.stringMatching(/^BC:[0-9a-f]{32}$/);
    expect(item).toEqual({
      status: "ready",
      draft: {
        accountId: CARD_ACCOUNT,
        date: "2026-11-02",
        amountMilliunits: -217375000,
        payeeName: "AMAZON MKTPLACE PMTS",
        categoryId: null,
        transferAccountId: null,
        memo: null,
        importId: expectedImportId,
        cleared: "cleared",
        approved: false,
      },
    });
  });

  it("records inflows as positive amounts", () => {
    const [item] = planTransactions(
      [
        {
          ...base,
          template: "B-2",
          kind: "inflow",
          direction: "inflow",
          account: { kind: "product", product: "savings" },
          counterparty: "WIZELINE SAS",
        },
      ],
      registry,
    );
    expect(item).toMatchObject({
      status: "ready",
      draft: { amountMilliunits: 217375000, payeeName: "WIZELINE SAS" },
    });
  });

  it("puts the destination of a transfer in the memo, not the payee", () => {
    const [item] = planTransactions(
      [
        {
          ...base,
          template: "B-6",
          kind: "transfer_out",
          account: { kind: "last4", last4: "1560" },
          amountPesos: 70500,
          counterparty: "*75639212378",
        },
      ],
      registry,
    );
    expect(item).toMatchObject({
      status: "ready",
      draft: {
        accountId: MAIN_ACCOUNT,
        payeeName: null,
        memo: "Transferencia Bancolombia a *75639212378",
      },
    });
  });

  it("posts ATM withdrawals to the payee Cash, without the ATM id", () => {
    const debitRegistry = AccountRegistrySchema.parse({
      entries: [{ bank: "bancolombia", last4: ["0669", "1560"], ynabAccountId: MAIN_ACCOUNT }],
    });
    const [item] = planTransactions(
      [
        {
          ...base,
          template: "B-7",
          kind: "withdrawal",
          amountPesos: 500000,
          account: { kind: "last4", last4: "0669" },
          counterparty: "UNIC_ARME3",
        },
      ],
      debitRegistry,
    );
    expect(item).toMatchObject({
      status: "ready",
      draft: {
        accountId: MAIN_ACCOUNT,
        amountMilliunits: -500000000,
        payeeName: "Cash",
        memo: null,
      },
    });
  });

  it("posts a card payment as a transfer to the card's own YNAB account (B-5)", () => {
    const [item] = planTransactions(
      [
        {
          ...base,
          template: "B-5",
          kind: "card_payment",
          account: { kind: "last4", last4: "1560" },
          counterAccountLast4: "8139",
          counterparty: null,
        },
      ],
      registry,
    );
    expect(item).toMatchObject({
      status: "ready",
      draft: {
        accountId: MAIN_ACCOUNT,
        amountMilliunits: -217375000,
        payeeName: null,
        categoryId: null,
        transferAccountId: CARD_ACCOUNT,
        approved: false,
      },
    });
  });

  it("posts 'Pagaste ... a Banco de Bogota' as a transfer, matching the payee loosely (B-12)", () => {
    const [item] = planTransactions(
      [
        {
          ...base,
          template: "B-12",
          kind: "payment",
          account: { kind: "last4", last4: "1560" },
          counterparty: "  BANCO  DE bogota ",
          amountPesos: 2000000,
        },
      ],
      registry,
    );
    expect(item).toMatchObject({
      status: "ready",
      draft: {
        accountId: MAIN_ACCOUNT,
        amountMilliunits: -2000000000,
        payeeName: null,
        transferAccountId: BOGOTA_ACCOUNT,
      },
    });
  });

  it("keeps a 'Pagaste' to any other payee an ordinary expense under that payee (B-12)", () => {
    const [item] = planTransactions(
      [
        {
          ...base,
          template: "B-12",
          kind: "payment",
          account: { kind: "last4", last4: "1560" },
          counterparty: "Claro",
        },
      ],
      registry,
    );
    expect(item).toMatchObject({
      status: "ready",
      draft: { payeeName: "Claro", transferAccountId: null },
    });
  });

  it("never turns a payment into a transfer from a card to itself", () => {
    const [item] = planTransactions(
      [
        {
          ...base,
          template: "B-12",
          kind: "payment",
          account: { kind: "last4", last4: "1560" },
          counterparty: "Banco de Bogota",
        },
      ],
      AccountRegistrySchema.parse({
        entries: [{ bank: "bancolombia", last4: ["1560"], ynabAccountId: MAIN_ACCOUNT }],
        transferTargets: [{ counterparty: "Banco de Bogota", ynabAccountId: MAIN_ACCOUNT }],
      }),
    );
    expect(item).toMatchObject({ status: "needs_review", reason: "transfer_target_unknown" });
  });

  it("rejects duplicate transfer targets at load time", () => {
    const parsed = AccountRegistrySchema.safeParse({
      entries: [],
      transferTargets: [
        { counterparty: "Banco de Bogota", ynabAccountId: MAIN_ACCOUNT },
        { counterparty: " BANCO DE BOGOTA", ynabAccountId: CARD_ACCOUNT },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("routes unknown cards and card payments to an unmapped card to review", () => {
    const items = planTransactions(
      [
        { ...base, account: { kind: "last4", last4: "9999" } },
        {
          ...base,
          template: "B-5",
          kind: "card_payment",
          account: { kind: "last4", last4: "1560" },
          counterAccountLast4: "2075",
          counterparty: null,
        },
      ],
      registry,
    );
    expect(items.map((i) => (i.status === "needs_review" ? i.reason : i.status))).toEqual([
      "unknown_last4",
      "transfer_target_unknown",
    ]);
  });

  it("posts under the rule's payee and category when the Rules Map matches", () => {
    const UBER_CATEGORY = "55555555-5555-4555-8555-555555555555";
    const rules = CategoryRulesSchema.parse({
      rules: [
        { counterparty: "UBER", match: "prefix", payeeName: "Uber", categoryId: UBER_CATEGORY },
      ],
    });
    const [item] = planTransactions([{ ...base, counterparty: "UBER RIDES*DL" }], registry, rules);
    expect(item).toMatchObject({
      status: "ready",
      draft: { payeeName: "Uber", categoryId: UBER_CATEGORY, approved: false },
    });
  });

  it("leaves the row uncategorized, with the bank's payee, when no rule matches", () => {
    const rules = CategoryRulesSchema.parse({
      rules: [
        {
          counterparty: "UBER",
          match: "prefix",
          payeeName: "Uber",
          categoryId: "55555555-5555-4555-8555-555555555555",
        },
      ],
    });
    const [item] = planTransactions([base], registry, rules);
    expect(item).toMatchObject({
      status: "ready",
      draft: { payeeName: "AMAZON MKTPLACE PMTS", categoryId: null },
    });
  });

  it("returns exactly one plan item per input (nothing is dropped)", () => {
    const items = planTransactions([base, base, { ...base, time: "09:00" }], registry);
    expect(items).toHaveLength(3);
  });
});
