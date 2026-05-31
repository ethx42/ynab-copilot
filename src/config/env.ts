import { z } from "zod";

// The env edge is UNTRUSTED. Parse-don't-validate: cross the boundary once,
// then the value is typed and trusted everywhere downstream (QG-02 seed).
export const EnvSchema = z.object({
  YNAB_PAT: z.string().min(1, "YNAB_PAT is required"),
  YNAB_BUDGET_ID: z.string().uuid("YNAB_BUDGET_ID must be a UUID"),
  ANTHROPIC_API_KEY: z.string().startsWith("sk-", "ANTHROPIC_API_KEY must start with sk-"),
});

export type Env = z.infer<typeof EnvSchema>;

// Throws a readable ZodError listing every missing/bad var if the edge is invalid.
export const loadEnv = (raw: NodeJS.ProcessEnv | Record<string, unknown> = process.env): Env =>
  EnvSchema.parse(raw);

// safeParse helper for edges where you fall back rather than crash (seeds the
// Phase-5 LLM path). Logs ONLY issue paths + messages — never raw input values,
// which may contain secrets (V7 / QG-05).
export const formatEnvIssues = (raw: Record<string, unknown>): string[] | null => {
  const result = EnvSchema.safeParse(raw);
  if (result.success) return null;
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};
