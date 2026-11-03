import type { IngestReport, NeedsReview } from "../ingest/run-ingest.js";
import type { ReviewTicket } from "../../ports/review-queue.js";

// Something in a run that only a human can settle. This repo is PUBLIC (issues, Actions logs):
// every field here is an id, a template name or a reason code — never a merchant, an amount,
// card digits or email text.
export type AttentionItem = {
  readonly key: string;
  readonly kind: "needs_review" | "parse_failure";
  readonly messageId: string;
  // Same wording the run log prints.
  readonly summary: string;
  readonly guidance: string;
};

const REVIEW_GUIDANCE: Readonly<Record<NeedsReview["reason"], string>> = {
  unknown_last4:
    "La tarjeta o cuenta del correo no está en `ACCOUNT_REGISTRY_JSON`. Si es una tuya, agrégala (y vuelve a guardar el secret); " +
    "si es una tarjeta que no usas, registra el movimiento a mano en YNAB.",
  no_product_fallback:
    "El correo solo dice 'ahorros' y el registro no tiene `productFallbacks` para ese banco. Agrégalo en `ACCOUNT_REGISTRY_JSON`.",
  transfer_target_unknown:
    "Es un pago a una tarjeta o cuenta propia, pero el destino no está en el registro (`entries` o `transferTargets`). " +
    "Agrégalo, o registra la transferencia a mano en YNAB.",
};

const PARSE_GUIDANCE =
  "El correo no coincide con ninguna plantilla conocida. Ábrelo en Gmail y registra el movimiento a mano en YNAB; " +
  "hay que agregar la plantilla al parser (con una copia del texto como prueba).";

export const attentionItems = (report: IngestReport): readonly AttentionItem[] => {
  const byKey = new Map<string, AttentionItem>();
  for (const item of report.needsReview) {
    const messageId = item.tx.sourceMessageId;
    const key = `needs_review:${messageId}:${item.reason}`;
    byKey.set(key, {
      key,
      kind: "needs_review",
      messageId,
      summary: `needs review: ${item.reason} (template ${item.tx.template}, message ${messageId})`,
      guidance: REVIEW_GUIDANCE[item.reason],
    });
  }
  for (const failure of report.parseFailures) {
    const key = `parse_failure:${failure.messageId}:${failure.code}`;
    byKey.set(key, {
      key,
      kind: "parse_failure",
      messageId: failure.messageId,
      summary: `parse failure: ${failure.code} (message ${failure.messageId})`,
      guidance: PARSE_GUIDANCE,
    });
  }
  return [...byKey.values()];
};

// `needs_review:<messageId>:<reason>` -> the Gmail message the ticket is about.
export const messageIdOfKey = (key: string): string | null => key.split(":")[1] ?? null;

export const TICKET_TITLE_PREFIX = "[review] ";

export const toTicket = (item: AttentionItem): ReviewTicket => ({
  key: item.key,
  title: `${TICKET_TITLE_PREFIX}${item.key}`,
  body: [
    "Un correo del banco no se pudo registrar solo en YNAB.",
    "",
    `- Motivo: \`${item.key.split(":")[2] ?? "desconocido"}\``,
    `- Correo: https://mail.google.com/mail/u/0/#all/${item.messageId}`,
    "",
    `**Qué hacer:** ${item.guidance}`,
    "",
    "El issue se cierra solo cuando el correo se procesa bien. Si lo cierras tú, el sistema da el tema por atendido y no vuelve a abrirlo.",
  ].join("\n"),
});
