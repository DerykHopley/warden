// Loaded into the e2e server through NODE_OPTIONS (`--import`), which the local Scan Job starter hands on to each Scan
// Job it spawns. In a Scan Job (its Scan's id set) it waits SCAN_JOB_START_DELAY_MS before the Job runs, so a Scan
// that story 2's test starts stays queued while the page reads the list again after the start's 202. Without the wait,
// the Job (with no GitHub settings here, it fails each Guard Scan) could end the Scan before that read, and the test
// would never see it queued or running. The server itself, with no Scan's id, runs at once.
import { setTimeout as sleep } from "node:timers/promises";
import { SCAN_ID_VARIABLE } from "../server/src/scans.ts";

/** Far longer than the page's read of the list right after a 202, and shorter than its 5 s re-read. */
const SCAN_JOB_START_DELAY_MS = 3_000;

if (process.env[SCAN_ID_VARIABLE] !== undefined) await sleep(SCAN_JOB_START_DELAY_MS);
