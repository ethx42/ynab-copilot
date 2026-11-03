export type AlertEmail = {
  readonly messageId: string;
  // Gmail internalDate as ISO-8601 UTC — the chronological ordering key.
  readonly receivedAt: string;
  readonly from: string;
  // Decoded text/plain body.
  readonly text: string;
};

// Impure edge: Gmail (read-only scope) in production, an in-memory fake in tests.
export interface MailPort {
  listAlertsSince(sinceIso: string): Promise<readonly AlertEmail[]>;
}
