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

  it("treats an unset or empty CATEGORY_RULES_JSON as no rules", () => {
    expect(IngestEnvSchema.parse(validEnv).CATEGORY_RULES_JSON.rules).toEqual([]);
    expect(
      IngestEnvSchema.parse({ ...validEnv, CATEGORY_RULES_JSON: "" }).CATEGORY_RULES_JSON.rules,
    ).toEqual([]);
  });

  it("parses CATEGORY_RULES_JSON and rejects bad rules without echoing ids", () => {
    const CATEGORY = "44444444-4444-4444-8444-444444444444";
    const good = IngestEnvSchema.parse({
      ...validEnv,
      CATEGORY_RULES_JSON: JSON.stringify({
        rules: [{ counterparty: "UBER", match: "prefix", payeeName: "Uber", categoryId: CATEGORY }],
      }),
    });
    expect(good.CATEGORY_RULES_JSON.rules[0]?.payeeName).toBe("Uber");

    const badId = formatIngestEnvIssues({
      ...validEnv,
      CATEGORY_RULES_JSON: JSON.stringify({
        rules: [{ counterparty: "UBER", payeeName: "Uber", categoryId: "not-a-uuid" }],
      }),
    });
    expect(badId?.join("\n")).toContain("CATEGORY_RULES_JSON does not match the rules schema");
    expect(badId?.join("\n")).not.toContain("not-a-uuid");

    const notJson = formatIngestEnvIssues({ ...validEnv, CATEGORY_RULES_JSON: "{oops" });
    expect(notJson).toEqual(["CATEGORY_RULES_JSON: CATEGORY_RULES_JSON is not valid JSON"]);
  });

  it("leaves the operations channels off when unset or blank", () => {
    const env = IngestEnvSchema.parse({
      ...validEnv,
      HEALTHCHECK_URL: "",
      NTFY_TOPIC: "  ",
      GITHUB_TOKEN: "",
      GITHUB_REPOSITORY: "",
    });
    expect(env.HEALTHCHECK_URL).toBeUndefined();
    expect(env.NTFY_TOPIC).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITHUB_REPOSITORY).toBeUndefined();
    expect(env.NTFY_SERVER).toBe("https://ntfy.sh");
  });

  it("accepts configured channels", () => {
    const env = IngestEnvSchema.parse({
      ...validEnv,
      HEALTHCHECK_URL: "https://hc-ping.com/11111111-2222-4333-8444-555555555555",
      NTFY_TOPIC: "my_private-topic1",
      GITHUB_TOKEN: "tok",
      GITHUB_REPOSITORY: "ethx42/ynab-copilot",
    });
    expect(env.NTFY_TOPIC).toBe("my_private-topic1");
    expect(env.GITHUB_REPOSITORY).toBe("ethx42/ynab-copilot");
  });

  it("rejects insecure or malformed channel settings without echoing their values", () => {
    const issues = formatIngestEnvIssues({
      ...validEnv,
      HEALTHCHECK_URL: "http://hc-ping.com/secret-uuid",
      NTFY_TOPIC: "bad topic/with spaces",
      GITHUB_REPOSITORY: "not a repo",
    });
    const text = (issues ?? []).join("\n");
    expect(text).toContain("HEALTHCHECK_URL");
    expect(text).toContain("NTFY_TOPIC");
    expect(text).toContain("GITHUB_REPOSITORY");
    expect(text).not.toContain("secret-uuid");
    expect(text).not.toContain("bad topic");
  });

  it("reads SMS_FORWARD_FROM as a normalised address list, off when blank", () => {
    expect(IngestEnvSchema.parse(validEnv).SMS_FORWARD_FROM).toBeUndefined();
    expect(IngestEnvSchema.parse({ ...validEnv, SMS_FORWARD_FROM: " " }).SMS_FORWARD_FROM).toBe(
      undefined,
    );
    expect(
      IngestEnvSchema.parse({
        ...validEnv,
        SMS_FORWARD_FROM: " Santiagov62@Gmail.com , me@icloud.com ",
      }).SMS_FORWARD_FROM,
    ).toEqual(["santiagov62@gmail.com", "me@icloud.com"]);
  });

  it("rejects a malformed SMS_FORWARD_FROM without echoing it", () => {
    const issues = formatIngestEnvIssues({ ...validEnv, SMS_FORWARD_FROM: "not-an-address" });
    expect(issues?.join("\n")).toContain("SMS_FORWARD_FROM");
    expect(issues?.join("\n")).not.toContain("not-an-address");
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
