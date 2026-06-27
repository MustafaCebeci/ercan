// models.js
// Tüm tablolar için CRUD Model katmanı (mysql2/promise + namedPlaceholders)
require("dotenv").config();
const mysql = require("mysql2/promise");

// ============ DB POOL ============
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,

    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
    queueLimit: 0,

    // Kopmaları azaltır:
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,

    // "bağlanamadım/çok bekledim" durumlarını daha düzgün yönetir:
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(err) {
    const code = err?.code || "";
    return (
        code === "ECONNRESET" ||
        code === "PROTOCOL_CONNECTION_LOST" ||
        code === "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR" ||
        code === "ETIMEDOUT"
    );
}

const executeRaw = pool.execute.bind(pool);
const queryRaw = pool.query.bind(pool);

async function executeWithRetry(fn, args, retries) {
    try {
        return await fn(...args);
    } catch (err) {
        if (retries > 0 && isTransientDbError(err)) {
            await sleep(100);
            return executeWithRetry(fn, args, retries - 1);
        }
        throw err;
    }
}

const defaultRetries = Number(process.env.DB_RETRY_COUNT || 1);
pool.execute = (sql, params) => executeWithRetry(executeRaw, [sql, params], defaultRetries);
pool.query = (sql, params) => executeWithRetry(queryRaw, [sql, params], defaultRetries);

pool.on("connection", (conn) => {
    conn.on("error", (err) => {
        if (isTransientDbError(err)) {
            // Let pool recreate connections; just avoid unhandled errors.
            return;
        }
        console.error("MySQL connection error:", err);
    });
});

// ============ HELPERS ============
function pickAllowed(obj, allowed) {
    const out = {};
    if (!obj) return out;
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    return out;
}

function ensureNotEmpty(data, table, action) {
    if (!data || Object.keys(data).length === 0) {
        const err = new Error(`${table}: ${action} için alan yok`);
        err.status = 400;
        throw err;
    }
}

function createCrudModel({ table, pk, columns }) {
    const pkCols = Array.isArray(pk) ? pk : [pk];

    return {
        table,
        pk: pkCols,
        columns,

        async list() {
            const [rows] = await pool.execute(`SELECT * FROM ${table}`);
            return rows;
        },

        async get(pkObj) {
            const where = pkCols.map((c) => `${c}=?`).join(" AND ");
            const params = pkCols.map((c) => pkObj[c]);
            const [rows] = await pool.execute(
                `SELECT * FROM ${table} WHERE ${where} LIMIT 1`,
                params
            );
            return rows[0] || null;
        },

        async create(payload) {
            const data = pickAllowed(payload, columns);
            ensureNotEmpty(data, table, "create");

            const keys = Object.keys(data);
            const colsSql = keys.join(", ");
            const valsSql = keys.map(() => `?`).join(", ");
            const params = keys.map((k) => data[k]);

            const [result] = await pool.execute(
                `INSERT INTO ${table} (${colsSql}) VALUES (${valsSql})`,
                params
            );
            return result.insertId ?? null;
        },

        async update(pkObj, payload) {
            const allowed = columns.filter((c) => !pkCols.includes(c));
            const data = pickAllowed(payload, allowed);
            ensureNotEmpty(data, table, "update");

            const keys = Object.keys(data);
            const setSql = keys.map((k) => `${k}=?`).join(", ");
            const whereSql = pkCols.map((c) => `${c}=?`).join(" AND ");

            const params = [
                ...keys.map((k) => data[k]),
                ...pkCols.map((c) => pkObj[c]),
            ];

            const [result] = await pool.execute(
                `UPDATE ${table} SET ${setSql} WHERE ${whereSql}`,
                params
            );
            return (result.affectedRows || 0) > 0;
        },

        async remove(pkObj) {
            const whereSql = pkCols.map((c) => `${c}=?`).join(" AND ");
            const params = pkCols.map((c) => pkObj[c]);

            const [result] = await pool.execute(
                `DELETE FROM ${table} WHERE ${whereSql}`,
                params
            );
            return (result.affectedRows || 0) > 0;
        },
    };
}

