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
});
