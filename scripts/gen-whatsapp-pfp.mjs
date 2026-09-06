// Render docs/brand/whatsapp-pfp.svg -> docs/brand/whatsapp-pfp.png
// WhatsApp profile picture for the clinic (1024x1024, circular-crop safe).
// Same headless-Chrome-over-CDP approach as gen-handbook-pdf.mjs, but a
// Page.captureScreenshot of a sized viewport instead of printToPDF.
// Re-run after any edit to the SVG.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 9336;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SRC = new URL("../docs/brand/whatsapp-pfp.svg", import.meta.url).pathname;
const OUT = new URL("../docs/brand/whatsapp-pfp.png", import.meta.url).pathname;
const SIZE = 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/ortho-wa-pfp-profile", "about:blank",
], { stdio: "ignore" });
chrome.on("error", (e) => { console.error("chrome error", e); process.exit(1); });

async function browserWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("devtools never came up");
}

const ws = new WebSocket(await browserWs());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }));
});

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false }, S);
  await send("Page.enable", {}, S);
  await send("Page.navigate", { url: `file://${SRC}` }, S);
  for (let i = 0; i < 60; i++) {
    const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, S);
    if (r.result.value === "complete") break;
    await sleep(200);
  }
  await sleep(500);
  const { data } = await send("Page.captureScreenshot", {
    format: "png", fromSurface: true,
    clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 },
  }, S);
  const png = Buffer.from(data, "base64");
  writeFileSync(OUT, png);
  console.log(`PNG written -> ${OUT} (${png.length} bytes)`);
} catch (e) {
  console.error("PNG render failed:", e.message);
} finally {
  ws.close(); chrome.kill("SIGKILL"); await sleep(200); process.exit(0);
}