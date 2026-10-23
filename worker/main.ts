import { connect as tcpConnect } from "node:net";
import { EndpointTicket, type BiStream, type Connection } from "@number0/iroh";
import { ALPN, bindEndpoint, decode, encode, pipeStreamAndSocket, readFrame, writeFrame, type Request, type Response, type SessionInfo } from "./link.ts";
import { Sandboxes, type Session } from "./sandboxes.ts";

const log = (message: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), message, ...fields }));
const ticket = process.env.CONTROL_TICKET;
const token = process.env.WORKER_TOKEN;
if (!ticket || !token) throw new Error("set CONTROL_TICKET and WORKER_TOKEN");

const sandboxes = new Sandboxes();
const endpoint = await bindEndpoint();
const info = (session: Session): SessionInfo => ({ id: session.id, ref: session.ref, commit: session.commit, startedAt: session.startedAt, ...(session.note ? { note: session.note } : {}) });

async function shutdown(reason: string) {
  log("stopping", { reason });
  await sandboxes.stopAll();
  await endpoint.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

setInterval(() => {
  void sandboxes.sweep().then((expired) => {
    if (expired.length) log("session reached its time limit", { expired });
    if (sandboxes.idle()) void shutdown("idle");
  });
}, 30_000);

async function handleRpc(request: Exclude<Request, { type: "cdp" }>): Promise<Response> {
  switch (request.method) {
    case "start":
      return { ok: true, session: info(await sandboxes.start(request.ref)) };
    case "exec":
      return { ok: true, output: await sandboxes.exec(request.session, request.argv, request.timeoutMs) };
    case "readFile":
      return { ok: true, file: (await sandboxes.readFile(request.session, request.path)).toString("base64") };
    case "stop":
      await sandboxes.stop(request.session);
      return { ok: true };
    case "list":
      return { ok: true, sessions: [...sandboxes.sessions.values()].map(info) };
  }
}

async function handleStream(stream: BiStream) {
  const request = await readFrame<Request>(stream.recv);
  if (request.type === "cdp") {
    const session = sandboxes.sessions.get(request.session);
    if (!session) return stream.send.reset(1n);
    pipeStreamAndSocket(stream, tcpConnect(session.cdpPort, "127.0.0.1"));
    return;
  }
  let response: Response;
  try {
    response = await handleRpc(request);
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  log("request", { method: request.method, ok: response.ok });
  await writeFrame(stream.send, response);
  await stream.send.finish();
}

async function ping(connection: Connection, message: unknown) {
  const stream = await connection.openBi();
  await stream.send.writeAll(encode(message));
  await stream.send.finish();
  return decode<{ type: string }>(await stream.recv.readToEnd(64 * 1024));
}

const connection = await endpoint.connect(EndpointTicket.fromString(ticket).endpointAddr(), ALPN);
if ((await ping(connection, { type: "hello", token })).type !== "ok") throw new Error("the control center refused this runner");
log("connected to the control center");
setInterval(() => ping(connection, { type: "ping" }).catch(() => connection.close(2n, [...Buffer.from("ping failed")])), 30_000);
try {
  for (;;) {
    const stream = await connection.acceptBi();
    handleStream(stream).catch((error) => log("request failed", { error: String(error) }));
  }
} catch {
  await shutdown("control center connection ended");
}
