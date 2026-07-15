// controllers.js
const { Models, pool } = require("./models");
const t = require("./temporal_api.utils");
const jwt = require("jsonwebtoken");
const { sendOtp, verifyOtp, sendSms, sendCancellationSms } = require("./notification.service.js");
const { emitAppointment, emitDesktopEvent } = require("./sse");

// --------------- Helpers ---------------
function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function asyncWrap(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const DEFAULT_STAFF_IMAGE = "/assets/ni.png";

function getPersonalBusinessId() {
    const raw = process.env.PERSONAL_BUSINESS_ID ?? process.env.BUSINESS_ID;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : 1;
}

function getPersonalBranchId() {
    const raw = process.env.PERSONAL_BRANCH_ID ?? process.env.BRANCH_ID;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : 1;
}

async function getBusinessSettingsJson() {
    const [rows] = await pool.execute(
        `SELECT settings_json FROM app_settings WHERE id = 1 LIMIT 1`
    );
    let settingsJson = rows[0]?.settings_json;
    if (typeof settingsJson === "string") {
        try { settingsJson = JSON.parse(settingsJson); } catch { settingsJson = {}; }
    }
    return settingsJson || {};
}

async function getAppSettingsRow(conn = pool) {
    const [rows] = await conn.execute(
        `SELECT settings_json, updated_at FROM app_settings WHERE id = 1 LIMIT 1`
    );
    let settingsJson = rows[0]?.settings_json;
    if (typeof settingsJson === "string") {
        try { settingsJson = JSON.parse(settingsJson); } catch { settingsJson = {}; }
    }
    return { settingsJson: settingsJson || {}, updated_at: rows[0]?.updated_at ?? null };
}

async function ensureStaffProvider(staffId, conn = pool) {
    const id = Number(staffId);
    if (!id) return null;

    // Yeni sistem: staffId aslında provider_id olabilir, once id ile ara
    const [rows] = await conn.execute(
        `SELECT id, provider_type, code, name, staff_id, capacity, meta_json, is_active
           FROM service_providers
          WHERE id = ?
          LIMIT 1`,
        [id]
    );
    if (rows.length) return rows[0];

    // Eski sistem: staff_id ile de dene (geriye uyumluluk)
    const [rowsByStaffId] = await conn.execute(
        `SELECT id, provider_type, code, name, staff_id, capacity, meta_json, is_active
           FROM service_providers
          WHERE staff_id = ?
          LIMIT 1`,
        [id]
    );
    if (rowsByStaffId.length) return rowsByStaffId[0];

    // Staff yoksa olustur
    const [stRows] = await conn.execute(
        `SELECT id, full_name, is_active FROM staff WHERE id = ? LIMIT 1`,
        [id]
    );
    const st = stRows[0];
    if (!st) return null;

    try {
        const [result] = await conn.execute(
            `INSERT INTO service_providers (provider_type, name, staff_id, capacity, is_active)
             VALUES ('staff', ?, ?, 1, ?)`,
            [st.full_name, id, Number(st.is_active) === 0 ? 0 : 1]
        );

        return {
            id: result.insertId,
            provider_type: "staff",
            code: null,
            name: st.full_name,
            staff_id: id,
            capacity: 1,
            meta_json: null,
            is_active: Number(st.is_active) === 0 ? 0 : 1,
        };
    } catch (err) {
        if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
            const [rows2] = await conn.execute(
                `SELECT id, provider_type, code, name, staff_id, capacity, meta_json, is_active
                   FROM service_providers
                  WHERE staff_id = ?
                  LIMIT 1`,
                [id]
            );
            return rows2[0] || null;
        }
        throw err;
    }
}

async function createConfirmedAppointmentWithSlots({
    conn,
    provider,
    service,
    customerId,
    startAt,
    durationMin,
    slotTimes,
    slotRangeStart,
    slotRangeEnd,
    customerNote,
    changedBy = "system",
    isCustom = false,
    customServiceName = "Özel Randevu",
    customPrice = null,
}) {
    if (!conn) throw httpError(500, "DB connection missing");
    if (!provider?.id) throw httpError(500, "Provider missing");
    if (!isCustom && !service?.id) throw httpError(500, "Service missing");
    if (!customerId) throw httpError(400, "customerId missing");
    if (!startAt) throw httpError(400, "startAt missing");
    if (!Number.isFinite(Number(durationMin)) || Number(durationMin) <= 0) {
        throw httpError(500, "Invalid duration");
    }
    if (!Array.isArray(slotTimes) || slotTimes.length === 0) {
        throw httpError(500, "Slot range invalid");
    }

    const serviceIdToInsert = isCustom ? null : service.id;
    const serviceNameSnapshot = isCustom ? customServiceName : service.name;
    const serviceDurationSnapshot = isCustom ? durationMin : service.duration_minutes;
    const servicePriceSnapshot = isCustom ? customPrice : (service.price ?? null);

    const endAtSqlExpr = `DATE_ADD(?, INTERVAL ? MINUTE)`;

    const [r1] = await conn.execute(
        `
        INSERT INTO appointments
          (
            provider_id, service_id, is_custom, customer_id,
            start_at, end_at,
            service_name_snapshot, service_duration_minutes_snapshot, service_price_snapshot,
            provider_name_snapshot, provider_type_snapshot,
            customer_note
          )
        VALUES
          (?, ?, ?, ?, ${endAtSqlExpr}, ?, ?, ?, ?, ?, ?)
        `,
        [
            provider.id,
            serviceIdToInsert,
            isCustom ? 1 : 0,
            customerId,
            startAt,
            startAt,
            serviceNameSnapshot,
            serviceDurationSnapshot,
            servicePriceSnapshot,
            provider.name,
            provider.provider_type,
            customerNote ?? null,
        ]
    );

    const appointmentId = r1.insertId;

    await conn.execute(
        `DELETE s FROM appointment_slots s
         INNER JOIN appointments a ON a.id = s.appointment_id
         WHERE s.provider_id = ?
           AND s.slot_time >= ?
           AND s.slot_time < ?
           AND a.status <> 'confirmed'`,
        [provider.id, slotRangeStart, slotRangeEnd]
    );

    const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ");
    const slotParams = [];
    for (const t of slotTimes) {
        slotParams.push(appointmentId, provider.id, t);
    }
    await conn.execute(
        `INSERT INTO appointment_slots (appointment_id, provider_id, slot_time)
         VALUES ${slotValues}`,
        slotParams
    );

    await conn.execute(
        `INSERT INTO appointment_status_history
         (appointment_id, old_status, new_status, changed_by, note)
         VALUES (?, ?, 'confirmed', ?, ?)`,
        [appointmentId, null, changedBy, null]
    );

    return appointmentId;
}

// --------------- JWT helpers ---------------
function mustJwtSecret() {
    const s = process.env.JWT_SECRET;
    if (!s) throw httpError(500, "ENV eksik: JWT_SECRET");
    return s;
}

function cookieOptions({ maxAge } = {}) {
    // Local dev i�in default: secure=false, sameSite=Lax
    const secure = String(process.env.COOKIE_SECURE || "0") === "1";
    const sameSite = process.env.COOKIE_SAMESITE || (secure ? "none" : "lax");
    return {
        httpOnly: true,
        secure,
        sameSite, // "lax" | "none" | "strict"
        path: "/",
        maxAge: Number(
            maxAge ?? process.env.JWT_COOKIE_MAXAGE_MS ?? 7 * 24 * 60 * 60 * 1000
        ),
    };
}

function signJwt(payload, { expiresIn } = {}) {
    const secret = mustJwtSecret();
    const ttl = expiresIn || process.env.JWT_EXPIRES_IN || "7d";
    return jwt.sign(payload, secret, { expiresIn: ttl });
}

function readJwtFromReq(req) {
    const token = req.cookies?.access_token;
    if (!token) return null;
    try {
        return jwt.verify(token, mustJwtSecret());
    } catch {
        return null;
    }
}

