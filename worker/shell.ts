import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Response, ShellInfo } from "./link.ts";

export const defaultShellDir = (env: NodeJS.ProcessEnv = process.env) => env.AGENT_SHELL_DIR ?? join(env.HOME ?? homedir(), ".agent-shell");

// The control center gets these five values and nothing else: the ticket is the
// only way in, the host key pins it, and the rest is where the agent works.
// Missing files mean the job ran without ssh_key, so there is no shell at all.
export async function shellResponse(dir = defaultShellDir()): Promise<Response> {
  const shell = await readShell(dir);
  return shell ? { ok: true, shell } : { ok: false, error: "no shell" };
}

async function readShell(dir: string): Promise<ShellInfo | null> {
  try {
    const [ticket, hostKey] = await Promise.all([readFile(join(dir, "ticket"), "utf8"), readFile(join(dir, "host_key.pub"), "utf8")]);
    if (!ticket.trim() || !hostKey.trim()) return null;
    return { ticket: ticket.trim(), hostKey: hostKey.trim(), user: "agent", home: "/home/agent", repo: "/home/agent/flocafe" };
  } catch {
    return null;
  }
}

// dumbpipe opens one local TCP connection to 127.0.0.1:22 per tunnel connection,
// so an established socket with port 22 on either end is a shell that is in use.
export const shellOpen = (listing: string) => listing.split("\n").some((line) => /[:.]22\s/.test(line));

const established = () =>
  new Promise<string>((resolve, reject) => {
    execFile("ss", ["-Htn", "state", "established"], (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

export async function shellConnectionOpen(list: () => Promise<string> = established): Promise<boolean> {
  try {
    return shellOpen(await list());
  } catch {
    // No ss, or it failed: keep the old rule rather than hold the runner open.
    return false;
  }
}

// An idle runner stops, unless an agent is still working over its shell.
export async function stopWhenIdle(idle: boolean, open: () => Promise<boolean> = shellConnectionOpen): Promise<boolean> {
  return idle && !(await open());
}
