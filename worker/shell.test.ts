import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultShellDir, shellConnectionOpen, shellOpen, shellResponse, stopWhenIdle } from "./shell.ts";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyOfThisJob agent-shell";

test("the shell RPC answers with the ticket, the host key and where the agent works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  await writeFile(join(dir, "ticket"), "endpointabc123\n");
  await writeFile(join(dir, "host_key.pub"), `${HOST_KEY}\n`);
  assert.deepEqual(await shellResponse(dir), {
    ok: true,
    shell: { ticket: "endpointabc123", hostKey: HOST_KEY, user: "agent", home: "/home/agent", repo: "/home/agent/flocafe" },
  });
});

test("a job without ssh_key has no shell files, and the RPC says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  assert.deepEqual(await shellResponse(dir), { ok: false, error: "no shell" });
});

test("a ticket without its host key, or an empty one, is no shell either", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  await writeFile(join(dir, "ticket"), "endpointabc123\n");
  assert.deepEqual(await shellResponse(dir), { ok: false, error: "no shell" });
  await writeFile(join(dir, "host_key.pub"), `${HOST_KEY}\n`);
  await writeFile(join(dir, "ticket"), "\n");
  assert.deepEqual(await shellResponse(dir), { ok: false, error: "no shell" });
});

test("the shell dir is the worker's home unless AGENT_SHELL_DIR says otherwise", () => {
  assert.equal(defaultShellDir({ HOME: "/home/runner" }), "/home/runner/.agent-shell");
  assert.equal(defaultShellDir({ HOME: "/home/runner", AGENT_SHELL_DIR: "/tmp/s" }), "/tmp/s");
});

const ESTABLISHED = `0 0 127.0.0.1:22 127.0.0.1:51820
0 0 127.0.0.1:51820 127.0.0.1:22
`;

test("an established socket to port 22 means a shell is in use", () => {
  assert.equal(shellOpen(ESTABLISHED), true);
  assert.equal(shellOpen("0 0 127.0.0.1:3128 127.0.0.1:41234\n0 0 [::1]:2200 [::1]:41235\n"), false);
  assert.equal(shellOpen(""), false);
});

test("an idle worker keeps running while an SSH connection is open and stops once it closes", async () => {
  const open = () => Promise.resolve(ESTABLISHED);
  const closed = () => Promise.resolve("");
  assert.equal(await stopWhenIdle(true, open), false);
  assert.equal(await stopWhenIdle(true, closed), true);
  assert.equal(await stopWhenIdle(false, closed), false);
  // A probe that fails must not hold the runner open.
  assert.equal(await shellConnectionOpen(() => Promise.resolve(ESTABLISHED)), true);
  assert.equal(await shellConnectionOpen(() => Promise.reject(new Error("no ss"))), false);
});

