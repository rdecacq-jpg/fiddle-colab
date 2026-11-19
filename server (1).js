const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, "rooms.json");
const CM = path.join(__dirname, "node_modules", "codemirror");
const read = f => fs.readFileSync(path.join(__dirname, f));
const PAGE = read("index.html"), SVG = read("favicon.svg"), PNG = read("favicon.png");
const K = ["html", "css", "js"];
const DEF = {
  html: '<h1>Bonjour !</h1>\n<button id="b">Clique-moi</button>\n<p id="o"></p>',
  css: "body{font-family:sans-serif;padding:1rem}\nbutton{padding:.5rem 1rem}",
  js: 'let n=0;\ndocument.getElementById("b").onclick=()=>{\n  document.getElementById("o").textContent="Clics : "+(++n);\n};'
};
const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const TYPES = { ".js": "text/javascript", ".css": "text/css" };
let saved = {}; try { saved = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch {}
const rooms = new Map();
let pt, uid = 0;

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    const s = saved[id];
    r = { clients: new Set(), fresh: !s, n: 0, tabs: {} };
    K.forEach(k => { const text = s ? s[k] : DEF[k]; r.tabs[k] = { text, v: 0, hist: [{ v: 0, text }] }; });
    rooms.set(id, r);
  }
  return r;
}
function persist() {
  clearTimeout(pt);
  pt = setTimeout(() => {
    rooms.forEach((r, id) => { if (!r.fresh) saved[id] = { html: r.tabs.html.text, css: r.tabs.css.text, js: r.tabs.js.text }; });
    const ids = Object.keys(saved); if (ids.length > 500) ids.slice(0, ids.length - 500).forEach(i => delete saved[i]);
    fs.writeFile(DATA, JSON.stringify(saved), () => {});
  }, 1500);
}
function diff(a, b) {
  const m = Math.min(a.length, b.length); let s = 0, t = 0;
  while (s < m && a[s] === b[s]) s++;
  while (t < m - s && a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
  return { s, e: a.length - t, ins: b.slice(s, b.length - t) };
}
// fusionne la modif du client (base -> cli) dans la version du serveur (base -> srv)
function merge(base, srv, cli) {
  const r = diff(base, srv), l = diff(base, cli);
  if (l.s === l.e && !l.ins) return srv;
  if (r.e <= l.s) { const d = r.ins.length - (r.e - r.s); return srv.slice(0, l.s + d) + l.ins + srv.slice(l.e + d); }
  if (l.e <= r.s) return srv.slice(0, l.s) + l.ins + srv.slice(l.e);
  return cli;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const send = (type, body) => { res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" }); res.end(body); };
  if (url === "/") { res.writeHead(302, { Location: "/r/" + crypto.randomBytes(4).toString("hex") }); return res.end(); }
  if (/^\/r\/[\w-]{1,40}$/.test(url)) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(PAGE); }
  if (url === "/favicon.svg") return send("image/svg+xml", SVG);
  if (url === "/favicon.png" || url === "/favicon.ico") return send("image/png", PNG);
  if (url.startsWith("/cm/")) {
    const f = path.normalize(path.join(CM, url.slice(4)));
    if (f.startsWith(CM + path.sep) && TYPES[path.extname(f)] && fs.existsSync(f)) return send(TYPES[path.extname(f)], fs.readFileSync(f));
  }
  res.writeHead(404); res.end("Introuvable");
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const m = /^\/ws\/([\w-]{1,40})$/.exec(req.url);
  if (!m) return ws.close();
  const r = getRoom(m[1]);
  const me = { id: ++uid, name: "", color: COLORS[r.n++ % COLORS.length], ws, on: false };
  const tx = (c, o) => c.ws.readyState === 1 && c.ws.send(JSON.stringify(o));
  const all = o => r.clients.forEach(c => c.on && tx(c, o));
  const others = o => r.clients.forEach(c => c.on && c !== me && tx(c, o));
  const list = () => [...r.clients].filter(c => c.on).map(c => ({ id: c.id, name: c.name, color: c.color }));
  ws.on("message", raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.type === "hello") {
      me.name = String(d.name || "Anonyme").slice(0, 20); me.on = true; r.clients.add(me);
      const tabs = {}; K.forEach(k => tabs[k] = { text: r.tabs[k].text, v: r.tabs[k].v });
      tx(me, { type: "init", you: { id: me.id, color: me.color }, fresh: r.fresh, tabs, peers: list() });
      return others({ type: "peers", peers: list() });
    }
    if (!me.on) return;
    if (d.type === "set" && K.includes(d.k) && typeof d.text === "string" && d.text.length < 300000) {
      const t = r.tabs[d.k]; let text = d.text;
      if (d.v !== t.v) { const b = t.hist.find(h => h.v === d.v); if (b) text = merge(b.text, t.text, text); }
      if (text !== t.text) {
        t.v++; t.text = text; t.hist.push({ v: t.v, text }); if (t.hist.length > 40) t.hist.shift();
        r.fresh = false; persist();
        all({ type: "set", k: d.k, text, v: t.v, from: me.id });
      } else tx(me, { type: "set", k: d.k, text, v: t.v, from: me.id });
    } else if (d.type === "cur" && K.includes(d.k)) others({ type: "cur", id: me.id, k: d.k, h: d.h, a: d.a });
    else if (d.type === "mouse") others({ type: "mouse", id: me.id, x: +d.x, y: +d.y });
  });
  ws.on("close", () => { r.clients.delete(me); if (me.on) all({ type: "peers", peers: list() }); });
});
setInterval(() => wss.clients.forEach(c => c.readyState === 1 && c.ping()), 30000);
server.listen(PORT, () => console.log("Fiddle collaboratif sur le port " + PORT));