// ============ MODELS (personal_db.sql TABLOLARINA GÖRE) ============
const Models = {
    app_settings: createCrudModel({
        table: "app_settings",
        pk: "id",
        columns: ["id", "settings_json", "updated_at"],
    }),

    customers: createCrudModel({
        table: "customers",
        pk: "id",
        columns: ["id", "phone", "display_name", "nickname", "is_active", "created_at", "updated_at"],
    }),

    services: createCrudModel({
        table: "services",
        pk: "id",
        columns: ["id", "name", "duration_minutes", "price", "is_active", "created_at", "updated_at"],
    }),

    staff: createCrudModel({
        table: "staff",
        pk: "id",
        columns: ["id", "full_name", "phone", "image", "is_active", "created_at", "updated_at"],
    }),

    service_providers: createCrudModel({
        table: "service_providers",
        pk: "id",
        columns: [
            "id",
            "provider_type",
            "code",
            "name",
            "staff_id",
            "capacity",
            "meta_json",
            "is_active",
            "created_at",
            "updated_at",
        ],
    }),

    provider_services: createCrudModel({
        table: "provider_services",
        pk: ["provider_id", "service_id"],
        columns: ["provider_id", "service_id"],
    }),

    appointments: createCrudModel({
        table: "appointments",
        pk: "id",
        columns: [
            "id",
            "provider_id",
            "service_id",
            "is_custom",
            "customer_id",
            "start_at",
            "end_at",
            "service_name_snapshot",
            "service_duration_minutes_snapshot",
            "service_price_snapshot",
            "provider_name_snapshot",
            "provider_type_snapshot",
            "status",
            "cancelled_by",
            "cancel_reason",
            "customer_note",
            "staff_note",
            "created_at",
            "updated_at",
        ],
    }),

    appointment_slots: createCrudModel({
        table: "appointment_slots",
        pk: "id",
        columns: ["id", "appointment_id", "provider_id", "slot_time"],
    }),

    appointment_status_history: createCrudModel({
        table: "appointment_status_history",
        pk: "id",
        columns: ["id", "appointment_id", "old_status", "new_status", "changed_by", "note", "created_at"],
    }),

    closures: createCrudModel({
        table: "closures",
        pk: "id",
        columns: [
            "id",
            "scope",
            "provider_id",
            "start_at",
            "end_at",
            "is_all_day",
            "status",
            "reason",
            "note",
            "created_at",
            "updated_at",
        ],
    }),

    staff_accounts: createCrudModel({
        table: "staff_accounts",
        pk: "id",
        columns: [
            "id",
            "staff_id",
            "is_admin",
            "is_active",
            "last_login_at",
            "created_at",
            "updated_at",
        ],
    }),

    customer_flags: createCrudModel({
        table: "customer_flags",
        pk: "id",
        columns: [
            "id",
            "customer_id",
            "no_show_count",
            "is_blacklisted",
            "blacklisted_at",
            "note",
            "created_at",
            "updated_at",
        ],
    }),

    otp_codes: createCrudModel({
        table: "otp_codes",
        pk: "id",
        columns: [
            "id",
            "user_type",
            "user_id",
            "destination",
            "code_hash",
            "expires_at",
            "used",
            "used_at",
            "try_count",
            "created_at",
        ],
    }),

    sms_messages: createCrudModel({
        table: "sms_messages",
        pk: "id",
        columns: [
            "id",
            "appointment_id",
            "to_phone",
            "type",
            "body",
            "provider",
            "status",
            "provider_msg_id",
            "error_message",
            "scheduled_at",
            "sent_at",
            "created_at",
            "updated_at",
            "source",
        ],
    }),

    // V2 Slot Engine Tables
    provider_break_rules: createCrudModel({
        table: "provider_break_rules",
        pk: "id",
        columns: ["id", "provider_id", "rule_json", "is_active", "created_at", "updated_at"],
    }),

    provider_static_slots: createCrudModel({
        table: "provider_static_slots",
        pk: "id",
        columns: ["id", "provider_id", "start_time", "end_time", "is_active", "created_at", "updated_at"],
    }),
};

module.exports = { pool, Models };
