// Counterparty text is compared, never rewritten: trim, collapse whitespace, ignore case.
export const normalizeCounterparty = (text: string): string =>
  text.trim().replace(/\s+/g, " ").toUpperCase();
