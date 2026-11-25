// Stories 1 and 2: a Member sees the Team's Products, with their Repo URLs and the frameworks they use, and nothing on
// the page that changes them; an Admin adds a Product on the page and changes it. In Cedar, the Team with no demo
// Findings.
import type { ProductInput } from "@warden/contracts";
import {
  CEDAR,
  CHAT_ASSISTANT,
  ensureProduct,
  expect,
  HEDY,
  KATHERINE,
  removeProducts,
  test,
} from "./session.ts";

test.beforeAll(async () => {
  await ensureProduct(CEDAR, CHAT_ASSISTANT);
});

test("a Member sees each Product's name, Repo URLs and dependencies, with nothing to change them", async ({
  page,
  signIn,
}) => {
  await signIn(KATHERINE, CEDAR);
  await page.goto("/products");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Products");

  const entry = page
    .locator(".product")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Chat assistant" }) });
  await expect(entry).toBeVisible();
  const links = entry.getByRole("list", { name: "Repo URLs" }).getByRole("link");
  await expect(links).toHaveText(CHAT_ASSISTANT.repo_urls);
  for (const url of CHAT_ASSISTANT.repo_urls) {
    await expect(links.filter({ hasText: url })).toHaveAttribute("href", url);
  }
  await expect(entry.getByRole("list", { name: "Dependencies" }).getByRole("listitem")).toHaveText([
    "Langflow 1.4.0 Self-hosted internet-facing",
    "LiteLLM version unknown Through another package",
  ]);

  // The page's own controls: none (the unit tests check each kind). The header's and the panel's buttons are the shell's.
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
});

/** This test's own Product, saved fresh each run, so the CVE Findings it reads can only come from its save. */
const VULNERABLE: ProductInput = {
  name: "Hedy's LangChain app",
  repo_urls: [],
  dependencies: [
    { framework: "langchain", version: "0.0.200", usage: "library", internet_facing: true },
  ],
};

test("a Product's save opens its CVE Findings from the loaded snapshot, on the Team's Findings page", async ({
  page,
  signIn,
}) => {
  await removeProducts(CEDAR, [VULNERABLE.name]);
  const id = await ensureProduct(CEDAR, VULNERABLE);
  await signIn(HEDY, CEDAR);
  await page.goto("/findings");

  // On the saved Product's Asset (a Finding names it by its id). How many the snapshot gives isn't fixed: a newer
  // snapshot changes it.
  const titles = page
    .getByRole("table", { name: "All Findings" })
    .getByRole("row")
    .filter({ has: page.locator(".asset-ref", { hasText: id }) })
    .locator(".finding-title")
    .filter({ hasText: /^CVE-\d{4}-\d+/ });
  await expect(titles.first()).toBeVisible();
});

/** This test's own Products, by name, so it never changes the Product another spec reads. */
const ADDED = "Hedy's research bot";
const RENAMED = "Hedy's research assistant";

test("an Admin adds a Product on the page, then changes it, and both last past a reload", async ({
  page,
  signIn,
}) => {
  await removeProducts(CEDAR, [ADDED, RENAMED]);
  await signIn(HEDY, CEDAR);
  await page.goto("/products");
  const main = page.getByRole("main");

  await main.getByRole("button", { name: "Add a Product" }).click();
  const form = main.getByRole("form", { name: "Add a Product" });
  await form.getByRole("textbox", { name: "Name" }).fill(ADDED);
  await form.getByRole("button", { name: "Add a Repo URL" }).click();
  await form.getByRole("textbox", { name: "Repo URL 1" }).fill("https://github.com/cedar/research");
  await form.getByRole("button", { name: "Add a Repo URL" }).click();
  await form
    .getByRole("textbox", { name: "Repo URL 2" })
    .fill("https://github.com/cedar/research-infra");
  // A new row is the first framework not yet picked (Langflow), a Library.
  await form.getByRole("button", { name: "Add a framework" }).click();
  await form
    .getByRole("combobox", { name: "Framework, Langflow" })
    .selectOption({ label: "LangChain" });
  await form.getByRole("textbox", { name: "Version, LangChain" }).fill("0.0.200");
  await form.getByRole("checkbox", { name: "Internet-facing, LangChain" }).check();
  await form.getByRole("button", { name: "Add a framework" }).click();
  await form
    .getByRole("combobox", { name: "Framework, Langflow" })
    .selectOption({ label: "Ollama" });
  await form
    .getByRole("combobox", { name: "Usage, Ollama" })
    .selectOption({ label: "Self-hosted" });
  await form.getByRole("button", { name: "Save" }).click();

  // The save runs the Product's Patch Scan before it answers; then the form closes and the list has the Product.
  await expect(form).toHaveCount(0);
  const entry = (name: string) =>
    main.locator(".product").filter({ has: page.getByRole("heading", { level: 2, name }) });
  await expect(entry(ADDED).getByRole("list", { name: "Repo URLs" }).getByRole("link")).toHaveText([
    "https://github.com/cedar/research",
    "https://github.com/cedar/research-infra",
  ]);
  const dependencies = (name: string) =>
    entry(name).getByRole("list", { name: "Dependencies" }).getByRole("listitem");
  await expect(dependencies(ADDED)).toHaveText([
    "LangChain 0.0.200 Library internet-facing",
    "Ollama version unknown Self-hosted",
  ]);

  // Edit opens with the Product as listed; the save sends it whole.
  await entry(ADDED)
    .getByRole("button", { name: `Edit ${ADDED}` })
    .click();
  const edit = main.getByRole("form", { name: `Edit ${ADDED}` });
  await edit.getByRole("textbox", { name: "Name" }).fill(RENAMED);
  await edit.getByRole("textbox", { name: "Version, LangChain" }).fill("0.1.0");
  await edit.getByRole("button", { name: "Remove Repo URL 2" }).click();
  await edit.getByRole("button", { name: "Remove Ollama" }).click();
  await edit.getByRole("button", { name: "Save" }).click();

  await expect(edit).toHaveCount(0);
  await page.reload();
  await expect(main.getByRole("heading", { level: 2, name: ADDED })).toHaveCount(0);
  await expect(
    entry(RENAMED).getByRole("list", { name: "Repo URLs" }).getByRole("link"),
  ).toHaveText(["https://github.com/cedar/research"]);
  await expect(dependencies(RENAMED)).toHaveText(["LangChain 0.1.0 Library internet-facing"]);
});
