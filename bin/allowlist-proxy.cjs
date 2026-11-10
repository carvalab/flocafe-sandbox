// The agent shell's only way out: an HTTP(S) proxy on loopback that allows a
// short host list. Egress for uid agent is a DROP rule, so a program that
// ignores HTTPS_PROXY cannot leave at all, and one that uses the proxy reaches
// only these hosts.
const http = require("node:http");
const net = require("node:net");

const PORT = Number(process.env.AGENT_SHELL_PROXY_PORT ?? 3128);
// A leading dot matches a whole domain: ".githubusercontent.com" is *.githubusercontent.com.
const ALLOWED = (process.env.AGENT_SHELL_ALLOW ?? ".githubusercontent.com,github.com,codeload.github.com,api.github.com,registry.npmjs.org").split(",").filter(Boolean);
const allowed = (host) => ALLOWED.some((name) => (name.startsWith(".") ? host.endsWith(name) && host.length > name.length : host === name));
const log = (host, verdict) => console.log(`${new Date().toISOString()} ${verdict} ${host}`);

const deny = (body) => ({ status: 403, body: `the agent shell proxy does not allow this host\n${body}` });

const server = http.createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host ?? ""}`);
  } catch {
    response.writeHead(400).end("bad request\n");
    return;
  }
  if (!allowed(url.hostname)) {
    log(url.hostname, "deny");
    const { status, body } = deny("");
    response.writeHead(status).end(body);
    return;
  }
  log(url.hostname, "allow");
  const upstream = http.request(
    { host: url.hostname, port: url.port || 80, method: request.method, path: url.pathname + url.search, headers: request.headers },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => response.destroy());
  request.pipe(upstream);
});

// TLS and git use CONNECT: the host check happens on the name before any byte flows.
server.on("connect", (request, socket, head) => {
  const [host, port = "443"] = request.url.split(":");
  if (!allowed(host)) {
    log(host, "deny");
    socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${deny("").body}`);
    return;
  }
  log(host, "allow");
  const upstream = net.connect(Number(port), host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`allowlist proxy on 127.0.0.1:${PORT}`));
