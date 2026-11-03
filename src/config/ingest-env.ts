import { z } from "zod";
import {
  CategoryRulesSchema,
  EMPTY_CATEGORY_RULES,
} from "../core/categorization/category-rules.js";
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

// Optional Rules Map. An unset secret reaches the job as an empty string, which means "no rules".
const RulesFromJson = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") return EMPTY_CATEGORY_RULES;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "CATEGORY_RULES_JSON is not valid JSON" });
      return z.NEVER;
    }
    const rules = CategoryRulesSchema.safeParse(json);
    if (!rules.success) {
      // Paths only: the values are the owner's category ids.
      ctx.addIssue({
        code: "custom",
        message: `CATEGORY_RULES_JSON does not match the rules schema (${rules.error.issues
          .map((issue) => issue.path.join("."))
          .join(", ")})`,
      });
      return z.NEVER;
    }
    return rules.data;
  });

// Unset secrets reach the job as empty strings: blank means "not configured".
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const IngestEnvSchema = z.object({
  YNAB_PAT: z.string().min(1, "YNAB_PAT is required"),
  YNAB_BUDGET_ID: z.string().uuid("YNAB_BUDGET_ID must be a UUID"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  GOOGLE_REFRESH_TOKEN: z.string().min(1, "GOOGLE_REFRESH_TOKEN is required"),
  ACCOUNT_REGISTRY_JSON: RegistryFromJson,
  CATEGORY_RULES_JSON: RulesFromJson,
  // How far back each run looks. Overlap between runs is intentional: the per-email import_id
  // makes YNAB skip anything it already has.
  LOOKBACK_HOURS: z.coerce.number().int().min(1).max(720).default(72),

  // Optional operations channels. Each is off until configured; with none, any item that needs a
  // human simply fails the run (GitHub then emails the owner).
  // Dead-man's switch (healthchecks.io ping URL). The URL is the credential.
  HEALTHCHECK_URL: z.preprocess(
    blankToUndefined,
    z.string().url().startsWith("https://", "must be an https URL").optional(),
  ),
  // Push notifications (ntfy). On ntfy.sh the topic name is the password.
  NTFY_TOPIC: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, '-' or '_'")
      .optional(),
  ),
  NTFY_SERVER: z.preprocess(
    blankToUndefined,
    z.string().url().startsWith("https://", "must be an https URL").default("https://ntfy.sh"),
  ),
  // Review queue (GitHub issues). Both are provided by GitHub Actions itself.
  GITHUB_TOKEN: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  GITHUB_REPOSITORY: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "must look like owner/name")
      .optional(),
  ),
});

export type IngestEnv = z.infer<typeof IngestEnvSchema>;

// Logs ONLY issue paths + messages — never raw input values (they are secrets).
export const formatIngestEnvIssues = (raw: Record<string, unknown>): string[] | null => {
  const result = IngestEnvSchema.safeParse(raw);
  if (result.success) return null;
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};
