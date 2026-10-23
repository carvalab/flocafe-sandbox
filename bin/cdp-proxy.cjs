const net = require("node:net");
net
  .createServer((client) => {
    const chrome = net.connect(9221, "127.0.0.1");
    client.pipe(chrome).pipe(client);
    client.on("error", () => chrome.destroy());
    chrome.on("error", () => client.destroy());
  })
  .listen(9222, "0.0.0.0");
