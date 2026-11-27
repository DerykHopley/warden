// Made-up secrets for Guard's tests, each joined from parts so the source never holds a whole one for a secret
// scanner to flag.

/** `parts` joined, so a fixture secret is never whole in the source. */
export const join = (...parts: string[]) => parts.join("");

/** What Guard's secret mask makes of a secret: its first 4 characters, then 8 `*`. Kept apart from `secrets.ts`'s
 * own, so a test checks the mask against this, not against itself. */
export const mask = (secret: string) => `${secret.slice(0, 4)}********`;

/** A made-up AWS access key id. */
export const AWS_KEY = ["AKIA", "Q7XJ2M4N6P8R3T5V"].join("");

/** A made-up GitHub personal access token. */
export const GITHUB_TOKEN = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");

/** A made-up Stripe live secret key. */
export const STRIPE_KEY = ["sk", "_live_", "9Zt4Kq7Wm2Rb8Xn5Hc3Vj6Lp"].join("");

/** A made-up Anthropic API key. */
export const ANTHROPIC_KEY = ["sk", "-ant-", "api03-", "Qm7Rt2Wx9Kb4Nz6Hd8Fj3Lc5Vp1Sg0Ty"].join("");

/** A made-up RSA private key block, as a PEM file holds one. */
export const RSA_PRIVATE_KEY = [
  ["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""),
  "the-key",
  ["-----END RSA ", "PRIVATE KEY-----"].join(""),
  "",
].join("\n");

/** A made-up Slack bot token. */
export const SLACK_TOKEN = ["xox", "b-", "4821936507-", "Tq8Wn3Zr6Kd1Hm9Xc"].join("");

/** One made-up secret of each of Guard's nine types, by the type's name (a private key by its header line). */
export const SECRET_OF_EACH_TYPE = {
  "AWS access key id": AWS_KEY,
  "GitHub token": GITHUB_TOKEN,
  "private key": join("-----BEGIN ", "RSA PRIVATE KEY-----"),
  "Stripe live secret key": join("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"),
  "Slack token": join("xox", "b-", "123456789012-1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx"),
  "Anthropic key": join("sk-", "ant-api03-", "Ab3".repeat(31)),
  "OpenRouter key": join("sk-", "or-v1-", "0123456789abcdef".repeat(4)),
  "OpenAI key": join("sk-", "proj-", "Zx9_Yw8-Vu7".repeat(4)),
  "Google API key": join("AIza", "SyD3x9Kq2Lm8Np4Rs6Tv1Wx5Yz7Ab0Cd2Ef"),
} as const;
