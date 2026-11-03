// Which parser owns the text: the bank's own notification email, or a Banco de Bogotá SMS that
// the owner's phone forwards to this mailbox (Bogotá sends no email alerts for everyday use).
export type AlertSource = "bancolombia" | "bancodebogota_sms";

export type AlertEmail = {
  readonly messageId: string;
  readonly source: AlertSource;
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
