import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  // A test file shares one window: each test starts at `/`, whatever address the last one left. (A file in the node
  // environment has no window.)
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
    // The Ask Warden panel keeps a person's choice here: each test starts from the width default.
    window.localStorage.clear();
  }
});
