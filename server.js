const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

const PORT = process.env.PORT || 10000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "RMT_DEVICE_HOME";
const ACCESS_CODE = process.env.ACCESS_CODE || "123456";
const DEVICE_ID = process.env.DEVICE_ID || "RAMATECH_HOME_01";

let deviceSocket = null;
let deviceLastSeen = 0;
let latestStatus = {
  type: "status",
  deviceId: DEVICE_ID,
  online: false,
  light: false,
  rope: false,
  fan: false,
  tv: false
};

// Never serve the server source or config files to the public.
const PRIVATE_FILES = /^\/(server\.js|package(-lock)?\.json|readme\.txt|\.env.*|node_modules(\/.*)?)$/i;
app.use((req, res, next) => (PRIVATE_FILES.test(req.path) ? res.status(404).end() : next()));

app.use(express.static(path.join(__dirname)));

// Latest known appliance state (used by the app and by older "/status" callers).
app.get("/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ...latestStatus, online: !!deviceSocket });
});

// ---------------------------------------------------------------
// ONLINE TEXT-TO-SPEECH for Arabic and Yoruba (phones rarely have these voices).
//   Arabic : Google Translate voice, then Meta MMS (needs HF_TOKEN)
//   Yoruba : Meta MMS (needs HF_TOKEN), then Google Translate voice
// Protected by ACCESS_CODE, cached in memory, rate-limited.
// ---------------------------------------------------------------
app.set("trust proxy", true);
const HF_TOKEN = process.env.HF_TOKEN || "";
const GOOGLE_TTS_URL = process.env.GOOGLE_TTS_URL || "https://translate.google.com/translate_tts";
const HF_BASES = process.env.HF_TTS_BASE
  ? [process.env.HF_TTS_BASE]
  : ["https://router.huggingface.co/hf-inference/models/", "https://api-inference.huggingface.co/models/"];
const HF_MODELS = { ar: "facebook/mms-tts-ara", yo: "facebook/mms-tts-yor" };
const ttsCache = new Map();
const ttsHits = new Map();

async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(timer); }
}
async function googleTTS(lang, text) {
  const url = GOOGLE_TTS_URL + "?ie=UTF-8&client=tw-ob&tl=" + lang + "&q=" + encodeURIComponent(text);
  const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", "Referer": "https://translate.google.com/" } }, 12000);
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("audio")) throw new Error("google tts " + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), type };
}
async function hfTTS(lang, text) {
  if (!HF_TOKEN) throw new Error("HF_TOKEN is not set on this server");
  const errors = [];
  for (const base of HF_BASES) {
    try {
      const r = await fetchWithTimeout(base + HF_MODELS[lang], {
        method: "POST",
        headers: { Authorization: "Bearer " + HF_TOKEN, "Content-Type": "application/json", "x-wait-for-model": "true", Accept: "audio/*" },
        body: JSON.stringify({ inputs: text })
      }, 30000);
      const type = r.headers.get("content-type") || "";
      if (r.ok && type.startsWith("audio")) return { buf: Buffer.from(await r.arrayBuffer()), type };
      const body = (await r.text()).replace(/\s+/g, " ").slice(0, 160);
      errors.push(base + " -> HTTP " + r.status + " " + body);
    } catch (e) { errors.push(base + " -> " + e.message); }
  }
  throw new Error(errors.join(" | "));
}

// OPTIONAL: run Meta's MMS Yoruba model on this server (set YO_LOCAL=1 and `npm i @huggingface/transformers`).
let localSynth = null;
async function localMmsTTS(lang, text) {
  if (process.env.YO_LOCAL !== "1" || lang !== "yo") throw new Error("local MMS is off (set YO_LOCAL=1)");
  if (!localSynth) {
    const { pipeline } = await import("@huggingface/transformers");
    localSynth = await pipeline("text-to-speech", process.env.YO_LOCAL_MODEL || "Xenova/mms-tts-yor");
  }
  const out = await localSynth(text);
  const pcm = Buffer.alloc(out.audio.length * 2);
  for (let i = 0; i < out.audio.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out.audio[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(out.sampling_rate, 24); h.writeUInt32LE(out.sampling_rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return { buf: Buffer.concat([h, pcm]), type: "audio/wav" };
}
const PROVIDERS = { google: googleTTS, huggingface: hfTTS, "local-mms": localMmsTTS };
// Yoruba: the self-hosted Meta MMS voice first (Hugging Face's free API does not serve this model, Google has no Yoruba).
const TTS_CHAIN = { ar: ["google", "huggingface"], yo: ["local-mms", "huggingface"] };

// Open /tts-test?code=YOUR_ACCESS_CODE&lang=yo in a browser to see exactly which voice provider works.
app.get("/tts-test", async (req, res) => {
  if (req.query.code !== ACCESS_CODE) return res.status(403).end();
  const lang = req.query.lang === "ar" ? "ar" : "yo";
  const text = lang === "ar" ? "مرحبا سيدي" : "Báwo ni, Ọ̀gá";
  const report = { lang, hfTokenSet: !!HF_TOKEN, localMmsEnabled: process.env.YO_LOCAL === "1", providers: [] };
  for (const name of TTS_CHAIN[lang]) {
    const t0 = Date.now();
    try { const o = await PROVIDERS[name](lang, text); report.providers.push({ name, ok: true, bytes: o.buf.length, type: o.type, ms: Date.now() - t0 }); }
    catch (e) { report.providers.push({ name, ok: false, error: String(e.message).slice(0, 600), ms: Date.now() - t0 }); }
  }
  res.json(report);
});

app.get("/tts", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");           // lets the ESP32 local page use this voice
  res.set("Cache-Control", "no-store");
  const lang = String(req.query.lang || "");
  const text = String(req.query.text || "").trim();
  if (req.query.code !== ACCESS_CODE) return res.status(403).end();
  if (!TTS_CHAIN[lang] || !text || text.length > 260) return res.status(400).end();

  const now = Date.now();
  const hit = ttsHits.get(req.ip) || { n: 0, reset: now + 60000 };
  if (now > hit.reset) { hit.n = 0; hit.reset = now + 60000; }
  if (++hit.n > 60) return res.status(429).end();
  ttsHits.set(req.ip, hit);

  const key = lang + "|" + text;
  let out = ttsCache.get(key);
  if (!out) {
    for (const name of TTS_CHAIN[lang]) {
      try { out = await PROVIDERS[name](lang, text); break; }
      catch (e) { console.log("TTS provider '" + name + "' failed for " + lang + ": " + e.message); }
    }
    if (!out) return res.status(502).end();
    ttsCache.set(key, out);
    if (ttsCache.size > 300) ttsCache.delete(ttsCache.keys().next().value);
  }
  res.set("Content-Type", out.type);
  res.send(out.buf);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, deviceOnline: !!deviceSocket, deviceId: DEVICE_ID });
});

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function broadcast(data) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.role === "browser" && client.authenticated) {
      client.send(JSON.stringify(data));
    }
  }
}

