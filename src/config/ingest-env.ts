import { z } from "zod";
import { AccountRegistrySchema } from "../core/resolution/account-registry.js";

// Env edge for the scheduled ingest job. Kept separate from `EnvSchema` (which also demands
// the not-yet-wired Anthropic key) so the job runs with exactly the secrets it uses.
//
// The card -> YNAB account mapping holds the user's real YNAB account ids, so it is a secret
// (a JSON document in `ACCOUNT_REGISTRY_JSON`), never committed to this public repo.
const RegistryFromJson = z.string().transform((raw, ctx) => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Deliberately no echo of `raw`: it holds account ids.
    ctx.addIssue({ code: "custom", message: "ACCOUNT_REGISTRY_JSON is not valid JSON" });
    return z.NEVER;
  }
  const registry = AccountRegistrySchema.safeParse(json);
  if (!registry.success) {
    ctx.addIssue({
      code: "custom",
      message: `ACCOUNT_REGISTRY_JSON does not match the registry schema (${registry.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")})`,
    });
    return z.NEVER;
  }
  return registry.data;
});

export const IngestEnvSchema = z.object({
  YNAB_PAT: z.string().min(1, "YNAB_PAT is required"),
  YNAB_BUDGET_ID: z.string().uuid("YNAB_BUDGET_ID must be a UUID"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  GOOGLE_REFRESH_TOKEN: z.string().min(1, "GOOGLE_REFRESH_TOKEN is required"),
  ACCOUNT_REGISTRY_JSON: RegistryFromJson,
  // How far back each run looks. Overlap between runs is intentional: YNAB's import_id
  // de-duplicates, and import_id occurrence counters need earlier same-minute alerts in view.
  LOOKBACK_HOURS: z.coerce.number().int().min(1).max(720).default(72),
});

export type IngestEnv = z.infer<typeof IngestEnvSchema>;

// Logs ONLY issue paths + messages — never raw input values (they are secrets).
export const formatIngestEnvIssues = (raw: Record<string, unknown>): string[] | null => {
  const result = IngestEnvSchema.safeParse(raw);
  if (result.success) return null;
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};
