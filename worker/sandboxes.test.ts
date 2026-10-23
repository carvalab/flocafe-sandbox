import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRef, cleanEnv, Sandboxes } from "./sandboxes.ts";

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

const SECRETS = { WORKER_TOKEN: "worker-secret-1111", CONTROL_TICKET: "ticket-secret-2222", ACTIONS_RUNTIME_TOKEN: "runtime-secret-3333", GITHUB_TOKEN: "ghs_secret_4444", MY_API_KEY: "key-secret-5555", DB_PASSWORD: "pw-secret-6666" };

test("cleanEnv drops every secret-looking variable, whatever its name, and keeps the ordinary ones", () => {
  const env = cleanEnv({ ...SECRETS, PATH: "/usr/bin", HOME: "/home/runner", CI: "true", NODE_OPTIONS: "--max-old-space-size=4096", npm_config_cache: "/tmp/npm", KEYBOARD: "us", MONKEY: "x" });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "KEYBOARD", "MONKEY", "NODE_OPTIONS", "PATH", "npm_config_cache"]);
});

test("a command, the build, the app and the browser start without the worker's secrets in their environment", async () => {
  const bin = await fakeBin();
  const dump = join(bin, "env-dump");
  const script = (name: string, body: string) => writeFile(join(bin, name), `#!/bin/sh
${body}
`, { mode: 0o755 });
  await script("build-flocafe.sh", `env >> "${dump}-build"; printf '%s' "$1" > "$FLOCAFE_COMMIT"`);
  await script("start-flocafe.sh", `env >> "${dump}-app"`);
  await script("start-browser.sh", `env >> "${dump}-browser"`);
  process.env.FLOCAFE_COMMIT = join(bin, "work", "flocafe.commit");
  const saved = { ...process.env };
  Object.assign(process.env, SECRETS, { VISIBLE_SETTING: "kept" });
  try {
    const sandboxes = new Sandboxes(bin);
    const session = await sandboxes.start("3.13.0");
    const env = await sandboxes.exec(session.id, ["sh", "-c", "env"]);
    const files = await Promise.all(["build", "app", "browser"].map((part) => readFile(`${dump}-${part}`, "utf8")));
    for (const text of [env.stdout, ...files]) {
      for (const [name, value] of Object.entries(SECRETS)) {
        assert.ok(!text.includes(value), `${name} leaked`);
        assert.ok(!text.includes(`${name}=`), `${name} is still named`);
      }
      assert.match(text, /VISIBLE_SETTING=kept/);
      assert.match(text, /\nPATH=/);
    }
  } finally {
    for (const name of Object.keys(SECRETS)) delete process.env[name];
    delete process.env.VISIBLE_SETTING;
    Object.assign(process.env, { PATH: saved.PATH });
  }
});
