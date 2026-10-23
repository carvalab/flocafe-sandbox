const net = require("net");
const fs = require("fs");
let n = 0;
net
  .createServer((socket) => {
    const file = `/tmp/printed-${String(++n).padStart(3, "0")}.bin`;
    socket.pipe(fs.createWriteStream(file));
    socket.on("end", () => console.log("saved", file));
  })
  .listen(Number(process.env.PORT || 9100), "0.0.0.0", () => console.log("fake printer on", process.env.PORT || 9100));
