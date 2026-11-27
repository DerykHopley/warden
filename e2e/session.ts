// Who the browser tests sign in as, and how: a session token shaped like Clerk's, signed with the key the global
// setup made (the server trusts its public half through CLERK_JWT_KEY), handed to the dashboard's Clerk stand-in
// before the page loads.
import { test as base, type Page } from "@playwright/test";
import { Product, ProductsBody, type ProductInput } from "@warden/contracts";
import { importJWK, SignJWT, type JWK } from "jose";

/** The Clerk Frontend API host the test publishable key names. Nothing is ever fetched from it. */
export const FRONTEND_API_HOST = "warden-e2e.clerk.accounts.dev";

export type Person = { userId: string; firstName: string; lastName: string; email: string };

export const ADA: Person = {
  userId: "user_e2e_ada",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@acme.test",
};
export const GRACE: Person = {
  userId: "user_e2e_grace",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@acme.test",
};
export const LINUS: Person = {
  userId: "user_e2e_linus",
  firstName: "Linus",
  lastName: "Bluebird",
  email: "linus@bluebird.test",
};

export const MARGARET: Person = {
  userId: "user_e2e_margaret",
  firstName: "Margaret",
  lastName: "Hamilton",
  email: "margaret@bluebird.test",
};

export const HEDY: Person = {
  userId: "user_e2e_hedy",
  firstName: "Hedy",
  lastName: "Lamarr",
  email: "hedy@cedar.test",
};

export const KATHERINE: Person = {
  userId: "user_e2e_katherine",
  firstName: "Katherine",
  lastName: "Johnson",
  email: "katherine@cedar.test",
};

/**
 * Two Teams, each opened by its Admin and seeded with the demo Findings but not the demo Product (`--no-product`), so
 * no CVE Findings join the counts their tests read. Acme also has Grace, a Member; Bluebird has Margaret, a Member
 * (only e2e/decisions.spec.ts reads Bluebird, so its decisions can't touch Acme's tests). A third, Cedar, has no demo
 * seed: the Products tests create their Products there, and with the CVE snapshot loaded, each save's Patch Scan opens
 * CVE Findings that would change Acme's and Bluebird's counts.
 */
export const ACME = { id: "org_e2e_acme", name: "Acme", admin: ADA, people: [ADA, GRACE] };
export const BLUEBIRD = {
  id: "org_e2e_bluebird",
  name: "Bluebird",
  admin: LINUS,
  people: [LINUS, MARGARET],
};

export const CEDAR = {
  id: "org_e2e_cedar",
  name: "Cedar",
  admin: HEDY,
  people: [HEDY, KATHERINE],
};

export const DOROTHY: Person = {
  userId: "user_e2e_dorothy",
  firstName: "Dorothy",
  lastName: "Vaughan",
  email: "dorothy@dahlia.test",
};

export const ANNIE: Person = {
  userId: "user_e2e_annie",
  firstName: "Annie",
  lastName: "Easley",
  email: "annie@dahlia.test",
};

/**
 * A fourth Team for story 6's Fix PR (e2e/fix-pr.spec.ts), apart from the other three so its write grant and Fix PR
 * change none of their Setup or Findings tests: one Repo Asset, `DAHLIA_REPO`, a write grant, and one Open Finding.
 */
export const DAHLIA = {
  id: "org_e2e_dahlia",
  name: "Dahlia",
  admin: DOROTHY,
  people: [DOROTHY, ANNIE],
};

export const MARY: Person = {
  userId: "user_e2e_mary",
  firstName: "Mary",
  lastName: "Jackson",
  email: "mary@elm.test",
};

export const EVELYN: Person = {
  userId: "user_e2e_evelyn",
  firstName: "Evelyn",
  lastName: "Granville",
  email: "evelyn@elm.test",
};

/**
 * A fifth Team for spec #341's stories 8 and 9 (e2e/overview.spec.ts), with no demo seed and no Scan: it turns VDA ISA
 * 2027.1 on and reviews its Controls, which can't be undone, so no other spec's Overview or Setup reads it.
 */
export const ELM = {
  id: "org_e2e_elm",
  name: "Elm",
  admin: MARY,
  people: [MARY, EVELYN],
};

export const FRANCES: Person = {
  userId: "user_e2e_frances",
  firstName: "Frances",
  lastName: "Allen",
  email: "frances@fir.test",
};

export const JOAN: Person = {
  userId: "user_e2e_joan",
  firstName: "Joan",
  lastName: "Clarke",
  email: "joan@fir.test",
};

