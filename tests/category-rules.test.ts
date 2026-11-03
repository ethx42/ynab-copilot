import { describe, expect, it } from "vitest";
import {
  applyCategoryRule,
  CategoryRulesSchema,
  EMPTY_CATEGORY_RULES,
} from "../src/core/categorization/category-rules.js";
import type { NormalizedTransaction } from "../src/core/domain/transaction.js";

const TRANSPORT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSONAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPECIFIC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const tx = (overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({
  bank: "bancolombia",
  template: "B-1",
  kind: "purchase",
  direction: "outflow",
  amountPesos: 10000,
  date: "2026-11-02",
  time: "08:00",
  account: { kind: "last4", last4: "8139" },
  counterparty: "UBER RIDES",
  counterAccountLast4: null,
  sourceMessageId: "m1",
  ...overrides,
});

const rules = CategoryRulesSchema.parse({
  rules: [
    { counterparty: "UBER", match: "prefix", payeeName: "Uber", categoryId: TRANSPORT },
    { counterparty: "AMAZON", match: "prefix", payeeName: "Amazon", categoryId: PERSONAL },
    { counterparty: "UBER RIDES*DL", payeeName: "Uber Eats", categoryId: SPECIFIC },
  ],
});

describe("category rules", () => {
  it("matches a prefix case-insensitively and with collapsed whitespace", () => {
    expect(applyCategoryRule(tx({ counterparty: "  uber   rides " }), rules)).toEqual({
      payeeName: "Uber",
      categoryId: TRANSPORT,
    });
    expect(applyCategoryRule(tx({ counterparty: "AMAZON MKTPLACE PMTS" }), rules)).toEqual({
      payeeName: "Amazon",
      categoryId: PERSONAL,
    });
  });

  it("lets an exact rule beat a prefix rule", () => {
    expect(applyCategoryRule(tx({ counterparty: "UBER RIDES*DL" }), rules)).toEqual({
      payeeName: "Uber Eats",
      categoryId: SPECIFIC,
    });
  });

  it("prefers the longest prefix when several match", () => {
    const longest = CategoryRulesSchema.parse({
      rules: [
        { counterparty: "UBER", match: "prefix", payeeName: "Uber", categoryId: TRANSPORT },
        { counterparty: "UBER EATS", match: "prefix", payeeName: "Eats", categoryId: SPECIFIC },
      ],
    });
    expect(applyCategoryRule(tx({ counterparty: "UBER EATS MX" }), longest)?.payeeName).toBe(
      "Eats",
    );
  });

  it("returns null when nothing matches, and never matches in the middle of the text", () => {
    expect(applyCategoryRule(tx({ counterparty: "PAYU*UBER" }), rules)).toBeNull();
    expect(applyCategoryRule(tx({ counterparty: "RAPPI COLOMBIA*DL" }), rules)).toBeNull();
    expect(applyCategoryRule(tx(), EMPTY_CATEGORY_RULES)).toBeNull();
  });

  it("only applies to purchases and inflows that carry a counterparty", () => {
    expect(applyCategoryRule(tx({ kind: "withdrawal", counterparty: "UBER" }), rules)).toBeNull();
    expect(applyCategoryRule(tx({ kind: "transfer_out", counterparty: "UBER" }), rules)).toBeNull();
    expect(applyCategoryRule(tx({ kind: "card_payment", counterparty: null }), rules)).toBeNull();
    expect(applyCategoryRule(tx({ kind: "inflow", direction: "inflow" }), rules)).not.toBeNull();
  });

  it("rejects non-uuid category ids and duplicate rules at load time", () => {
    expect(
      CategoryRulesSchema.safeParse({
        rules: [{ counterparty: "UBER", payeeName: "Uber", categoryId: "nope" }],
      }).success,
    ).toBe(false);
    expect(
      CategoryRulesSchema.safeParse({
        rules: [
          { counterparty: "Uber", payeeName: "Uber", categoryId: TRANSPORT },
          { counterparty: " UBER ", payeeName: "Uber", categoryId: PERSONAL },
        ],
      }).success,
    ).toBe(false);
  });
});
