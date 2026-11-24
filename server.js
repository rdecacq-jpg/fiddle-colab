const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, "rooms.json");
const CM = path.join(__dirname, "node_modules", "codemirror");
const read = f => fs.readFileSync(path.join(__dirname, f));
const PAGE = read("index.html"), SVG = read("favicon.svg"), PNG = read("favicon.png");
const NAME = /^[\w][\w.-]{0,38}\.(html|css|js)$/i;
const tpl = n => /\.html$/i.test(n) ? '<!DOCTYPE html>\n<html lang="fr">\n<head>\n  <meta charset="utf-8">\n  <title>' + n + '</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  \n  <script src="script.js"></script>\n</body>\n</html>' : "";
const NAV = '<nav><a href="index.html">Accueil</a> | <a href="page2.html">Page 2</a></nav>\n  ';
const DEF = [
  ["index.html", tpl("index.html").replace("Accueil" , "Accueil").replace("<body>\n  ", "<body>\n  " + NAV + '<h1>Bonjour !</h1>\n  <button id="b">Clique-moi</button>\n  <p id="o"></p>\n  ').replace("<title>index.html", "<title>Accueil")],
  ["page2.html", tpl("page2.html").replace("<body>\n  ", "<body>\n  " + NAV + "<h1>Page 2</h1>\n  <p>Tu as navigué d'un fichier à l'autre !</p>\n  ").replace("<title>page2.html", "<title>Page 2")],
  ["style.css", "body{font-family:sans-serif;padding:1rem}\nnav a{margin:0 .3rem}\nbutton{padding:.5rem 1rem}"],
  ["script.js", 'let n=0;\nconst b=document.getElementById("b");\nif(b)b.onclick=()=>{\n  document.getElementById("o").textContent="Clics : "+(++n);\n};']
];
const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const TYPES = { ".js": "text/javascript", ".css": "text/css" };
let saved = {}; try { saved = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch {}
const rooms = new Map();
let pt, uid = 0;

const mk = text => ({ text, v: 0, hist: [{ v: 0, text }] });
function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    const s = saved[id], list = s && s.order ? s.order.map(n => [n, s.files[n]]) : DEF;
    r = { clients: new Set(), fresh: !(s && s.order), n: 0, order: list.map(x => x[0]), files: {} };
    list.forEach(([n, t]) => r.files[n] = mk(t));
    rooms.set(id, r);
  }
  return r;
}
function persist() {
  clearTimeout(pt);
  pt = setTimeout(() => {
    rooms.forEach((r, id) => {
      if (r.fresh) return;
      const files = {}; r.order.forEach(n => files[n] = r.files[n].text);
      saved[id] = { order: r.order, files };
    });
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
      const files = r.order.map(n => ({ name: n, text: r.files[n].text, v: r.files[n].v }));
      tx(me, { type: "init", you: { id: me.id, color: me.color }, fresh: r.fresh, files, peers: list() });
      return others({ type: "peers", peers: list() });
    }
    if (!me.on) return;
    const touch = () => { r.fresh = false; persist(); };
    if (d.type === "set" && r.files[d.name] && typeof d.text === "string" && d.text.length < 300000) {
      const t = r.files[d.name]; let text = d.text;
      if (d.v !== t.v) { const b = t.hist.find(h => h.v === d.v); if (b) text = merge(b.text, t.text, text); }
      if (text !== t.text) {
        t.v++; t.text = text; t.hist.push({ v: t.v, text }); if (t.hist.length > 40) t.hist.shift();
        touch(); all({ type: "set", name: d.name, text, v: t.v, from: me.id });
      } else tx(me, { type: "set", name: d.name, text, v: t.v, from: me.id });
    } else if (d.type === "add" && NAME.test(d.name) && !r.files[d.name] && r.order.length < 30) {
      const text = typeof d.text === "string" && d.text.length < 300000 ? d.text : tpl(d.name);
      r.files[d.name] = mk(text); r.order.push(d.name); touch(); all({ type: "add", name: d.name, text });
    } else if (d.type === "del" && r.files[d.name] && r.order.length > 1) {
      delete r.files[d.name]; r.order = r.order.filter(n => n !== d.name); touch(); all({ type: "del", name: d.name });
    } else if (d.type === "ren" && r.files[d.from] && NAME.test(d.to) && !r.files[d.to] && d.to.split(".").pop().toLowerCase() === d.from.split(".").pop().toLowerCase()) {
      r.files[d.to] = r.files[d.from]; delete r.files[d.from]; r.order = r.order.map(n => n === d.from ? d.to : n);
      touch(); all({ type: "ren", from: d.from, to: d.to });
    } else if (d.type === "cur" && r.files[d.f]) others({ type: "cur", id: me.id, f: d.f, h: d.h, a: d.a });
    else if (d.type === "mouse") others({ type: "mouse", id: me.id, x: +d.x, y: +d.y });
  });
  ws.on("close", () => { r.clients.delete(me); if (me.on) all({ type: "peers", peers: list() }); });
});
setInterval(() => wss.clients.forEach(c => c.readyState === 1 && c.ping()), 30000);
server.listen(PORT, () => console.log("Fiddle collaboratif sur le port " + PORT));