/**
 * A sixth Team for spec #341's Control card (e2e/control-card.spec.ts): one Repo Asset, `FIR_REPO`, and a Guard Scan
 * of it under both of 1.3.3's Rules with one Open `guard/unapproved-ai-tool` Finding, so 1.3.3 is Partly evidenced.
 * Its review and its Finding's False positive can't be undone, so no other spec reads Fir.
 */
export const FIR = {
  id: "org_e2e_fir",
  name: "Fir",
  admin: FRANCES,
  people: [FRANCES, JOAN],
};

/** Fir's one Repo Asset, linked by the global setup. */
export const FIR_REPO = { ref: "https://github.com/fir/assistant", githubId: 5251 };

export type Team = typeof ACME;

/**
 * Dahlia's one Repo Asset, the one repo the GitHub fake knows (`e2e/fake-github.ts`), with its GitHub id, and its
 * full name. That module only defines the fake, so importing it here installs nothing in a test worker.
 */
export { DAHLIA_REPO, DAHLIA_REPO_FULL_NAME } from "./fake-github.ts";

/**
 * Cedar's two Repo Assets, linked by the global setup with a Guard Scan of both queued 2 hours ago that never started:
 * the server's first read of them ends it as failed (story 2).
 */
export const CEDAR_REPOS = [
  "https://github.com/cedar/chat-assistant",
  "https://github.com/cedar/chat-infra",
];

/**
 * Cedar's Product, with two Repo URLs and two dependencies: one with a version and internet-facing, one without either.
 * Each spec that needs it creates it (`ensureProduct`), so none depends on another's running first.
 */
export const CHAT_ASSISTANT: ProductInput = {
  name: "Chat assistant",
  repo_urls: ["https://github.com/cedar/chat-assistant", "https://github.com/cedar/chat-infra"],
  dependencies: [
    { framework: "langflow", version: "1.4.0", usage: "self_hosted", internet_facing: true },
    { framework: "litellm", version: null, usage: "transitive", internet_facing: false },
  ],
};

/**
 * Cedar's Product on a LangChain version with CVEs in the loaded snapshot, so it has open CVE Findings for the detail
 * card's Patch section. Its own name: products.spec.ts deletes and saves "Hedy's LangChain app" again each run.
 */
export const LANGCHAIN_SERVICE: ProductInput = {
  name: "Cedar's LangChain service",
  repo_urls: [],
  dependencies: [
    { framework: "langchain", version: "0.0.200", usage: "library", internet_facing: true },
  ],
};

/** A pattern for `text` as a whole: a Product's name, never a longer one that holds it. */
export const exactly = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** A v2 session token for `person` in `team`, as Clerk writes one: `o.rol` without the `org:` prefix. */
export async function sessionToken(
  key: CryptoKey | Uint8Array,
  origin: string,
  person: Person,
  team: Team,
  clerkRole: "admin" | "member",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return (
    new SignJWT({
      sid: `sess_${person.userId}`,
      azp: origin,
      v: 2,
      o: { id: team.id, rol: clerkRole },
    })
      // `cat` is the category Clerk's SDK puts on a session token's header, and checks (as in the server's tests).
      .setProtectedHeader({ alg: "RS256", kid: "ins_e2e", typ: "JWT", cat: "cl_B7d4PD111AAA" })
      .setSubject(person.userId)
      .setIssuer(`https://${FRONTEND_API_HOST}`)
      .setIssuedAt(now - 60)
      .setNotBefore(now - 60)
      .setExpirationTime(now + 3600)
      .sign(key)
  );
}

/** The signing key the global setup made, from the environment it left for the test workers. */
export async function signingKey() {
  const jwk = process.env.E2E_SIGNING_JWK;
  if (!jwk) throw new Error("E2E_SIGNING_JWK is unset: run the browser tests with `pnpm e2e`");
  return importJWK(JSON.parse(jwk) as JWK, "RS256");
}

/**
 * Creates `product` in `team` through the API, as the Team's Admin, unless the Team already has a Product by that
 * name, so a spec's `beforeAll` can run again in a restarted worker. Its id either way.
 */
export async function ensureProduct(team: Team, product: ProductInput): Promise<string> {
  const admin = await asAdmin(team);
  const { origin, headers } = admin;
  const idThere = async () =>
    (await listProducts(team, admin)).find(({ name }) => name === product.name)?.id;
  const before = await idThere();
  if (before !== undefined) return before;
  const res = await fetch(`${origin}/api/products`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(product),
  });
  if (res.status === 201) return Product.parse(await res.json()).id;
  // Workers run at once: another may have created it between the look and the post. Then it's there now.
  const after = res.status === 409 ? await idThere() : undefined;
  if (after !== undefined) return after;
  throw new Error(`creating ${product.name} in ${team.name}: ${res.status} ${await res.text()}`);
}

