// Whether a stored SCRAM-SHA-256 verifier lets `password` sign in. pg's own client plays its side of the exchange;
// this plays Postgres's: it checks the client's proof against the StoredKey and signs with the ServerKey, which the
// client checks in turn (RFC 5802). The suite's Postgres uses trust auth, so this stands in for a real login.
import { createHash, createHmac, randomBytes } from "node:crypto";
import sasl from "pg/lib/crypto/sasl.js";

const VERIFIER = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

export async function scramAuthenticates(verifier: string, password: string): Promise<boolean> {
  const parts = VERIFIER.exec(verifier);
  if (!parts) return false;
  const [, iterations, salt, storedKeyText, serverKeyText] = parts as unknown as string[];
  const storedKey = Buffer.from(storedKeyText as string, "base64");
  const serverKey = Buffer.from(serverKeyText as string, "base64");

  const session = sasl.startSession(["SCRAM-SHA-256"]);
  const serverFirst = `r=${session.clientNonce}${randomBytes(18).toString("base64")},s=${salt},i=${iterations}`;
  await sasl.continueSession(session, password, serverFirst);

  const proofAt = session.response.lastIndexOf(",p=");
  const authMessage = `n=*,r=${session.clientNonce},${serverFirst},${session.response.slice(0, proofAt)}`;
  const proof = Buffer.from(session.response.slice(proofAt + 3), "base64");
  const signature = createHmac("sha256", storedKey).update(authMessage).digest();
  const clientKey = Buffer.from(proof.map((byte, i) => byte ^ (signature[i] ?? 0)));
  if (!createHash("sha256").update(clientKey).digest().equals(storedKey)) return false;

  const serverSignature = createHmac("sha256", serverKey).update(authMessage).digest("base64");
  sasl.finalizeSession(session, `v=${serverSignature}`);
  return true;
}
