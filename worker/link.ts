import type { Socket } from "node:net";
import { Endpoint, SecretKey, type BiStream, type RecvStream, type SendStream } from "@number0/iroh";

export const ALPN = [...Buffer.from("flocafe-sandbox/1")];
const MAX_FRAME = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;

export type SessionInfo = { id: string; ref: string; commit: string; startedAt: string; note?: string };
export type ExecOutput = { code: number; stdout: string; stderr: string; ms: number };
export type Request =
  | { type: "rpc"; method: "start"; ref: string }
  | { type: "rpc"; method: "exec"; session: string; argv: string[]; timeoutMs?: number }
  | { type: "rpc"; method: "readFile"; session: string; path: string }
  | { type: "rpc"; method: "stop"; session: string }
  | { type: "rpc"; method: "list" }
  | { type: "cdp"; session: string };
export type Response = { ok: true; session?: SessionInfo; sessions?: SessionInfo[]; output?: ExecOutput; file?: string } | { ok: false; error: string };

export async function bindEndpoint(): Promise<Endpoint> {
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.secretKey(SecretKey.generate().toBytes());
  builder.alpns([ALPN]);
  const endpoint = await builder.bind();
  await endpoint.online();
  return endpoint;
}

export const encode = (message: unknown) => [...Buffer.from(JSON.stringify(message))];
export const decode = <T>(bytes: number[] | Uint8Array): T => JSON.parse(Buffer.from(bytes).toString("utf8")) as T;

export async function writeFrame(send: SendStream, message: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  await send.writeAll([...header, ...body]);
}

export async function readFrame<T>(recv: RecvStream): Promise<T> {
  const size = Buffer.from(await recv.readExact(4)).readUInt32BE();
  if (size > MAX_FRAME) throw new Error(`frame too large: ${size}`);
  return JSON.parse(Buffer.from(await recv.readExact(size)).toString("utf8")) as T;
}

export function pipeStreamAndSocket(stream: BiStream, socket: Socket): void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    stream.send.finish().catch(() => {});
  };
  void (async () => {
    try {
      for (;;) {
        const chunk = await stream.recv.read(CHUNK);
        if (chunk.length === 0) break;
        if (!socket.write(Buffer.from(chunk))) await new Promise((resolve) => socket.once("drain", resolve));
      }
    } catch {
      // the remote side reset the stream
    }
    close();
  })();
  let writing = Promise.resolve();
  socket.on("data", (data: Buffer) => {
    socket.pause();
    writing = writing
      .then(() => stream.send.writeAll([...data]))
      .then(() => {
        socket.resume();
      })
      .catch(close);
  });
  socket.on("end", () => void writing.then(close));
  socket.on("error", close);
}
