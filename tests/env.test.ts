import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { EnvSchema, loadEnv } from "../src/config/env.js";

// A syntactically valid env object built from fake (never-real) values.
const validEnv = {
  YNAB_PAT: "fake-pat-token",
  YNAB_BUDGET_ID: "123e4567-e89b-12d3-a456-426614174000",
  ANTHROPIC_API_KEY: "sk-fake-anthropic-key",
} as const;

describe("loadEnv (zod-at-the-edge, QG-02)", () => {
  it("accepts a well-formed env and returns a typed Env", () => {
    const env = loadEnv(validEnv);
    expect(env.YNAB_PAT).toBe(validEnv.YNAB_PAT);
    expect(env.YNAB_BUDGET_ID).toBe(validEnv.YNAB_BUDGET_ID);
    expect(env.ANTHROPIC_API_KEY).toBe(validEnv.ANTHROPIC_API_KEY);
  });

  it("rejects a missing/empty YNAB_PAT with a ZodError (malformed input rejected)", () => {
    expect(() => loadEnv({ ...validEnv, YNAB_PAT: "" })).toThrow(ZodError);
  });

  it("rejects a non-uuid YNAB_BUDGET_ID with a ZodError", () => {
    expect(() => loadEnv({ ...validEnv, YNAB_BUDGET_ID: "not-a-uuid" })).toThrow(ZodError);
  });

  it("rejects an ANTHROPIC_API_KEY without the sk- prefix", () => {
    expect(() => loadEnv({ ...validEnv, ANTHROPIC_API_KEY: "nope-no-prefix" })).toThrow(ZodError);
  });

  it("does NOT leak secret values in the formatted safeParse issue output (no-secret-leak)", () => {
    // Use a recognizable sentinel as a malformed secret value. It is invalid
    // (no sk- prefix), so it appears in the bad input — but must NOT surface in
    // the issue paths/messages we are allowed to log.
    const sentinel = "SUPER_SECRET_SENTINEL_DO_NOT_LEAK";
    const result = EnvSchema.safeParse({ ...validEnv, ANTHROPIC_API_KEY: sentinel });
    expect(result.success).toBe(false);
    if (result.success) return; // narrow for the type checker
    const formatted = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    expect(formatted).toContain("ANTHROPIC_API_KEY");
    expect(formatted).not.toContain(sentinel);
  });
});
