// app.js
// Only load dotenv if no DB_NAME is set (avoid double-loading issues)
if (!process.env.DB_NAME) {
  require("dotenv").config();
}
const express = require("express");
const path = require("path");
const router = require("./router.js");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { pathToRegexp } = require("path-to-regexp");
const { pool } = require("./models");
const t = require("./temporal_api.utils");
const { startScheduler } = require("./cron");
const { ensureSettingsDefaults } = require("./settingsManager");
const { logRequest } = require("./logger.js");

const app = express();

// -------- Middlewares --------
// For webhook routes, capture raw body before JSON parsing (for signature verification)
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) {
    express.raw({ type: 'application/json', limit: '10mb' })(req, res, (err) => {
      if (err) return next(err);
      req._rawBody = req.body; // Buffer
      try {
        req.body = JSON.parse(req._rawBody.toString());
      } catch {
        req.body = null;
      }
      next();
    });
  } else {
    next();
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = [
    "http://localhost:7000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:8080",
    "http://localhost:5500",
    "http://localhost:3001", // Desktop app
];

app.use(
    cors({
        origin: allowedOrigins,
        credentials: true,
    })
);

app.use(cookieParser());

// -------- Auth Gate (production only) --------
const isProduction =
  String(process.env.ENVIRONMENT || "").toLowerCase() === "production" ||
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

function readJwt(req) {
  const token = req.cookies?.access_token;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET || "");
  } catch {
    return null;
  }
}

const publicPages = new Set([
  "/",
  "/login_customer",
  "/login_barber",
  "/register",
  "/aydinlatma",
  "/gizlilik",
  
]);

const publicApi = [
  "/api/auth/login",
  "/api/auth/verify",
  "/api/auth/logout",
  "/api/customers",
  "/api/businesses/current",
  "/api/branches/current",
  "/api/services",
  "/api/staff",
  "/api/branch_closures/today",
  "/api/cron/jobs",
  "/api/desktop/events/stream",
  "/api/desktop/events/ack",
  "/api/desktop/events/action",
  "/api/desktop/appointments/today",
  "/api/desktop/appointments/:id",
  // WhatsApp Cloud API Webhooks (Meta sends these without JWT)
  "/webhooks/whatsapp",
];

// Compile publicApi patterns to regex matchers at startup — runs once
const publicApiMatchers = publicApi.map((pattern) => {
  const { regexp, keys } = pathToRegexp(pattern);
  return { pattern, regexp, keys };
});

function isPublicApi(pathname) {
  return publicApiMatchers.some(({ regexp }) => regexp.test(pathname));
}

function isPublicAsset(pathname) {
  return (
    pathname.startsWith("/_app") ||
    pathname.startsWith("/assets") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  );
}

function loginRedirectForPath(pathname) {
  if (pathname.startsWith("/bPanel")) return "/login_barber";
  return "/login_customer";
}

app.use((req, res, next) => {
  if (!isProduction) return next();
  const pathname = req.path || "/";

  if (isPublicAsset(pathname)) return next();

  // WhatsApp webhooks bypass auth (Meta sends without JWT)
  if (pathname.startsWith("/webhooks/")) return next();

  if (pathname.startsWith("/api")) {
    if (isPublicApi(pathname)) return next();
    const decoded = readJwt(req);
    if (!decoded) return res.status(401).json({ ok: false, message: "Unauthenticated" });
    if (pathname === "/api/appointments/stream" && decoded.typ !== "user" && decoded.typ !== "barber") {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }
    return next();
  }

  if (publicPages.has(pathname)) return next();

  const decoded = readJwt(req);
  if (!decoded) {
    return res.redirect(302, loginRedirectForPath(pathname));
  }

  if (pathname.startsWith("/bPanel") && decoded.typ !== "user") {
    return res.redirect(302, "/login_barber");
  }
  if ((pathname.startsWith("/randevu") || pathname.startsWith("/randevular")) && decoded.typ !== "customer") {
    return res.redirect(302, "/login_customer");
  }

  return next();
});

// -------- Request Logger (site isteklerini logla) --------
app.use((req, res, next) => {
    // Sadece normal site isteklerini logla (API değil)
    if (!req.path.startsWith('/api') && !req.path.startsWith('/health') && !req.path.startsWith('/__routes')) {
        logRequest(req);
    }
    next();
});

// -------- Static Assets (Svelte build) --------
app.use(
  "/_app",
    express.static(path.join(__dirname, "public/_app"), {
        maxAge: "1y",
        immutable: true,
    })
);
app.use(express.static(path.join(__dirname, "public")));

const routerDumb = require('./routesDump.js');

app.get('/__routes', (req, res) => {
    const routes = routerDumb.listRoutes(router);
    res.json({ ok: true, routes });
});

// -------- Health Check --------
app.get("/health", (req, res) => {
    res.json({ ok: true });
});

// -------- API Routes --------
app.use("/api", router);

// -------- API 404 --------
app.use("/api", (req, res) => {
    res.status(404).json({ ok: false, message: "Not found" });
});

// -------- Pages (Static HTML) --------
const pageRouter = require("./pageRouter.js");
app.use(pageRouter);

// -------- Global Error Handler --------
app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || 500;
    res.status(status).json({
        ok: false,
        message: err.message || "Server error",
    });
});

// -------- Settings init --------
ensureSettingsDefaults().catch(console.error);

// -------- Scheduler --------
startScheduler();

// -------- Server --------
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
});

module.exports = app;
