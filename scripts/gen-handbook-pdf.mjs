// Render docs/handbook/ortho-handbook.html -> docs/Ramachandra-Ortho-Handbook.pdf
// using headless Chrome over the DevTools Protocol (no deps; Node 24 WebSocket).
// Re-run after every edit to the HTML.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 9334;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SRC = new URL("../docs/handbook/ortho-handbook.html", import.meta.url).pathname;
const OUT = new URL("../docs/Ramachandra-Ortho-Handbook.pdf", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/ortho-handbook-pdf-profile", "about:blank",
], { stdio: "ignore" });
chrome.on("error", (e) => { console.error("chrome error", e); process.exit(1); });

async function browserWs() {
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error("devtools never came up");
}

const ws = new WebSocket(await browserWs());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result); }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }));
});

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, S);
  await send("Page.navigate", { url: `file://${SRC}` }, S);
  for (let i = 0; i < 60; i++) {
    const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, S);
    if (r.result.value === "complete") break; await sleep(200);
  }
  await sleep(500);
  const { data } = await send("Page.printToPDF", {
    printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
  }, S);
  writeFileSync(OUT, Buffer.from(data, "base64"));
  console.log(`PDF written -> ${OUT} (${Math.round(Buffer.from(data, "base64").length / 1024)} KB)`);
} catch (e) {
  console.error("PDF render failed:", e.message);
} finally {
  ws.close(); chrome.kill("SIGKILL"); await sleep(200); process.exit(0);
}
