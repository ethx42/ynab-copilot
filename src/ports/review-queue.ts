// A bank email the pipeline could not turn into a YNAB row by itself.
export type ReviewTicket = {
  // Stable identity: the same problem on the same email always has the same key.
  readonly key: string;
  readonly title: string;
  readonly body: string;
};

export type KnownTicket = {
  readonly key: string;
  readonly open: boolean;
  // Opaque to the core; only the adapter that issued it can use it.
  readonly ref: string;
};

// Impure edge: where unresolved items wait for the owner (GitHub issues in production).
export interface ReviewQueuePort {
  // Open AND closed tickets: a ticket the owner closed means "handled", so it is not reopened.
  listKnown(): Promise<readonly KnownTicket[]>;
  open(ticket: ReviewTicket): Promise<void>;
  close(ticket: KnownTicket, note: string): Promise<void>;
}
