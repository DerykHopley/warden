// Loaded with `--import` into the e2e server and each Scan Job it starts (the global setup's NODE_OPTIONS): installs
// the GitHub fake (`fake-github.ts`) in place of `globalThis.fetch`, logging to `E2E_FAKE_GITHUB_LOG` where it's set.
// The one module that installs it, so importing the fake anywhere else changes no process's fetch.
import { createFakeGitHub, fakeFetch } from "./fake-github.ts";

globalThis.fetch = fakeFetch(
  createFakeGitHub({ log: process.env.E2E_FAKE_GITHUB_LOG }),
  globalThis.fetch,
);
