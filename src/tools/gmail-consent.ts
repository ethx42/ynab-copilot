// One-time, LOCAL helper: runs the Google consent flow (gmail.readonly) and prints the
// long-lived refresh token to YOUR terminal so you can store it as the GitHub secret
// GOOGLE_REFRESH_TOKEN. It is never run by CI and never logs the client secret.
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... pnpm gmail:consent
import { createServer } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { GMAIL_READONLY_SCOPE } from "../adapters/gmail/gmail-mail.js";

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${String(PORT)}`;

const clientId = process.env["GOOGLE_CLIENT_ID"];
const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
if (
  clientId === undefined ||
  clientId === "" ||
  clientSecret === undefined ||
  clientSecret === ""
) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
  process.exit(1);
}

const oauth = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
const authUrl = oauth.generateAuthUrl({
  access_type: "offline",
  // `consent` forces Google to return a refresh token even if this app was approved before.
  prompt: "consent",
  scope: [GMAIL_READONLY_SCOPE],
});

const server = createServer((req, res) => {
  const code = new URL(req.url ?? "/", REDIRECT_URI).searchParams.get("code");
  if (code === null) {
    res.writeHead(400).end("Missing ?code");
    return;
  }
  oauth.getToken(code).then(
    ({ tokens }) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Listo. Puedes cerrar esta pestaña y volver a la terminal.");
      if (tokens.refresh_token === undefined || tokens.refresh_token === null) {
        console.error(
          "Google did not return a refresh token. Remove the app at " +
            "https://myaccount.google.com/permissions and run this again.",
        );
        process.exitCode = 1;
      } else {
        console.log("\nGOOGLE_REFRESH_TOKEN (copy it into the GitHub secret):\n");
        console.log(tokens.refresh_token);
      }
      server.close();
    },
    (error: unknown) => {
      res.writeHead(500).end("Token exchange failed");
      console.error(`Token exchange failed: ${error instanceof Error ? error.message : "unknown"}`);
      process.exitCode = 1;
      server.close();
    },
  );
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this URL in your browser and approve read-only access to Gmail:\n");
  console.log(authUrl);
});
