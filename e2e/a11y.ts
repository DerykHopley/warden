// docs/design.md's Accessibility floor as the browser tests check it, shared by each spec that needs it: a visible
// focus ring when the keyboard reaches a control, and touch targets at least 44 by 44px.
import type { Locator, Page } from "@playwright/test";
import { expect } from "./session.ts";

/** Focuses `target` from the keyboard (from the control before it), and reads its outline. */
async function ring(page: Page, target: Locator) {
  await target.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  return target.evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
}

/** Fails unless each of `targets`, reached from the keyboard, shows a solid ring at least 2px wide. */
export async function expectRings(page: Page, targets: Locator[]) {
  for (const target of targets) {
    const { style, width } = await ring(page, target);
    expect(style, await target.evaluate((el) => el.outerHTML.slice(0, 80))).toBe("solid");
    expect(width).toBeGreaterThanOrEqual(2);
  }
}

/** Fails unless each of `targets` is at least 44 by 44px. */
export async function expectTargets(targets: Locator[]) {
  for (const target of targets) {
    const box = await target.boundingBox();
    const what = await target.evaluate((el) => el.outerHTML.slice(0, 80));
    expect(box, what).not.toBeNull();
    expect(box!.width, what).toBeGreaterThanOrEqual(44);
    expect(box!.height, what).toBeGreaterThanOrEqual(44);
  }
}
