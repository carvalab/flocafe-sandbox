import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const MAX_OUTPUT = 1024 * 1024;
export const SESSION_MS = Number(process.env.SESSION_MS ?? 60 * 60_000);
const IDLE_MS = Number(process.env.IDLE_MS ?? 15 * 60_000);

type ExecResult = { code: number; stdout: string; stderr: string; ms: number };
export type Session = { id: string; ref: string; commit: string; cdpPort: number; startedAt: string; note?: string };

function run(file: string, args: string[], timeoutMs = 10 * 60_000): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT * 2 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: stdout.slice(-MAX_OUTPUT), stderr: stderr.slice(-MAX_OUTPUT), ms: Date.now() - started });
    });
  });
}

async function mustRun(file: string, args: string[], timeoutMs?: number): Promise<string> {
  const result = await run(file, args, timeoutMs);
  if (result.code !== 0) throw new Error(`${file} ${args.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function checkRef(ref: string): string {
  if (!/^[\w.][\w./-]{0,99}$/.test(ref)) throw new Error(`invalid ref: ${ref}`);
  return ref;
}

export class Sandboxes {
  readonly sessions = new Map<string, Session>();
  private lastActivity = Date.now();
  private built: { ref: string; commit: string } | null = null;
  private readonly bin: string;

  constructor(bin = process.env.SANDBOX_BIN ?? join(import.meta.dirname, "..", "bin")) {
    this.bin = bin;
  }

  private touch() {
    this.lastActivity = Date.now();
  }

  private expired(session: Session) {
    return Date.now() - Date.parse(session.startedAt) >= SESSION_MS;
  }

  async sweep(): Promise<string[]> {
    const expired = [...this.sessions.values()].filter((session) => this.expired(session)).map((session) => session.id);
    for (const id of expired) await this.stop(id);
    return expired;
  }

  idle() {
    return this.sessions.size === 0 && Date.now() - this.lastActivity >= IDLE_MS;
  }

  async start(ref: string): Promise<Session> {
    checkRef(ref);
    this.touch();
    const reusable = [...this.sessions.values()].find((session) => session.ref === ref && !this.expired(session));
    if (reusable) return reusable;
    for (const running of this.sessions.values()) await this.stop(running.id);
    const id = `fs-${randomBytes(4).toString("hex")}`;
    if (this.built?.ref !== ref) {
      this.built = null;
      const build = await run(this.bin + "/build-flocafe.sh", [ref], 20 * 60_000);
      if (build.code !== 0) throw new Error(`build of ${ref} failed: ${build.stderr || build.stdout}`);
      this.built = { ref, commit: (await mustRun("cat", [process.env.FLOCAFE_COMMIT ?? "/work/flocafe.commit"])).trim() };
    }
    const { commit } = this.built;
    const note = (await mustRun(this.bin + "/start-flocafe.sh", [], 120_000)).trim();
    await mustRun(this.bin + "/start-browser.sh", [], 60_000);
    const session: Session = { id, ref, commit, cdpPort: 9222, startedAt: new Date().toISOString(), ...(note ? { note } : {}) };
    this.sessions.set(id, session);
    return session;
  }

  async exec(id: string, argv: string[], timeoutMs = 120_000): Promise<ExecResult> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session ${id}`);
    if (this.expired(session)) throw new Error(`session ${id} reached its time limit`);
    if (argv.length === 0) throw new Error("empty command");
    this.touch();
    return run(argv[0], argv.slice(1), timeoutMs);
  }

  async readFile(id: string, path: string): Promise<Buffer> {
    const result = await this.exec(id, ["base64", "-w0", path], 60_000);
    if (result.code !== 0) throw new Error(result.stderr);
    return Buffer.from(result.stdout, "base64");
  }

  async stop(id: string): Promise<void> {
    this.sessions.delete(id);
    this.touch();
    await run("pkill", ["-f", "node (scripts|tests)/"]);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
