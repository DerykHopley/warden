import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./log.ts";
import { createShutdown } from "./shutdown.ts";

function setup(end: () => Promise<void>) {
  const lines: string[] = [];
  const deps = {
    close: vi.fn((done: () => void) => done()),
    end: vi.fn(end),
    exit: vi.fn(),
    logger: createLogger((line) => lines.push(line)),
  };
  return { deps, lines, shutdown: createShutdown(deps) };
}

describe("createShutdown", () => {
  it("closes the server and the pool once, however many signals arrive", async () => {
    const { deps, shutdown } = setup(() => new Promise((resolve) => setTimeout(resolve, 10)));

    shutdown("SIGTERM");
    shutdown("SIGINT");
    await vi.waitFor(() => expect(deps.exit).toHaveBeenCalled());

    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(deps.end).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("logs a pool that fails to close and exits 1", async () => {
    const { deps, lines, shutdown } = setup(() => Promise.reject(new Error("end failed")));

    shutdown("SIGTERM");
    await vi.waitFor(() => expect(deps.exit).toHaveBeenCalled());

    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lines.join("")).toContain("end failed");
  });
});
