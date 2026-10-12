import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.RAFT_SOURCE) {
  console.error("Set RAFT_SOURCE to a checkout of https://github.com/botiverse/raft-source");
  process.exit(2);
}
const out = join(mkdtempSync(join(tmpdir(), "pontoon-")), "envelopes.json");
const env = { ...process.env, CONTRACT_FIXTURE_OUT: out };
execFileSync("cargo", ["test", "--lib", "contract::tests::envelopes_fixture"], { cwd: join(root, "src-tauri"), env: { CARGO_TARGET_DIR: join(root, "src-tauri/target-linux"), ...env }, stdio: "inherit" });
execFileSync(join(root, "node_modules/.bin/tsx"), [join(root, "tests/contract-check.mts")], { env, stdio: "inherit" });
