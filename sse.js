const { EventEmitter } = require("events");

// Singleton -tek instance, tüm require'lerde paylaşılır
const emitter = new EventEmitter();

// YENİ — desktop events için ayrı emitter
const desktopEmitter = new EventEmitter();

// Event ID generator
function generateEventId() {
  return 'evt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Event envelope factory
function makeEvent(type, name, payload = {}) {
  return {
    id: generateEventId(),
    type,
    name,
    timestamp: Math.floor(Date.now() / 1000),
    payload
  };
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseHandler(req, res) {
  console.log("SSE: New connection");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  sendEvent(res, "ready", { ok: true });

  const onAppointment = (payload) => {
    console.log("SSE: Sending appointment event", payload);
    sendEvent(res, "appointment", payload);
  };
  emitter.on("appointment", onAppointment);

  const keepAlive = setInterval(() => {
    sendEvent(res, "ping", { t: Date.now() });
  }, 25000);

  req.on("close", () => {
    console.log("SSE: Connection closed");
    clearInterval(keepAlive);
    emitter.off("appointment", onAppointment);
  });
}

function emitAppointment(payload) {
  console.log("EMIT: ", payload);
  emitter.emit("appointment", payload);
}

// =======================
// DESKTOP EVENTS SSE (YENİ)
// =======================
function desktopSseHandler(req, res) {
  // Header-based secret auth (CORS değil — native desktop app için)
  const secret = process.env.DESKTOP_EVENTS_SECRET;
  console.log("[DesktopSSE] Incoming request headers:", JSON.stringify(req.headers));
  console.log("[DesktopSSE] Expected secret:", secret, "| Received:", req.headers["x-desktop-secret"]);
  if (secret && req.headers["x-desktop-secret"] !== secret) {
    console.log("[DesktopSSE] Unauthorized — secret mismatch");
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
    return;
  }

  console.log("[DesktopSSE] Auth OK — New connection");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // ready/connected event — handshake
  const sendEvent = (eventObj) => {
    res.write(`event: ${eventObj.name}\n`);
    res.write(`data: ${JSON.stringify(eventObj)}\n\n`);
  };

  sendEvent(makeEvent("state", "connected", { ok: true }));

  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  // Wildcard listener — tüm event'leri client'a gönder
  const onEvent = (event) => {
    console.log(`[DesktopSSE] Broadcasting event: ${event.name}`, event.id);
    sendEvent(event);
  };

  desktopEmitter.on("*", onEvent);

  req.on("close", () => {
    console.log("[DesktopSSE] Connection closed");
    clearInterval(keepAlive);
    desktopEmitter.off("*", onEvent);
  });
}

// State veya command event gönder — tüm desktop SSE client'larına
function emitDesktopEvent(type, name, payload = {}) {
  const event = makeEvent(type, name, payload);
  desktopEmitter.emit("*", event);
  console.log(`[DesktopEvent] Emitted: ${name}`, event.id);
  return event;
}

module.exports = {
  sseHandler,
  emitAppointment,
  desktopSseHandler,
  emitDesktopEvent
};
