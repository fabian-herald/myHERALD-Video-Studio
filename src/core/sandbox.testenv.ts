import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Redirect `DATA_DIR` and `OUT_DIR` at a temporary directory for this test process.
 *
 * Import this **first**, before anything that reaches `paths.ts`: ES modules evaluate
 * depth-first in source order, so being the first import is what puts this assignment
 * ahead of the constants it has to affect. Import it second and it does nothing at all.
 *
 *     import "./sandbox.testenv.ts";
 *     import {readLedger} from "./ledger.ts";
 *
 * Not named `*.test.ts` so the runner does not try to execute it as a suite.
 */
process.env.STUDIO_SANDBOX ??= fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-"));

export const SANDBOX_DIR = process.env.STUDIO_SANDBOX;
