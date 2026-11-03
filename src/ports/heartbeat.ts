// Impure edge: an external dead-man's switch (healthchecks.io in production). The job pings it
// at the end of every run; the SERVICE alerts when pings stop, which is the only way to notice
// that the scheduler itself (cron disabled, workflow removed, token revoked) went silent.
export interface HeartbeatPort {
  // `detail` is counts only — it ends up in a third-party dashboard.
  ping(status: "ok" | "fail", detail: string): Promise<void>;
}
