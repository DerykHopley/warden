// Stories 2 and 1 (read half): a Member and an Admin each see the Team's Products, with their Repo URLs and the
// frameworks they use, and nothing on the page that changes them. In Cedar, the Team with no demo Findings.
import { CEDAR, CHAT_ASSISTANT, ensureProduct, expect, KATHERINE, test } from "./session.ts";

test.beforeAll(async () => {
  await ensureProduct(CEDAR, CHAT_ASSISTANT);
});

for (const [who, person] of [
  ["a Member", KATHERINE],
  ["an Admin", CEDAR.admin],
] as const) {
  test(`${who} sees each Product's name, Repo URLs and dependencies, with nothing to change them`, async ({
    page,
    signIn,
  }) => {
    await signIn(person, CEDAR);
    await page.goto("/products");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Products");

    const entry = page
      .locator(".product")
      .filter({ has: page.getByRole("heading", { level: 2, name: "Chat assistant" }) });
    await expect(entry).toBeVisible();
    const links = entry.getByRole("list", { name: "Repo URLs" }).getByRole("link");
    await expect(links).toHaveText(CHAT_ASSISTANT.repo_urls);
    for (const url of CHAT_ASSISTANT.repo_urls) {
      const link = links.filter({ hasText: url });
      await expect(link).toHaveAttribute("href", url);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    await expect(
      entry.getByRole("list", { name: "Dependencies" }).getByRole("listitem"),
    ).toHaveText([
      "Langflow 1.4.0 Self-hosted internet-facing",
      "LiteLLM version unknown Through another package",
    ]);

    // The page's own controls: none. The header's buttons and the Ask Warden panel's button are the shell's.
    const main = page.getByRole("main");
    await expect(main.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Products" }),
    ).toHaveAttribute("aria-current", "page");
  });
}
