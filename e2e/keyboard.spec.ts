// docs/design.md, Accessibility floor, on the Findings page and its Ask Warden panel: the keyboard reaches each card,
// filter tab and row (the button in its title cell), then the panel's controls, in order, and leaves them; focus shows a
// visible ring; and touch targets are at least 44 by 44px at phone width. On the Products page (in Cedar), the same for
// its Repo URL links, and for an Admin's Add, Edit and Product form.
import type { Locator, Page } from "@playwright/test";
import { expectRings, expectTargets } from "./a11y.ts";
import { cedarCveFinding, openCveCard } from "./cedar-cve.ts";
import {
  CEDAR,
  CHAT_ASSISTANT,
  ensureProduct,
  expect,
  GRACE,
  HEDY,
  KATHERINE,
  LANGCHAIN_SERVICE,
  signInEachTest,
  SIGNS_IN_ITSELF,
  test,
} from "./session.ts";

signInEachTest(GRACE);

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/findings");
  await expect(page.locator(".findings-table tbody tr")).toHaveCount(7);
  await expect(page.locator(".level-line")).toBeVisible();
}

/** What has focus, as a short name: a card's title, a tab's group and word, a row's title, or the tag. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    if (el.classList.contains("finding-card"))
      return `card:${el.querySelector(".card-title")?.textContent}`;
    if (el.classList.contains("filter-tab")) {
      return `tab:${el.closest("[role=group]")?.getAttribute("aria-label")}:${el.textContent}`;
    }
    if (el.classList.contains("finding-link")) {
      return `row:${el.querySelector(".finding-title")?.textContent}`;
    }
    const label = el.getAttribute("aria-label");
    return `${el.tagName.toLowerCase()}:${label ?? el.textContent}`;
  });

/** Presses Tab `times` times from where focus is, and names what each press reached. */
async function tabThrough(page: Page, times: number) {
  const reached: string[] = [];
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("Tab");
    reached.push(await focused(page));
  }
  return reached;
}

test("Tab reaches the Level line's link, each card, then each filter tab, then each row, in order, then the closed panel's button, and leaves", async ({
  page,
}) => {
  await open(page, 1024);
  await page.getByRole("button", { name: "Sign out" }).focus();

  expect(await tabThrough(page, 1)).toEqual(["a:see the journey"]);
  const reached = await tabThrough(page, 5 + 14 + 7 + 2);

  const cards = await page.locator(".finding-card .card-title").allTextContents();
  const tabs = await page
    .locator(".filter-tab")
    .evaluateAll((all) =>
      all.map(
        (t) => `tab:${t.closest("[role=group]")?.getAttribute("aria-label")}:${t.textContent}`,
      ),
    );
  const rows = await page.locator(".findings-table .finding-title").allTextContents();
  expect(reached.slice(0, 5)).toEqual(cards.map((title) => `card:${title}`));
  expect(reached.slice(5, 19)).toEqual(tabs);
  expect(reached.slice(19, 26)).toEqual(rows.map((title) => `row:${title}`));
  // After the last row, the closed Ask Warden panel's button; then focus leaves the page's controls.
  expect(reached.slice(26)).toEqual(["button:Ask Warden", "body"]);
});

test("Tab reaches the open panel's controls after the page's, in order, and then leaves them", async ({
  page,
}) => {
  await open(page, 1400);
  const lastRow = page.locator(".findings-table .finding-link").last();
  await page.locator(".finding-card").first().click();
  const panel = page.getByRole("complementary", { name: "Ask Warden" });
  await expect(panel).toHaveAttribute("data-shown", "floating");
  // Grace is a Member: an Open Finding's card offers her its Propose buttons (#59), once its Proposals have loaded
  // and none waits on it (#87).
  await expect(panel.getByRole("button", { name: "Propose accepting" })).toBeVisible();

  await lastRow.focus();
  expect(await tabThrough(page, 8)).toEqual([
    "button:Pin",
    "button:Close Ask Warden",
    "button:Clear the focus",
    "button:Propose accepting",
    "button:Propose False positive",
    "input:Message",
    "button:Send",
    "body",
  ]);

  await panel.getByRole("button", { name: "Pin" }).click();
  await expect(panel).toHaveAttribute("data-shown", "pinned");
  await lastRow.focus();
  expect(await tabThrough(page, 9)).toEqual([
    "div:Resize Ask Warden",
    "button:Unpin",
    "button:Close Ask Warden",
    "button:Clear the focus",
    "button:Propose accepting",
    "button:Propose False positive",
    "input:Message",
    "button:Send",
    "body",
  ]);
});

test("a focused card, filter tab, row, Level line link and Overview link each show a visible ring", async ({
  page,
}) => {
  await open(page, 1024);
  await expectRings(page, [
    page.getByRole("link", { name: "see the journey" }),
    page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Overview" }),
    page.locator(".finding-card").first(),
    page.locator(".filter-tab").nth(2),
    page.locator(".findings-table .finding-link").nth(1),
  ]);
});

