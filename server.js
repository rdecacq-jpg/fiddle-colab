const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PAGE = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const DEF = {
  html: '<h1>Bonjour !</h1>\n<button id="b">Clique-moi</button>\n<p id="o"></p>',
  css: "body{font-family:sans-serif;padding:1rem}\nbutton{padding:.5rem 1rem}",
  js: 'let n=0;\ndocument.getElementById("b").onclick=()=>{\n  document.getElementById("o").textContent="Clics : "+(++n);\n};'
};
const rooms = new Map(); // id -> { state, clients:Set }

function room(id) {
  if (!rooms.has(id)) rooms.set(id, { state: { ...DEF }, clients: new Set() });
  return rooms.get(id);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/") {
    const id = crypto.randomBytes(4).toString("hex");
    res.writeHead(302, { Location: "/r/" + id });
    return res.end();
  }
  if (/^\/r\/[A-Za-z0-9_-]{1,40}$/.test(url)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  res.writeHead(404);
  res.end("Introuvable");
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const m = /^\/ws\/([A-Za-z0-9_-]{1,40})$/.exec(req.url);
  if (!m) return ws.close();
  const r = room(m[1]);
  r.clients.add(ws);
  const count = () => {
    const msg = JSON.stringify({ type: "peers", n: r.clients.size });
    r.clients.forEach(c => c.readyState === 1 && c.send(msg));
  };
  ws.send(JSON.stringify({ type: "init", state: r.state }));
  count();
  ws.on("message", data => {
    let d;
    try { d = JSON.parse(data); } catch { return; }
    if (d.type !== "set" || !["html", "css", "js"].includes(d.k) || typeof d.text !== "string" || d.text.length > 500000) return;
    r.state[d.k] = d.text;
    const msg = JSON.stringify({ type: "set", k: d.k, text: d.text });
    r.clients.forEach(c => c !== ws && c.readyState === 1 && c.send(msg));
  });
  ws.on("close", () => {
    r.clients.delete(ws);
    if (r.clients.size) count();
    else setTimeout(() => { const x = rooms.get(m[1]); if (x && !x.clients.size) rooms.delete(m[1]); }, 6 * 3600 * 1000);
  });
});

server.listen(PORT, () => console.log("Fiddle collaboratif sur le port " + PORT));