function markOffline() {
  latestStatus.online = false;
  deviceLastSeen = 0;
  broadcast(latestStatus);
}

wss.on("connection", (ws) => {
  ws.authenticated = false;
  ws.role = null;
  ws.isAlive = true;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: "error", message: "Invalid JSON" }); }

    // DEVICE AUTHENTICATION
    if (msg.type === "auth" && msg.role === "device") {
      if (msg.token !== DEVICE_TOKEN || msg.deviceId !== DEVICE_ID) {
        return send(ws, { type: "auth_error" });
      }

      if (deviceSocket && deviceSocket !== ws) {
        try { deviceSocket.close(); } catch {}
      }

      deviceSocket = ws;
      ws.authenticated = true;
      ws.role = "device";
      ws.deviceId = DEVICE_ID;
      deviceLastSeen = Date.now();

      send(ws, { type: "auth_ok", deviceId: DEVICE_ID });
      return;
    }

    // BROWSER AUTHENTICATION
    if (msg.type === "auth" && msg.role === "browser") {
      if (msg.code !== ACCESS_CODE) {
        return send(ws, { type: "auth_error" });
      }

      ws.authenticated = true;
      ws.role = "browser";
      send(ws, { type: "auth_ok", deviceId: DEVICE_ID });
      send(ws, { ...latestStatus, online: !!deviceSocket });
      return;
    }

    if (!ws.authenticated) {
      return send(ws, { type: "auth_error", message: "Authenticate first" });
    }

    // DEVICE STATUS
    if (ws.role === "device" && msg.type === "status") {
      if (ws !== deviceSocket) return;
      latestStatus = {
        type: "status",
        deviceId: DEVICE_ID,
        online: true,
        light: !!msg.light,
        rope: !!msg.rope,
        fan: !!msg.fan,
        tv: !!msg.tv
      };
      deviceLastSeen = Date.now();
      broadcast(latestStatus);
      return;
    }

    // DEVICE PING/HEARTBEAT STATUS
    if (ws.role === "device" && msg.type === "heartbeat") {
      deviceLastSeen = Date.now();
      return;
    }

    // BROWSER COMMAND
    if (ws.role === "browser" && (msg.type === "command" || msg.type === "all" || msg.type === "status_request" || msg.type === "display")) {
      if (!deviceSocket || deviceSocket.readyState !== WebSocket.OPEN) {
        return send(ws, { type: "device_offline" });
      }

      if (msg.deviceId !== DEVICE_ID) return;

      send(deviceSocket, msg);
      return;
    }
  });

  ws.on("close", () => {
    if (ws === deviceSocket) {
      deviceSocket = null;
      markOffline();
    }
  });

  ws.on("error", () => {});
});

// Keepalive for WebSockets. Render recommends ping/pong and client reconnects.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }

  if (deviceSocket && Date.now() - deviceLastSeen > 45000) {
    try { deviceSocket.terminate(); } catch {}
    deviceSocket = null;
    markOffline();
  }
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RAMATECH HOME AI Cloud running on port ${PORT}`);
  console.log(`Device ID: ${DEVICE_ID}`);

  // Load the Yoruba voice in the background so the first spoken reply is not slow.
  if (process.env.YO_LOCAL === "1") {
    localMmsTTS("yo", "Báwo ni").then(() => console.log("Yoruba voice ready")).catch(e => console.log("Yoruba voice warm-up failed: " + e.message));
  }
});