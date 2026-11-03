import type { YnabTransactionDraft } from "../core/domain/ynab-draft.js";

export type CreateResult = {
  readonly createdIds: readonly string[];
  // import_ids YNAB skipped because they already exist on that account (idempotent re-runs).
  readonly duplicateImportIds: readonly string[];
};

// Impure edge: implemented by an adapter (YNAB REST, PAT in v1). The core only sees this.
export interface YnabPort {
  createTransactions(drafts: readonly YnabTransactionDraft[]): Promise<CreateResult>;
}

// Read-only view used by the daily digest.
export interface YnabReadPort {
  // Rows the pipeline imported (our import_id prefixes) that the owner has not approved yet.
  countUnapprovedImported(): Promise<number>;
}
