// Runs the envelopes produced by the Rust contract code through the official
// closed validators from botiverse/raft-source (packages/desktop-contract).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const source = process.env.RAFT_SOURCE;
const fixture = process.env.CONTRACT_FIXTURE_OUT;
if (!source || !fixture) throw new Error("RAFT_SOURCE and CONTRACT_FIXTURE_OUT are required");

const ipc = await import(pathToFileURL(join(source, "packages/desktop-contract/src/ipc.ts")).href);
const envelopes = JSON.parse(readFileSync(fixture, "utf8")) as Array<Record<string, unknown>>;

let failed = 0;
for (const envelope of envelopes) {
  const valid = ipc.validateIpcResponse(envelope);
  console.log(`${valid ? "ok  " : "FAIL"} ${envelope.method} ${envelope.status}`);
  if (!valid) {
    failed += 1;
    console.log(JSON.stringify(envelope));
  }
}
if (envelopes.length < 9) failed += 1;
process.exit(failed ? 1 : 0);