// --------------- AUTH ---------------
// Tek ak��:
// POST /api/auth/login  -> OTP �ret + DB kaydet + sms/email g�nder
// POST /api/auth/verify -> OTP do�rula + JWT �ret + cookie bas
const AuthControllers = {
    login: asyncWrap(async (req, res) => {
        const body = req.body || {};
        const userType = body.userType; // "customer" | "user" | "barber"
        if (userType !== "customer" && userType !== "user" && userType !== "barber") {
            throw httpError(400, "userType sadece 'customer', 'user' veya 'barber' olabilir.");
        }

        // CUSTOMER LOGIN: phone ile (varsa bul, yoksa olu�tur)
        if (userType === "customer") {
            const phone = String(body.phone || "").trim();
            if (!phone) throw httpError(400, "phone zorunlu");

            const [rows] = await pool.execute(
                `SELECT id, phone, display_name, is_active FROM customers WHERE phone = ? LIMIT 1`,
                [phone]
            );

            const customer = rows[0];
            const customerId = customer?.id;
            if (!customerId) {
                const redirectUrl = `/register?phone=${encodeURIComponent(phone)}`;
                return res.status(404).json({
                    ok: false,
                    message: "Customer not found",
                    redirect_url: redirectUrl,
                });
            }
            if (Number(customer.is_active) === 0) {
                throw httpError(403, "Hesap pasif");
            }
            const [flagRows] = await pool.execute(
                `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
                [customerId]
            );
            if (flagRows[0]?.is_blacklisted) {
                return res.status(403).json({
                    ok: false,
                    message: "Hesabiniz kara listeye alinmistir.",
                });
            }

            const resp = await sendOtp({
                user_type: "customer",
                user_id: customerId,
                destinationOverride: phone,
            });

            return res.json({
                ok: true,
                userType,
                userId: customerId,
                channel: resp.channel, // "sms"
            });
        }

        // USER LOGIN (branch_account): phone ile OTP gönder
        const email = String(body.email || "").trim().toLowerCase();
        const phone = String(body.phone || "").trim();

        // Barber login: phone ile staff_account + staff bul
        if (userType === "barber" || phone) {
            console.log('[DEBUG LOGIN] userType:', userType, '| phone:', phone);
            if (!phone) throw httpError(400, "phone zorunlu");

            // staff_account'u staff.phone ile bul
            const [accRows] = await pool.execute(
                `SELECT sa.id, sa.is_active, s.phone as staff_phone
                    FROM staff_accounts sa
                    LEFT JOIN staff s ON s.id = sa.staff_id
                    WHERE s.phone = ?
                    LIMIT 1`,
                [phone]
            );

            console.log('[DEBUG LOGIN] accRows length:', accRows.length);
            console.log('[DEBUG LOGIN] accRows:', JSON.stringify(accRows));

            const acc = accRows[0];
            if (!acc) {
                console.log('[DEBUG LOGIN] Account not found for phone:', phone);
                throw httpError(401, "Geçersiz giriş");
            }
            console.log('[DEBUG LOGIN] Account found:', acc.id, '| is_active:', acc.is_active);
            if (acc.is_active === 0) throw httpError(403, "Hesap pasif");

            console.log('[DEBUG LOGIN] Calling sendOtp for staff_account:', acc.id, '| phone:', acc.staff_phone);
            const resp = await sendOtp({
                user_type: "staff_account",
                user_id: acc.id,
                destinationOverride: acc.staff_phone,
            });

            return res.json({
                ok: true,
                userType,
                userId: acc.id,
                channel: resp.channel,
            });
        }

        if (!email) {
            // Email login disabled - staff_accounts table has no email column
            throw httpError(400, "Geçersiz giriş - telefon ile giriş yapın");
        }

        const [accRows] = await pool.execute(
            `SELECT id, is_active, staff_id
                FROM staff_accounts
                WHERE id = ?
                LIMIT 1`,
            [email]
        );

        const acc = accRows[0];
        if (!acc) throw httpError(401, "Geçersiz giriş");
        if (acc.is_active === 0) throw httpError(403, "Hesap pasif");

        console.log('[DEBUG LOGIN] Calling sendOtp for staff (alt login):', acc.id);
        const resp = await sendOtp({
            user_type: "staff_account",
            user_id: acc.id,
            destinationOverride: null,
        });

        return res.json({
            ok: true,
            userType,
            userId: acc.id,
            channel: resp.channel,
        });
    }),

    verify: asyncWrap(async (req, res) => {
        const body = req.body || {};
        const userType = body.userType; // "customer" | "user"
        const userId = Number(body.userId);
        const code = String(body.code || "").trim();

        if (userType !== "customer" && userType !== "user" && userType !== "barber") {
            throw httpError(400, "userType sadece 'customer', 'user' veya 'barber' olabilir.");
        }
        if (!userId || Number.isNaN(userId)) throw httpError(400, "userId zorunlu");
        if (!code) throw httpError(400, "code zorunlu");

        const mapped = userType === "customer" ? "customer" : "staff_account";

        const v = await verifyOtp({ user_type: mapped, user_id: userId, code });
        if (!v.ok) {
            return res.status(401).json({ ok: false, reason: v.reason });
        }

        let payload = { sub: userId, typ: userType };

        if (userType === "user") {
            const [rows] = await pool.execute(
                `SELECT id, staff_id, is_admin, is_active
                    FROM staff_accounts
                    WHERE id = ?
                    LIMIT 1`,
                [userId]
            );
            const u = rows[0];
            if (!u) throw httpError(404, "Kullan�c� bulunamad�");
            if (Number(u.is_active) === 0) throw httpError(403, "Hesap pasif");

            payload = {
                sub: userId,
                typ: "user",
                business_id: getPersonalBusinessId(),
                branch_id: getPersonalBranchId(),
                staff_id: u.staff_id ?? null,
                is_admin: Number(u.is_admin ?? 0) === 1 ? 1 : 0,
            };

            await pool.execute(`UPDATE staff_accounts SET last_login_at = ? WHERE id = ?`, [t.toISODateTime(t.now()), userId]);
        } else if (userType === "barber") {
            // Barber: staff_account + staff bilgisi
            const [rows] = await pool.execute(
                `SELECT sa.id, sa.staff_id, sa.is_admin, sa.is_active,
                        s.full_name as staff_name, s.phone as staff_phone
                    FROM staff_accounts sa
                    LEFT JOIN staff s ON s.id = sa.staff_id
                    WHERE sa.id = ?
                    LIMIT 1`,
                [userId]
            );
            const u = rows[0];
            if (!u) throw httpError(404, "Kullanıcı bulunamadı");
            if (Number(u.is_active) === 0) throw httpError(403, "Hesap pasif");

            payload = {
                sub: userId,
                typ: "barber",
                business_id: getPersonalBusinessId(),
                branch_id: getPersonalBranchId(),
                staff_id: u.staff_id ?? null,
                staff_name: u.staff_name ?? null,
                is_admin: Number(u.is_admin ?? 0) === 1 ? 1 : 0,
            };

            await pool.execute(`UPDATE staff_accounts SET last_login_at = ? WHERE id = ?`, [t.toISODateTime(t.now()), userId]);
        } else {
            const [rows] = await pool.execute(
                `SELECT id, phone, display_name FROM customers WHERE id = ? LIMIT 1`,
                [userId]
            );
            const c = rows[0];
            if (!c) throw httpError(404, "M��teri bulunamad�");
            const [flagRows] = await pool.execute(
                `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
                [userId]
            );
            if (flagRows[0]?.is_blacklisted) {
                return res.status(403).json({
                    ok: false,
                    message: "Hesabiniz kara listeye alinmistir.",
                });
            }

            payload = {
                sub: userId,
                typ: "customer",
                phone: c.phone,
                display_name: c.display_name ?? null,
            };
        }

        const isUser = userType === "user" || userType === "barber";
        const token = signJwt(payload, { expiresIn: isUser ? "2d" : undefined });

        console.log('[DEBUG VERIFY] Token oluşturuldu, cookie set ediliyor...');
        console.log('[DEBUG VERIFY] isUser:', isUser, '| maxAge:', isUser ? 2 * 24 * 60 * 60 * 1000 : 'default');

        res.cookie(
            "access_token",
            token,
            cookieOptions({ maxAge: isUser ? 2 * 24 * 60 * 60 * 1000 : undefined })
        );

        console.log('[DEBUG VERIFY] Cookie set edildi, response dönüyor...');
        return res.json({ ok: true });
    }),

    me: asyncWrap(async (req, res) => {
        const token = req.cookies?.access_token;
        console.log('[DEBUG ME] Cookie access_token:', token ? token.substring(0, 50) + '...' : 'YOK');

        const decoded = readJwtFromReq(req);
        if (!decoded) {
            console.log('[DEBUG ME] Token decode edilemedi veya yok');
            return res.status(401).json({ ok: false, message: "Unauthenticated" });
        }

        console.log('[DEBUG ME] Token decode edildi, decoded:', JSON.stringify(decoded));

        const userId = decoded.sub;
        const userType = decoded.typ;

        if (userType === "customer") {
            const [rows] = await pool.execute(
                `
            SELECT 
                *
            FROM customers c
            WHERE c.id = ?
            LIMIT 1
            `,
                [userId]
            );

            if (!rows.length) {
                return res.status(404).json({ ok: false, message: "Customer not found" });
            }
            const [flagRows] = await pool.execute(
                `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
                [userId]
            );
            if (flagRows[0]?.is_blacklisted) {
                return res.status(403).json({
                    ok: false,
                    message: "Hesabiniz kara listeye alinmistir.",
                });
            }

            return res.json({
                ok: true,
                userType: "customer",
                user: rows[0]
            });
        }

        if (userType === "user" || userType === "barber") {
            const businessId = getPersonalBusinessId();
            const branchId = getPersonalBranchId();
            const settingsJson = await getBusinessSettingsJson(businessId);

            const [rows] = await pool.execute(
                `
            SELECT
                sa.id,
                sa.is_admin,
                sa.is_active,
                sa.last_login_at,
                s.id AS staff_id,
                s.full_name AS staff_name,
                s.phone AS staff_phone
            FROM staff_accounts sa
            LEFT JOIN staff s ON s.id = sa.staff_id
            WHERE sa.id = ?
            LIMIT 1
            `,
                [userId]
            );

            if (!rows.length) {
                return res.status(404).json({ ok: false, message: "User not found" });
            }

            const businessName = settingsJson.business_name ?? settingsJson.businessName ?? null;
            const branchName = settingsJson.branch_name ?? settingsJson.branchName ?? null;

            return res.json({
                ok: true,
                userType: userType, // "user" veya "barber"
                user: {
                    ...rows[0],
                    business_id: businessId,
                    business_name: businessName,
                    branch_id: branchId,
                    branch_name: branchName,
                }
            });
        }

        return res.status(400).json({ ok: false, message: "Invalid token type" });
    }),

    logout: asyncWrap(async (req, res) => {
        res.clearCookie("access_token", { path: "/" });
        res.json({ ok: true });
    }),
};


// --------------- BOOKING (special endpoint) ---------------

// basit helper: cookie jwt -> customer doğrulama
function requireCustomer(req) {
    const decoded = readJwtFromReq(req);
    if (!decoded) throw httpError(401, "Unauthenticated");
    if (decoded.typ !== "customer") throw httpError(403, "Only customers can book");
    return decoded;
}

function requireUser(req) {
    const decoded = readJwtFromReq(req);
    if (!decoded) throw httpError(401, "Unauthenticated");
    // "user" veya "barber" tipi kabul edilir
    if (decoded.typ !== "user" && decoded.typ !== "barber") throw httpError(403, "Only users can access this");
    return decoded;
}

function requireSession(req) {
    const decoded = readJwtFromReq(req);
    if (!decoded) throw httpError(401, "Unauthenticated");
    return decoded;
}

async function requireAdminUser(decoded) {
    const userId = Number(decoded.sub);
    const [accRows] = await pool.execute(
        `SELECT is_admin, is_active FROM staff_accounts WHERE id = ? LIMIT 1`,
        [userId]
    );
    if (!accRows.length || Number(accRows[0].is_active) === 0 || Number(accRows[0].is_admin) !== 1) {
        throw httpError(403, "Admin required");
    }
    return true;
}

function toSqlDateTime(dateStr, timeStr) {
    // date: YYYY-MM-DD, time: HH:MM
    if (!dateStr || !timeStr) return null;
    return `${dateStr} ${timeStr}:00`;
}

function parseHHMMToMinutes(hhmm) {
    const [h, m] = String(hhmm || "").split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
}

const VIRTUAL_SLOT_MINUTES = 5;

function pad2(n) {
    return String(n).padStart(2, "0");
}

function minutesToHHMM(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${pad2(h)}:${pad2(m)}`;
}

function roundUpToStep(mins, step) {
    if (!Number.isFinite(mins)) return mins;
    return Math.ceil(mins / step) * step;
}

function buildSlotTimes(dateStr, startMin, durationMin, step = VIRTUAL_SLOT_MINUTES) {
    const endMin = startMin + durationMin;
    const slots = [];
    for (let m = startMin; m < endMin; m += step) {
        slots.push(`${dateStr} ${minutesToHHMM(m)}:00`);
    }
    return slots;
}

function dateToYmdLocal(d) {
    if (d instanceof Date) {
        // Legacy Date handling - convert to ISO string then parse
        return d.toISOString().slice(0, 10);
    }
    return t.toYmd(d instanceof Temporal.PlainDateTime ? d : t.fromDBDateTime(d));
}

function extractDateTimeParts(value) {
    if (!value) return { dateStr: "", timeStr: "" };
    if (value instanceof Date) {
        return {
            dateStr: dateToYmdLocal(value),
            timeStr: `${pad2(value.getHours())}:${pad2(value.getMinutes())}`,
        };
    }
    return t.extractDateTimeParts(value);
}

function diffMinutes(startValue, endValue) {
    if (startValue instanceof Date) startValue = startValue.toISOString().replace(' ', 'T');
    if (endValue instanceof Date) endValue = endValue.toISOString().replace(' ', 'T');
    return t.diffMinutes(startValue, endValue);
}

function timeStrFromDateTimeSql(sqlDt) {
    // "YYYY-MM-DD HH:MM:SS" -> "HH:MM"
    const t = String(sqlDt).split(" ")[1] || "";
    return t.slice(0, 5);
}

function dateStrFromDateTimeSql(sqlDt) {
    return String(sqlDt).split(" ")[0];
}

function todayYmd() {
    return t.todayYmd();
}

function addDaysYmd(ymd, days) {
    return t.addDaysToYmd(ymd, days);
}

function duplicateMessage(err) {
    const msg = String(err?.sqlMessage || err?.message || "");
    if (msg.includes("uq_provider_slot")) return "Secilen saat dolu.";
    return "Slot dolu veya aktif randevu kurali ihlali (duplicate)";
}

const BookingControllers = {
    /**
     * POST /api/appointments/book
     * body: {
     *   slug?: string,
     *   businessId?: number,
     *   branchId: number,
     *   staffId: number,
     *   serviceId: number,
     *   date: "YYYY-MM-DD",
     *   time: "HH:MM",
     *   customer_note?: string
     * }
     */
    book: asyncWrap(async (req, res) => {
        const decoded = requireCustomer(req);
        const customerId = Number(decoded.sub);
        const businessId = getPersonalBusinessId();
        const [flagRows] = await pool.execute(
            `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
            [customerId]
        );
        if (flagRows[0]?.is_blacklisted) {
            throw httpError(403, "Hesabiniz kara listeye alinmistir.");
        }

        const body = req.body || {};
        const branchIdBody = Number(body.branchId ?? body.branch_id);
        const staffId = Number(body.staffId ?? body.staff_id);
        const rawServiceId = body.serviceId ?? body.service_id;
        const serviceId = rawServiceId ? Number(rawServiceId) : null;
        const isCustom = !serviceId;
        const dateStr = String(body.date || "").trim();
        const timeStr = String(body.time || "").trim();
        const customerNote = body.customer_note ?? null;
        const noPhone = !!body.no_phone;

        if (!staffId) throw httpError(400, "staffId zorunlu");
        if (!dateStr || !timeStr) throw httpError(400, "date ve time zorunlu (YYYY-MM-DD, HH:MM)");

        // businessId already resolved above
        const branchId = getPersonalBranchId();
        if (branchIdBody && Number(branchIdBody) !== Number(branchId)) {
            throw httpError(400, "branchId mismatch");
        }

        // start_at parse
        const startAt = toSqlDateTime(dateStr, timeStr);
        if (!startAt) throw httpError(400, "Geçersiz date/time");

        // business settings (merged into businesses.settings_json)
        const settingsJson = await getBusinessSettingsJson(businessId);
        const startHour = String(settingsJson.start_hour ?? "09:00");
        const endHour = String(settingsJson.end_hour ?? "22:00");
        const maxActiveCount = Number(settingsJson.multiple_appointment_count ?? 2);
        const maxDayRange = Number(settingsJson.booking_coming_day_range ?? 2);

        if (Number.isFinite(maxDayRange) && maxDayRange > 0) {
            const maxDate = addDaysYmd(todayYmd(), maxDayRange);
            if (dateStr > maxDate) {
                throw httpError(400, "Randevu gun araligi asildi");
            }
        }

        if (Number.isFinite(maxActiveCount) && maxActiveCount > 0) {
                const [cntRows] = await pool.execute(
                    `SELECT COUNT(*) AS cnt
                     FROM appointments
                     WHERE customer_id = ? AND status = 'confirmed'`,
                    [customerId]
                );
            const cnt = Number(cntRows[0]?.cnt ?? 0);
            if (cnt >= maxActiveCount) {
                throw httpError(400, "Alınabilecek maksimum randevu limitine ulaşıldı");
            }
        }

        // saat aralığı kontrolü
        const startMin = parseHHMMToMinutes(timeStr);
        const openMin = parseHHMMToMinutes(startHour);
        const closeMin = parseHHMMToMinutes(endHour);
        if (startMin === null || openMin === null || closeMin === null) {
            throw httpError(500, "Invalid business settings time format");
        }

        if (startMin < openMin || startMin >= closeMin) {
            throw httpError(400, "Selected time is outside working hours");
        }
        // 5 dk slot kurali: dakika acilisa gore 5 dk carpani olmali
        if ((startMin - openMin) % VIRTUAL_SLOT_MINUTES !== 0) {
            throw httpError(400, "Selected time is not aligned with 5-minute slots");
        }


        // service doğrula (duration çekme yok)
        // Custom randevularda service validation atlanır
        let svc = null;
        let durationMin = 0;
        if (!isCustom) {
            const [svcRows] = await pool.execute(
                `SELECT id, name, duration_minutes, price, is_active
                 FROM services WHERE id = ? LIMIT 1`,
                [serviceId]
            );
            svc = svcRows[0];
            if (!svc) throw httpError(404, "Service not found");
            if (Number(svc.is_active) === 0) throw httpError(400, "Service inactive");
            const durationMinRaw = Number(svc.duration_minutes);
            if (!Number.isFinite(durationMinRaw) || durationMinRaw <= 0) {
                throw httpError(500, "Invalid service duration");
            }
            durationMin = durationMinRaw;
        } else {
            durationMin = Number(body.custom_duration_minutes ?? 30);
            if (!Number.isFinite(durationMin) || durationMin <= 0) {
                throw httpError(400, "Gecersiz custom_duration_minutes");
            }
        }
        const blockDurationMin = roundUpToStep(durationMin, VIRTUAL_SLOT_MINUTES);

        const endMin = startMin + durationMin;
        const blockEndMin = startMin + blockDurationMin;
        if (endMin > closeMin || blockEndMin > closeMin) {
            throw httpError(400, "Selected slot exceeds closing time");
        }

        const slotTimes = buildSlotTimes(dateStr, startMin, blockDurationMin);
        const slotRangeStart = `${dateStr} ${minutesToHHMM(startMin)}:00`;
        const slotRangeEnd = `${dateStr} ${minutesToHHMM(startMin + blockDurationMin)}:00`;

        // branch doğrula
        // staff doğrula
        const [stRows] = await pool.execute(
            `SELECT id, name FROM service_providers WHERE id = ? LIMIT 1`,
            [staffId]
        );
        const st = stRows[0]; 
        if (!st) throw httpError(404, "Staff not found");

        // staff_services doğrula (custom randevularda atlanır)
        const provider = await ensureStaffProvider(staffId);
        if (!provider) throw httpError(404, "Provider not found");
        if (Number(provider.is_active) === 0) throw httpError(400, "Provider inactive");

        if (!isCustom) {
            const [ssRows] = await pool.execute(
                `SELECT provider_id, service_id FROM provider_services
                 WHERE provider_id = ? AND service_id = ? LIMIT 1`,
                [provider.id, serviceId]
            );
            if (!ssRows.length) throw httpError(400, "Staff does not provide this service");
        }

        // period_settings kontrolü - özel fiyat varsa kullan (custom randevularda atlanır)
        let effectivePrice = null;
        if (!isCustom && svc) {
            effectivePrice = svc.price ?? null;
            try {
                const [periodRows] = await pool.execute(
                    `SELECT data_json FROM period_settings
                     WHERE start_date <= ? AND end_date >= ?
                     LIMIT 1`,
                    [dateStr, dateStr]
                );
                if (periodRows.length > 0) {
                    let dataJson = periodRows[0].data_json;
                    if (typeof dataJson === "string") {
                        dataJson = JSON.parse(dataJson);
                    }
                    const costs = dataJson?.cost || [];
                    const costEntry = costs.find(c => Number(c.service_id) === serviceId);
                    if (costEntry && costEntry.price !== undefined) {
                        effectivePrice = Number(costEntry.price);
                        console.log(`[book] period override: service ${serviceId} price ${svc.price} -> ${effectivePrice}`);
                    }
                }
            } catch (err) {
                console.error("[book] period_settings check failed:", err);
            }
        } else {
            // Custom randevu: fiyat body'den alınır
            if (body.custom_price !== undefined) {
                effectivePrice = Number(body.custom_price);
            }
        }

        const [closureRows] = await pool.execute(
            `SELECT id FROM closures
             WHERE status = 'active'
               AND start_at < ?
               AND end_at > ?
               AND (
                 (scope = 'global' AND provider_id IS NULL) OR
                 (scope = 'provider' AND provider_id = ?)
               )
             LIMIT 1`,
            [slotRangeEnd, slotRangeStart, provider.id]
        );
        if (closureRows.length) {
            throw httpError(400, "Business is closed for the selected date");
        }

        // end_at hesapla (MySQL DATE_ADD)
        const endAtSqlExpr = `DATE_ADD(?, INTERVAL ? MINUTE)`;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // 1) appointments insert
            const [r1] = await conn.execute(
                `
          INSERT INTO appointments
            (
              provider_id, service_id, is_custom, source, customer_id,
              start_at, end_at,
              service_name_snapshot, service_duration_minutes_snapshot, service_price_snapshot,
              provider_name_snapshot, provider_type_snapshot,
              customer_note
            )
          VALUES
            (?, ?, ?, 'customer', ?, ${endAtSqlExpr}, ?, ?, ?, ?, ?, ?)
        `,
                // end_at expr: DATE_ADD(start_at, durationMin)
                [
                    provider.id,     // provider_id
                    serviceId,      // service_id
                    0,              // is_custom
                    customerId,      // customer_id
                    startAt,         // start_at
                    startAt,         // DATE_ADD start
                    isCustom ? durationMin : svc.duration_minutes, // DATE_ADD interval
                    isCustom ? (body.custom_service_name ?? "Özel Randevu") : svc.name, // service_name_snapshot
                    isCustom ? durationMin : svc.duration_minutes, // service_duration_minutes_snapshot
                    effectivePrice,  // service_price_snapshot
                    provider.name,   // provider_name_snapshot
                    provider.provider_type, // provider_type_snapshot
                    customerNote     // customer_note
                ]
            );

            const appointmentId = r1.insertId;

            // 2) appointment_slots insert
             await conn.execute(
                 `DELETE s FROM appointment_slots s
                  INNER JOIN appointments a
                    ON a.id = s.appointment_id
                  WHERE s.provider_id = ?
                    AND s.slot_time >= ?
                    AND s.slot_time < ?
                    AND a.status <> 'confirmed'`,
                [provider.id, slotRangeStart, slotRangeEnd]
             );
            if (!slotTimes.length) {
                throw httpError(500, "Slot range invalid");
            }
            const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ")
            const slotParams = [];
            for (const t of slotTimes) {
                slotParams.push(appointmentId, provider.id, t);
            }
            await conn.execute(
                `INSERT INTO appointment_slots (appointment_id, provider_id, slot_time)
                 VALUES ${slotValues}`,
                slotParams
            );



            // 3) status history insert
            await conn.execute(
                `
          INSERT INTO appointment_status_history (appointment_id, old_status, new_status, changed_by, note)
          VALUES (?, 'confirmed', 'confirmed', 'customer', ?)
        `,
                [appointmentId, null]
            );
            // end_at geri oku (response'a koymak için)
            const [aRows] = await conn.execute(
                `SELECT start_at, end_at, status FROM appointments WHERE id = ? LIMIT 1`,
                [appointmentId]
            );

            await conn.commit();

            emitAppointment({
                appointmentId,
                providerId: provider.id,
                staffId,
                serviceId,
                start_at: startAt,
                status: "confirmed",
            });

            // Desktop SSE — yeni randevu oluştu
            emitDesktopEvent("command", "print.appointment", { appointmentId, date: startAt });

            try {
                const smsEnabled = settingsJson.sms_reminder !== false;
                if (smsEnabled && !noPhone) {
                    let customerPhone = decoded.phone;
                    if (!customerPhone) {
                        const [cRows] = await pool.execute(
                            `SELECT phone FROM customers WHERE id = ? LIMIT 1`,
                            [customerId]
                        );
                        customerPhone = cRows[0]?.phone ?? null;
                    }
                    if (customerPhone) {
                        const msg = `Ercan İncirkuş Berber Dükkanı - Randevunuz olusturuldu. Tarih: ${dateStr} ${timeStr}. Hizmet: ${svc.name}.`;
                        await sendSms({
                            appointment_id: appointmentId,
                            phone: customerPhone,
                            message: msg,
                            type: "reminder"
                        });
                    }
                }
            } catch (smsErr) {
                console.error("SMS send failed:", smsErr);
            }

            // Staff bildirim SMS'i
            try {
                const staffNotificationEnabled = settingsJson.sms_notification !== false;
                if (staffNotificationEnabled) {
                    const [staffRows] = await pool.execute(
                        `SELECT phone FROM staff WHERE id = ? LIMIT 1`,
                        [staffId]
                    );
                    const staffPhone = staffRows[0]?.phone ?? null;
                    if (staffPhone) {
                        const msg = `Ercan İncirkuş Berber Dükkanı - Yeni randevu: ${svc.name}, ${dateStr} ${timeStr}.`;
                        await sendSms({
                            appointment_id: appointmentId,
                            phone: staffPhone,
                            message: msg,
                            type: "reminder"
                        });
                    }
                }
            } catch (staffSmsErr) {
                console.error("Staff SMS send failed:", staffSmsErr);
            }

            const appointmentIdOut = appointmentId ?? "";
            const qs = new URLSearchParams({
                appointmentId: String(appointmentIdOut),
                date: String(dateStr || ""),
                time: String(timeStr || ""),
                staff: String(staffId || ""),
                service: String(serviceId || ""),
            }).toString();
            const redirectUrl = `/success?${qs}`;
            const accept = String(req.headers.accept || "");
            const wantsHtml = accept.includes("text/html");

            if (wantsHtml) {
                return res.redirect(302, redirectUrl);
            }

            return res.status(201).json({
                ok: true,
                appointmentId,
                businessId,
                branchId,
                staffId,
                serviceId,
                customerId,
                start_at: aRows[0]?.start_at ?? startAt,
                end_at: aRows[0]?.end_at ?? null,
                status: aRows[0]?.status ?? "confirmed",
                duration_minutes: durationMin,
                redirect_url: redirectUrl,
                periodOverrideApplied: effectivePrice !== (svc.price ?? null),
                effectivePrice: effectivePrice,
            });
        } catch (err) {
            await conn.rollback();

            if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
                return res.status(409).json({
                    ok: false,
                    message: duplicateMessage(err),
                });
            }

            throw err;
        } finally {
            conn.release();
        }
    }),

    /**
     * POST /api/appointments/success-details
     * body: { appointmentId: number }
     */
    successDetails: asyncWrap(async (req, res) => {
        const decoded = requireCustomer(req);
        const customerId = Number(decoded.sub);

        const body = req.body || {};
        const appointmentId = Number(body.appointmentId ?? body.appointment_id);
        if (!appointmentId || Number.isNaN(appointmentId)) {
            throw httpError(400, "appointmentId zorunlu");
        }

        const [rows] = await pool.execute(
            `
            SELECT
                a.id,
                a.provider_id,
                a.service_id,
                a.customer_id,
                a.start_at,
                a.end_at,
                a.status,
                a.service_name_snapshot,
                a.service_duration_minutes_snapshot,
                a.service_price_snapshot,
                a.provider_name_snapshot,
                a.provider_type_snapshot,
                sp.staff_id AS staff_id_out,
                st.full_name AS staff_full_name,
                st.phone AS staff_phone
            FROM appointments a
            LEFT JOIN service_providers sp ON sp.id = a.provider_id
            LEFT JOIN staff st ON st.id = sp.staff_id
            WHERE a.id = ?
              AND a.customer_id = ?
            LIMIT 1
            `,
            [appointmentId, customerId]
        );
        const appt = rows[0];
        if (!appt) throw httpError(404, "Appointment not found");
        if (String(appt.status) !== "confirmed") {
            throw httpError(400, "Appointment is not confirmed");
        }

        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();
        const settingsJson = await getBusinessSettingsJson(businessId);
        const businessName = settingsJson.business_name ?? settingsJson.businessName ?? null;
        const businessSlug = settingsJson.business_slug ?? settingsJson.businessSlug ?? null;
        const branchName = settingsJson.branch_name ?? settingsJson.branchName ?? null;
        const branchPhone = settingsJson.branch_phone ?? settingsJson.branchPhone ?? null;

        return res.json({
            ok: true,
            appointment: {
                id: appt.id,
                businessId,
                branchId,
                providerId: appt.provider_id,
                staffId: appt.staff_id_out ?? null,
                serviceId: appt.service_id,
                customerId: appt.customer_id,
                start_at: appt.start_at,
                end_at: appt.end_at,
                status: appt.status,
            },
            business: { id: businessId, name: businessName, slug: businessSlug },
            branch: { id: branchId, name: branchName, phone: branchPhone },
            staff: appt.staff_id_out
                ? { id: appt.staff_id_out, full_name: appt.staff_full_name, phone: appt.staff_phone }
                : null,
            service: {
                id: appt.service_id,
                name: appt.service_name_snapshot,
                duration_minutes: appt.service_duration_minutes_snapshot,
                price: appt.service_price_snapshot,
            },
            provider: {
                id: appt.provider_id,
                name: appt.provider_name_snapshot,
                provider_type: appt.provider_type_snapshot,
            },
        });
    }),

    /**
     * POST /api/appointments/success-details-all
     * body: {}
     */
    successDetailsAll: asyncWrap(async (req, res) => {
        const decoded = requireCustomer(req);
        const customerId = Number(decoded.sub);

        const [rows] = await pool.execute(
            `
            SELECT
                a.id AS appointment_id,
                a.provider_id,
                a.service_id,
                a.customer_id,
                a.start_at,
                a.end_at,
                a.status,
                a.service_name_snapshot,
                a.service_duration_minutes_snapshot,
                a.service_price_snapshot,
                a.provider_name_snapshot,
                a.provider_type_snapshot,
                sp.staff_id AS staff_id_out,
                st.full_name AS staff_full_name,
                st.phone AS staff_phone
            FROM appointments a
            LEFT JOIN service_providers sp ON sp.id = a.provider_id
            LEFT JOIN staff st ON st.id = sp.staff_id
            WHERE a.customer_id = ?
            ORDER BY a.start_at DESC
            `,
            [customerId]
        );

        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();
        const settingsJson = await getBusinessSettingsJson(businessId);
        const businessName = settingsJson.business_name ?? settingsJson.businessName ?? null;
        const businessSlug = settingsJson.business_slug ?? settingsJson.businessSlug ?? null;
        const branchName = settingsJson.branch_name ?? settingsJson.branchName ?? null;
        const branchPhone = settingsJson.branch_phone ?? settingsJson.branchPhone ?? null;

        const business = { id: businessId, name: businessName, slug: businessSlug };
        const branch = { id: branchId, name: branchName, phone: branchPhone };

        const items = rows.map((row) => ({
            appointment: {
                id: row.appointment_id,
                businessId,
                branchId,
                providerId: row.provider_id,
                staffId: row.staff_id_out ?? null,
                serviceId: row.service_id,
                customerId: row.customer_id,
                start_at: row.start_at,
                end_at: row.end_at,
                status: row.status,
            },
            business,
            branch,
            staff: row.staff_id_out
                ? { id: row.staff_id_out, full_name: row.staff_full_name, phone: row.staff_phone }
                : null,
            service: {
                id: row.service_id,
                name: row.service_name_snapshot,
                duration_minutes: row.service_duration_minutes_snapshot,
                price: row.service_price_snapshot,
            },
            provider: {
                id: row.provider_id,
                name: row.provider_name_snapshot,
                provider_type: row.provider_type_snapshot,
            },
        }));

        // cancel_deadline_hours ayarını frontend'e gönder
        const cancelDeadlineHours = settingsJson.cancel_deadline_hours ?? 2;

        return res.json({ ok: true, items, settings: { cancelDeadlineHours } });
    }),

    /**
     * GET /api/appointments/panel
     * - branch account: business/branch context from JWT (fallback to DB)
     */
    panelList: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffId = decoded.staff_id ?? decoded.staffId ?? null;
        const isAdmin = Number(decoded.is_admin ?? decoded.isAdmin ?? 0) === 1;
        if (!staffId && !isAdmin) throw httpError(403, "staff_id missing");

        let provider = null;
        if (staffId) {
            provider = await ensureStaffProvider(staffId);
            if (!provider) throw httpError(404, "Provider not found");
        }

        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        // Admin değilse sadece kendi staff bilgisini al
        let staff = null;
        if (!isAdmin && staffId) {
            const [staffRows] = await pool.execute(
                `SELECT id, full_name, phone FROM staff WHERE id = ? LIMIT 1`,
                [staffId]
            );
            staff = staffRows[0]
                ? { id: staffRows[0].id, full_name: staffRows[0].full_name, phone: staffRows[0].phone }
                : null;
        }

        // Randevuları getir - admin ise tümü, değilse sadece kendi provider'ı
        let query = `
            SELECT
                a.id AS appointment_id,
                a.provider_id,
                sp.provider_type,
                sp.staff_id AS staff_id,
                a.service_id,
                a.customer_id,
                a.start_at,
                a.end_at,
                a.status,
                a.customer_note,
                a.staff_note,
                a.created_at,
                a.updated_at,
                a.service_name_snapshot,
                a.service_duration_minutes_snapshot,
                a.service_price_snapshot,
                c.id AS customer_id_out,
                c.display_name AS customer_name,
                c.nickname AS customer_nickname,
                c.phone AS customer_phone,
                st.id AS staff_out_id,
                st.full_name AS staff_out_name
            FROM appointments a
            LEFT JOIN customers c ON c.id = a.customer_id
            LEFT JOIN service_providers sp ON sp.id = a.provider_id
            LEFT JOIN staff st ON st.id = sp.staff_id
            WHERE 1=1
        `;
        const params = [];

        // provider_ids varsa - direkt filtreleme yap
        if (req.query.provider_ids) {
            const providerIds = String(req.query.provider_ids).split(',').map(id => parseInt(id.trim())).filter(n => !isNaN(n) && n > 0);
            if (providerIds.length > 0) {
                const placeholders = providerIds.map(() => '?').join(',');
                query += ` AND a.provider_id IN (${placeholders})`;
                params.push(...providerIds);
            }
        } else if (provider) {
            // provider_ids yok - kullanıcının kendi provider'ını göster
            query += ` AND a.provider_id = ?`;
            params.push(provider.id);
        }
        // provider_ids yok ve provider yok = tüm randevular (query'ye ekleme yapma)

        query += ` ORDER BY a.start_at DESC`;

        const [rows] = await pool.execute(query, params);

        const items = rows.map((row) => ({
            id: row.appointment_id,
            serviceId: row.service_id,
            providerId: row.provider_id,
            staffId: row.staff_id,
            customerId: row.customer_id,
            title: row.service_name_snapshot,
            customerName: row.customer_name,
            customerNickname: row.customer_nickname ?? null,
            customerPhone: row.customer_phone,
            providerType: row.provider_type,
            staffName: row.staff_out_name || null,
            start: row.start_at,
            end: row.end_at,
            status: row.status,
            customerNote: row.customer_note ?? null,
            staffNote: row.staff_note ?? null,
            serviceDuration: row.service_duration_minutes_snapshot,
            servicePrice: row.service_price_snapshot,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));

        return res.json({ ok: true, items });
    }),

    /**
     * POST /api/appointments/v2/panel
     * Returns only appointments for a specific date (optimized for calendar view)
     */
    panelListV2: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffId = decoded.staff_id ?? decoded.staffId ?? null;
        const isAdmin = Number(decoded.is_admin ?? decoded.isAdmin ?? 0) === 1;
        if (!staffId && !isAdmin) throw httpError(403, "staff_id missing");

        const { date } = req.body;
        if (!date) throw httpError(400, "date parametresi gerekli");

        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        // Takvim sistemi: seçili gün 06:00 - ertesi gün 03:00
        const startDateTime = `${date} 06:00:00`;
        const endDate = new Date(date + 'T00:00:00');
        endDate.setDate(endDate.getDate() + 1);
        const endYear = endDate.getFullYear();
        const endMonth = String(endDate.getMonth() + 1).padStart(2, '0');
        const endDay = String(endDate.getDate()).padStart(2, '0');
        const endDateTime = `${endYear}-${endMonth}-${endDay} 03:00:00`;

        let query = `
            SELECT
                a.id AS appointment_id,
                a.provider_id,
                sp.provider_type,
                sp.staff_id AS staff_id,
                a.service_id,
                a.customer_id,
                a.start_at,
                a.end_at,
                a.status,
                a.service_name_snapshot,
                a.service_price_snapshot,
                a.customer_note,
                c.display_name AS customer_name,
                c.nickname AS customer_nickname,
                c.phone AS customer_phone
            FROM appointments a
            LEFT JOIN customers c ON c.id = a.customer_id
            LEFT JOIN service_providers sp ON sp.id = a.provider_id
            WHERE a.start_at >= ? AND a.start_at <= ?
                And status IN ('confirmed', 'completed')
        `;
        const params = [startDateTime, endDateTime];

        if (req.body.provider_ids) {
            const providerIds = String(req.body.provider_ids).split(',').map(id => parseInt(id.trim())).filter(n => !isNaN(n) && n > 0);
            if (providerIds.length > 0) {
                const placeholders = providerIds.map(() => '?').join(',');
                query += ` AND a.provider_id IN (${placeholders})`;
                params.push(...providerIds);
            }
        }
        // provider_ids yoksa: tüm randevuları göster (filtreleme yok)

        query += ` ORDER BY a.start_at ASC`;

        const [rows] = await pool.execute(query, params);

        const items = rows.map((row) => ({
            id: row.appointment_id,
            providerId: row.provider_id,
            providerType: row.provider_type,
            staffId: row.staff_id,
            serviceId: row.service_id,
            customerId: row.customer_id,
            title: row.service_name_snapshot,
            customerName: row.customer_name,
            customerNickname: row.customer_nickname ?? null,
            customerPhone: row.customer_phone ?? null,
            customerNote: row.customer_note ?? null,
            start: row.start_at,
            end: row.end_at,
            status: row.status,
            servicePrice: row.service_price_snapshot,
        }));

        return res.json({ ok: true, items });
    }),

    /**
     * GET /api/appointments/panel/:id
     * Returns appointment details by ID
     */
    panelGetById: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffId = decoded.staff_id ?? decoded.staffId ?? null;
        const isAdmin = Number(decoded.is_admin ?? decoded.isAdmin ?? 0) === 1;

        const appointmentId = Number(req.params.id);
        if (!appointmentId) throw httpError(400, "appointmentId zorunlu");

        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        // Randevuyu getir
        const [rows] = await pool.execute(
            `
            SELECT
                a.id AS appointment_id,
                a.provider_id,
                sp.staff_id AS staff_id,
                a.service_id,
                a.customer_id,
                a.start_at,
                a.end_at,
                a.status,
                a.customer_note,
                a.staff_note,
                a.created_at,
                a.updated_at,
                a.service_name_snapshot,
                a.service_duration_minutes_snapshot,
                a.service_price_snapshot,
                c.id AS customer_id_out,
                c.display_name AS customer_name,
                c.nickname AS customer_nickname,
                c.phone AS customer_phone,
                st.id AS staff_out_id,
                st.full_name AS staff_out_name
            FROM appointments a
            LEFT JOIN customers c ON c.id = a.customer_id
            LEFT JOIN service_providers sp ON sp.id = a.provider_id
            LEFT JOIN staff st ON st.id = sp.staff_id
            WHERE a.id = ?
            `,
            [appointmentId]
        );

        if (!rows.length) {
            throw httpError(404, "Randevu bulunamadı");
        }

        const row = rows[0];

        return res.json({
            ok: true,
            item: {
                appointment: {
                    id: row.appointment_id,
                    businessId,
                    branchId,
                    providerId: row.provider_id,
                    staffId: row.staff_id,
                    serviceId: row.service_id,
                    customerId: row.customer_id,
                    start_at: row.start_at,
                    end_at: row.end_at,
                    status: row.status,
                    customer_note: row.customer_note ?? null,
                    staff_note: row.staff_note ?? null,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                },
                staff: row.staff_out_id ? { id: row.staff_out_id, full_name: row.staff_out_name } : null,
                service: {
                    id: row.service_id,
                    name: row.service_name_snapshot,
                    duration_minutes: row.service_duration_minutes_snapshot,
                    price: row.service_price_snapshot,
                },
                customer: row.customer_id_out
                    ? {
                        id: row.customer_id_out,
                        display_name: row.customer_name,
                        nickname: row.customer_nickname ?? null,
                        phone: row.customer_phone,
                    }
                    : null,
            }
        });
    }),

    /**
     * POST /api/appointments/panel/status
     * body: { appointmentId, status }
     */
    panelSetStatus: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffId = decoded.staff_id ?? decoded.staffId ?? null;
        if (!staffId) throw httpError(403, "staff_id missing");
        const provider = await ensureStaffProvider(staffId);
        if (!provider) throw httpError(404, "Provider not found");
        const isAdmin = Number(decoded.is_admin ?? decoded.isAdmin ?? 0) === 1;
        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        const body = req.body || {};
        const appointmentId = Number(body.appointmentId ?? body.appointment_id);
        const status = String(body.status || "").trim();

        const allowed = ["confirmed", "no_show", "completed", "cancelled"];
        if (!appointmentId || Number.isNaN(appointmentId)) throw httpError(400, "appointmentId zorunlu");
        if (!allowed.includes(status)) throw httpError(400, "Invalid status");

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [rows] = await conn.execute(
                `SELECT id, provider_id, status, customer_id, start_at, end_at
                 FROM appointments
                 WHERE id = ? LIMIT 1 FOR UPDATE`,
                [appointmentId]
            );
            const ap = rows[0];
            if (!ap) throw httpError(404, "Appointment not found");
            if (!isAdmin && Number(ap.provider_id) !== Number(provider.id)) throw httpError(403, "Not allowed");

            const oldStatus = ap.status;
            if (oldStatus !== status) {
                await conn.execute(
                    `UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?`,
                    [status, t.toISODateTime(t.now()), appointmentId]
                );
                await conn.execute(
                    `
                    INSERT INTO appointment_status_history
                      (appointment_id, old_status, new_status, changed_by, note)
                    VALUES (?, ?, ?, 'staff', ?)
                    `,
                    [appointmentId, oldStatus, status, null]
                );
                const customerId = Number(ap.customer_id);
                if (customerId && Number.isFinite(customerId)) {
                    if (status === "no_show" && oldStatus !== "no_show") {
                        await conn.execute(
                            `INSERT INTO customer_flags (customer_id, no_show_count)
                             VALUES (?, 1)
                             ON DUPLICATE KEY UPDATE no_show_count = no_show_count + 1`,
                            [customerId]
                        );
                    } else if (status === "confirmed" && oldStatus === "no_show") {
                        await conn.execute(
                            `INSERT INTO customer_flags (customer_id, no_show_count)
                             VALUES (?, 0)
                             ON DUPLICATE KEY UPDATE no_show_count = GREATEST(CAST(no_show_count AS SIGNED) - 1, 0)`,
                            [customerId]
                        );
                    }
                }

                if (status !== "confirmed") {
                    await conn.execute(
                        `DELETE FROM appointment_slots WHERE appointment_id = ?`,
                        [appointmentId]
                    );
                } else if (status === "confirmed" && oldStatus !== "confirmed") {
                    const { dateStr, timeStr } = extractDateTimeParts(ap.start_at);
                    const startMin = parseHHMMToMinutes(timeStr);
                    const durationMin = diffMinutes(ap.start_at, ap.end_at);
                    if (!dateStr || startMin === null || durationMin <= 0) {
                        throw httpError(400, "Gecersiz randevu zamani");
                    }
                    const blockDurationMin = roundUpToStep(durationMin, VIRTUAL_SLOT_MINUTES);
                    const slotTimes = buildSlotTimes(dateStr, startMin, blockDurationMin);
                    const slotRangeStart = `${dateStr} ${minutesToHHMM(startMin)}:00`;
                    const slotRangeEnd = `${dateStr} ${minutesToHHMM(startMin + blockDurationMin)}:00`;

                    try {
                        await conn.execute(
                            `DELETE s FROM appointment_slots s
                             INNER JOIN appointments a
                               ON a.id = s.appointment_id
                             WHERE s.provider_id = ?
                               AND s.slot_time >= ?
                               AND s.slot_time < ?
                               AND a.status <> 'confirmed'`,
                            [ap.provider_id, slotRangeStart, slotRangeEnd]
                        );
                        if (!slotTimes.length) {
                            throw httpError(500, "Slot range invalid");
                        }
                        const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ");
                        const slotParams = [];
                        for (const t of slotTimes) {
                            slotParams.push(appointmentId, ap.provider_id, t);
                        }
                        await conn.execute(
                            `INSERT INTO appointment_slots (appointment_id, provider_id, slot_time)
                             VALUES ${slotValues}`,
                            slotParams
                        );
                    } catch (e) {
                        if (e && (e.code === "ER_DUP_ENTRY" || e.errno === 1062)) {
                            throw httpError(409, "Secilen saat dolu.");
                        }
                        throw e;
                    }
                }
            }

            await conn.commit();

            emitAppointment({
                appointmentId,
                providerId: ap.provider_id,
                staffId,
                start_at: ap.start_at,
                status,
            });

            // Desktop SSE — randevu güncellendi (yeniden yazdır)
            emitDesktopEvent("command", "print.appointment", { appointmentId, date: ap.start_at });

            return res.json({ ok: true, status });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }),

    /**
     * PUT /api/appointments/:id
     * body: { date, time, serviceId?, staffId? }
     */
    appointmentUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffIdFromToken = decoded.staff_id ?? decoded.staffId ?? null;
        if (!staffIdFromToken) throw httpError(403, "staff_id missing");

        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        const appointmentId = Number(req.params.id);
        if (!appointmentId || Number.isNaN(appointmentId)) {
            throw httpError(400, "appointmentId zorunlu");
        }

        const body = req.body || {};
        const dateStr = String(body.date || "").trim();
        const timeStr = String(body.time || "").trim();
        const endTimeStr = body.endTime ? String(body.endTime).trim() : null;
        // serviceId: explicitly null = custom appointment, number = normal, undefined = keep existing
        const serviceIdProvided = body.serviceId !== undefined;
        const serviceId = body.serviceId !== undefined && body.serviceId !== null ? Number(body.serviceId) : null;
        const requestedProviderId = body.provider_id ? Number(body.provider_id) : null;
        const requestedStaffIdRaw = body.staffId;
        const requestedStaffId = requestedStaffIdRaw ? Number(requestedStaffIdRaw) : null;

        if (!dateStr || !timeStr) {
            throw httpError(400, "date ve time zorunlu (YYYY-MM-DD, HH:MM)");
        }

        let startAt = toSqlDateTime(dateStr, timeStr);
        if (!startAt) throw httpError(400, "Gecersiz date/time");
        const startMin = parseHHMMToMinutes(timeStr);
        if (startMin === null) throw httpError(400, "Invalid time format");
        if (startMin % VIRTUAL_SLOT_MINUTES !== 0) {
            throw httpError(400, "Secilen saat 5 dakika dilimlerine uygun olmali");
        }

        let staffId = Number(staffIdFromToken);
        const isAdmin = Number(decoded.is_admin ?? decoded.isAdmin ?? 0) === 1;
        if (requestedStaffId && requestedStaffId !== staffId) {
            await requireAdminUser(decoded, businessId, branchId);
            staffId = requestedStaffId;
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Get current appointment
            const [rows] = await conn.execute(
                `SELECT id, customer_id, provider_id, service_id, is_custom, start_at, end_at, status
                 FROM appointments WHERE id = ? LIMIT 1 FOR UPDATE`,
                [appointmentId]
            );
            const ap = rows[0];
            if (!ap) throw httpError(404, "Appointment not found");

            // Provider değişikliği kontrolü: body.provider_id varsa kullan, yoksa mevcut korunsun
            let targetProviderId = null;
            if (requestedProviderId) {
                targetProviderId = requestedProviderId;
                if (Number(ap.provider_id) !== targetProviderId) {
                    await requireAdminUser(decoded, businessId, branchId);
                }
            }

            // Provider'ı al: değişiklik varsa yeni provider, yoksa mevcut provider korunsun
            let provider;
            if (targetProviderId) {
                provider = await ensureStaffProvider(targetProviderId);
                if (!provider) throw httpError(404, "Provider not found");
            } else {
                provider = { id: Number(ap.provider_id) };
            }

            // is_custom: explicitly null serviceId = custom, number = normal, undefined = keep existing
            let isCustomUpdate = Number(ap.is_custom);
            if (serviceIdProvided) {
                isCustomUpdate = serviceId === null ? 1 : 0;
            }

            // Get service duration
            let durationMin;
            if (isCustomUpdate === 1) {
                durationMin = Number(body.custom_duration_minutes ?? 30);
                if (!Number.isFinite(durationMin) || durationMin <= 0) {
                    throw httpError(400, "Gecersiz custom_duration_minutes");
                }
            } else {
                const serviceIdToUse = serviceId || ap.service_id;
                const [svcRows] = await conn.execute(
                    `SELECT duration_minutes FROM services WHERE id = ? LIMIT 1`,
                    [serviceIdToUse]
                );
                const svc = svcRows[0];
                if (!svc) throw httpError(404, "Service not found");
                durationMin = Number(svc.duration_minutes);
            }
            let blockDurationMin = roundUpToStep(durationMin, VIRTUAL_SLOT_MINUTES);
            let endAt;

            // If endTime provided (from DND), calculate end from it
            if (endTimeStr) {
                // Parse "HH:MM" to PlainDateTime
                const [endH, endM] = endTimeStr.split(":").map(Number);
                const endDt = Temporal.PlainDate.from(dateStr).toPlainDateTime(
                    Temporal.PlainTime.from({ hour: endH, minute: endM })
                );
                endAt = endDt;
            } else {
                const startDt = t.fromDBDateTime(startAt);
                endAt = startDt.add({ minutes: blockDurationMin });
            }

            // Update appointment - her ikisi de aynı formatta olmalı
            const endH = endAt.hour;
            const endM = endAt.minute;
            const endAtStr = `${dateStr} ${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00`;
            // serviceId: null if custom, number if normal, keep existing if not provided
            const serviceIdToPersist = !serviceIdProvided ? ap.service_id : serviceId;
            await conn.execute(
                `UPDATE appointments
                 SET start_at = ?, end_at = ?, service_id = ?, is_custom = ?, provider_id = ?, updated_at = ?
                 WHERE id = ?`,
                [startAt, endAtStr, serviceIdToPersist, isCustomUpdate, provider.id, t.toISODateTime(t.now()), appointmentId]
            );

            // Update slots if confirmed
            if (ap.status === "confirmed") {
                await conn.execute(
                    `DELETE FROM appointment_slots WHERE appointment_id = ?`,
                    [appointmentId]
                );

                const slotTimes = buildSlotTimes(dateStr, startMin, blockDurationMin);
                if (slotTimes.length) {
                    const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ");
                    const slotParams = [];
                    for (const t of slotTimes) {
                        slotParams.push(appointmentId, provider.id, t);
                    }
                    await conn.execute(
                        `INSERT IGNORE INTO appointment_slots (appointment_id, provider_id, slot_time) VALUES ${slotValues}`,
                        slotParams
                    );
                }
            }

            await conn.commit();

            // Müşteriye SMS ile bilgi ver
            const timeChanged = String(ap.start_at) !== startAt;
            if (timeChanged) {
                try {
                    const [cRows] = await pool.execute(
                        `SELECT phone, display_name FROM customers WHERE id = ? LIMIT 1`,
                        [ap.customer_id]
                    );
                    const customer = cRows[0];
                    if (customer?.phone) {
                        const oldTime = t.formatDateTime(ap.start_at);
                        const newTime = t.formatDateTime(startAt);
                        const msg = `Ercan İncirkuş Berber Dükkanı - Randevunuz ${oldTime} yerine ${newTime} saatine taşınmıştır. Saygılarımızla.`;
                        await sendSms({ phone: customer.phone, message: msg, type: "general" });
                    }
                } catch (smsErr) {
                    console.error("SMS gönderim hatası:", smsErr);
                }
            }

            emitAppointment({
                appointmentId,
                providerId: provider.id,
                staffId,
                start_at: startAt,
                status: ap.status,
            });
            emitDesktopEvent("command", "print.appointment", { appointmentId, date: startAt });

            return res.json({ ok: true });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }),

    /**
     * POST /api/customers/blacklist
     * body: { customerId }
     */
    blacklistCustomer: asyncWrap(async (req, res) => {
        requireUser(req);

        const body = req.body || {};
        const customerId = Number(body.customerId ?? body.customer_id);
        if (!customerId || Number.isNaN(customerId)) throw httpError(400, "customerId zorunlu");

        const [rows] = await pool.execute(
            `SELECT id FROM customers WHERE id = ? LIMIT 1`,
            [customerId]
        );
        if (!rows.length) return res.status(404).json({ ok: false, message: "Customer not found" });

        const now = t.toISODateTime(t.now());
        await pool.execute(
            `INSERT INTO customer_flags (customer_id, is_blacklisted, blacklisted_at)
             VALUES (?, 1, ?)
             ON DUPLICATE KEY UPDATE is_blacklisted = 1, blacklisted_at = ?`,
            [customerId, now, now]
        );

        const [aptRows] = await pool.execute(
            `SELECT id
             FROM appointments
             WHERE customer_id = ?
               AND status = 'confirmed'`,
            [customerId]
        );
        if (aptRows.length) {
            const ids = aptRows.map((r) => r.id);
            const placeholders = ids.map(() => "?").join(", ");
            const now = t.toISODateTime(t.now());
            await pool.execute(
                `UPDATE appointments
                 SET status = 'cancelled',
                     cancelled_by = 'system',
                     cancel_reason = 'blacklisted',
                     updated_at = ?
                 WHERE id IN (${placeholders})`,
                [now, ...ids]
            );
            for (const apptId of ids) {
                await pool.execute(
                    `INSERT INTO appointment_status_history
                     (appointment_id, old_status, new_status, changed_by, note)
                     VALUES (?, 'confirmed', 'cancelled', 'system', 'blacklisted')`,
                    [apptId]
                );
            }
            await pool.execute(
                `DELETE FROM appointment_slots WHERE appointment_id IN (${placeholders})`,
                ids
            );
        }

        return res.json({ ok: true, customerId });
    }),

    /**
     * GET /api/customers/blacklist
     */
    blacklistList: asyncWrap(async (req, res) => {
        requireUser(req);
        const [rows] = await pool.execute(
            `SELECT cf.customer_id, cf.no_show_count, cf.is_blacklisted, cf.blacklisted_at,
                    c.display_name, c.phone
             FROM customer_flags cf
             INNER JOIN customers c ON c.id = cf.customer_id
             WHERE cf.is_blacklisted = 1
             ORDER BY cf.blacklisted_at DESC`
        );
        return res.json({ ok: true, items: rows });
    }),

    /**
     * POST /api/customers/blacklist/remove
     * body: { customerId }
     */
    blacklistRemove: asyncWrap(async (req, res) => {
        requireUser(req);
        const body = req.body || {};
        const customerId = Number(body.customerId ?? body.customer_id);
        if (!customerId || Number.isNaN(customerId)) throw httpError(400, "customerId zorunlu");

        await pool.execute(
            `UPDATE customer_flags
             SET is_blacklisted = 0, blacklisted_at = NULL, updated_at = ?
             WHERE customer_id = ?`,
            [t.toISODateTime(t.now()), customerId]
        );

        return res.json({ ok: true, customerId });
    }),


    /**
     * POST /api/appointments/report-month
     * body: { year, month }
     */
    /**
     * GET /api/customers/flags/:customerId
     */
    customerFlags: asyncWrap(async (req, res) => {
        requireUser(req);
        const customerId = Number(req.params.customerId ?? req.params.id ?? req.params.customer_id);
        if (!customerId || Number.isNaN(customerId)) throw httpError(400, "customerId zorunlu");

        const [cRows] = await pool.execute(
            `SELECT id FROM customers WHERE id = ? LIMIT 1`,
            [customerId]
        );
        if (!cRows.length) return res.status(404).json({ ok: false, message: "Customer not found" });

        const [rows] = await pool.execute(
            `SELECT is_blacklisted, no_show_count
             FROM customer_flags
             WHERE customer_id = ? LIMIT 1`,
            [customerId]
        );
        const row = rows[0] || {};
        const noShowCount = Math.max(0, Number(row.no_show_count ?? 0));
        return res.json({
            ok: true,
            item: {
                customer_id: customerId,
                is_blacklisted: Number(row.is_blacklisted ?? 0) === 1,
                no_show_count: noShowCount
            }
        });
    }),

    customerList: asyncWrap(async (req, res) => {
        const { q = "", limit = 50 } = req.query;
        const searchTerm = `%${q}%`;
        const safeLimit = parseInt(limit, 10) || 50;
        const [rows] = await pool.query(
            `SELECT id, phone, display_name, nickname, is_active, created_at
             FROM customers
             WHERE is_active = 1
               AND (phone LIKE ? OR display_name LIKE ?)
             ORDER BY created_at DESC
             LIMIT ?`,
            [searchTerm, searchTerm, safeLimit]
        );
        return res.json({ ok: true, items: rows });
    }),

    customerStats: asyncWrap(async (req, res) => {
        requireUser(req);
        const [rows] = await pool.execute(
            `SELECT
                c.id, c.display_name, c.nickname, c.phone, c.created_at,
                COALESCE(cf.is_blacklisted, 0) AS is_blacklisted,
                COALESCE(cf.no_show_count, 0) AS no_show_count,
                COUNT(a.id) AS total_appointments,
                SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
                SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_show_appointments
             FROM customers c
             LEFT JOIN customer_flags cf ON cf.customer_id = c.id
             LEFT JOIN appointments a ON a.customer_id = c.id
             GROUP BY c.id
             ORDER BY total_appointments DESC`
        );
        return res.json({ ok: true, items: rows });
    }),

    customerStats: asyncWrap(async (req, res) => {
        requireUser(req);
        const [rows] = await pool.execute(
            `SELECT
                c.id, c.display_name, c.nickname, c.phone, c.created_at,
                COALESCE(cf.is_blacklisted, 0) AS is_blacklisted,
                COALESCE(cf.no_show_count, 0) AS no_show_count,
                COUNT(a.id) AS total_appointments,
                SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
                SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_show_appointments
             FROM customers c
             LEFT JOIN customer_flags cf ON cf.customer_id = c.id
             LEFT JOIN appointments a ON a.customer_id = c.id
             GROUP BY c.id
             ORDER BY total_appointments DESC`
        );
        return res.json({ ok: true, items: rows });
    }),

    reportMonth: asyncWrap(async (req, res) => {

        const body = req.body || {};
        const year = Number(body.year);
        const month = Number(body.month);
        if (!year || !month || month < 1 || month > 12) {
            throw httpError(400, "year ve month zorunlu");
        }

        const lastDay = t.lastDayOfMonth(year, month);
        const mm = String(month).padStart(2, "0");
        const startAt = `${year}-${mm}-01 00:00:00`;
        const endAt = `${year}-${mm}-${String(lastDay).padStart(2, "0")} 23:59:59`;

        const [rows] = await pool.execute(
            `SELECT id, provider_id, service_id, customer_id, start_at, end_at, status,
                    service_name_snapshot, service_price_snapshot,
                    provider_name_snapshot, provider_type_snapshot
             FROM appointments
             WHERE start_at >= ?
               AND start_at <= ?
             ORDER BY start_at ASC`,
            [startAt, endAt]
        );

        const summary = {
            total: rows.length,
            confirmed: 0,
            completed: 0,
            cancelled: 0,
            no_show: 0,
            revenue_cents: 0
        };

        for (const row of rows) {
            if (summary[row.status] !== undefined) {
                summary[row.status] += 1;
            }
            if (row.status === "completed") {
                summary.revenue_cents += Number(row.service_price_snapshot || 0);
            }
        }

        return res.json({ ok: true, year, month, summary, items: rows });
    }),

    /**
     * POST /api/appointments/monthly-occupancy
     * Body: { year, month }
     * Ayın her günü için doluluk bilgisi döndürür (HH:MM formatı için dakika bazlı).
     */
    monthlyOccupancy: asyncWrap(async (req, res) => {
        const body = req.body || {};
        const year = Number(body.year);
        const month = Number(body.month);
        if (!year || !month || month < 1 || month > 12) {
            throw httpError(400, "year ve month zorunlu");
        }

        const lastDay = t.lastDayOfMonth(year, month);
        const mm = String(month).padStart(2, "0");
        const startAt = `${year}-${mm}-01 00:00:00`;
        const endAt = `${year}-${mm}-${String(lastDay).padStart(2, "0")} 23:59:59`;

        if (process.env.NODE_ENV !== "production") {
            console.log(`[MONTHLY-OCCUPANCY] İstek alındı: year=${year}, month=${month}`);
            console.log(`[MONTHLY-OCCUPANCY] Tarih aralığı: ${startAt} → ${endAt}`);
        }

        // Çalışma saatleri ve kapalı günler settings'den
        const settings = await getBusinessSettingsJson();
        const startHour = String(settings.start_hour ?? "09:00");
        const endHour = String(settings.end_hour ?? "22:00");
        const closedDays = Array.isArray(settings.closed_days) ? settings.closed_days : [];

        if (process.env.NODE_ENV !== "production") {
            console.log(`[MONTHLY-OCCUPANCY] Settings: start_hour=${startHour}, end_hour=${endHour}, closed_days=${JSON.stringify(closedDays)}`);
        }

        // start_hour/end_hour -> dakika cinsinden günlük toplam
        const [sH, sM] = startHour.split(":").map(Number);
        const [eH, eM] = endHour.split(":").map(Number);
        const totalMinutesPerDay = (eH * 60 + eM) - (sH * 60 + sM);

        // SQL: start_at/end_at VARCHAR(80) olduğu için aggregation JS tarafında yapılacak
        // confirmed + completed + no_show randevuları çek (cancelled hariç)
        // Aralık karşılaştırması SUBSTRING ile (string karşılaştırmasında .000 vs boşluk sorun çıkarıyor)
        const [rows] = await pool.execute(
            `SELECT SUBSTRING(start_at, 1, 10) AS day,
                    start_at,
                    end_at,
                    status
             FROM appointments
             WHERE SUBSTRING(start_at, 1, 10) >= ?
               AND SUBSTRING(start_at, 1, 10) <= ?
               AND status IN ('confirmed', 'completed', 'no_show')`,
            [`${year}-${mm}-01`, `${year}-${mm}-${String(lastDay).padStart(2, "0")}`]
        );

        if (process.env.NODE_ENV !== "production") {
            console.log(`[MONTHLY-OCCUPANCY] SQL'den gelen randevu sayısı: ${rows.length}`);
            if (rows.length > 0) {
                console.log(`[MONTHLY-OCCUPANCY] İlk 3 örnek:`, rows.slice(0, 3));
            } else {
                console.log(`[MONTHLY-OCCUPANCY] UYARI: Hiç randevu dönmedi! Aralığı kontrol et: ${startAt} → ${endAt}`);
            }
        }

        // rows -> map[YYYY-MM-DD] = { filled_minutes, appointments_count }
        const dayMap = {};
        let parseErrors = 0;
        for (const row of rows) {
            const dayStr = String(row.day).slice(0, 10);

            // Temporal API ile dakika farkı hesapla
            const startDt = t.fromDBDateTime(row.start_at);
            const endDt = t.fromDBDateTime(row.end_at);
            let minutes = 0;
            if (startDt && endDt) {
                minutes = t.diffMinutes(startDt, endDt);
            } else {
                parseErrors += 1;
                if (process.env.NODE_ENV !== "production") {
                    console.warn(`[MONTHLY-OCCUPANCY] Parse hatası: start_at=${row.start_at}, end_at=${row.end_at}`);
                }
            }

            if (!dayMap[dayStr]) {
                dayMap[dayStr] = { filled_minutes: 0, appointments_count: 0 };
            }
            dayMap[dayStr].filled_minutes += minutes;
            dayMap[dayStr].appointments_count += 1;
        }

        if (process.env.NODE_ENV !== "production") {
            console.log(`[MONTHLY-OCCUPANCY] dayMap oluşturuldu: ${Object.keys(dayMap).length} gün, parse hataları: ${parseErrors}`);
            console.log(`[MONTHLY-OCCUPANCY] dayMap içeriği:`, dayMap);
        }

        // Tüm günleri üret (kapalı günler dahil)
        const days = [];
        let workingDays = 0;
        let totalFilledMinutes = 0;

        for (let d = 1; d <= lastDay; d++) {
            const dateStr = `${year}-${mm}-${String(d).padStart(2, "0")}`;
            const dateObj = new Date(year, month - 1, d);
            const dayOfWeek = dateObj.getDay(); // 0 = Pazar
            const isClosed = closedDays.includes(dayOfWeek);

            const dayData = dayMap[dateStr] || { filled_minutes: 0, appointments_count: 0 };

            days.push({
                date: dateStr,
                day: d,
                day_of_week: dayOfWeek,
                is_closed: isClosed,
                filled_minutes: dayData.filled_minutes,
                appointments_count: dayData.appointments_count,
                total_minutes: isClosed ? 0 : totalMinutesPerDay
            });

            if (!isClosed) {
                workingDays += 1;
                totalFilledMinutes += dayData.filled_minutes;
            }
        }

        const totalPossibleMinutes = workingDays * totalMinutesPerDay;
        const occupancyPercent = totalPossibleMinutes > 0
            ? (totalFilledMinutes / totalPossibleMinutes) * 100
            : 0;

        if (process.env.NODE_ENV !== "production") {
            console.log(`[MONTHLY-OCCUPANCY] Summary: working_days=${workingDays}, total_filled=${totalFilledMinutes}dk (${Math.floor(totalFilledMinutes/60)}:${String(totalFilledMinutes%60).padStart(2,'0')}), total_possible=${totalPossibleMinutes}dk, occupancy=${occupancyPercent.toFixed(1)}%`);
            console.log(`[MONTHLY-OCCUPANCY] İlk 5 gün:`, days.slice(0, 5).map(d => ({ date: d.date, filled: d.filled_minutes, count: d.appointments_count })));
        }

        return res.json({
            ok: true,
            year,
            month,
            start_hour: startHour,
            end_hour: endHour,
            closed_days: closedDays,
            total_minutes_per_day: totalMinutesPerDay,
            days,
            summary: {
                working_days: workingDays,
                total_filled_minutes: totalFilledMinutes,
                total_possible_minutes: totalPossibleMinutes,
                occupancy_percent: Math.round(occupancyPercent * 10) / 10
            }
        });
    }),

    /**
     * POST /api/appointments/day-details
     * Body: { date: "YYYY-MM-DD" }
     * Belirli bir günün tüm randevularını getirir (confirmed/completed/no_show)
     * Customer bilgisi JOIN ile birlikte döner
     */
    dayDetails: asyncWrap(async (req, res) => {
        const body = req.body || {};
        const date = String(body.date || "").trim();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw httpError(400, "Geçerli bir tarih giriniz (YYYY-MM-DD)");
        }

        if (process.env.NODE_ENV !== "production") {
            console.log(`[DAY-DETAILS] İstek: date=${date}`);
        }

        // SQL: o güne ait randevuları customer bilgisi ile birlikte çek
        const [rows] = await pool.execute(
            `SELECT
                a.id,
                a.start_at,
                a.end_at,
                a.status,
                a.service_name_snapshot,
                a.service_duration_minutes_snapshot,
                a.service_price_snapshot,
                a.provider_name_snapshot,
                a.provider_type_snapshot,
                a.provider_id,
                a.customer_id,
                a.customer_note,
                a.staff_note,
                a.is_custom,
                c.display_name AS customer_name,
                c.phone AS customer_phone
             FROM appointments a
             LEFT JOIN customers c ON c.id = a.customer_id
             WHERE SUBSTRING(a.start_at, 1, 10) = ?
               AND a.status IN ('confirmed', 'completed', 'no_show')
             ORDER BY a.start_at ASC, a.id ASC`,
            [date]
        );

        const appointments = rows.map((row) => {
            // Dakika hesabı Temporal API ile
            const startDt = t.fromDBDateTime(row.start_at);
            const endDt = t.fromDBDateTime(row.end_at);
            let durationMinutes = 0;
            if (startDt && endDt) {
                durationMinutes = t.diffMinutes(startDt, endDt);
            }

            // Saat başlangıcı (YYYY-MM-DD HH:MM)
            const timeStr = String(row.start_at).slice(11, 16);

            return {
                id: row.id,
                start_at: row.start_at,
                end_at: row.end_at,
                start_time: timeStr,
                duration_minutes: durationMinutes,
                status: row.status,
                service_name: row.service_name_snapshot,
                service_duration: row.service_duration_minutes_snapshot,
                service_price: row.service_price_snapshot,
                provider_name: row.provider_name_snapshot,
                provider_type: row.provider_type_snapshot,
                provider_id: row.provider_id,
                customer_id: row.customer_id,
                customer_name: row.customer_name || `Müşteri #${row.customer_id}`,
                customer_phone: row.customer_phone || null,
                customer_note: row.customer_note,
                staff_note: row.staff_note,
                is_custom: row.is_custom === 1
            };
        });

        if (process.env.NODE_ENV !== "production") {
            console.log(`[DAY-DETAILS] ${appointments.length} randevu bulundu`);
        }

        return res.json({
            ok: true,
            date,
            appointments,
            count: appointments.length
        });
    }),

    /**
     * POST /api/appointments/panel/create
     * body: { serviceId, date, time, phone, display_name?, customer_note?, staffId? }
     */
    panelCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffIdFromToken = decoded.staff_id ?? decoded.staffId ?? null;
        if (!staffIdFromToken) throw httpError(403, "staff_id missing");

        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        const body = req.body || {};
        const rawServiceId = body.serviceId ?? body.service_id;
        const serviceId = rawServiceId ? Number(rawServiceId) : null;
        const isCustom = !serviceId;
        const requestedStaffIdRaw = body.staffId ?? body.staff_id;
        const requestedStaffId = requestedStaffIdRaw ? Number(requestedStaffIdRaw) : null;
        const dateStr = String(body.date || "").trim();
        const timeStr = String(body.time || "").trim();
        const phone = String(body.phone || "").trim();
        const displayName = body.display_name ?? body.displayName ?? null;
        const customerNote = body.customer_note ?? null;

        if (!dateStr || !timeStr) throw httpError(400, "date ve time zorunlu (YYYY-MM-DD, HH:MM)");
        if (!phone) throw httpError(400, "phone zorunlu");

        const startAt = toSqlDateTime(dateStr, timeStr);
        if (!startAt) throw httpError(400, "Gecersiz date/time");

        const settingsJson = await getBusinessSettingsJson(businessId);
        const startHour = String(settingsJson.start_hour ?? "09:00");
        const endHour = String(settingsJson.end_hour ?? "22:00");

        const startMin = parseHHMMToMinutes(timeStr);
        const openMin = parseHHMMToMinutes(startHour);
        const closeMin = parseHHMMToMinutes(endHour);
        if (startMin === null || openMin === null || closeMin === null) {
            throw httpError(500, "Invalid business settings time format");
        }
        if (startMin < openMin || startMin >= closeMin) {
            throw httpError(400, "Selected time is outside working hours");
        }
        // 5 dk slot kurali: dakika acilisa gore 5 dk carpani olmali
        if ((startMin - openMin) % VIRTUAL_SLOT_MINUTES !== 0) {
            throw httpError(400, "Selected time is not aligned with 5-minute slots");
        }

        let staffId = Number(staffIdFromToken);
        if (requestedStaffId && requestedStaffId !== staffId) {
            await requireAdminUser(decoded, businessId, branchId);
            staffId = requestedStaffId;
        }

        const [stRows] = await pool.execute(
            `SELECT id, full_name, is_active FROM staff WHERE id = ? LIMIT 1`,
            [staffId]
        );
        const st = stRows[0];
        if (!st) throw httpError(404, "Staff not found");
        if (Number(st.is_active) === 0) throw httpError(400, "Staff inactive");

        // Custom randevularda service validation atlanır
        let svc = null;
        let durationMin = 0;
        if (!isCustom) {
            const [svcRows] = await pool.execute(
                `SELECT id, name, duration_minutes, price, is_active
                 FROM services WHERE id = ? LIMIT 1`,
                [serviceId]
            );
            svc = svcRows[0];
            if (!svc) throw httpError(404, "Service not found");
            if (Number(svc.is_active) === 0) throw httpError(400, "Service inactive");
            const durationMinRaw = Number(svc.duration_minutes);
            if (!Number.isFinite(durationMinRaw) || durationMinRaw <= 0) {
                throw httpError(500, "Invalid service duration");
            }
            durationMin = durationMinRaw;
        } else {
            durationMin = Number(body.custom_duration_minutes ?? 30);
            if (!Number.isFinite(durationMin) || durationMin <= 0) {
                throw httpError(400, "Gecersiz custom_duration_minutes");
            }
        }
        const blockDurationMin = roundUpToStep(durationMin, VIRTUAL_SLOT_MINUTES);

        const endMin = startMin + durationMin;
        const blockEndMin = startMin + blockDurationMin;
        if (endMin > closeMin || blockEndMin > closeMin) {
            throw httpError(400, "Selected slot exceeds closing time");
        }

        const provider = await ensureStaffProvider(staffId);
        if (!provider) throw httpError(404, "Provider not found");
        if (Number(provider.is_active) === 0) throw httpError(400, "Provider inactive");

        if (!isCustom) {
            const [ssRows] = await pool.execute(
                `SELECT provider_id, service_id FROM provider_services
                 WHERE provider_id = ? AND service_id = ? LIMIT 1`,
                [provider.id, serviceId]
            );
            if (!ssRows.length) throw httpError(400, "Staff does not provide this service");
        }

        const [cRows] = await pool.execute(
            `SELECT id, phone, is_active FROM customers WHERE phone = ? LIMIT 1`,
            [phone]
        );
        let customerId = cRows[0]?.id;
        if (customerId && Number(cRows[0]?.is_active ?? 1) === 0) {
            throw httpError(403, "Hesap pasif");
        }
        if (!customerId) {
            const id = await Models.customers.create({
                phone,
                display_name: displayName || null,
                is_active: 1
            });
            customerId = id;
        }

        const [flagRows] = await pool.execute(
            `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
            [customerId]
        );
        if (flagRows[0]?.is_blacklisted) {
            throw httpError(403, "Hesabiniz kara listeye alinmistir.");
        }

        const endAtSqlExpr = `DATE_ADD(?, INTERVAL ? MINUTE)`;
        const slotTimes = buildSlotTimes(dateStr, startMin, blockDurationMin);
        const slotRangeStart = `${dateStr} ${minutesToHHMM(startMin)}:00`;
        const slotRangeEnd = `${dateStr} ${minutesToHHMM(startMin + blockDurationMin)}:00`;

        const [closureRows] = await pool.execute(
            `SELECT id FROM closures
             WHERE status = 'active'
               AND start_at < ?
               AND end_at > ?
               AND (
                 (scope = 'global' AND provider_id IS NULL) OR
                 (scope = 'provider' AND provider_id = ?)
               )
             LIMIT 1`,
            [slotRangeEnd, slotRangeStart, provider.id]
        );
        if (closureRows.length) {
            throw httpError(400, "Business is closed for the selected date");
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [r1] = await conn.execute(
                `
           INSERT INTO appointments
             (
              provider_id, service_id, is_custom, source, customer_id,
              start_at, end_at,
              service_name_snapshot, service_duration_minutes_snapshot, service_price_snapshot,
              provider_name_snapshot, provider_type_snapshot,
              customer_note
            )
          VALUES
            (?, ?, ?, 'barber', ?, ${endAtSqlExpr}, ?, ?, ?, ?, ?, ?)
        `,
                [
                    provider.id,
                    serviceId,
                    isCustom ? 1 : 0,
                    customerId,
                    startAt,
                    startAt,
                    isCustom ? (body.custom_service_name ?? "Özel Randevu") : svc.name,
                    isCustom ? durationMin : svc.duration_minutes,
                    isCustom ? (body.custom_price !== undefined ? Number(body.custom_price) : null) : (svc.price ?? null),
                    provider.name,
                    provider.provider_type,
                    customerNote
                ]
            );

            const appointmentId = r1.insertId;

            await conn.execute(
                `DELETE s FROM appointment_slots s
                 INNER JOIN appointments a
                   ON a.id = s.appointment_id
                 WHERE s.provider_id = ?
                   AND s.slot_time >= ?
                   AND s.slot_time < ?
                   AND a.status <> 'confirmed'`,
                [provider.id, slotRangeStart, slotRangeEnd]
            );
            if (!slotTimes.length) {
                throw httpError(500, "Slot range invalid");
            }
            const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ");
            const slotParams = [];
            for (const t of slotTimes) {
                slotParams.push(appointmentId, provider.id, t);
            }
            await conn.execute(
                `INSERT INTO appointment_slots (appointment_id, provider_id, slot_time)
                 VALUES ${slotValues}`,
                slotParams
            );

            await conn.execute(
                `
          INSERT INTO appointment_status_history (appointment_id, old_status, new_status, changed_by, note)
          VALUES (?, 'confirmed', 'confirmed', 'staff', ?)
        `,
                [appointmentId, null]
            );

            await conn.commit();

            emitAppointment({
                appointmentId,
                providerId: provider.id,
                staffId,
                serviceId,
                start_at: startAt,
                status: "confirmed",
            });
            emitDesktopEvent("command", "print.appointment", { appointmentId, date: startAt });
            return res.status(201).json({ ok: true, appointmentId });
        } catch (err) {
            await conn.rollback();
            if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
                return res.status(409).json({
                    ok: false,
                    message: duplicateMessage(err)
                });
            }
            throw err;
        } finally {
            conn.release();
        }
    }),

    /**
     * POST /api/appointments/panel/create-direct
     * Kuralsiz: saat, slot, kapanis vb. kontrol yok
     * body: { serviceId, date, time, phone, display_name?, customer_note?, staffId? }
     */
    panelCreateDirect: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffIdFromToken = decoded.staff_id ?? decoded.staffId ?? null;
        if (!staffIdFromToken) throw httpError(403, "staff_id missing");

        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        const body = req.body || {};
        const rawServiceId = body.serviceId ?? body.service_id;
        const serviceId = rawServiceId ? Number(rawServiceId) : null;
        const isCustom = !serviceId;
        const requestedStaffIdRaw = body.staffId ?? body.staff_id;
        const requestedStaffId = requestedStaffIdRaw ? Number(requestedStaffIdRaw) : null;
        const dateStr = String(body.date || "").trim();
        const timeStr = String(body.time || "").trim();
        const phone = String(body.phone || "").trim();
        const displayName = body.display_name ?? body.displayName ?? null;
        const customerNote = body.customer_note ?? null;

        if (!dateStr || !timeStr) throw httpError(400, "date ve time zorunlu (YYYY-MM-DD, HH:MM)");
        if (!phone) throw httpError(400, "phone zorunlu");

        const startAt = toSqlDateTime(dateStr, timeStr);
        if (!startAt) throw httpError(400, "Gecersiz date/time");
        const startMin = parseHHMMToMinutes(timeStr);
        if (startMin === null) throw httpError(400, "Invalid time format");
        if (startMin % VIRTUAL_SLOT_MINUTES !== 0) {
            throw httpError(400, "Selected time is not aligned with 5-minute slots");
        }

        let staffId = Number(staffIdFromToken);
        if (requestedStaffId && requestedStaffId !== staffId) {
            await requireAdminUser(decoded, businessId, branchId);
            staffId = requestedStaffId;
        }

        const [stRows] = await pool.execute(
            `SELECT id, full_name, is_active FROM staff WHERE id = ? LIMIT 1`,
            [staffId]
        );
        const st = stRows[0];
        if (!st) throw httpError(404, "Staff not found");
        if (Number(st.is_active) === 0) throw httpError(400, "Staff inactive");

        // Custom randevularda service validation atlanır
        let svc = null;
        let durationMin = 0;
        if (!isCustom) {
            const [svcRows] = await pool.execute(
                `SELECT id, name, duration_minutes, price, is_active
                 FROM services WHERE id = ? LIMIT 1`,
                [serviceId]
            );
            svc = svcRows[0];
            if (!svc) throw httpError(404, "Service not found");
            if (Number(svc.is_active) === 0) throw httpError(400, "Service inactive");
            const durationMinRaw = Number(svc.duration_minutes);
            if (!Number.isFinite(durationMinRaw) || durationMinRaw <= 0) {
                throw httpError(500, "Invalid service duration");
            }
            durationMin = durationMinRaw;
        } else {
            durationMin = Number(body.custom_duration_minutes ?? 30);
            if (!Number.isFinite(durationMin) || durationMin <= 0) {
                throw httpError(400, "Gecersiz custom_duration_minutes");
            }
        }
        const blockDurationMin = roundUpToStep(durationMin, VIRTUAL_SLOT_MINUTES);
        const slotTimes = buildSlotTimes(dateStr, startMin, blockDurationMin);
        const slotRangeStart = `${dateStr} ${minutesToHHMM(startMin)}:00`;
        const slotRangeEnd = `${dateStr} ${minutesToHHMM(startMin + blockDurationMin)}:00`;

        const provider = await ensureStaffProvider(staffId);
        if (!provider) throw httpError(404, "Provider not found");
        if (Number(provider.is_active) === 0) throw httpError(400, "Provider inactive");

        if (!isCustom) {
            const [psRows] = await pool.execute(
                `SELECT provider_id FROM provider_services WHERE provider_id = ? AND service_id = ? LIMIT 1`,
                [provider.id, serviceId]
            );
            if (!psRows.length) throw httpError(400, "Staff does not provide this service");
        }

        const [cRows] = await pool.execute(
            `SELECT id, phone, is_active FROM customers WHERE phone = ? LIMIT 1`,
            [phone]
        );
        let customerId = cRows[0]?.id;
        if (customerId && Number(cRows[0]?.is_active ?? 1) === 0) {
            throw httpError(403, "Hesap pasif");
        }
        if (!customerId) {
            const id = await Models.customers.create({
                phone,
                display_name: displayName || null,
                is_active: 1
            });
            customerId = id;
        }

        const [flagRows] = await pool.execute(
            `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
            [customerId]
        );
        if (flagRows[0]?.is_blacklisted) {
            throw httpError(403, "Hesabiniz kara listeye alinmistir.");
        }

        const endAtSqlExpr = `DATE_ADD(?, INTERVAL ? MINUTE)`;
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [r1] = await conn.execute(
                `
           INSERT INTO appointments
             (
              provider_id, service_id, is_custom, source, customer_id,
              start_at, end_at,
              service_name_snapshot, service_duration_minutes_snapshot, service_price_snapshot,
              provider_name_snapshot, provider_type_snapshot,
              customer_note
            )
          VALUES
            (?, ?, ?, 'barber', ?, ${endAtSqlExpr}, ?, ?, ?, ?, ?, ?)
        `,
                [
                    provider.id,
                    serviceId,
                    isCustom ? 1 : 0,
                    customerId,
                    startAt,
                    startAt,
                    isCustom ? (body.custom_service_name ?? "Özel Randevu") : svc.name,
                    isCustom ? durationMin : svc.duration_minutes,
                    isCustom ? (body.custom_price !== undefined ? Number(body.custom_price) : null) : (svc.price ?? null),
                    provider.name,
                    provider.provider_type,
                    customerNote
                ]
            );

            const appointmentId = r1.insertId;

            await conn.execute(
                `DELETE s FROM appointment_slots s
                 INNER JOIN appointments a
                   ON a.id = s.appointment_id
                 WHERE s.provider_id = ?
                   AND s.slot_time >= ?
                   AND s.slot_time < ?
                   AND a.status <> 'confirmed'`,
                [provider.id, slotRangeStart, slotRangeEnd]
            );
            if (!slotTimes.length) {
                throw httpError(500, "Slot range invalid");
            }
            const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ");
            const slotParams = [];
            for (const t of slotTimes) {
                slotParams.push(appointmentId, provider.id, t);
            }
            await conn.execute(
                `INSERT INTO appointment_slots (appointment_id, provider_id, slot_time)
                 VALUES ${slotValues}`,
                slotParams
            );

            await conn.execute(
                `
          INSERT INTO appointment_status_history (appointment_id, old_status, new_status, changed_by, note)
          VALUES (?, 'confirmed', 'confirmed', 'staff', ?)
        `,
                [appointmentId, null]
            );

            await conn.commit();

            emitAppointment({
                appointmentId,
                providerId: provider.id,
                staffId,
                serviceId,
                start_at: startAt,
                status: "confirmed",
            });
            emitDesktopEvent("command", "print.appointment", { appointmentId, date: startAt });
            return res.status(201).json({ ok: true, appointmentId });
        } catch (err) {
            await conn.rollback();
            if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
                return res.status(409).json({
                    ok: false,
                    message: duplicateMessage(err)
                });
            }
            throw err;
        } finally {
            conn.release();
        }
    }),

    /**
     * POST /api/appointments/panel/book-quick
     * Panel icin hizli randevu (staff token ile)
     * body: { provider_id, service_id, date, time, customer_id }
     */
    panelBookQuick: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        const body = req.body || {};
        const providerId = Number(body.provider_id);
        const rawServiceId = body.service_id;
        const serviceId = rawServiceId ? Number(rawServiceId) : null;
        const isCustom = !serviceId;
        const dateStr = String(body.date || "").trim();
        const timeStr = String(body.time || "").trim();
        const customerId = Number(body.customer_id);
        const customerNote = body.customer_note ?? null;

        if (!providerId) throw httpError(400, "provider_id zorunlu");
        if (!dateStr || !timeStr) throw httpError(400, "date ve time zorunlu (YYYY-MM-DD, HH:MM)");
        if (!customerId) throw httpError(400, "customer_id zorunlu");

        const startAt = toSqlDateTime(dateStr, timeStr);
        if (!startAt) throw httpError(400, "Gecersiz date/time");

        const startMin = parseHHMMToMinutes(timeStr);
        if (startMin === null) throw httpError(400, "Invalid time format");
        if (startMin % VIRTUAL_SLOT_MINUTES !== 0) {
            throw httpError(400, "Selected time is not aligned with 5-minute slots");
        }

        // Provider dogrula
        const [pRows] = await pool.execute(
            `SELECT id, name, provider_type, is_active FROM service_providers WHERE id = ? LIMIT 1`,
            [providerId]
        );
        const provider = pRows[0];
        if (!provider) throw httpError(404, "Provider not found");
        if (Number(provider.is_active) === 0) throw httpError(400, "Provider inactive");

        // Service dogrula (custom randevularda atlanır)
        let svc = null;
        let durationMin = 0;
        if (!isCustom) {
            const [sRows] = await pool.execute(
                `SELECT id, name, duration_minutes, price, is_active FROM services WHERE id = ? LIMIT 1`,
                [serviceId]
            );
            svc = sRows[0];
            if (!svc) throw httpError(404, "Service not found");
            if (Number(svc.is_active) === 0) throw httpError(400, "Service inactive");
            durationMin = Number(svc.duration_minutes);
        } else {
            durationMin = Number(body.custom_duration_minutes ?? 30);
            if (!Number.isFinite(durationMin) || durationMin <= 0) {
                throw httpError(400, "Gecersiz custom_duration_minutes");
            }
        }
        const blockDurationMin = roundUpToStep(durationMin, VIRTUAL_SLOT_MINUTES);
        const slotTimes = buildSlotTimes(dateStr, startMin, blockDurationMin);
        const slotRangeStart = `${dateStr} ${minutesToHHMM(startMin)}:00`;
        const slotRangeEnd = `${dateStr} ${minutesToHHMM(startMin + blockDurationMin)}:00`;

        // Provider-service iliskisi (custom randevularda atlanır)
        if (!isCustom) {
            const [psRows] = await pool.execute(
                `SELECT provider_id FROM provider_services WHERE provider_id = ? AND service_id = ? LIMIT 1`,
                [provider.id, serviceId]
            );
            if (!psRows.length) throw httpError(400, "Provider does not provide this service");
        }

        // Customer dogrula
        const [cRows] = await pool.execute(
            `SELECT id, is_active FROM customers WHERE id = ? LIMIT 1`,
            [customerId]
        );
        const customer = cRows[0];
        if (!customer) throw httpError(404, "Customer not found");
        if (Number(customer.is_active ?? 1) === 0) throw httpError(403, "Customer account is inactive");

        // Blacklist kontrolü
        const [flagRows] = await pool.execute(
            `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
            [customerId]
        );
        if (flagRows[0]?.is_blacklisted) {
            throw httpError(403, "Customer is blacklisted");
        }

        const endAtSqlExpr = `DATE_ADD(?, INTERVAL ? MINUTE)`;
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [r1] = await conn.execute(
                `
          INSERT INTO appointments
            (
              provider_id, service_id, is_custom, source, customer_id,
              start_at, end_at,
              service_name_snapshot, service_duration_minutes_snapshot, service_price_snapshot,
              provider_name_snapshot, provider_type_snapshot,
              customer_note
            )
          VALUES
            (?, ?, ?, 'barber', ?, ${endAtSqlExpr}, ?, ?, ?, ?, ?, ?)
        `,
                [
                    provider.id,
                    serviceId,
                    isCustom ? 1 : 0,
                    customerId,
                    startAt,
                    startAt,
                    durationMin,
                    isCustom ? (body.custom_service_name ?? "Özel Randevu") : svc.name,
                    isCustom ? durationMin : svc.duration_minutes,
                    isCustom ? (body.custom_price !== undefined ? Number(body.custom_price) : null) : (svc.price ?? null),
                    provider.name,
                    provider.provider_type,
                    customerNote
                ]
            );

            const appointmentId = r1.insertId;

            // Slot temizleme (non-confirmed)
            await conn.execute(
                `DELETE s FROM appointment_slots s
                 INNER JOIN appointments a ON a.id = s.appointment_id
                 WHERE s.provider_id = ?
                   AND s.slot_time >= ?
                   AND s.slot_time < ?
                   AND a.status <> 'confirmed'`,
                [provider.id, slotRangeStart, slotRangeEnd]
            );

            // Yeni slotlar ekle
            if (slotTimes.length) {
                const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ");
                const slotParams = [];
                for (const t of slotTimes) {
                    slotParams.push(appointmentId, provider.id, t);
                }
                await conn.execute(
                    `INSERT INTO appointment_slots (appointment_id, provider_id, slot_time) VALUES ${slotValues}`,
                    slotParams
                );
            }

            // Status history
            await conn.execute(
                `INSERT INTO appointment_status_history (appointment_id, old_status, new_status, changed_by, note)
                 VALUES (?, 'confirmed', 'confirmed', 'staff', ?)`,
                [appointmentId, null]
            );

            await conn.commit();

            emitAppointment({
                appointmentId,
                providerId: provider.id,
                staffId: provider.id,
                serviceId,
                start_at: startAt,
                status: "confirmed",
            });

            emitDesktopEvent("command", "print.appointment", { appointmentId, date: startAt });

            return res.status(201).json({ ok: true, appointmentId });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }),

    /**
     * POST /api/appointments/custom
     * Body: {
     *   provider_id, date (YYYY-MM-DD), time (HH:MM), end_time (HH:MM),
     *   is_custom (0|1),
     *   customer_id,
     *   customer_note,
     *   -- standard: service_id
     *   -- custom: custom_service_name, custom_duration_minutes, custom_price?
     * }
     */
    createCustom: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffIdFromToken = decoded.staff_id ?? decoded.staffId ?? null;
        if (!staffIdFromToken) throw httpError(403, "staff_id missing");

        const body = req.body || {};
        const providerId = Number(body.provider_id);
        const dateStr = String(body.date || "").trim();
        const timeStr = String(body.time || "").trim();
        const endTimeStr = String(body.end_time || "").trim();
        const isCustom = Number(body.is_custom ?? 0) === 1;
        const customerId = body.customer_id ? Number(body.customer_id) : null;
        const customerNote = body.customer_note ?? null;

        if (!providerId) throw httpError(400, "provider_id zorunlu");
        if (!dateStr || !timeStr) throw httpError(400, "date ve time zorunlu");
        if (!endTimeStr) throw httpError(400, "end_time zorunlu");

        // Parse times
        const startAt = toSqlDateTime(dateStr, timeStr);
        const endAt = toSqlDateTime(dateStr, endTimeStr);
        if (!startAt || !endAt) throw httpError(400, "Gecersiz date/time");

        const startMin = parseHHMMToMinutes(timeStr);
        const endMin = parseHHMMToMinutes(endTimeStr);
        if (startMin === null || endMin === null) throw httpError(400, "Invalid time format");
        if (endMin <= startMin) throw httpError(400, "Bitis zamani baslangictan once olmali");

        // Validate provider
        const [pRows] = await pool.execute(
            `SELECT id, name, provider_type, is_active FROM service_providers WHERE id = ? LIMIT 1`,
            [providerId]
        );
        const provider = pRows[0];
        if (!provider) throw httpError(404, "Provider not found");
        if (Number(provider.is_active) === 0) throw httpError(400, "Provider inactive");

        // Validate customer
        let customer = null;
        if (customerId) {
            const [cRows] = await pool.execute(
                `SELECT id, is_active FROM customers WHERE id = ? LIMIT 1`,
                [customerId]
            );
            customer = cRows[0];
            if (!customer) throw httpError(404, "Customer not found");
            if (Number(customer.is_active ?? 1) === 0) throw httpError(403, "Customer inactive");

            const [flagRows] = await pool.execute(
                `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
                [customerId]
            );
            if (flagRows[0]?.is_blacklisted) throw httpError(403, "Customer blacklisted");
        }

        // Service / custom snapshot fields
        let serviceIdToInsert = null;
        let serviceNameSnapshot = "Özel Randevu";
        let serviceDurationSnapshot = endMin - startMin;
        let servicePriceSnapshot = null;

        if (!isCustom) {
            const serviceId = Number(body.service_id);
            if (!serviceId) throw httpError(400, "service_id zorunlu (standard mode)");

            const [sRows] = await pool.execute(
                `SELECT id, name, duration_minutes, price, is_active FROM services WHERE id = ? LIMIT 1`,
                [serviceId]
            );
            const svc = sRows[0];
            if (!svc) throw httpError(404, "Service not found");
            if (Number(svc.is_active) === 0) throw httpError(400, "Service inactive");

            // Check provider-service relationship
            const [psRows] = await pool.execute(
                `SELECT provider_id FROM provider_services WHERE provider_id = ? AND service_id = ? LIMIT 1`,
                [providerId, serviceId]
            );
            if (!psRows.length) throw httpError(400, "Provider does not offer this service");

            serviceIdToInsert = serviceId;
            serviceNameSnapshot = svc.name;
            serviceDurationSnapshot = Number(svc.duration_minutes);
            servicePriceSnapshot = svc.price ?? null;
        } else {
            serviceNameSnapshot = String(body.custom_service_name || "Özel Randevu").trim();
            const customDur = Number(body.custom_duration_minutes);
            if (!Number.isFinite(customDur) || customDur <= 0) {
                throw httpError(400, "custom_duration_minutes gecerli olmali");
            }
            serviceDurationSnapshot = customDur;
            if (body.custom_price !== undefined && body.custom_price !== null) {
                servicePriceSnapshot = Number(body.custom_price);
            }
        }

        // Closure check
        const slotRangeStart = `${dateStr} ${timeStr}:00`;
        const slotRangeEnd = `${dateStr} ${endTimeStr}:00`;
        const [clRows] = await pool.execute(
            `SELECT id FROM closures
             WHERE status = 'active'
               AND start_at < ?
               AND end_at > ?
               AND (
                 (scope = 'global' AND provider_id IS NULL) OR
                 (scope = 'provider' AND provider_id = ?)
               )
             LIMIT 1`,
            [slotRangeEnd, slotRangeStart, providerId]
        );
        if (clRows.length) throw httpError(400, "Provider is not available at this time");

        const blockDurationMin = roundUpToStep(serviceDurationSnapshot, VIRTUAL_SLOT_MINUTES);
        const slotTimes = buildSlotTimes(dateStr, startMin, blockDurationMin);

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [r1] = await conn.execute(
                `
                INSERT INTO appointments
                  (
                    provider_id, service_id, is_custom, customer_id,
                    start_at, end_at,
                    service_name_snapshot, service_duration_minutes_snapshot, service_price_snapshot,
                    provider_name_snapshot, provider_type_snapshot,
                    customer_note
                  )
                VALUES
                  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    providerId,
                    serviceIdToInsert,
                    isCustom ? 1 : 0,
                    customerId,
                    startAt,
                    endAt,
                    serviceNameSnapshot,
                    serviceDurationSnapshot,
                    servicePriceSnapshot,
                    provider.name,
                    provider.provider_type,
                    customerNote
                ]
            );

            const appointmentId = r1.insertId;

            // Delete old non-confirmed slots
            await conn.execute(
                `DELETE s FROM appointment_slots s
                 INNER JOIN appointments a ON a.id = s.appointment_id
                 WHERE s.provider_id = ?
                   AND s.slot_time >= ?
                   AND s.slot_time < ?
                   AND a.status <> 'confirmed'`,
                [providerId, slotRangeStart, slotRangeEnd]
            );

            // Insert new 5-min slots
            if (slotTimes.length > 0) {
                const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ");
                const slotParams = [];
                for (const t of slotTimes) {
                    slotParams.push(appointmentId, providerId, t);
                }
                await conn.execute(
                    `INSERT INTO appointment_slots (appointment_id, provider_id, slot_time)
                     VALUES ${slotValues}`,
                    slotParams
                );
            }

            // Status history
            await conn.execute(
                `INSERT INTO appointment_status_history
                 (appointment_id, old_status, new_status, changed_by, note)
                 VALUES (?, 'confirmed', 'confirmed', 'staff', ?)`,
                [appointmentId, null]
            );

            await conn.commit();

            emitAppointment({
                appointmentId,
                providerId,
                staffId: staffIdFromToken,
                start_at: startAt,
                status: "confirmed",
            });

            emitDesktopEvent("command", "print.appointment", { appointmentId, date: startAt });

            return res.status(201).json({ ok: true, appointmentId });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }),

    /**
     * POST /api/appointments/can-book
     * body: { slug?: string, businessId?: number }
     */
    canBook: asyncWrap(async (req, res) => {
        const decoded = requireCustomer(req);
        const customerId = Number(decoded.sub);
        const businessId = getPersonalBusinessId();
        const [flagRows] = await pool.execute(
            `SELECT is_blacklisted FROM customer_flags WHERE customer_id = ? LIMIT 1`,
            [customerId]
        );
        if (flagRows[0]?.is_blacklisted) {
            return res.json({
                ok: true,
                allowed: false,
                limit: 0,
                activeCount: 0,
                businessId,
                message: "Hesabiniz kara listeye alinmistir.",
            });
        }

        const settingsJson = await getBusinessSettingsJson(businessId);

        const maxActiveCount = Number(settingsJson.multiple_appointment_count ?? 2);
        if (!Number.isFinite(maxActiveCount) || maxActiveCount <= 0) {
            return res.json({ ok: true, allowed: true, limit: 0, activeCount: 0, businessId });
        }

        const [cntRows] = await pool.execute(
            `SELECT COUNT(*) AS cnt
             FROM appointments
             WHERE customer_id = ? AND status = 'confirmed'`,
            [customerId]
        );
        const cnt = Number(cntRows[0]?.cnt ?? 0);
        const allowed = cnt < maxActiveCount;

        return res.json({
            ok: true,
            allowed,
            limit: maxActiveCount,
            activeCount: cnt,
            businessId,
            message: allowed ? null : "Alınabilecek maksimum randevu limitine ulaşıldı",
        });
    }),

    /**
     * POST /api/appointments/available-slots
     * Body: { date?: "YYYY-MM-DD", staffId?: number, serviceId?: number }
     * Access: Both customer and staff (admin)
     */
    getAvailableSlots: asyncWrap(async (req, res) => {
        // 1. Profil tespiti
        const decoded = readJwtFromReq(req);
        if (!decoded) throw httpError(401, "Unauthenticated");

        const isCustomer = decoded.typ === "customer";
        const isUser = decoded.typ === "user";

        if (!isCustomer && !isUser) {
            throw httpError(403, "Invalid profile type");
        }

        const businessId = getPersonalBusinessId();

        // 2. Input validation
        const body = req.body || {};
        const dateStr = String(body.date || "").trim();
        const staffId = Number(body.staffId ?? body.staff_id ?? body.providerId ?? body.provider_id);
        const serviceId = Number(body.serviceId ?? body.service_id);

        // Bugün için varsayılan
        const targetDate = dateStr || t.todayYmd();

        // 3. Business settings
        const settingsJson = await getBusinessSettingsJson(businessId);
        const startHour = String(settingsJson.start_hour ?? settingsJson.open_time ?? "09:00");
        const endHour = String(settingsJson.end_hour ?? settingsJson.close_time ?? "22:00");
        const slotTime = Number(settingsJson.slot_time ?? 60);

        // 4. Service duration (varsa)
        let duration = slotTime;
        if (serviceId) {
            const [svcRows] = await pool.execute(
                "SELECT duration_minutes FROM services WHERE id = ? LIMIT 1",
                [serviceId]
            );
            if (svcRows.length && svcRows[0].duration_minutes) {
                duration = Number(svcRows[0].duration_minutes);
            }
        }

        // 5. Fetch appointments for the date and provider
        let providerFilter = "";
        let params = [targetDate, targetDate];

        if (staffId) {
            // staffId -> provider_id çevir
            const provider = await ensureStaffProvider(staffId);
            if (provider) {
                providerFilter = "AND a.provider_id = ?";
                params.push(provider.id);
            }
        }

        const [apptRows] = await pool.execute(
            `SELECT a.id, a.provider_id, a.start_at, a.end_at, a.status
             FROM appointments a
             WHERE DATE(a.start_at) = ?
               AND DATE(a.end_at) = ?
               AND a.status = 'confirmed'
               ${providerFilter}`,
            params
        );

        // 6. Calculate busy minutes
        const busySet = new Set();
        const step = 5;
        for (const appt of apptRows) {
            const startDt = t.fromDBDateTime(appt.start_at);
            const endDt = t.fromDBDateTime(appt.end_at);
            let startMin = startDt.hour * 60 + startDt.minute;
            let endMin = endDt.hour * 60 + endDt.minute;

            // Round up to slot step
            const blockDuration = Math.ceil((endMin - startMin) / step) * step;

            for (let m = startMin; m < startMin + blockDuration; m += step) {
                busySet.add(m);
            }
        }
        // 7. Server time for filtering past hours
        const nowZ = t.now();
        const isToday = targetDate === nowZ.toPlainDate().toString();
        const currentMin = isToday ? nowZ.hour * 60 + nowZ.minute : null;
        // 8. Generate available slots - service süresine göre
        const openMin = parseHHMMToMinutes(startHour);
        const closeMin = parseHHMMToMinutes(endHour);
        const maxDuration = Math.ceil(duration / step) * step;
        const availableSlots = [];
        // Service süresi kadar ilerleyerek slot üret
        for (let m = openMin; m + maxDuration <= closeMin; m += maxDuration) {
            // Skip past hours if today
            if (isToday && currentMin !== null && m < currentMin) continue;

            // Check if window is free (service süresi kadar)
            let isFree = true;
            for (let x = m; x < m + maxDuration; x += step) {
                if (busySet.has(x)) {
                    isFree = false;
                    break;
                }
            }

            if (isFree) {
                const h = String(Math.floor(m / 60)).padStart(2, "0");
                const min = String(m % 60).padStart(2, "0");
                availableSlots.push(`${h}:${min}`);
            }
        }

        return res.json({
            ok: true,
            date: targetDate,
            slots: availableSlots,
            busySlots: Array.from(busySet).sort((a, b) => a - b).map(m => {
                const h = String(Math.floor(m / 60)).padStart(2, "0");
                const min = String(m % 60).padStart(2, "0");
                return `${h}:${min}`;
            }),
            settings: {
                open_time: startHour,
                close_time: endHour,
                slot_time: slotTime,
                duration
            }
        });
    }),

    /**
     * POST /api/appointments/slots/generate
     * Generates time slots for a given staff and date
     * Returns all slots (HH:MM) and busy slots
     */
    generateSlots: asyncWrap(async (req, res) => {
        const decoded = readJwtFromReq(req);
        if (!decoded) throw httpError(401, "Unauthenticated");

        const businessId = getPersonalBusinessId();
        const body = req.body || {};
        const dateStr = String(body.date || "").trim();
        const staffId = Number(body.staffId ?? body.staff_id ?? body.providerId ?? body.provider_id);
        const serviceId = Number(body.serviceId ?? body.service_id);

        const targetDate = dateStr || t.todayYmd();

        // Business settings
        const settingsJson = await getBusinessSettingsJson(businessId);
        const startHour = String(settingsJson.start_hour ?? settingsJson.open_time ?? "09:00");
        const endHour = String(settingsJson.end_hour ?? settingsJson.close_time ?? "22:00");
        const slotTime = Number(settingsJson.slot_time ?? 60);

        // ====== PERIOD_SETTINGS OVERRIDE ======
        // Özel dönem ayarları varsa (tatil, bayram vb.) işletme saatlerini override et
        const [periodRows] = await pool.execute(`
            SELECT data_json FROM period_settings
            WHERE start_date <= ? AND end_date >= ?
            LIMIT 1
        `, [targetDate, targetDate]);

        if (periodRows.length > 0) {
            let periodData = periodRows[0].data_json;
            if (typeof periodData === "string") {
                periodData = JSON.parse(periodData);
            }

            const periodSettings = periodData?.settings;

            // Kapalı gün kontrolü - eğer bu gün kapalıysa boş slot döndür
            if (periodSettings?.closed_days && Array.isArray(periodSettings.closed_days)) {
                const targetDateObj = t.fromYmd(targetDate);
                const dayOfWeek = targetDateObj.dayOfWeek; // Temporal: 1=Pazartesi, 7=Pazar
                const jsDayOfWeek = dayOfWeek === 7 ? 0 : dayOfWeek; // Convert to 0-based (0=Pazar)

                if (periodSettings.closed_days.includes(jsDayOfWeek)) {
                    return []; // Bu gün kapalı - boş slot döndür
                }
            }

            // Saat override - period_settings'te özel saat varsa kullan
            if (periodSettings?.start_hour) {
                startHour = String(periodSettings.start_hour);
            }
            if (periodSettings?.end_hour) {
                endHour = String(periodSettings.end_hour);
            }
            if (periodSettings?.slot_time) {
                slotTime = Number(periodSettings.slot_time);
            }
        }
        // ====== PERIOD_SETTINGS END ======

        // Service duration
        let duration = slotTime;
        if (serviceId) {
            const [svcRows] = await pool.execute(
                "SELECT duration_minutes FROM services WHERE id = ? LIMIT 1",
                [serviceId]
            );
            if (svcRows.length && svcRows[0].duration_minutes) {
                duration = Number(svcRows[0].duration_minutes);
            }
        }

        // Fetch busy slots from appointment_slots table
        // appointment_slots stores ALL 5-min blocks for confirmed appointments
        let providerFilter = "";
        let params = [targetDate, targetDate];

        if (staffId) {
            const provider = await ensureStaffProvider(staffId);
            if (provider) {
                providerFilter = "AND aslots.provider_id = ?";
                params.push(provider.id);
            }
        }

        const [slotRows] = await pool.execute(
            `SELECT aslots.appointment_id, aslots.slot_time,
                    appt.start_at, appt.end_at
             FROM appointment_slots aslots
             INNER JOIN appointments appt ON appt.id = aslots.appointment_id
             WHERE DATE(aslots.slot_time) = ?
               AND appt.status = 'confirmed'
               ${providerFilter}
             ORDER BY aslots.appointment_id, aslots.slot_time`,
            params
        );

        // Build busySet for availability check (still needed)
        // AND busyAppointments for frontend display
        const busySet = new Set();
        const busyAppointmentsMap = new Map();
        const step = 5;
        for (const row of slotRows) {
            const slotDt = t.fromDBDateTime(row.slot_time);
            const mins = slotDt.hour * 60 + slotDt.minute;
            busySet.add(mins);

            if (!busyAppointmentsMap.has(row.appointment_id)) {
                const startDt = t.fromDBDateTime(row.start_at);
                const endDt = t.fromDBDateTime(row.end_at);
                busyAppointmentsMap.set(row.appointment_id, {
                    start: `${String(startDt.hour).padStart(2,'0')}:${String(startDt.minute).padStart(2,'0')}`,
                    end: `${String(endDt.hour).padStart(2,'0')}:${String(endDt.minute).padStart(2,'0')}`
                });
            }
        }

        // Fallback: if appointment_slots is empty, calculate from appointments table
        if (busySet.size === 0) {
            const [apptRows] = await pool.execute(
                `SELECT a.id, a.provider_id, a.start_at, a.end_at, a.status
                 FROM appointments a
                 WHERE DATE(a.start_at) = ?
                   AND DATE(a.end_at) = ?
                   AND a.status = 'confirmed'
                   ${providerFilter.replace('aslots.provider_id', 'a.provider_id')}`,
                params
            );

            for (const appt of apptRows) {
                const startDt = t.fromDBDateTime(appt.start_at);
                const endDt = t.fromDBDateTime(appt.end_at);
                let startMin = startDt.hour * 60 + startDt.minute;
                let endMin = endDt.hour * 60 + endDt.minute;
                const blockDuration = Math.ceil((endMin - startMin) / step) * step;
                for (let m = startMin; m < startMin + blockDuration; m += step) {
                    busySet.add(m);
                }
                busyAppointmentsMap.set(appt.id, {
                    start: `${String(startDt.hour).padStart(2,'0')}:${String(startDt.minute).padStart(2,'0')}`,
                    end: `${String(endDt.hour).padStart(2,'0')}:${String(endDt.minute).padStart(2,'0')}`
                });
            }
        }

        // ====== CLOSURE HANDLING ======
        // Check for active closures (global + provider-specific) for this provider and date
        if (staffId) {
            const provider = await ensureStaffProvider(staffId);
            if (provider) {
                const [closureRows] = await pool.execute(`
                    SELECT start_at, end_at, is_all_day, scope
                    FROM closures
                    WHERE status = 'active'
                      AND (
                        (scope = 'global' AND provider_id IS NULL) OR
                        (scope = 'provider' AND provider_id = ?)
                      )
                      AND DATE(start_at) <= ?
                      AND DATE(end_at) >= ?
                `, [provider.id, targetDate, targetDate]);

                for (const closure of closureRows) {
                    const closureStartDt = t.fromDBDateTime(closure.start_at);
                    const closureEndDt = t.fromDBDateTime(closure.end_at);
                    const closureStartMin = closureStartDt.hour * 60 + closureStartDt.minute;
                    const closureEndMin = closureEndDt.hour * 60 + closureEndDt.minute;
                    const closureStartStr = minutesToHHMM(closureStartMin);
                    const closureEndStr = minutesToHHMM(closureEndMin);

                    // Add closure minutes to busySet (for slot overlap detection)
                    for (let cm = closureStartMin; cm < closureEndMin; cm += step) {
                        busySet.add(cm);
                    }

                    // Add closure to busyAppointmentsMap with special key
                    const closureKey = `closure_${closure.scope}_${closureStartMin}`;
                    busyAppointmentsMap.set(closureKey, {
                        start: closureStartStr,
                        end: closureEndStr,
                        isClosure: true,
                        scope: closure.scope
                    });
                }
            }
        }

        const busyAppointments = Array.from(busyAppointmentsMap.values());

        // Server time for past filtering
        const nowZ = t.now();
        const isToday = targetDate === nowZ.toPlainDate().toString();
        const currentMin = isToday ? nowZ.hour * 60 + nowZ.minute : null;

        // Generate enriched slots with status
        const openMin = parseHHMMToMinutes(startHour);
        const closeMin = parseHHMMToMinutes(endHour);
        const maxDuration = Math.ceil(duration / step) * step;
        const slotStep = maxDuration; // service duration for next-slot progression

        // helper functions
        function parseHHMMToMinutesSimple(hhmm) {
            const [h, m] = String(hhmm).split(':').map(Number);
            return h * 60 + (m || 0);
        }
        function minutesToHHMM(mins) {
            return `${String(Math.floor(mins / 60)).padStart(2,'0')}:${String(mins % 60).padStart(2,'0')}`;
        }
        function findConflictEnd(blockedMin, busyAppts) {
            for (const appt of busyAppts) {
                const startMin = parseHHMMToMinutesSimple(appt.start);
                const endMin = parseHHMMToMinutesSimple(appt.end);
                if (blockedMin >= startMin && blockedMin < endMin) {
                    return endMin;
                }
            }
            return blockedMin + slotStep;
        }

        const enrichedSlots = [];
        let m = openMin;

        while (m + maxDuration <= closeMin) {
            if (isToday && currentMin !== null && m < currentMin) {
                m += step;
                continue;
            }

            const slotStartStr = minutesToHHMM(m);
            let status = 'available';
            let endTimeStr = minutesToHHMM(m + maxDuration);
            let busyAppt = null;
            let conflictAppt = null; // For notAvailable - the conflicting appointment

            // Check if this slot is a busy appointment start
            for (const appt of busyAppointments) {
                const apptStartMin = parseHHMMToMinutesSimple(appt.start);
                const apptEndMin = parseHHMMToMinutesSimple(appt.end);
                if (m === apptStartMin) {
                    status = 'busy';
                    endTimeStr = appt.end;
                    busyAppt = appt;
                    break;
                }
            }

            // If not busy, check if window overlaps with any busy appointment
            if (status !== 'busy') {
                for (const appt of busyAppointments) {
                    const apptStartMin = parseHHMMToMinutesSimple(appt.start);
                    const apptEndMin = parseHHMMToMinutesSimple(appt.end);
                    if (m < apptEndMin && apptStartMin < m + maxDuration) {
                        status = 'notAvailable';
                        endTimeStr = appt.start;
                        conflictAppt = appt;
                        break;
                    }
                }
            }

            enrichedSlots.push({
                start: slotStartStr,
                end: endTimeStr,
                status: status
            });

            // Next position
            if (status === 'busy' && busyAppt) {
                // Jump to end of busy appointment
                m = parseHHMMToMinutesSimple(busyAppt.end);
            } else if (status === 'notAvailable' && conflictAppt) {
                // Jump to start of conflicting appointment
                m = parseHHMMToMinutesSimple(conflictAppt.start);
            } else {
                m += slotStep;
            }
        }

        return res.json({
            ok: true,
            date: targetDate,
            slots: enrichedSlots,
            settings: {
                open_time: startHour,
                close_time: endHour,
                slot_time: slotTime,
                duration
            }
        });
    }),

    /**
     * POST /api/appointments/slots/generate/v2
     * V2 Slot Generator - Uses generateSlotsV2Engine for pure algorithm
     */
    generateSlotsV2: asyncWrap(async (req, res) => {
        const decoded = readJwtFromReq(req);
        if (!decoded) throw httpError(401, "Unauthenticated");

        // Import engine at runtime to avoid circular deps
        const { generateSlotsV2Engine } = require("./src/services/slot-generator-v2");

        const body = req.body || {};
        const dateStr = String(body.date || "").trim();
        const staffId = Number(body.staffId ?? body.staff_id ?? body.providerId ?? body.provider_id);
        const serviceId = Number(body.serviceId ?? body.service_id);

        const targetDate = dateStr || t.todayYmd();

        // ====== Get Business Settings ======
        const settingsJson = await getBusinessSettingsJson();
        let startHour = String(settingsJson.start_hour ?? settingsJson.open_time ?? "09:00");
        let endHour = String(settingsJson.end_hour ?? settingsJson.close_time ?? "22:00");
        let slotTime = Number(settingsJson.slot_time ?? 60);

        // ====== Period Settings Override ======
        const [periodRows] = await pool.execute(`
            SELECT data_json FROM period_settings
            WHERE start_date <= ? AND end_date >= ?
            LIMIT 1
        `, [targetDate, targetDate]);

        let isClosedDay = false;
        if (periodRows.length > 0) {
            let periodData = periodRows[0].data_json;
            if (typeof periodData === "string") {
                periodData = JSON.parse(periodData);
            }
            const periodSettings = periodData?.settings;

            // Closed days check
            if (periodSettings?.closed_days && Array.isArray(periodSettings.closed_days)) {
                const targetDateObj = t.fromYmd(targetDate);
                const dayOfWeek = targetDateObj.dayOfWeek;
                const jsDayOfWeek = dayOfWeek === 7 ? 0 : dayOfWeek;
                if (periodSettings.closed_days.includes(jsDayOfWeek)) {
                    isClosedDay = true;
                }
            }

            if (periodSettings?.start_hour) startHour = String(periodSettings.start_hour);
            if (periodSettings?.end_hour) endHour = String(periodSettings.end_hour);
            if (periodSettings?.slot_time) slotTime = Number(periodSettings.slot_time);
        }

        if (isClosedDay) {
            return res.json({ ok: true, date: targetDate, slots: [], settings: { open_time: startHour, close_time: endHour, slot_time: slotTime, duration: slotTime } });
        }

        // ====== Get Service Duration ======
        let duration = slotTime;
        if (serviceId) {
            const [svcRows] = await pool.execute(
                "SELECT duration_minutes FROM services WHERE id = ? LIMIT 1",
                [serviceId]
            );
            if (svcRows.length && svcRows[0].duration_minutes) {
                duration = Number(svcRows[0].duration_minutes);
            }
        }

        // ====== Provider Resolution ======
        let providerId = null;
        if (staffId) {
            const provider = await ensureStaffProvider(staffId);
            if (provider) providerId = provider.id;
        }

        // ====== Get Appointments ======
        const appointments = [];
        let apptQuery = `SELECT start_at, end_at FROM appointments WHERE DATE(start_at) = ? AND status = 'confirmed'`;
        let apptParams = [targetDate];
        if (providerId) {
            apptQuery += " AND provider_id = ?";
            apptParams.push(providerId);
        }
        const [apptRows] = await pool.execute(apptQuery, apptParams);
        for (const appt of apptRows) {
            const startDt = t.fromDBDateTime(appt.start_at);
            const endDt = t.fromDBDateTime(appt.end_at);
            appointments.push({
                start: `${String(startDt.hour).padStart(2,'0')}:${String(startDt.minute).padStart(2,'0')}`,
                end: `${String(endDt.hour).padStart(2,'0')}:${String(endDt.minute).padStart(2,'0')}`
            });
        }

        // ====== Get Closures ======
        const closures = [];
        let closureQuery = `
            SELECT start_at, end_at, scope FROM closures
            WHERE status = 'active'
              AND DATE(start_at) <= ?
              AND DATE(end_at) >= ?
              AND (
                (scope = 'global' AND provider_id IS NULL)
                OR (scope = 'provider' AND provider_id = ?)
              )
        `;
        let closureParams = [targetDate, targetDate];
        if (providerId) closureParams.push(providerId);
        const [closureRows] = await pool.execute(closureQuery, closureParams);
        for (const closure of closureRows) {
            const startDt = t.fromDBDateTime(closure.start_at);
            const endDt = t.fromDBDateTime(closure.end_at);
            closures.push({
                start: `${String(startDt.hour).padStart(2,'0')}:${String(startDt.minute).padStart(2,'0')}`,
                end: `${String(endDt.hour).padStart(2,'0')}:${String(endDt.minute).padStart(2,'0')}`,
                scope: closure.scope
            });
        }

        // ====== Get Break Rules ======
        const { expandWeeklyBreakRules } = require('./src/services/weekly-break-rule-expander');
        let weeklyBreakRule = null;
        if (providerId) {
            const [breakRows] = await pool.execute(
                `SELECT rule_json FROM provider_break_rules WHERE provider_id = ? AND is_active = 1`,
                [providerId]
            );
            if (breakRows.length > 0) {
                let ruleJson = breakRows[0].rule_json;
                if (typeof ruleJson === "string") {
                    try { ruleJson = JSON.parse(ruleJson); } catch { ruleJson = null; }
                }
                weeklyBreakRule = ruleJson;
            }
        }
        const breakRules = expandWeeklyBreakRules({
            date: targetDate,
            weeklyBreakRule
        });

        // ====== Get Static Slots ======
        const staticSlots = [];
        if (providerId) {
            const [staticRows] = await pool.execute(
                `SELECT start_time, end_time FROM provider_static_slots WHERE provider_id = ? AND is_active = 1`,
                [providerId]
            );
            for (const row of staticRows) {
                const startTimeStr = typeof row.start_time === "string" ? row.start_time.slice(0, 5) : String(row.start_time).slice(0, 5);
                const endTimeStr = typeof row.end_time === "string" ? row.end_time.slice(0, 5) : String(row.end_time).slice(0, 5);
                staticSlots.push({ start: startTimeStr, end: endTimeStr });
            }
        }

        // ====== Get Reserved Slots ======
        const { expandReservedSlots } = require('./src/services/reserved-slot-expander');
        let expandedReservedSlots = [];
        if (providerId) {
            const [rsRows] = await pool.execute(
                `SELECT provider_id, day_of_week, start_time, end_time,
                        recurrence_weeks, beginning, is_active, note
                 FROM reserved_slots
                 WHERE provider_id = ? AND is_active = 1`,
                [providerId]
            );
            expandedReservedSlots = expandReservedSlots({
                date: targetDate,
                reservedSlots: rsRows,
                providerId
            });
        }

        // ====== Reserved Slot Preview Mode ======
        // Preview a proposed reserved slot (ghost slot shown as "reserved" status)
        const previewSlot = body.reserved_slot_preview;
        if (previewSlot && providerId) {
            const previewStart = previewSlot.start_time || previewSlot.start;
            const previewEnd = previewSlot.end_time || previewSlot.end;
            if (previewStart && previewEnd) {
                expandedReservedSlots.push({
                    start: String(previewStart).slice(0, 5),
                    end: String(previewEnd).slice(0, 5),
                    source: 'preview',
                    note: previewSlot.note || 'Önizleme'
                });
            }
        }

        // ====== Today Filter ======
        const nowZ = t.now();
        const isToday = targetDate === nowZ.toPlainDate().toString();
        const currentMinute = isToday ? nowZ.hour * 60 + nowZ.minute : null;

        // ====== Call Engine ======
        const engineResult = generateSlotsV2Engine({
            date: targetDate,
            serviceDuration: duration,
            workingHours: { start: startHour, end: endHour },
            appointments,
            closures,
            breakRules,
            staticSlots,
            reservedSlots: expandedReservedSlots,
            isToday,
            currentMinute,
            settings: { slotTime }
        });

        // ====== Generate Bookable Slots ======
        // Import at runtime to avoid circular deps
        const { generateBookableSlots } = require("./src/services/booking-candidate-generator.js");

        const bookableSlots = generateBookableSlots({
            timeline: engineResult.slots,
            serviceDuration: duration,
            workingHours: { start: startHour, end: endHour },
            staticSlots: staticSlots
        });

        return res.json({
            ok: true,
            date: targetDate,
            slots: bookableSlots,
            settings: engineResult.settings
        });
    }),

    /**
     * POST /api/appointments/cancel
     * body: { appointmentId: number, reason?: string }
     */
    cancel: asyncWrap(async (req, res) => {
        const decoded = requireCustomer(req);
        const customerId = Number(decoded.sub);

        const body = req.body || {};
        const appointmentId = Number(body.appointmentId ?? body.appointment_id);
        const reason = body.reason ? String(body.reason).trim() : null;

        if (!appointmentId || Number.isNaN(appointmentId)) {
            throw httpError(400, "appointmentId zorunlu");
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [rows] = await conn.execute(
                `SELECT id, customer_id, status, provider_id, start_at FROM appointments WHERE id = ? LIMIT 1 FOR UPDATE`,
                [appointmentId]
            );
            const appt = rows[0];
            if (!appt) throw httpError(404, "Appointment not found");
            if (Number(appt.customer_id) !== customerId) throw httpError(403, "Forbidden");
            if (String(appt.status) !== "confirmed") {
                throw httpError(400, "Appointment is not confirmed");
            }

            // cancel_deadline_hours kontrolü
            const [settingsRows] = await pool.execute(
                `SELECT settings_json FROM app_settings LIMIT 1`
            );
            let cancelDeadlineHours = 2;
            if (settingsRows.length > 0) {
                let settingsJson = settingsRows[0]?.settings_json;
                if (typeof settingsJson === "string") {
                    try { settingsJson = JSON.parse(settingsJson); } catch { settingsJson = {}; }
                }
                cancelDeadlineHours = settingsJson?.cancel_deadline_hours ?? 2;
            }

            const hoursUntilAppt = t.diffMinutes(t.now().toPlainDateTime(), appt.start_at) / 60;
            if (hoursUntilAppt < cancelDeadlineHours) {
                throw httpError(400, `Randevu başlamasına ${cancelDeadlineHours} saatten az süre kaldığı için iptal edilemez`);
            }

            await conn.execute(
                `UPDATE appointments
                 SET status = 'cancelled', cancelled_by = 'customer', cancel_reason = ?, updated_at = ?
                 WHERE id = ?`,
                [reason, t.toISODateTime(t.now()), appointmentId]
            );

            await conn.execute(
                `INSERT INTO appointment_status_history
                 (appointment_id, old_status, new_status, changed_by, note)
                 VALUES (?, 'confirmed', 'cancelled', 'customer', ?)`,
                [appointmentId, reason]
            );

            await conn.execute(
                `DELETE FROM appointment_slots WHERE appointment_id = ?`,
                [appointmentId]
            );

            await conn.commit();
            emitAppointment({
                appointmentId,
                providerId: appt.provider_id,
                start_at: appt.start_at,
                status: "cancelled",
            });
            return res.json({ ok: true, appointmentId, status: "cancelled" });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }),

    updateStatus: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const staffId = decoded.staff_id ?? decoded.staffId ?? null;
        if (!staffId) throw httpError(403, "staff_id missing");

        const appointmentId = Number(req.params.id);
        if (!appointmentId || Number.isNaN(appointmentId)) {
            throw httpError(400, "appointmentId zorunlu");
        }

        const { status } = req.body || {};
        const allowed = ["confirmed", "no_show", "completed", "cancelled"];
        if (!status || !allowed.includes(status)) {
            throw httpError(400, "Gecersiz status");
        }

        const conn = await pool.getConnection();
        try {
            const [rows] = await conn.execute(
                `SELECT id, provider_id, start_at, status FROM appointments WHERE id = ?`,
                [appointmentId]
            );
            const ap = rows[0];
            if (!ap) throw httpError(404, "Appointment not found");

            const oldStatus = ap.status;
            if (oldStatus !== status) {
                await conn.execute(
                    `UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?`,
                    [status, t.toISODateTime(t.now()), appointmentId]
                );
                await conn.execute(
                    `INSERT INTO appointment_status_history (appointment_id, old_status, new_status, changed_by, note) VALUES (?, ?, ?, 'staff', NULL)`,
                    [appointmentId, oldStatus, status]
                );
                // Emit SSE event
                emitAppointment({
                    appointmentId,
                    providerId: ap.provider_id,
                    start_at: ap.start_at,
                    status,
                });
                emitDesktopEvent("command", "print.appointment", { appointmentId, date: ap.start_at });
                if (status === "cancelled") {
                    emitDesktopEvent("state", "appointment.cancelled", { appointmentId });
                }
            }
            return res.json({ ok: true });
        } finally {
            conn.release();
        }
    }),
};




// -------- Scoped list-only controllers --------
const ScopedControllers = {
    businessesList: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const { settingsJson, updated_at } = await getAppSettingsRow();
        const item = {
            id: businessId,
            slug: settingsJson.business_slug ?? settingsJson.businessSlug ?? settingsJson.slug ?? "personal",
            name: settingsJson.business_name ?? settingsJson.businessName ?? settingsJson.name ?? "Business",
            phone: settingsJson.business_phone ?? settingsJson.businessPhone ?? settingsJson.phone ?? null,
            address: settingsJson.business_address ?? settingsJson.businessAddress ?? settingsJson.address ?? null,
            city: settingsJson.business_city ?? settingsJson.businessCity ?? settingsJson.city ?? null,
            district: settingsJson.business_district ?? settingsJson.businessDistrict ?? settingsJson.district ?? null,
            description: settingsJson.business_description ?? settingsJson.businessDescription ?? settingsJson.description ?? null,
            settings_json: settingsJson,
            is_active: 1,
            created_at: null,
            updated_at: updated_at ?? null,
        };
        return res.json({ ok: true, items: [item] });
    }),

    businessesGet: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const id = Number(req.params.id ?? req.params.business_id);
        if (Number(id) !== Number(businessId)) {
            return res.status(404).json({ ok: false, message: "Not found" });
        }
        const { settingsJson, updated_at } = await getAppSettingsRow();
        const item = {
            id: businessId,
            slug: settingsJson.business_slug ?? settingsJson.businessSlug ?? settingsJson.slug ?? "personal",
            name: settingsJson.business_name ?? settingsJson.businessName ?? settingsJson.name ?? "Business",
            phone: settingsJson.business_phone ?? settingsJson.businessPhone ?? settingsJson.phone ?? null,
            address: settingsJson.business_address ?? settingsJson.businessAddress ?? settingsJson.address ?? null,
            city: settingsJson.business_city ?? settingsJson.businessCity ?? settingsJson.city ?? null,
            district: settingsJson.business_district ?? settingsJson.businessDistrict ?? settingsJson.district ?? null,
            description: settingsJson.business_description ?? settingsJson.businessDescription ?? settingsJson.description ?? null,
            settings_json: settingsJson,
            is_active: 1,
            created_at: null,
            updated_at: updated_at ?? null,
        };
        return res.json({ ok: true, item });
    }),

    businessesCurrent: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const { settingsJson, updated_at } = await getAppSettingsRow();
        const item = {
            id: businessId,
            slug: settingsJson.business_slug ?? settingsJson.businessSlug ?? settingsJson.slug ?? "personal",
            name: settingsJson.business_name ?? settingsJson.businessName ?? settingsJson.name ?? "Business",
            phone: settingsJson.business_phone ?? settingsJson.businessPhone ?? settingsJson.phone ?? null,
            address: settingsJson.business_address ?? settingsJson.businessAddress ?? settingsJson.address ?? null,
            city: settingsJson.business_city ?? settingsJson.businessCity ?? settingsJson.city ?? null,
            district: settingsJson.business_district ?? settingsJson.businessDistrict ?? settingsJson.district ?? null,
            description: settingsJson.business_description ?? settingsJson.businessDescription ?? settingsJson.description ?? null,
            settings_json: settingsJson,
            is_active: 1,
            created_at: null,
            updated_at: updated_at ?? null,
        };
        return res.json({ ok: true, item });
    }),

    branchesGet: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();
        const id = Number(req.params.id ?? req.params.branch_id);
        if (Number(id) !== Number(branchId)) {
            return res.status(404).json({ ok: false, message: "Not found" });
        }
        const { settingsJson, updated_at } = await getAppSettingsRow();
        const item = {
            id: branchId,
            business_id: businessId,
            name: settingsJson.branch_name ?? settingsJson.branchName ?? "Branch",
            phone: settingsJson.branch_phone ?? settingsJson.branchPhone ?? null,
            address: settingsJson.branch_address ?? settingsJson.branchAddress ?? null,
            is_active: 1,
            created_at: null,
            updated_at: updated_at ?? null,
        };
        return res.json({ ok: true, item });
    }),

    branchesCurrent: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();
        const { settingsJson, updated_at } = await getAppSettingsRow();
        const item = {
            id: branchId,
            business_id: businessId,
            name: settingsJson.branch_name ?? settingsJson.branchName ?? "Branch",
            phone: settingsJson.branch_phone ?? settingsJson.branchPhone ?? null,
            address: settingsJson.branch_address ?? settingsJson.branchAddress ?? null,
            is_active: 1,
            created_at: null,
            updated_at: updated_at ?? null,
        };
        return res.json({ ok: true, item });
    }),

    staffList: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();
        const [rows] = await pool.execute(
            `SELECT s.*,
                    ? AS business_id,
                    ? AS branch_id
               FROM staff s`,
            [businessId, branchId]
        );
        return res.json({ ok: true, items: rows });
    }),

    servicesList: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const [rows] = await pool.execute(
            `SELECT sv.*,
                    ? AS business_id
               FROM services sv`,
            [businessId]
        );
        return res.json({ ok: true, items: rows });
    }),

    staffServicesList: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const [rows] = await pool.execute(
            `SELECT ? AS business_id,
                    sp.id AS provider_id,
                    sp.staff_id,
                    sp.provider_type,
                    ps.service_id,
                    sv.name AS service_name,
                    sv.duration_minutes,
                    sv.price,
                    sv.is_active AS service_is_active
               FROM provider_services ps
               INNER JOIN service_providers sp ON sp.id = ps.provider_id
               LEFT JOIN services sv ON sv.id = ps.service_id`,
            [businessId]
        );
        return res.json({ ok: true, items: rows });
    }),

    /**
     * POST /api/provider_services/by-provider
     * body: { providerId }
     * Returns services for a specific provider
     */
    servicesByProvider: asyncWrap(async (req, res) => {
        const businessId = getPersonalBusinessId();
        const body = req.body || {};
        const providerId = Number(body.providerId ?? body.provider_id ?? body.staffId ?? body.staff_id);

        if (!providerId) {
            throw httpError(400, "providerId zorunlu");
        }

        const [rows] = await pool.execute(
            `SELECT
                sv.id,
                sv.name,
                sv.duration_minutes,
                sv.price,
                sv.is_active
             FROM provider_services ps
             INNER JOIN services sv ON sv.id = ps.service_id
             WHERE ps.provider_id = ?
             AND (sv.is_active IS NULL OR sv.is_active = 1)`,
            [providerId]
        );

        return res.json({ ok: true, items: rows });
    }),

    customerCreate: asyncWrap(async (req, res) => {
        const body = req.body || {};
        const phone = String(body.phone || "").trim();
        const displayName = body.display_name ?? body.displayName ?? null;
        if (!phone) throw httpError(400, "phone zorunlu");
        try {
            const id = await Models.customers.create({
                phone,
                display_name: displayName,
                nickname: body.nickname ?? null,
                is_active: 1
            });
            return res.status(201).json({ ok: true, id });
        } catch (err) {
            if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
                return res.status(409).json({ ok: false, message: "Bu telefon zaten kayitli" });
            }
            throw err;
        }
    }),

    customerUpdate: asyncWrap(async (req, res) => {
        const { id } = req.params;
        const body = req.body || {};
        if (!id) throw httpError(400, "id zorunlu");
        try {
            const updated = await Models.customers.update(
                { id: Number(id) },
                {
                    display_name: body.display_name ?? body.displayName ?? null,
                    nickname: body.nickname ?? null,
                    phone: body.phone ? String(body.phone).trim() : null,
                    is_active: body.is_active !== undefined ? (body.is_active ? 1 : 0) : 1,
                }
            );
            if (!updated) return res.status(404).json({ ok: false, message: "Musteri bulunamadi" });
            return res.json({ ok: true });
        } catch (err) {
            if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
                return res.status(409).json({ ok: false, message: "Bu telefon zaten kayitli" });
            }
            throw err;
        }
    }),

    customerDelete: asyncWrap(async (req, res) => {
        const { id } = req.params;
        if (!id) throw httpError(400, "id zorunlu");
        const deleted = await Models.customers.remove({ id: Number(id) });
        if (!deleted) return res.status(404).json({ ok: false, message: "Musteri bulunamadi" });
        return res.json({ ok: true });
    }),

    appointmentsList: asyncWrap(async (req, res) => {
        requireCustomer(req);
        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();
        const [rows] = await pool.execute(
            `SELECT a.id,
                    ? AS business_id,
                    ? AS branch_id,
                    sp.staff_id AS staff_id,
                    a.provider_id,
                    a.service_id,
                    a.start_at,
                    a.end_at,
                    a.status
               FROM appointments a
               LEFT JOIN service_providers sp ON sp.id = a.provider_id
              WHERE a.status = 'confirmed'`,
            [businessId, branchId]
        );
        return res.json({ ok: true, items: rows });
    }),

    branchClosuresList: asyncWrap(async (req, res) => {
        requireUser(req);
        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();

        const scope = req.query?.scope;
        const providerId = req.query?.provider_id;
        const status = req.query?.status;
        const startDate = req.query?.start_date;
        const endDate = req.query?.end_date;

        let whereClause = "1=1";
        const params = [businessId, branchId];

        if (scope && scope !== 'all') {
            whereClause += " AND c.scope = ?";
            params.push(scope);
        }

        if (providerId) {
            whereClause += " AND c.provider_id = ?";
            params.push(Number(providerId));
        }

        if (status && status !== 'all') {
            whereClause += " AND c.status = ?";
            params.push(status);
        }

        if (startDate) {
            whereClause += " AND c.start_at >= ?";
            params.push(startDate);
        }

        if (endDate) {
            whereClause += " AND c.end_at <= ?";
            params.push(endDate);
        }

        const [rows] = await pool.execute(
            `SELECT c.*,
                    sp.name AS provider_name,
                    sp.provider_type AS provider_type,
                    ? AS business_id,
                    ? AS branch_id
               FROM closures c
               LEFT JOIN service_providers sp ON sp.id = c.provider_id
              WHERE ${whereClause}
              ORDER BY c.id DESC`,
            params
        );
        return res.json({ ok: true, items: rows });
    }),

    branchClosuresPreview: asyncWrap(async (req, res) => {
        requireUser(req);
        const body = req.body || {};
        const providerId = body.provider_id ? Number(body.provider_id) : null;
        const startAt = body.start_at;
        const endAt = body.end_at;

        if (!startAt || !endAt) {
            throw httpError(400, "start_at ve end_at zorunlu");
        }

        let appointmentQuery;
        let queryParams;

        if (providerId) {
            appointmentQuery = `
                SELECT a.id, a.start_at, a.end_at,
                       c.display_name AS customer_name,
                       c.phone AS customer_phone,
                       s.name AS service_name
                FROM appointments a
                JOIN customers c ON c.id = a.customer_id
                JOIN services s ON s.id = a.service_id
                WHERE a.provider_id = ?
                  AND a.status = 'confirmed'
                  AND a.start_at < ?
                  AND a.end_at > ?
                ORDER BY a.start_at
            `;
            queryParams = [providerId, endAt, startAt];
        } else {
            appointmentQuery = `
                SELECT a.id, a.start_at, a.end_at,
                       c.display_name AS customer_name,
                       c.phone AS customer_phone,
                       s.name AS service_name,
                       sp.name AS provider_name
                FROM appointments a
                JOIN customers c ON c.id = a.customer_id
                JOIN services s ON s.id = a.service_id
                JOIN service_providers sp ON sp.id = a.provider_id
                WHERE a.status = 'confirmed'
                  AND a.start_at < ?
                  AND a.end_at > ?
                ORDER BY a.start_at
            `;
            queryParams = [endAt, startAt];
        }

        const [aptRows] = await pool.execute(appointmentQuery, queryParams);

        const warning = aptRows.length > 0
            ? `Bu tarih aralığında ${aptRows.length} randevu bulunmaktadır. Onaylarsanız tümü iptal edilecek ve müşteriler bilgilendirilecektir.`
            : "Bu tarih aralığında randevu bulunmamaktadır.";

        return res.json({
            ok: true,
            has_conflict: aptRows.length > 0,
            appointment_count: aptRows.length,
            appointments: aptRows,
            can_proceed: true,
            warning
        });
    }),

    branchClosuresCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const businessId = getPersonalBusinessId();
        const branchId = getPersonalBranchId();
        await requireAdminUser(decoded);

        const body = req.body || {};
        const scope = body.scope === 'provider' ? 'provider' : 'global';
        const providerId = body.provider_id ? Number(body.provider_id) : null;
        const startAt = body.start_at;
        const endAt = body.end_at;
        const isAllDay = body.is_all_day ?? 1;
        const status = body.status ?? "active";
        const reason = body.reason ?? null;
        const note = body.note ?? null;
        const cancelAppointments = body.cancel_appointments === true;
        const sendSms = body.send_sms === true;

        if (!startAt || !endAt) {
            throw httpError(400, "start_at ve end_at zorunlu");
        }

        if (scope === 'provider' && !providerId) {
            throw httpError(400, "provider_id zorunlu when scope is provider");
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [result] = await conn.execute(
                `INSERT INTO closures
                 (scope, provider_id, start_at, end_at, is_all_day, status, reason, note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    scope,
                    scope === 'global' ? null : providerId,
                    startAt,
                    endAt,
                    isAllDay,
                    status,
                    reason,
                    note
                ]
            );
            const closureId = result.insertId ?? null;

            if (status === "active" && startAt && endAt) {
                let aptQuery;
                let aptParams;

                if (scope === 'provider' && providerId) {
                    aptQuery = `
                        SELECT a.id, a.customer_id, a.start_at, a.end_at,
                               c.phone AS customer_phone, c.display_name AS customer_name
                        FROM appointments a
                        JOIN customers c ON c.id = a.customer_id
                        WHERE a.provider_id = ?
                          AND a.status = 'confirmed'
                          AND a.start_at < ?
                          AND a.end_at > ?
                    `;
                    aptParams = [providerId, endAt, startAt];
                } else {
                    aptQuery = `
                        SELECT a.id, a.customer_id, a.start_at, a.end_at,
                               c.phone AS customer_phone, c.display_name AS customer_name
                        FROM appointments a
                        JOIN customers c ON c.id = a.customer_id
                        WHERE a.status = 'confirmed'
                          AND a.start_at < ?
                          AND a.end_at > ?
                    `;
                    aptParams = [endAt, startAt];
                }

                const [aptRows] = await conn.execute(aptQuery, aptParams);

                if (aptRows.length && cancelAppointments) {
                    const ids = aptRows.map((r) => r.id);
                    const placeholders = ids.map(() => "?").join(", ");
                    const cancelReason = scope === 'provider' ? 'provider_closed' : 'branch_closed';

                    await conn.execute(
                        `UPDATE appointments
                         SET status = 'cancelled',
                             cancelled_by = 'system',
                             cancel_reason = ?,
                             updated_at = ?
                         WHERE id IN (${placeholders})`,
                        [cancelReason, t.toISODateTime(t.now()), ...ids]
                    );

                    for (const apptId of ids) {
                        await conn.execute(
                            `INSERT INTO appointment_status_history
                             (appointment_id, old_status, new_status, changed_by, note)
                             VALUES (?, 'confirmed', 'cancelled', 'system', ?)`,
                            [apptId, cancelReason]
                        );
                    }

                    await conn.execute(
                        `DELETE FROM appointment_slots WHERE appointment_id IN (${placeholders})`,
                        ids
                    );

                    // SMS bildirimi gönder
                    if (sendSms && aptRows.length) {
                        for (const appt of aptRows) {
                            await sendCancellationSms(appt, startAt, endAt);
                        }
                    }
                }
            }

            await conn.commit();

            emitAppointment({
                businessId,
                branchId,
                providerId: scope === 'provider' ? providerId : null,
                status: "cancelled",
                reason: scope === 'provider' ? 'provider_closed' : 'branch_closed',
                closureId
            });

            return res.status(201).json({ ok: true, id: closureId });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }),

    branchClosuresDelete: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params?.id);
        if (!id) throw httpError(400, "id zorunlu");

        const now = t.toISODateTime(t.now());
        const [result] = await pool.execute(
            `UPDATE closures
             SET status = 'cancelled',
                 cancelled_by = ?,
                 cancelled_at = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'active'`,
            [decoded.sub, now, now, id]
        );

        if (result.affectedRows === 0) {
            throw httpError(404, "Closure not found or already cancelled");
        }

        emitAppointment({ action: "closure_cancelled", closureId: id });
        return res.json({ ok: true });
    }),

    branchClosuresGetById: asyncWrap(async (req, res) => {
        // NO requireUser - public endpoint
        const id = Number(req.params?.id);
        if (!id) throw httpError(400, "id zorunlu");

        const [rows] = await pool.execute(
            `SELECT c.*,
                    sp.name AS provider_name,
                    sp.provider_type AS provider_type
               FROM closures c
               LEFT JOIN service_providers sp ON sp.id = c.provider_id
               WHERE c.id = ?
               LIMIT 1`,
            [id]
        );

        if (!rows.length) throw httpError(404, "Closure not found");
        return res.json({ ok: true, item: rows[0] });
    }),

    branchClosuresReopenToday: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const z = t.now();
        const y = z.year;
        const m = String(z.month).padStart(2, "0");
        const d = String(z.day).padStart(2, "0");
        const startAt = `${y}-${m}-${d} 00:00:00`;
        const endAt = `${y}-${m}-${d} 23:59:59`;

        const [result] = await pool.execute(
            `UPDATE closures
             SET status = 'cancelled', updated_at = ?
             WHERE scope = 'global'
               AND status = 'active'
               AND start_at <= ?
               AND end_at >= ?`,
            [t.toISODateTime(t.now()), endAt, startAt]
        );

        emitAppointment({ action: "branch_reopen", affected: result.affectedRows || 0 });
        return res.json({ ok: true, affected: result.affectedRows || 0 });
    }),

    branchClosuresTodayPublic: asyncWrap(async (req, res) => {
        // NO requireUser - public endpoint for booking page
        const z = t.now();
        const y = z.year;
        const m = String(z.month).padStart(2, "0");
        const d = String(z.day).padStart(2, "0");
        const startAt = `${y}-${m}-${d} 00:00:00`;
        const endAt = `${y}-${m}-${d} 23:59:59`;

        const [rows] = await pool.execute(
            `SELECT id FROM closures
             WHERE scope = 'global'
               AND status = 'active'
               AND start_at <= ?
               AND end_at >= ?
             LIMIT 1`,
            [endAt, startAt]
        );

        return res.json({ ok: true, closed: rows.length > 0 });
    }),

    businessSettingsUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const businessId = getPersonalBusinessId();
        await requireAdminUser(decoded);

        const id = Number(req.params.id ?? req.params.business_id);
        if (!id || Number(id) !== Number(businessId)) {
            return res.status(404).json({ ok: false, message: "Not found" });
        }

        const settingsJson = req.body?.settings_json ?? req.body?.settingsJson;
        if (settingsJson === undefined) throw httpError(400, "settings_json zorunlu");

        let settingsObj = settingsJson;
        if (settingsObj === null) settingsObj = {};
        if (typeof settingsObj === "string") {
            try {
                settingsObj = JSON.parse(settingsObj);
            } catch {
                throw httpError(400, "settings_json invalid JSON");
            }
        }

        await pool.execute(
            `INSERT INTO app_settings (id, settings_json)
             VALUES (1, ?)
             ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json), updated_at = ?`,
            [JSON.stringify(settingsObj || {}), t.toISODateTime(t.now())]
        );

        // Desktop SSE — settings değiştiyse bildir
        emitDesktopEvent("state", "settings.updated", {
            printer_enabled: !!settingsObj.printer_enabled,
            printer_auto_print_new: !!settingsObj.printer_auto_print_new,
            printer_daily_report: !!settingsObj.printer_daily_report
        });

        // printer_enabled değişikliği ayrı bir event olarak
        if (typeof settingsObj.printer_enabled === "boolean") {
            emitDesktopEvent(
                "state",
                settingsObj.printer_enabled ? "printer.enabled" : "printer.disabled",
                {}
            );
        }

        return res.json({ ok: true });
    }),

    servicesCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const body = req.body || {};
        const name = String(body.name || "").trim();
        const durationMinutes = Number(body.duration_minutes ?? body.durationMinutes);
        const priceValue = body.price ?? null;
        const isActive = body.is_active ?? 1;

        if (!name) throw httpError(400, "name zorunlu");
        if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
            throw httpError(400, "duration_minutes zorunlu");
        }

        const id = await Models.services.create({
            name,
            duration_minutes: durationMinutes,
            price: priceValue,
            is_active: isActive ? 1 : 0
        });
        return res.status(201).json({ ok: true, id });
    }),

    servicesUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id ?? req.params.service_id);
        if (!id) throw httpError(400, "service id zorunlu");

        const [rows] = await pool.execute(
            `SELECT id FROM services WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ ok: false, message: "Not found" });

        const body = req.body || {};
        const payload = {};
        if (body.name !== undefined) payload.name = String(body.name || "").trim();
        if (body.duration_minutes !== undefined || body.durationMinutes !== undefined) {
            const dur = Number(body.duration_minutes ?? body.durationMinutes);
            if (!Number.isFinite(dur) || dur <= 0) {
                throw httpError(400, "duration_minutes invalid");
            }
            payload.duration_minutes = dur;
        }
        if (body.price !== undefined) {
            payload.price = body.price;
        }
        if (body.is_active !== undefined) payload.is_active = body.is_active ? 1 : 0;
        if (body.sound_id !== undefined) payload.sound_id = body.sound_id;

        const ok = await Models.services.update({ id }, payload);
        if (!ok) return res.status(404).json({ ok: false, message: "Not found" });
        return res.json({ ok: true });
    }),

    staffServicesAssign: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const body = req.body || {};
        // Support both providerId (new) and staffId (legacy)
        let providerId = Number(body.providerId ?? body.provider_id);
        const staffId = Number(body.staffId ?? body.staff_id);
        const serviceId = Number(body.serviceId ?? body.service_id);

        if (!serviceId) throw httpError(400, "serviceId zorunlu");

        // If providerId not provided, get from staffId
        if (!providerId && staffId) {
            const provider = await ensureStaffProvider(staffId);
            if (!provider?.id) throw httpError(404, "Provider not found");
            providerId = provider.id;
        }

        if (!providerId) throw httpError(400, "providerId veya staffId zorunlu");

        // Validate service exists
        const [svcRows] = await pool.execute(
            `SELECT id FROM services WHERE id = ? LIMIT 1`,
            [serviceId]
        );
        if (!svcRows.length) throw httpError(404, "Service not found");

        try {
            await Models.provider_services.create({
                provider_id: providerId,
                service_id: serviceId
            });
        } catch (err) {
            if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
                return res.json({ ok: true, already: true });
            }
            throw err;
        }
        return res.json({ ok: true });
    }),

    staffServicesUnassign: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const body = req.body || {};
        // Support both providerId (new) and staffId (legacy)
        let providerId = Number(body.providerId ?? body.provider_id);
        const staffId = Number(body.staffId ?? body.staff_id);
        const serviceId = Number(body.serviceId ?? body.service_id);

        if (!serviceId) throw httpError(400, "serviceId zorunlu");

        // If providerId not provided, get from staffId
        if (!providerId && staffId) {
            const provider = await ensureStaffProvider(staffId);
            if (!provider?.id) throw httpError(404, "Provider not found");
            providerId = provider.id;
        }

        if (!providerId) throw httpError(400, "providerId veya staffId zorunlu");

        const ok = await Models.provider_services.remove({
            provider_id: providerId,
            service_id: serviceId
        });
        return res.json({ ok: true, removed: ok });
    }),

    staffCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const body = req.body || {};
        const fullName = String(body.full_name ?? body.fullName ?? "").trim();
        const phone = body.phone ? String(body.phone).trim() : null;
        const image = body.image ? String(body.image).trim() : DEFAULT_STAFF_IMAGE;
        const isActive = body.is_active ?? 1;

        if (!fullName) throw httpError(400, "full_name zorunlu");

        const id = await Models.staff.create({
            full_name: fullName,
            phone,
            image,
            is_active: isActive ? 1 : 0
        });
        await ensureStaffProvider(id);
        return res.status(201).json({ ok: true, id });
    }),

    staffUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id ?? req.params.staff_id);
        if (!id) throw httpError(400, "staff id zorunlu");

        const [rows] = await pool.execute(
            `SELECT id FROM staff WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ ok: false, message: "Not found" });

        const body = req.body || {};
        const payload = {};
        if (body.full_name !== undefined || body.fullName !== undefined) {
            payload.full_name = String(body.full_name ?? body.fullName ?? "").trim();
        }
        if (body.phone !== undefined) payload.phone = body.phone ? String(body.phone).trim() : null;
        if (body.image !== undefined) payload.image = body.image ? String(body.image).trim() : null;
        if (body.is_active !== undefined) payload.is_active = body.is_active ? 1 : 0;

        const ok = await Models.staff.update({ id }, payload);
        if (!ok) return res.status(404).json({ ok: false, message: "Not found" });

        await ensureStaffProvider(id);
        const [stRows] = await pool.execute(
            `SELECT full_name, is_active FROM staff WHERE id = ? LIMIT 1`,
            [id]
        );
        const st = stRows[0];
        if (st) {
            await pool.execute(
                `UPDATE service_providers
                    SET name = ?, is_active = ?, updated_at = ?
                  WHERE staff_id = ?`,
                [st.full_name, Number(st.is_active) === 0 ? 0 : 1, t.toISODateTime(t.now()), id]
            );
        }

        return res.json({ ok: true });
    }),

    branchAccountsList: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const [rows] = await pool.execute(
            `SELECT id, staff_id, is_admin, is_active, last_login_at
             FROM staff_accounts`
        );
        return res.json({ ok: true, items: rows });
    }),

    branchAccountsCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const body = req.body || {};
        const staffId = Number(body.staffId ?? body.staff_id);
        const isAdmin = body.is_admin ? 1 : 0;

        if (!staffId) throw httpError(400, "staffId zorunlu");

        const [stRows] = await pool.execute(
            `SELECT id FROM staff WHERE id = ? LIMIT 1`,
            [staffId]
        );
        if (!stRows.length) throw httpError(404, "Staff not found");

        const [existing] = await pool.execute(
            `SELECT id FROM staff_accounts WHERE staff_id = ? LIMIT 1`,
            [staffId]
        );
        if (existing.length) {
            return res.status(409).json({ ok: false, message: "Hesap zaten mevcut" });
        }

        const id = await Models.staff_accounts.create({
            staff_id: staffId,
            is_admin: isAdmin,
            is_active: 1
        });
        return res.status(201).json({ ok: true, id });
    }),

    branchAccountsUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id ?? req.params.account_id);
        if (!id) throw httpError(400, "account id zorunlu");

        const [rows] = await pool.execute(
            `SELECT id FROM staff_accounts WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ ok: false, message: "Not found" });

        const body = req.body || {};
        const payload = {};
        if (body.is_active !== undefined) payload.is_active = body.is_active ? 1 : 0;
        if (body.is_admin !== undefined) payload.is_admin = body.is_admin ? 1 : 0;

        const ok = await Models.staff_accounts.update({ id }, payload);
        if (!ok) return res.status(404).json({ ok: false, message: "Not found" });
        return res.json({ ok: true });
    }),

    branchAccountsRemove: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id ?? req.params.account_id);
        if (!id) throw httpError(400, "account id zorunlu");

        const [rows] = await pool.execute(
            `SELECT id FROM staff_accounts WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ ok: false, message: "Not found" });

        const ok = await Models.staff_accounts.remove({ id });
        return res.json({ ok: true, removed: ok });
    }),

    staffRemove: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id ?? req.params.staff_id);
        if (!id) throw httpError(400, "staff id zorunlu");

        const [rows] = await pool.execute(
            `SELECT id FROM staff WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ ok: false, message: "Not found" });

        try {
            const ok = await Models.staff.remove({ id });
            return res.json({ ok: true, removed: ok });
        } catch (err) {
            if (err && (err.code === "ER_ROW_IS_REFERENCED_2" || err.errno === 1451)) {
                return res.status(409).json({ ok: false, message: "Personel silinemedi, bagli kayitlar var" });
            }
            throw err;
        }
    }),

    // ----- Service Providers CRUD -----
    providersList: asyncWrap(async (req, res) => {
        // Public endpoint - no auth required for customer booking
        const [rows] = await pool.execute(
            `SELECT sp.*, s.full_name as staff_name
             FROM service_providers sp
             LEFT JOIN staff s ON s.id = sp.staff_id
             WHERE sp.is_active = 1
             ORDER BY sp.provider_type, sp.name`
        );
        return res.json({ ok: true, items: rows });
    }),

    providersCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const body = req.body || {};
        const providerType = String(body.provider_type ?? "staff").trim(); // staff, equipment, virtual
        const name = String(body.name ?? "").trim();
        const code = body.code ? String(body.code).trim() : null;
        const staffId = body.staff_id ? Number(body.staff_id) : null;
        const capacity = Number(body.capacity ?? 1);
        const isActive = body.is_active ?? 1;

        if (!name) throw httpError(400, "name zorunlu");
        if (!["staff", "equipment", "virtual"].includes(providerType)) {
            throw httpError(400, "provider_type: staff, equipment veya virtual olmali");
        }
        if (providerType === "staff" && !staffId) {
            throw httpError(400, "staff tipi icin staff_id zorunlu");
        }

        const id = await Models.service_providers.create({
            provider_type: providerType,
            name,
            code,
            staff_id: staffId,
            capacity: Math.max(1, capacity),
            is_active: isActive ? 1 : 0
        });
        return res.status(201).json({ ok: true, id });
    }),

    providersUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id);
        if (!id) throw httpError(400, "provider id zorunlu");

        const [rows] = await pool.execute(
            `SELECT id FROM service_providers WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ ok: false, message: "Provider not found" });

        const body = req.body || {};
        const updateData = {};
        if (body.name !== undefined) updateData.name = String(body.name).trim();
        if (body.code !== undefined) updateData.code = body.code ? String(body.code).trim() : null;
        if (body.capacity !== undefined) updateData.capacity = Math.max(1, Number(body.capacity));
        if (body.is_active !== undefined) updateData.is_active = body.is_active ? 1 : 0;
        if (body.provider_type !== undefined) updateData.provider_type = String(body.provider_type).trim();

        // #7: Prevent empty update
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ ok: false, message: "Güncellenecek alan belirtilmedi" });
        }

        const ok = await Models.service_providers.update({ id }, updateData);
        return res.json({ ok: true, updated: ok });
    }),

    providersRemove: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id);
        if (!id) throw httpError(400, "provider id zorunlu");

        try {
            const ok = await Models.service_providers.remove({ id });
            return res.json({ ok: true, removed: ok });
        } catch (err) {
            if (err && (err.code === "ER_ROW_IS_REFERENCED_2" || err.errno === 1451)) {
                return res.status(409).json({ ok: false, message: "Provider silinemedi, bagli kayitlar var" });
            }
            throw err;
        }
    }),

    /**
     * POST /api/appointments/:id/send-reminder
     * Manuel olarak randevu hatırlatma SMS'i gönderir
     */
    sendAppointmentReminder: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const businessId = getPersonalBusinessId();
        await requireAdminUser(decoded);

        const appointmentId = Number(req.params.id);
        if (!appointmentId) throw httpError(400, "appointment id zorunlu");

        // Randevuyu bul
        const [apptRows] = await pool.execute(
            `SELECT a.*,
                    c.phone as customer_phone,
                    c.display_name as customer_name,
                    sv.name as service_name,
                    sp.name as provider_name
             FROM appointments a
             LEFT JOIN customers c ON c.id = a.customer_id
             LEFT JOIN services sv ON sv.id = a.service_id
             LEFT JOIN service_providers sp ON sp.id = a.provider_id
             WHERE a.id = ?`,
            [appointmentId]
        );

        if (!apptRows || !apptRows[0]) {
            throw httpError(404, "Randevu bulunamadi");
        }

        const appt = apptRows[0];
        const phone = appt.customer_phone;

        if (!phone) {
            throw httpError(400, "Musteri telefonu yok");
        }

        // Tarih ve saat formatla
        const startDt = t.fromDBDateTime(appt.start_at);
        const dateStr = t.formatDate(startDt);
        const timeStr = t.formatTime(startDt);

        // Hatırlatma mesajı oluştur
        const msg = `Ercan İncirkuş Berber Dükkanı - Merhaba ${appt.customer_name || "Musteri"}, randevunuz ${dateStr} tarihinde ${timeStr} saatinde ${appt.service_name || "hizmet"} icin hatirlatilir. Sagliklar!`;

        try {
            await sendSms({
                appointment_id: appointmentId,
                phone: phone,
                message: msg,
                type: "reminder",
                source: "manual"
            });
            return res.json({ ok: true, message: "SMS gonderildi" });
        } catch (smsErr) {
            console.error("Hatirlatma SMS gonderilemedi:", smsErr);
            throw httpError(500, "SMS gonderilemedi");
        }
    }),

    // ---- Period Settings CRUD ----
    periodSettingsList: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const [rows] = await pool.execute(
            `SELECT id, start_date, end_date, data_json, created_at, updated_at
             FROM period_settings
             ORDER BY start_date DESC`
        );

        return res.json({
            ok: true,
            items: rows.map((r) => ({
                ...r,
                start_date: typeof r.start_date === "string" ? r.start_date.slice(0, 10) : String(r.start_date).slice(0, 10),
                end_date: typeof r.end_date === "string" ? r.end_date.slice(0, 10) : String(r.end_date).slice(0, 10),
                data_json: typeof r.data_json === "string" ? JSON.parse(r.data_json) : r.data_json
            }))
        });
    }),

    periodSettingsCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const body = req.body || {};
        const startDate = body.start_date;
        const endDate = body.end_date;
        const dataJson = body.data_json;

        if (!startDate || !endDate) {
            throw httpError(400, "start_date ve end_date zorunlu");
        }

        if (!dataJson || typeof dataJson !== "object") {
            throw httpError(400, "data_json zorunlu ve object olmali");
        }

        const [result] = await pool.execute(
            `INSERT INTO period_settings (start_date, end_date, data_json)
             VALUES (?, ?, ?)`,
            [startDate, endDate, JSON.stringify(dataJson)]
        );

        return res.json({ ok: true, id: result.insertId });
    }),

    periodSettingsUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");

        const body = req.body || {};
        const startDate = body.start_date;
        const endDate = body.end_date;
        const dataJson = body.data_json;

        if (!startDate || !endDate) {
            throw httpError(400, "start_date ve end_date zorunlu");
        }

        if (!dataJson || typeof dataJson !== "object") {
            throw httpError(400, "data_json zorunlu ve object olmali");
        }

        await pool.execute(
            `UPDATE period_settings
             SET start_date = ?, end_date = ?, data_json = ?, updated_at = ?
             WHERE id = ?`,
            [startDate, endDate, JSON.stringify(dataJson), t.toISODateTime(t.now()), id]
        );

        return res.json({ ok: true });
    }),

    periodSettingsPreviewUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");

        const body = req.body || {};
        const newDataJson = body.data_json;

        if (!newDataJson || typeof newDataJson !== "object") {
            throw httpError(400, "data_json zorunlu ve object olmali");
        }

        const newSettings = newDataJson?.settings || {};
        const newStartHour = newSettings.start_hour;
        const newEndHour = newSettings.end_hour;

        // Mevcut period_setting'i al
        const [psRows] = await pool.execute(
            `SELECT start_date, end_date, data_json FROM period_settings WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!psRows.length) throw httpError(404, "Period setting not found");

        const ps = psRows[0];
        const rawDataJson = ps.data_json;
        const currentData = typeof rawDataJson === 'string' ? JSON.parse(rawDataJson || "{}") : (rawDataJson || {});
        const currentSettings = currentData.settings || {};

        // Eski ve yeni saatleri karşılaştır
        const oldStartHour = currentSettings.start_hour || "09:00";
        const oldEndHour = currentSettings.end_hour || "22:00";

        // Saatler değişmediyse conflict yok
        if (newStartHour === oldStartHour && newEndHour === oldEndHour) {
            return res.json({
                ok: true,
                has_conflict: false,
                appointment_count: 0,
                appointments: [],
                warning: "Uyumsuz randevu bulunamadi."
            });
        }

        // Yeni saatlere sığmayan randevuları bul
        const [conflicts] = await pool.execute(`
            SELECT a.id, a.start_at, a.end_at,
                   c.display_name AS customer_name,
                   c.phone AS customer_phone,
                   s.name AS service_name,
                   sp.name AS provider_name
            FROM appointments a
            JOIN customers c ON c.id = a.customer_id
            JOIN services s ON s.id = a.service_id
            JOIN service_providers sp ON sp.id = a.provider_id
            WHERE DATE(a.start_at) BETWEEN ? AND ?
            AND a.status = 'confirmed'
            AND (
                TIME(a.start_at) < ? OR TIME(a.end_at) > ?
            )
        `, [ps.start_date, ps.end_date, newStartHour || oldStartHour, newEndHour || oldEndHour]);

        return res.json({
            ok: true,
            has_conflict: conflicts.length > 0,
            appointment_count: conflicts.length,
            appointments: conflicts,
            warning: conflicts.length > 0
                ? `${conflicts.length} randevu yeni saatlere (${newStartHour || oldStartHour}-${newEndHour || oldEndHour}) sigmiyor. Iptal edilecek.`
                : "Uyumsuz randevu bulunamadi."
        });
    }),

    periodSettingsDelete: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);

        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");

        // Silmeden once appointment sayisini bul (opsiyonel, silme oncesi bilgi)
        const [psRows] = await pool.execute(
            `SELECT start_date, end_date FROM period_settings WHERE id = ? LIMIT 1`,
            [id]
        );
        let affectedAppointments = 0;
        if (psRows.length > 0) {
            const ps = psRows[0];
            const [apptRows] = await pool.execute(
                `SELECT COUNT(*) as cnt FROM appointments
                 WHERE DATE(start_at) BETWEEN ? AND ?
                 AND status = 'confirmed'`,
                [ps.start_date, ps.end_date]
            );
            affectedAppointments = apptRows[0]?.cnt || 0;
        }

        // cancel_appointments flag kontrolü
        const body = req.body || {};
        const cancelAppointments = body.cancel_appointments === true;
        const sendSmsFlag = body.send_sms === true;

        // İptal edilecek randevuları bul (SMS için gerekli bilgiler)
        let cancelAppts = [];
        if (cancelAppointments && affectedAppointments > 0) {
            const [apptRows] = await pool.execute(`
                SELECT a.id, a.customer_id, a.start_at,
                       c.phone AS customer_phone, c.display_name AS customer_name
                FROM appointments a
                JOIN customers c ON c.id = a.customer_id
                WHERE DATE(a.start_at) BETWEEN ? AND ?
                AND a.status = 'confirmed'
            `, [psRows[0].start_date, psRows[0].end_date]);
            cancelAppts = apptRows;
        }

        // Onay silme islemi
        if (cancelAppointments && affectedAppointments > 0) {
            // Bu tarih araligindaki confirmed appointment'lari iptal et
            await pool.execute(
                `UPDATE appointments SET status = 'cancelled',
                 cancelled_by = 'system', cancel_reason = 'period_deleted', updated_at = ?
                 WHERE DATE(start_at) BETWEEN ? AND ?
                 AND status = 'confirmed'`,
                [t.toISODateTime(t.now()), psRows[0].start_date, psRows[0].end_date]
            );

            // SMS gönder
            if (sendSmsFlag && cancelAppts.length) {
                for (const appt of cancelAppts) {
                    await sendCancellationSms(appt, psRows[0].start_date, psRows[0].end_date);
                }
            }
        }

        await pool.execute(`DELETE FROM period_settings WHERE id = ?`, [id]);

        return res.json({
            ok: true,
            affectedAppointments
        });
    }),

    periodSettingsForDate: asyncWrap(async (req, res) => {
        const decoded = requireSession(req);
        if (!decoded) throw httpError(401, "Unauthenticated");
        const body = req.body || {};
        const dateStr = String(body.date || "").trim();
        if (!dateStr) throw httpError(400, "date zorunlu (YYYY-MM-DD)");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError(400, "Gecersiz date format");
        const [rows] = await pool.execute(
            `SELECT id, start_date, end_date, data_json, created_at, updated_at
             FROM period_settings
             WHERE start_date <= ? AND end_date >= ?
             ORDER BY end_date DESC LIMIT 1`,
            [dateStr, dateStr]
        );
        if (!rows.length) return res.json({ ok: true, item: null });
        const row = rows[0];
        let dataJson = row.data_json;
        if (typeof dataJson === "string") { try { dataJson = JSON.parse(dataJson); } catch { dataJson = {}; } }
        return res.json({
            ok: true,
            item: {
                id: row.id,
                start_date: typeof row.start_date === "string" ? row.start_date.slice(0, 10) : String(row.start_date).slice(0, 10),
                end_date: typeof row.end_date === "string" ? row.end_date.slice(0, 10) : String(row.end_date).slice(0, 10),
                data_json: dataJson
            }
        });
    }),

    // ============ V2 SLOT ENGINE CRUD ============

    /**
     * provider_break_rules CRUD
     */
    providerBreakRulesList: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const [rows] = await pool.execute(
            `SELECT pbr.*, sp.name AS provider_name
             FROM provider_break_rules pbr
             LEFT JOIN service_providers sp ON sp.id = pbr.provider_id
             WHERE pbr.is_active = 1
             ORDER BY pbr.id`
        );
        const items = rows.map(r => {
            let ruleJson = r.rule_json;
            if (typeof ruleJson === "string") {
                try { ruleJson = JSON.parse(ruleJson); } catch { ruleJson = {}; }
            }
            return { ...r, rule_json: ruleJson };
        });
        return res.json({ ok: true, items });
    }),

    providerBreakRulesCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const body = req.body || {};
        const providerId = Number(body.provider_id);
        const ruleJson = body.rule_json;
        const isActive = body.is_active ?? 1;
        if (!providerId) throw httpError(400, "provider_id zorunlu");
        if (!ruleJson) throw httpError(400, "rule_json zorunlu");
        const ruleJsonStr = typeof ruleJson === "string" ? ruleJson : JSON.stringify(ruleJson);
        const id = await Models.provider_break_rules.create({
            provider_id: providerId,
            rule_json: ruleJsonStr,
            is_active: isActive ? 1 : 0,
        });
        return res.status(201).json({ ok: true, id });
    }),

    providerBreakRulesUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        const body = req.body || {};
        const payload = {};
        if (body.provider_id !== undefined) payload.provider_id = Number(body.provider_id);
        if (body.rule_json !== undefined) {
            payload.rule_json = typeof body.rule_json === "string" ? body.rule_json : JSON.stringify(body.rule_json);
        }
        if (body.is_active !== undefined) payload.is_active = body.is_active ? 1 : 0;
        const ok = await Models.provider_break_rules.update({ id }, payload);
        if (!ok) return res.status(404).json({ ok: false, message: "Not found" });
        return res.json({ ok: true });
    }),

    providerBreakRulesDelete: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        const ok = await Models.provider_break_rules.remove({ id });
        if (!ok) return res.status(404).json({ ok: false, message: "Not found" });
        return res.json({ ok: true });
    }),

    providerBreakRulesGetById: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        const item = await Models.provider_break_rules.get({ id });
        if (!item) return res.status(404).json({ ok: false, message: "Not found" });
        let ruleJson = item.rule_json;
        if (typeof ruleJson === "string") {
            try { ruleJson = JSON.parse(ruleJson); } catch { ruleJson = {}; }
        }
        return res.json({ ok: true, item: { ...item, rule_json: ruleJson } });
    }),

    /**
     * provider_static_slots CRUD
     */
    providerStaticSlotsList: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const [rows] = await pool.execute(
            `SELECT pss.*, sp.name AS provider_name
             FROM provider_static_slots pss
             LEFT JOIN service_providers sp ON sp.id = pss.provider_id
             WHERE pss.is_active = 1
             ORDER BY pss.id`
        );
        return res.json({ ok: true, items: rows });
    }),

    providerStaticSlotsCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const body = req.body || {};
        const providerId = Number(body.provider_id);
        const startTime = body.start_time;
        const endTime = body.end_time;
        const isActive = body.is_active ?? 1;
        if (!providerId) throw httpError(400, "provider_id zorunlu");
        if (!startTime) throw httpError(400, "start_time zorunlu");
        if (!endTime) throw httpError(400, "end_time zorunlu");
        const id = await Models.provider_static_slots.create({
            provider_id: providerId,
            start_time: startTime,
            end_time: endTime,
            is_active: isActive ? 1 : 0,
        });
        return res.status(201).json({ ok: true, id });
    }),

    providerStaticSlotsUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        const body = req.body || {};
        const payload = {};
        if (body.provider_id !== undefined) payload.provider_id = Number(body.provider_id);
        if (body.start_time !== undefined) payload.start_time = body.start_time;
        if (body.end_time !== undefined) payload.end_time = body.end_time;
        if (body.is_active !== undefined) payload.is_active = body.is_active ? 1 : 0;
        const ok = await Models.provider_static_slots.update({ id }, payload);
        if (!ok) return res.status(404).json({ ok: false, message: "Not found" });
        return res.json({ ok: true });
    }),

    providerStaticSlotsDelete: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        const ok = await Models.provider_static_slots.remove({ id });
        if (!ok) return res.status(404).json({ ok: false, message: "Not found" });
        return res.json({ ok: true });
    }),

    providerStaticSlotsGetById: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        const item = await Models.provider_static_slots.get({ id });
        if (!item) return res.status(404).json({ ok: false, message: "Not found" });
        return res.json({ ok: true, item });
    }),

    /**
     * reserved_slots CRUD
     */
    reservedSlotsList: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const [rows] = await pool.execute(
            `SELECT rs.*, sp.name AS provider_name, c.display_name AS customer_name
             FROM reserved_slots rs
             LEFT JOIN service_providers sp ON sp.id = rs.provider_id
             LEFT JOIN customers c ON c.id = rs.customer_id
             ORDER BY rs.day_of_week, rs.start_time`
        );
        return res.json({ ok: true, items: rows });
    }),

    reservedSlotsCreate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const body = req.body || {};
        const { provider_id, customer_id, day_of_week, start_time, end_time,
                recurrence_weeks, beginning, is_active, note } = body;
        if (!provider_id) throw httpError(400, "provider_id zorunlu");
        if (!day_of_week) throw httpError(400, "day_of_week zorunlu");
        if (!start_time) throw httpError(400, "start_time zorunlu");
        if (!end_time) throw httpError(400, "end_time zorunlu");
        const [result] = await pool.execute(
            `INSERT INTO reserved_slots
             (provider_id, customer_id, day_of_week, start_time, end_time,
              recurrence_weeks, beginning, is_active, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                Number(provider_id),
                customer_id ? Number(customer_id) : null,
                day_of_week,
                start_time,
                end_time,
                recurrence_weeks ? Number(recurrence_weeks) : 1,
                beginning || null,
                is_active !== undefined ? (is_active ? 1 : 0) : 1,
                note || null
            ]
        );
        return res.status(201).json({ ok: true, id: result.insertId });
    }),

    reservedSlotsUpdate: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        const body = req.body || {};
        const fields = [];
        const params = [];
        const allowed = ["provider_id", "customer_id", "day_of_week", "start_time",
                         "end_time", "recurrence_weeks", "beginning", "is_active", "note"];
        for (const f of allowed) {
            if (body[f] !== undefined) {
                fields.push(`${f} = ?`);
                params.push(f === "provider_id" || f === "customer_id" || f === "recurrence_weeks"
                    ? Number(body[f]) : body[f]);
            }
        }
        if (fields.length === 0) throw httpError(400, "Güncellenecek alan yok");
        fields.push("updated_at = NOW()");
        params.push(id);
        await pool.execute(
            `UPDATE reserved_slots SET ${fields.join(", ")} WHERE id = ?`,
            params
        );
        return res.json({ ok: true });
    }),

    reservedSlotsDelete: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        await pool.execute(`DELETE FROM reserved_slots WHERE id = ?`, [id]);
        return res.json({ ok: true });
    }),

    reservedSlotsGetById: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const id = Number(req.params.id);
        if (!id) throw httpError(400, "id zorunlu");
        const [rows] = await pool.execute(
            `SELECT rs.*, sp.name AS provider_name, c.display_name AS customer_name
             FROM reserved_slots rs
             LEFT JOIN service_providers sp ON sp.id = rs.provider_id
             LEFT JOIN customers c ON c.id = rs.customer_id
             WHERE rs.id = ? LIMIT 1`,
            [id]
        );
        return res.json({ ok: true, item: rows[0] || null });
    }),

    /**
     * POST /api/reserved-slots/check-conflicts
     * Verilen parametrelere göre çakışan rezervasyonları döner.
     * Kaydetmeden önce çakışma kontrolü yapar.
     */
    reservedSlotsCheckConflicts: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        await requireAdminUser(decoded);
        const body = req.body || {};
        const { provider_id, day_of_week, start_time, end_time, beginning, exclude_id } = body;
        if (!provider_id) throw httpError(400, "provider_id zorunlu");
        if (!day_of_week) throw httpError(400, "day_of_week zorunlu");
        if (!start_time) throw httpError(400, "start_time zorunlu");
        if (!end_time) throw httpError(400, "end_time zorunlu");

        // Overlap check: NOT (end_a <= start_b OR start_a >= end_b)
        const query = `
            SELECT id, day_of_week, start_time, end_time, beginning, note, customer_id
            FROM reserved_slots
            WHERE provider_id = ?
              AND is_active = 1
              AND day_of_week = ?
              AND end_time > ?
              AND start_time < ?
              AND (? IS NULL OR beginning IS NULL OR beginning <= CURDATE())
              AND (? IS NULL OR id != ?)
        `;
        const [rows] = await pool.execute(query, [
            Number(provider_id),
            day_of_week,
            start_time,
            end_time,
            beginning || null,
            exclude_id || null,
            exclude_id || null
        ]);
        return res.json({ ok: true, conflicts: rows });
    }),

    servicesGet: asyncWrap(async (req, res) => {
        const { id } = req.params;
        const businessId = getPersonalBusinessId();
        const [rows] = await pool.execute(
            `SELECT sv.*, ? AS business_id FROM services sv WHERE sv.id = ?`,
            [businessId, id]
        );
        if (!rows.length) return res.status(404).json({ ok: false, message: "Service not found" });
        return res.json({ ok: true, item: rows[0] });
    }),

    soundsList: asyncWrap(async (req, res) => {
        const [rows] = await pool.execute(`SELECT * FROM sounds ORDER BY id DESC`);
        return res.json({ ok: true, items: rows });
    }),

    soundsGet: asyncWrap(async (req, res) => {
        const { id } = req.params;
        const [rows] = await pool.execute(`SELECT * FROM sounds WHERE id = ? LIMIT 1`, [id]);
        if (!rows.length) return res.status(404).json({ ok: false, message: "Sound not found" });
        return res.json({ ok: true, item: rows[0] });
    }),

    // Desktop Events ACK — desktop uygulaması yazdırma sonucunu bildirir
    desktopEventAck: asyncWrap(async (req, res) => {
        const decoded = requireUser(req);
        const { eventId, status, reason } = req.body || {};

        if (!eventId) throw httpError(400, "eventId zorunlu");
        if (!["success", "failed"].includes(status)) {
            throw httpError(400, "status 'success' veya 'failed' olmalı");
        }

        // Şimdilik console log — ileride veritabanına kaydedilebilir
        console.log(`[DesktopACK] event=${eventId} status=${status} reason=${reason || ""}`);

        return res.json({ ok: true });
    }),

    // Desktop Appointments Today — yazıcı için günlük veri
    desktopAppointmentsToday: asyncWrap(async (req, res) => {
        // X-Desktop-Secret auth
        const secret = process.env.DESKTOP_EVENTS_SECRET;
        if (secret && req.headers["x-desktop-secret"] !== secret) {
            throw httpError(401, "Unauthorized");
        }

        const dateStr = req.query.date || todayYmd();
        const nextDateStr = addDaysYmd(dateStr, 1);

        // SQL: date 06:00 → next_date 03:00 (gece yarısı devam eden randevular için)
        const startRange = `${dateStr} 06:00:00`;
        const endRange = `${nextDateStr} 03:00:00`;

        // Business/branch info (app_settings)
        const settings = await getBusinessSettingsJson(getPersonalBusinessId());

        // Günün randevuları
        const [appts] = await pool.execute(
            `SELECT
                 a.id,
                 a.start_at,
                 a.end_at,
                 a.status,
                 a.service_name_snapshot,
                 a.service_duration_minutes_snapshot,
                 a.service_price_snapshot,
                 a.provider_name_snapshot,
                 a.provider_type_snapshot,
                 a.customer_note,
                 a.staff_note,
                 c.id AS customer_id,
                 c.display_name AS customer_name,
                 c.nickname AS customer_nickname,
                 c.phone AS customer_phone
             FROM appointments a
             LEFT JOIN customers c ON c.id = a.customer_id
             WHERE a.start_at >= ? AND a.start_at < ?
               AND a.status IN ('confirmed','completed','no_show')
             ORDER BY a.start_at ASC`,
            [startRange, endRange]
        );

        return res.json({
            ok: true,
            date: dateStr,
            business: {
                name: settings.business_name,
                phone: settings.business_phone,
                address: settings.business_address,
                city: settings.business_city,
                district: settings.business_district
            },
            branch: {
                name: settings.branch_name,
                phone: settings.branch_phone,
                address: settings.branch_address
            },
            printer_settings: {
                printer_enabled: !!settings.printer_enabled,
                printer_auto_print_new: !!settings.printer_auto_print_new,
                printer_daily_report: !!settings.printer_daily_report
            },
            appointments: appts.map(a => ({
                id: a.id,
                start_at: a.start_at,
                end_at: a.end_at,
                status: a.status,
                service_name: a.service_name_snapshot,
                service_duration: a.service_duration_minutes_snapshot,
                service_price: a.service_price_snapshot,
                provider_name: a.provider_name_snapshot,
                provider_type: a.provider_type_snapshot,
                customer_id: a.customer_id,
                customer_name: a.customer_name,
                customer_nickname: a.customer_nickname,
                customer_phone: a.customer_phone,
                customer_note: a.customer_note,
                staff_note: a.staff_note
            })),
            count: appts.length
        });
    }),

    // Desktop Appointment By ID — tek randevu detayı
    desktopAppointmentById: asyncWrap(async (req, res) => {
        // X-Desktop-Secret auth
        const secret = process.env.DESKTOP_EVENTS_SECRET;
        if (secret && req.headers["x-desktop-secret"] !== secret) {
            throw httpError(401, "Unauthorized");
        }

        const appointmentId = Number(req.params.id);
        if (!appointmentId) throw httpError(400, "Geçersiz appointment ID");

        // Business/branch info (app_settings)
        const settings = await getBusinessSettingsJson(getPersonalBusinessId());

        // Randevu detayı
        const [appts] = await pool.execute(
            `SELECT
                 a.id,
                 a.start_at,
                 a.end_at,
                 a.status,
                 a.service_name_snapshot,
                 a.service_duration_minutes_snapshot,
                 a.service_price_snapshot,
                 a.provider_name_snapshot,
                 a.provider_type_snapshot,
                 a.customer_note,
                 a.staff_note,
                 c.id AS customer_id,
                 c.display_name AS customer_name,
                 c.nickname AS customer_nickname,
                 c.phone AS customer_phone
             FROM appointments a
             LEFT JOIN customers c ON c.id = a.customer_id
             WHERE a.id = ?
             LIMIT 1`,
            [appointmentId]
        );

        if (!appts.length) {
            throw httpError(404, "Randevu bulunamadı");
        }

        const a = appts[0];
        return res.json({
            ok: true,
            appointment: {
                id: a.id,
                start_at: a.start_at,
                end_at: a.end_at,
                status: a.status,
                service_name: a.service_name_snapshot,
                service_duration: a.service_duration_minutes_snapshot,
                service_price: a.service_price_snapshot,
                provider_name: a.provider_name_snapshot,
                provider_type: a.provider_type_snapshot,
                customer_id: a.customer_id,
                customer_name: a.customer_name,
                customer_nickname: a.customer_nickname,
                customer_phone: a.customer_phone,
                customer_note: a.customer_note,
                staff_note: a.staff_note
            },
            business: {
                name: settings.business_name,
                phone: settings.business_phone,
                address: settings.business_address,
                city: settings.business_city,
                district: settings.business_district
            },
            branch: {
                name: settings.branch_name,
                phone: settings.branch_phone,
                address: settings.branch_address
            },
            printer_settings: {
                printer_enabled: !!settings.printer_enabled,
                printer_auto_print_new: !!settings.printer_auto_print_new,
                printer_daily_report: !!settings.printer_daily_report
            }
        });
    }),

    // Desktop Event Action — calendar'dan gün başı/gün sonu komutu
    desktopEventAction: asyncWrap(async (req, res) => {
        // X-Desktop-Secret auth
        const secret = process.env.DESKTOP_EVENTS_SECRET;
        if (secret && req.headers["x-desktop-secret"] !== secret) {
            throw httpError(401, "Unauthorized");
        }

        const { action } = req.body || {};
        if (action !== "day.start" && action !== "day.end") {
            throw httpError(400, "Invalid action");
        }

        emitDesktopEvent("command", action, {
            triggeredAt: new Date().toISOString(),
            triggeredBy: "calendar"
        });

        res.json({ ok: true });
    }),
};

module.exports = { AuthControllers, BookingControllers, ScopedControllers, asyncWrap };