/**
 * Deletes each Product of `team` named one of `names`, through the API as the Team's Admin: a test that creates a
 * Product through the page clears what an earlier run (a retry, say) left behind.
 */
export async function removeProducts(team: Team, names: readonly string[]) {
  const admin = await asAdmin(team);
  const { origin, headers } = admin;
  for (const { id, name } of await listProducts(team, admin)) {
    if (!names.includes(name)) continue;
    const res = await fetch(`${origin}/api/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
    });
    // 404: another worker deleted it first.
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(`deleting ${name} in ${team.name}: ${res.status} ${await res.text()}`);
    }
  }
}

/** The server's origin and the headers that call the API as `team`'s Admin. */
export async function asAdmin(team: Team) {
  const origin = process.env.E2E_BASE_URL;
  if (!origin) throw new Error("E2E_BASE_URL is unset: run the browser tests with `pnpm e2e`");
  const token = await sessionToken(await signingKey(), origin, team.admin, team, "admin");
  return { origin, headers: { Authorization: `Bearer ${token}` } };
}

/** Calls the API at `path` as `team`'s Admin with `body` as JSON; throws unless it answers 2xx. */
export async function sendAsAdmin(
  team: Team,
  method: "PUT" | "POST",
  path: string,
  body: object,
): Promise<void> {
  const { origin, headers } = await asAdmin(team);
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} in ${team.name}: ${res.status} ${await res.text()}`);
  }
}

/** Where VDA ISA 2027.1 is turned on or off, and its Controls reviewed under `/controls/<ref>/reviews`. */
export const ISA_PATH = "/api/vouch/catalogues/vda-isa-2027.1";

/** Turns VDA ISA 2027.1 on or off for `team`, as its Admin, before a test reads Setup or the Overview. */
export const switchCatalogue = (team: Team, on: boolean) =>
  sendAsAdmin(team, "PUT", ISA_PATH, { on });

/** `team`'s Products, asked with the Admin call the caller already made, so its token is minted once. */
async function listProducts(team: Team, { origin, headers }: Awaited<ReturnType<typeof asAdmin>>) {
  const res = await fetch(`${origin}/api/products`, { headers });
  if (!res.ok)
    throw new Error(`listing ${team.name}'s Products: ${res.status} ${await res.text()}`);
  return ProductsBody.parse(await res.json()).products;
}

/**
 * Tags a test that signs in itself, as someone other than its file's usual person (in Cedar, say), so
 * `signInEachTest` leaves it alone: Playwright doesn't fix the order of two init scripts, so a second sign-in can't be
 * relied on to win.
 */
export const SIGNS_IN_ITSELF = { tag: "@signs-in-itself" };

/** Signs `person` in to `team` before each test of the calling file, except a test tagged `SIGNS_IN_ITSELF`. */
export function signInEachTest(person: Person, team: Team = ACME) {
  test.beforeEach(async ({ signIn }, testInfo) => {
    if (!testInfo.tags.includes(SIGNS_IN_ITSELF.tag)) await signIn(person, team);
  });
}

/** The browser tests' `test`: `baseURL` is the server the global setup started, and `signIn` signs a person in. */
export const test = base.extend<{
  signIn: (person: Person, team?: Team) => Promise<void>;
}>({
  // Playwright reads a fixture's dependencies from its first parameter's pattern: this one has none.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    await use(process.env.E2E_BASE_URL);
  },
  signIn: async ({ page, baseURL }, use) => {
    await use(async (person, team = ACME) => {
      const origin = new URL(baseURL!).origin;
      const role = person === team.admin ? "admin" : "member";
      const session = {
        token: await sessionToken(await signingKey(), origin, person, team, role),
        userId: person.userId,
        orgId: team.id,
        orgName: team.name,
        memberships: team.people.map((p) => ({
          userId: p.userId,
          firstName: p.firstName,
          lastName: p.lastName,
          identifier: p.email,
        })),
      };
      await signInPage(page, session);
    });
  },
});

function signInPage(page: Page, session: object) {
  return page.addInitScript((value) => {
    (window as unknown as { __WARDEN_E2E_SESSION__: object }).__WARDEN_E2E_SESSION__ = value;
  }, session);
}

export { expect } from "@playwright/test";