test("the panel's button, Pin, ✕, divider, card's ✕, a Member's Propose buttons, input and Send each show a visible ring", async ({
  page,
}) => {
  await open(page, 1400);
  await expectRings(page, [page.getByRole("button", { name: "Ask Warden" })]);

  await page.locator(".finding-card").first().click();
  const panel = page.getByRole("complementary", { name: "Ask Warden" });
  await expectRings(page, [
    panel.getByRole("button", { name: "Pin" }),
    panel.getByRole("button", { name: "Close Ask Warden" }),
    panel.getByRole("button", { name: "Clear the focus" }),
    panel.getByRole("button", { name: "Propose accepting" }),
    panel.getByRole("button", { name: "Propose False positive" }),
    panel.getByRole("textbox", { name: "Message" }),
    panel.getByRole("button", { name: "Send" }),
  ]);

  await panel.getByRole("button", { name: "Pin" }).click();
  await expectRings(page, [panel.getByRole("separator", { name: "Resize Ask Warden" })]);
});

test("at 390px, every card, filter tab, row, page link and the Level line's link is at least 44 by 44px", async ({
  page,
}) => {
  await open(page, 390);
  const targets = page.locator(
    ".finding-card, .filter-tab, .findings-table .finding-link, .page-links a, .app-header button, .level-line a",
  );
  const sizes = await targets.evaluateAll((all) =>
    all.map((el) => {
      const box = el.getBoundingClientRect();
      return { what: el.textContent?.slice(0, 30), width: box.width, height: box.height };
    }),
  );
  expect(sizes.length).toBe(5 + 14 + 7 + 5 + 1 + 1);
  for (const size of sizes) {
    expect(size.width, size.what).toBeGreaterThanOrEqual(44);
    expect(size.height, size.what).toBeGreaterThanOrEqual(44);
  }
});

test(
  "on Products at 390px, the Products page link and each Repo URL link are at least 44 by 44px, and a Repo URL link shows a ring",
  SIGNS_IN_ITSELF,
  async ({ page, signIn }) => {
    await ensureProduct(CEDAR, CHAT_ASSISTANT);
    await signIn(KATHERINE, CEDAR);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/products");
    const repoLinks = page
      .locator(".product", { hasText: "Chat assistant" })
      .getByRole("list", { name: "Repo URLs" })
      .getByRole("link");
    await expect(repoLinks).toHaveCount(2);

    await expectTargets([
      page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Products" }),
      ...(await repoLinks.all()),
    ]);
    await expectRings(page, [repoLinks.first()]);
  },
);

test(
  "at 390px, a CVE Finding's Product link, NVD and OSV links are each at least 44 by 44px and show a ring",
  SIGNS_IN_ITSELF,
  async ({ page, signIn }) => {
    const finding = await cedarCveFinding((assessment) => assessment.links.osv.length > 0);
    await signIn(HEDY, CEDAR);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/findings");
    const links = (await openCveCard(page, finding)).locator(".patch-links").getByRole("link");
    await expect(links.first()).toHaveText("NVD");
    await expect(links.nth(1)).toHaveText(/^OSV/);
    // The Asset's Product name links to its entry on Products (#210).
    const product = page
      .locator(".detail-card")
      .getByRole("link", { name: LANGCHAIN_SERVICE.name, exact: true });

    const all = [product, ...(await links.all())];
    await expectTargets(all);
    await expectRings(page, all);
  },
);

test("at 390px, the panel's button, ✕, card's ✕, a Member's Propose buttons, input and Send are each at least 44 by 44px", async ({
  page,
}) => {
  await open(page, 390);
  await expectTargets([page.getByRole("button", { name: "Ask Warden" })]);

  // Pin and the divider aren't offered under 1100px: an open panel fills the screen.
  await page.locator(".finding-card").first().click();
  const panel = page.getByRole("complementary", { name: "Ask Warden" });
  await expect(panel).toHaveAttribute("data-shown", "full-screen");
  await expect(panel.getByRole("button", { name: "Pin" })).toHaveCount(0);
  await expect(panel.getByRole("separator")).toHaveCount(0);
  await expectTargets([
    panel.getByRole("button", { name: "Close Ask Warden" }),
    panel.getByRole("button", { name: "Clear the focus" }),
    panel.getByRole("button", { name: "Propose accepting" }),
    panel.getByRole("button", { name: "Propose False positive" }),
    panel.getByRole("textbox", { name: "Message" }),
    panel.getByRole("button", { name: "Send" }),
  ]);
});

/**
 * Edit's form on Chat assistant (two Repo URLs, Langflow and LiteLLM), as Cedar's Admin: each of its controls in Tab
 * order. The Internet-facing checkbox's touch target is its whole label row, so `targets` holds the row for it.
 */
