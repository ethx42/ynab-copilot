import { gmail } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import { simpleParser } from "mailparser";
import { parse as parseHtml } from "node-html-parser";
import type { AlertEmail, MailPort } from "../../ports/mail.js";

// Gmail adapter (read-only scope). Impure edge: lists the bank's alert emails and decodes
// each MIME message to plain text. It makes no decisions about what an alert means.

// Matches an.notificacionesbancolombia.com, ayn.notificacionesbancolombia.com and the bare domain.
const BANCOLOMBIA_QUERY = "from:notificacionesbancolombia.com";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// The two calls we need, so the decoding/paging logic can be tested without Google.
export interface GmailApi {
  // Message ids matching `query`, newest first, across ALL result pages.
  listMessageIds(query: string): Promise<readonly string[]>;
  // Raw RFC822 bytes plus Gmail's receive time (epoch milliseconds).
  getRaw(id: string): Promise<{ readonly raw: Buffer; readonly internalDateMs: number }>;
}

// Bancolombia alerts are multipart/alternative with ONLY a text/html part, and mailparser leaves
// `text` empty for those. Reduce the HTML to its visible text: no markup, scripts, styles or
// comments, entities decoded. Whitespace is collapsed later by the parser.
const htmlToText = (html: string): string => {
  const root = parseHtml(html);
  for (const node of root.querySelectorAll("style, script, title, head")) node.remove();
  return root.text.trim();
};

const toAlert = async (id: string, raw: Buffer, internalDateMs: number): Promise<AlertEmail> => {
  const mail = await simpleParser(raw);
  const plain = mail.text?.trim() ?? "";
  // Prefer a real text/plain part. An empty result is still passed on as-is: the parser then
  // reports it as unrecognized (loud) instead of this adapter guessing.
  const text = plain !== "" ? plain : typeof mail.html === "string" ? htmlToText(mail.html) : "";
  return {
    messageId: id,
    receivedAt: new Date(internalDateMs).toISOString(),
    from: mail.from?.text ?? "",
    text,
  };
};

export const createGmailMailPort = (api: GmailApi): MailPort => ({
  listAlertsSince: async (sinceIso) => {
    const sinceSeconds = Math.floor(new Date(sinceIso).getTime() / 1000);
    if (!Number.isFinite(sinceSeconds)) throw new Error("listAlertsSince: invalid sinceIso");
    const ids = await api.listMessageIds(`${BANCOLOMBIA_QUERY} after:${String(sinceSeconds)}`);
    const alerts: AlertEmail[] = [];
    for (const id of ids) {
      const { raw, internalDateMs } = await api.getRaw(id);
      alerts.push(await toAlert(id, raw, internalDateMs));
    }
    return alerts;
  },
});

export type GoogleCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
  // Long-lived (does not rotate); the library mints short-lived access tokens from it.
  readonly refreshToken: string;
};

export const createGoogleGmailApi = (credentials: GoogleCredentials): GmailApi => {
  const auth = new OAuth2Client(credentials.clientId, credentials.clientSecret);
  auth.setCredentials({ refresh_token: credentials.refreshToken });
  const client = gmail({ version: "v1", auth });

  return {
    listMessageIds: async (query) => {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await client.users.messages.list({
          userId: "me",
          q: query,
          maxResults: 100,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        for (const message of page.data.messages ?? []) {
          if (message.id !== undefined && message.id !== null) ids.push(message.id);
        }
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken !== undefined);
      return ids;
    },
    getRaw: async (id) => {
      const response = await client.users.messages.get({ userId: "me", id, format: "raw" });
      const { raw, internalDate } = response.data;
      if (
        raw === undefined ||
        raw === null ||
        internalDate === undefined ||
        internalDate === null
      ) {
        throw new Error(`Gmail message ${id} came back without raw content or internalDate`);
      }
      return { raw: Buffer.from(raw, "base64url"), internalDateMs: Number(internalDate) };
    },
  };
};

export { GMAIL_READONLY_SCOPE };
