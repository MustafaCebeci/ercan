const { EventEmitter } = require("events");

// Singleton -tek instance, tüm require'lerde paylaşılır
const emitter = new EventEmitter();

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

module.exports = { sseHandler, emitAppointment };