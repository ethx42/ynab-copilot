import { err, ok, type Result } from "./result.js";

export type DateTimeError = { readonly code: "invalid_datetime"; readonly raw: string };

const DMY = /^(?<d>\d{2})\/(?<m>\d{2})\/(?<y>\d{4})$/;
const HM = /^(?<h>\d{2}):(?<min>\d{2})$/;

// `DD/MM/YYYY` (as printed by the bank, local Colombia time) -> `YYYY-MM-DD`.
// Rejects impossible dates (31/02) instead of letting them roll over.
export const parseDmyDate = (raw: string): Result<string, DateTimeError> => {
  const g = DMY.exec(raw)?.groups;
  const d = g?.["d"];
  const m = g?.["m"];
  const y = g?.["y"];
  if (d === undefined || m === undefined || y === undefined) {
    return err({ code: "invalid_datetime", raw });
  }
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const valid =
    probe.getUTCFullYear() === Number(y) &&
    probe.getUTCMonth() === Number(m) - 1 &&
    probe.getUTCDate() === Number(d);
  return valid ? ok(`${y}-${m}-${d}`) : err({ code: "invalid_datetime", raw });
};

// `HH:MM` 24h -> same string, validated.
export const parseClockTime = (raw: string): Result<string, DateTimeError> => {
  const g = HM.exec(raw)?.groups;
  const h = g?.["h"];
  const min = g?.["min"];
  if (h === undefined || min === undefined) return err({ code: "invalid_datetime", raw });
  return Number(h) <= 23 && Number(min) <= 59 ? ok(raw) : err({ code: "invalid_datetime", raw });
};
