import { describe, expect, it } from "vitest";
import { formatIngestEnvIssues, IngestEnvSchema } from "../src/config/ingest-env.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const validEnv = {
  YNAB_PAT: "fake-pat",
  YNAB_BUDGET_ID: "123e4567-e89b-12d3-a456-426614174000",
  GOOGLE_CLIENT_ID: "fake-client-id",
  GOOGLE_CLIENT_SECRET: "fake-client-secret",
  GOOGLE_REFRESH_TOKEN: "fake-refresh-token",
  ACCOUNT_REGISTRY_JSON: JSON.stringify({
    entries: [{ bank: "bancolombia", last4: ["8139", "0338"], ynabAccountId: ACCOUNT }],
  }),
};

describe("IngestEnvSchema", () => {
  it("parses the registry JSON into a typed registry and defaults the lookback", () => {
    const env = IngestEnvSchema.parse(validEnv);
    expect(env.ACCOUNT_REGISTRY_JSON.entries[0]?.last4).toEqual(["8139", "0338"]);
    expect(env.ACCOUNT_REGISTRY_JSON.productFallbacks).toEqual([]);
    expect(env.LOOKBACK_HOURS).toBe(72);
  });

  it("coerces LOOKBACK_HOURS from the string an environment provides", () => {
    expect(IngestEnvSchema.parse({ ...validEnv, LOOKBACK_HOURS: "48" }).LOOKBACK_HOURS).toBe(48);
  });

  it("rejects malformed registry JSON without echoing it", () => {
    const issues = formatIngestEnvIssues({
      ...validEnv,
      ACCOUNT_REGISTRY_JSON: `{"oops" ${ACCOUNT}`,
    });
    expect(issues).toEqual(["ACCOUNT_REGISTRY_JSON: ACCOUNT_REGISTRY_JSON is not valid JSON"]);
    expect(issues?.join("\n")).not.toContain(ACCOUNT);
  });

  it("rejects an ambiguous registry (one card number mapped to two accounts)", () => {
    const issues = formatIngestEnvIssues({
      ...validEnv,
      ACCOUNT_REGISTRY_JSON: JSON.stringify({
        entries: [
          { bank: "bancolombia", last4: ["8139"], ynabAccountId: ACCOUNT },
          {
            bank: "bancolombia",
            last4: ["8139"],
            ynabAccountId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      }),
    });
    expect(issues?.join("\n")).toContain(
      "ACCOUNT_REGISTRY_JSON does not match the registry schema",
    );
  });

  it("reports every missing secret by name", () => {
    const issues = formatIngestEnvIssues({});
    expect(issues?.join("\n")).toContain("GOOGLE_REFRESH_TOKEN");
    expect(issues?.join("\n")).toContain("YNAB_PAT");
  });
});