function productFormControls(page: Page) {
  const form = page.getByRole("form", { name: "Edit Chat assistant" });
  /** A control, and its touch target when that's another element. */
  type Control = { control: Locator; target?: Locator };
  const one = (control: Locator): Control => ({ control });
  const row = (framework: string): Control[] => {
    const checkbox = { name: `Internet-facing, ${framework}` };
    return [
      one(form.getByRole("combobox", { name: `Framework, ${framework}` })),
      one(form.getByRole("textbox", { name: `Version, ${framework}` })),
      one(form.getByRole("combobox", { name: `Usage, ${framework}` })),
      {
        control: form.getByRole("checkbox", checkbox),
        // `has` reads its locator from inside each label, so it starts at the page.
        target: form.locator("label.check").filter({ has: page.getByRole("checkbox", checkbox) }),
      },
      one(form.getByRole("button", { name: `Remove ${framework}` })),
    ];
  };
  const controls: Control[] = [
    one(form.getByRole("textbox", { name: "Name" })),
    one(form.getByRole("textbox", { name: "Repo URL 1" })),
    one(form.getByRole("button", { name: "Remove Repo URL 1" })),
    one(form.getByRole("textbox", { name: "Repo URL 2" })),
    one(form.getByRole("button", { name: "Remove Repo URL 2" })),
    one(form.getByRole("button", { name: "Add a Repo URL" })),
    ...row("Langflow"),
    ...row("LiteLLM"),
    one(form.getByRole("button", { name: "Add a framework" })),
    one(form.getByRole("button", { name: "Save" })),
    one(form.getByRole("button", { name: "Cancel" })),
  ];
  return {
    form,
    inOrder: controls.map(({ control }) => control),
    targets: controls.map(({ control, target }) => target ?? control),
  };
}

test(
  "on Products at 390px, an Admin's Add and Edit, and every button, field, select and checkbox of the Product form, are at least 44 by 44px",
  SIGNS_IN_ITSELF,
  async ({ page, signIn }) => {
    await ensureProduct(CEDAR, CHAT_ASSISTANT);
    await signIn(HEDY, CEDAR);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/products");
    const edit = page.getByRole("button", { name: "Edit Chat assistant" });
    await expectTargets([page.getByRole("button", { name: "Add a Product" }), edit]);

    await edit.click();
    const { form, targets } = productFormControls(page);
    await expect(form.locator(".dependency-fields")).toHaveCount(2);
    // Every control the form holds is in the list.
    const controls = form.locator("button, input, select");
    expect(await controls.count()).toBe(targets.length);
    await expectTargets(targets);
  },
);

test(
  "the keyboard alone opens Edit's Product form, reaches each control in order with a visible ring, and leaves it, Esc putting focus back on Edit",
  SIGNS_IN_ITSELF,
  async ({ page, signIn }) => {
    await ensureProduct(CEDAR, CHAT_ASSISTANT);
    await signIn(HEDY, CEDAR);
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/products");
    const edit = page.getByRole("button", { name: "Edit Chat assistant" });
    await expectRings(page, [page.getByRole("button", { name: "Add a Product" }), edit]);

    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    const { form, inOrder } = productFormControls(page);
    await expect(inOrder[0]!).toBeFocused();
    for (const control of inOrder.slice(1)) {
      await page.keyboard.press("Tab");
      await expect(control).toBeFocused();
    }
    await expectRings(page, inOrder);

    // Past Cancel, focus leaves the form: the other Products' Edit buttons wait while it's open.
    await page.keyboard.press("Tab");
    expect(await form.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    await page.keyboard.press("Shift+Tab");
    await expect(form.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await expect(edit).toBeFocused();
  },
);

/** The delete confirm on Chat assistant, and its two buttons. */
function deleteConfirm(page: Page) {
  const confirm = page.getByRole("group", {
    name: "Delete Chat assistant? Its CVE Findings turn Fixed.",
  });
  return {
    confirm,
    remove: confirm.getByRole("button", { name: "Delete", exact: true }),
    cancel: confirm.getByRole("button", { name: "Cancel" }),
  };
}

test(
  "on Products at 390px, an Admin's Delete and the delete confirm's Delete and Cancel are at least 44 by 44px",
  SIGNS_IN_ITSELF,
  async ({ page, signIn }) => {
    await ensureProduct(CEDAR, CHAT_ASSISTANT);
    await signIn(HEDY, CEDAR);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/products");
    const open = page.getByRole("button", { name: "Delete Chat assistant" });
    await expectTargets([open]);

    await open.click();
    const { remove, cancel } = deleteConfirm(page);
    await expectTargets([remove, cancel]);
  },
);

test(
  "the keyboard alone opens the delete confirm, reaches its Delete and Cancel with a visible ring, and leaves it",
  SIGNS_IN_ITSELF,
  async ({ page, signIn }) => {
    await ensureProduct(CEDAR, CHAT_ASSISTANT);
    await signIn(HEDY, CEDAR);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/products");
    const open = page.getByRole("button", { name: "Delete Chat assistant" });
    await expectRings(page, [open]);

    await expect(open).toBeFocused();
    await page.keyboard.press("Enter");
    const { confirm, remove, cancel } = deleteConfirm(page);
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(remove).toBeFocused();
    await expectRings(page, [remove, cancel]);

    // Past Cancel, focus leaves the confirm, which stays open: it doesn't trap focus.
    await page.keyboard.press("Tab");
    expect(await confirm.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    await expect(confirm).toBeVisible();
  },
);
