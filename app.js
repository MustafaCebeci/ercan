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
const { pool } = require("./models");
const t = require("./temporal_api.utils");
// scheduler.js artık harici cronjob manager tarafından tetikleniyor
const { logRequest } = require("./logger.js");

const app = express();

// -------- Middlewares --------
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = [
    "http://localhost:7000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:8080",
    "http://localhost:5500",
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

const publicApi = new Set([
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
]);

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

async function isBranchClosedNow() {
  const z = t.now();
  const y = z.year;
  const m = String(z.month).padStart(2, "0");
  const d = String(z.day).padStart(2, "0");
  const startAt = `${y}-${m}-${d} 00:00:00`;
  const endAt = `${y}-${m}-${d} 23:59:59`;
  const [rows] = await pool.execute(
    `SELECT id
       FROM closures
      WHERE scope = 'global'
        AND status = 'active'
        AND start_at <= ?
        AND end_at >= ?
      LIMIT 1`,
    [endAt, startAt]
  );
  return rows.length > 0;
}

app.use((req, res, next) => {
  if (!isProduction) return next();
  const pathname = req.path || "/";

  if (isPublicAsset(pathname)) return next();

  if (pathname.startsWith("/api")) {
    if (publicApi.has(pathname)) return next();
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
  if (pathname.startsWith("/randevu") && decoded.typ !== "customer") {
    return res.redirect(302, "/login_customer");
  }

  return next();
});

// -------- Customer Page Guard (branch closed) --------
app.use(async (req, res, next) => {
  const pathname = req.path || "/";
  if (pathname.startsWith("/api")) return next();
  if (isPublicAsset(pathname)) return next();
  const isCustomerPage =
    pathname.startsWith("/randevu") ||
    pathname.startsWith("/success") ||
    pathname === "/login_customer" ||
    pathname === "/register";
  if (!isCustomerPage) return next();
  try {
    if (await isBranchClosedNow()) {
      return res.redirect(302, "/");
    }
  } catch (err) {
    console.error("branch closure check failed", err);
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

// -------- Server --------
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
});

module.exports = app;
