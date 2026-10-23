import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRef, Sandboxes } from "./sandboxes.ts";

async function fakeBin() {
  const dir = await mkdtemp(join(tmpdir(), "fs-"));
  await mkdir(join(dir, "work"), { recursive: true });
  const script = (name: string, body: string) => writeFile(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await script("build-flocafe.sh", `printf '%s' "$1" > "$FLOCAFE_COMMIT"`);
  await script("start-flocafe.sh", "true");
  await script("start-browser.sh", "true");
  return dir;
}

test("a second start of the same ref reuses the session, and a different ref rebuilds in place", async () => {
  const bin = await fakeBin();
  process.env.FLOCAFE_COMMIT = join(bin, "work", "flocafe.commit");
  const sandboxes = new Sandboxes(bin);
  const first = await sandboxes.start("3.13.0");
  const second = await sandboxes.start("3.13.0");
  assert.equal(second.id, first.id);
  const switched = await sandboxes.start("main");
  assert.notEqual(switched.id, first.id);
  assert.equal(switched.ref, "main");
  assert.equal(sandboxes.sessions.size, 1);
});

test("a session past its time limit is swept, and the runner goes idle once nothing is left", async () => {
  const bin = await fakeBin();
  process.env.FLOCAFE_COMMIT = join(bin, "work", "flocafe.commit");
  const sandboxes = new Sandboxes(bin);
  const session = await sandboxes.start("3.13.0");
  session.startedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  assert.deepEqual(await sandboxes.sweep(), [session.id]);
  assert.equal(sandboxes.sessions.size, 0);
  assert.equal(sandboxes.idle(), false);
});

test("refuses refs that could be read as options or shell syntax", () => {
  for (const ref of ["--help", "-c", "--upload-pack=touch /tmp/x", "main; rm -rf /", "a b", "", "x".repeat(101), "$(id)"]) {
    assert.throws(() => checkRef(ref), /invalid ref/);
  }
});
