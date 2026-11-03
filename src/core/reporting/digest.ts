import type { Analysis } from "../ingest/run-ingest.js";
import type { Notice } from "../../ports/notifier.js";
import type { KnownTicket } from "../../ports/review-queue.js";
import type { AlertEmail } from "../../ports/mail.js";

export type DigestFacts = {
  readonly windowHours: number;
  readonly emailsSeen: number;
  readonly movements: number;
  readonly attention: number;
  readonly openTickets: number;
  // null = the YNAB read failed; the digest says so instead of guessing.
  readonly unapproved: number | null;
};

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

export const factsFrom = (
  windowHours: number,
  alerts: readonly AlertEmail[],
  analysis: Analysis,
  known: readonly KnownTicket[],
  unapproved: number | null,
): DigestFacts => ({
  windowHours,
  emailsSeen: alerts.length,
  movements: analysis.parsed.length,
  attention: analysis.needsReview.length + analysis.parseFailures.length,
  openTickets: known.filter((t) => t.open).length,
  unapproved,
});

// The point of a DAILY message: silence means something is wrong with the system itself.
export const buildDigest = (facts: DigestFacts): Notice => {
  const lines = [
    facts.emailsSeen === 0
      ? `Sin correos del banco en las últimas ${String(facts.windowHours)} h.`
      : `Últimas ${String(facts.windowHours)} h: ${plural(facts.emailsSeen, "correo", "correos")} del banco, ` +
        `${plural(facts.movements, "movimiento", "movimientos")}.`,
    facts.unapproved === null
      ? "No pude leer las filas sin aprobar de YNAB."
      : `${plural(facts.unapproved, "fila", "filas")} sin aprobar en YNAB.`,
    facts.openTickets > 0
      ? `${plural(facts.openTickets, "issue abierto", "issues abiertos")} por revisar en GitHub.`
      : "Nada pendiente de revisión.",
  ];
  const needsYou = facts.openTickets > 0 || facts.attention > 0;
  return {
    title: needsYou ? "YNAB: resumen diario (requiere revisión)" : "YNAB: resumen diario",
    message: lines.join("\n"),
    priority: needsYou ? "high" : "default",
  };
};
