// services/notification.service.js
const crypto = require("crypto");
const { pool } = require("./models");
const t = require("./temporal_api.utils");
const { getMailer, env } = require("./config");

// SMS Provider (NetGSM)
const { createSmsProvider, TopluMesaj } = require("./sms.provider.js");

// WhatsApp Provider (WhatsApp Cloud API)
const { createWhatsAppProvider } = require("./whatsapp.js");

// Message manager - lazy require to avoid circular dependency
// const { sendNotification } = require("./messageManager");

// Caller'ın logical type adı -> DB ENUM değeri.
// Listede olmayan type'lar 'other' fallback olur (mevcut davranış).
const TYPE_ALIAS = {
    appointment_reminder: 'reminder',
    reminder: 'reminder',
    otp: 'otp',
    other: 'other',
};

// 'cancellation' sadece whatsapp_messages için geçerli;
// sms_messages'a düşerse 'other' fallback olur (ENUM hatası olmaz).
function normalizeType(logicalType, channel /* 'sms' | 'wa' */) {
    const mapped = TYPE_ALIAS[logicalType] ?? 'other';
    if (channel === 'sms' && mapped === 'cancellation') return 'other';
    return mapped;
}

// --- OTP yardımcıları ---
function generateOtpCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function sha256(input) {
    return crypto.createHash("sha256").update(String(input)).digest("hex");
}

/**
 * DB: otp_codes kaydı oluştur
 * user_type: 'staff_account' | 'customer'
 * ttlSeconds: Çağıran tarafından hesaplanır (settingsManager.getSetting('otp_ttl_seconds'))
 *             Verilmezse 60 saniyeye fallback
 */
async function createOtpRecord({
    user_type,
    user_id,
    destination,
    code,
    ttlSeconds = null,
}) {
    const effectiveTtl = ttlSeconds ?? 60;
    const code_hash = sha256(code);

    // expires_at: Backend'de hesapla (MySQL NOW() kullanma - timezone sorunu olur)
    // db.sql'de expires_at VARCHAR(30) olarak tanımlı, DB'nin tarihe müdahalesi olmamalı
    const expiresAt = t.toISODateTime(t.now().add({ seconds: effectiveTtl }));

    await pool.execute(
        `INSERT INTO otp_codes (user_type, user_id, destination, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
        [user_type, user_id, destination, code_hash, expiresAt]
    );

    return { code_hash };
}

/**
 * DB: sms_messages logla (OTP)
 * - scheduled_at zorunlu
 * - type enum: 'otp'
 */
async function logSmsToDb({
    appointment_id = null,
    to_phone,
    body,
    type = "otp",
    provider = "netgsm",
    status = "sent",
    provider_msg_id = null,
    error_message = null,
    source = "system",
}) {
    // Backend'de hesapla (MySQL NOW() kullanma - timezone sorunu olur)
    const now = t.toISODateTime(t.now());
    const sentAt = status === 'sent' ? now : null;

    await pool.execute(
        `INSERT INTO sms_messages
      (appointment_id, to_phone, type, body, provider, status, provider_msg_id, error_message, scheduled_at, sent_at, source)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [appointment_id, to_phone, type, body, provider, status, provider_msg_id, error_message, now, sentAt, source]
    );
}

/**
 * DB: whatsapp_messages logla
 */
async function logWhatsAppToDb({
    appointment_id = null,
    customer_id = null,
    to_phone,
    body,
    type = "other",
    status = "sent",
    wa_message_id = null,
    template_name = null,
    error_message = null,
    source = "system",
}) {
    // Normalize type to valid whatsapp_messages ENUM
    const normalizedType = normalizeType(type, 'wa');

    const now = t.toISODateTime(t.now());
    const sentAt = status === 'sent' ? now : null;

    await pool.execute(
        `INSERT INTO whatsapp_messages
      (appointment_id, customer_id, to_phone, type, body, status, wa_message_id, template_name, error_message, scheduled_at, sent_at, source)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [appointment_id, customer_id, to_phone, normalizedType, body, status, wa_message_id, template_name, error_message, now, sentAt, source]
    );
}

/**
 * MAIL gönder
 */
async function sendMail({ to, subject, text }) {
    console.log("[GÖNDERİLEN MAIL]", { to, subject, text });
    const transporter = await getMailer();
    await transporter.sendMail({
        from: `"Berberler" <${env("GMAIL_USER")}>`,
        to,
        subject,
        text,
    });
}

/**
 * SMS API instance (NetGSM)
 */
function createSmsApi() {
    return createSmsProvider();
}

/**
 * SMS gönder (GERÇEK)
 * - NetGSM üzerinden gönderir
 * - sms_messages loglar
 */
async function sendSms({ appointment_id = null, phone, message, type = "otp", source = "system" }) {
    // Normalize type to valid sms_messages ENUM
    const normalizedType = normalizeType(type, 'sms');

    const smsApi = createSmsApi();
    const providerName = smsApi.getProviderName();

    const baslik = env("NETGSM_HEADER", "");

    // "05xxxxxxxxx" veya "5xxxxxxxxx" formatı sende nasıl ise onu gönder.
    // Senin örnek: 5467473915 (başında 0 yok) -> aynen geçiyoruz.
    const mesaj = new TopluMesaj(message, phone);

    try {
        const resp = await smsApi.topluMesajGonder(baslik, mesaj);

        // provider id alanı API'de farklı isimde olabilir. Yine de loglayalım:
        const providerMsgId =
            resp?.msg_id ?? resp?.message_id ?? resp?.id ?? resp?.data?.id ?? null;

        await logSmsToDb({
            appointment_id,
            to_phone: phone,
            body: message,
            type: normalizedType,
            provider: providerName,
            status: "sent",
            provider_msg_id: providerMsgId,
            error_message: null,
            source,
        });

        return resp;
    } catch (e) {
        const errText = e?.message || String(e);

        await logSmsToDb({
            appointment_id,
            to_phone: phone,
            body: message,
            type: normalizedType,
            provider: providerName,
            status: "failed",
            provider_msg_id: null,
            error_message: errText,
            source,
        });

        throw new Error(errText);
    }
}

/**
 * WhatsApp mesaj gönder
 * - WhatsApp Cloud API üzerinden gönderir
 * - whatsapp_messages loglar
 */
async function sendWhatsApp({ appointment_id = null, customer_id = null, phone, message, type = "other", source = "system" }) {
    const waApi = createWhatsAppProvider();
    const providerName = waApi.getProviderName();

    try {
        const resp = await waApi.sendMessage(phone, message);

        const waMsgId = resp?.wa_message_id ?? resp?.message_id ?? null;

        await logWhatsAppToDb({
            appointment_id,
            customer_id,
            to_phone: phone,
            body: message,
            type,
            provider: providerName,
            status: "sent",
            wa_message_id: waMsgId,
            error_message: null,
            source,
        });

        return resp;
    } catch (e) {
        const errText = e?.message || String(e);

        await logWhatsAppToDb({
            appointment_id,
            customer_id,
            to_phone: phone,
            body: message,
            type,
            provider: providerName,
            status: "failed",
            wa_message_id: null,
            error_message: errText,
            source,
        });

        throw new Error(errText);
    }
}

/**
 * Tek fonksiyon: OTP üret + DB kaydet + SMS olarak gönder
 *
 * Tüm user_type'lar için SMS kanalı
 *
 * DÖNÜŞ: { ok, codeSent }
 */
async function sendOtp({ user_type, user_id, destinationOverride = null }) {
    if (user_type !== "staff_account" && user_type !== "customer") {
        throw new Error("user_type sadece 'staff_account' veya 'customer' olabilir.");
    }

    const destination = destinationOverride;
    if (!destination) throw new Error("destinationOverride zorunlu (phone).");

    // TTL'i tek seferde hesapla — hem DB expires_at hem SMS etiketi için aynı değeri kullanır
    const { getSetting } = require('./settingsManager');
    const ttlSeconds = (await getSetting('otp_ttl_seconds')) ?? 60;

    const code = generateOtpCode();

    await createOtpRecord({
        user_type,
        user_id,
        destination,
        code,
        ttlSeconds,
    });

    const ttlLabel = ttlSeconds >= 60 ? `${Math.round(ttlSeconds / 60)} Dakika` : `${ttlSeconds} Saniye`;

    const { sendNotification } = require('./messageManager');
    await sendNotification({
        template: 'login_t1',
        phone: destination,
        headerVars: [code],
        bodyVars: [ttlLabel, 'Ercan İncirkuş Berber Dükkanı'],
        type: 'login_t1'
    });

    return { ok: true, codeSent: code };
}

/**
 * OTP doğrula
 */
async function verifyOtp({ user_type, user_id, code, maxTries = 5 }) {
    const code_hash = sha256(code);

    const [rows] = await pool.execute(
        `SELECT id, code_hash, expires_at, used, try_count
     FROM otp_codes
     WHERE user_type = ? AND user_id = ?
     ORDER BY id DESC
     LIMIT 1`,
        [user_type, user_id]
    );

    const rec = rows[0];
    if (!rec) return { ok: false, reason: "no_code" };
    if (rec.used) return { ok: false, reason: "used" };

    if (t.isExpired(rec.expires_at)) return { ok: false, reason: "expired" };

    if (rec.try_count >= maxTries) return { ok: false, reason: "too_many_tries" };

    await pool.execute(`UPDATE otp_codes SET try_count = try_count + 1 WHERE id = ?`, [rec.id]);

    if (rec.code_hash !== code_hash) return { ok: false, reason: "invalid" };

    // used_at: Backend'de hesapla (MySQL NOW() kullanma - timezone sorunu olur)
    const usedAt = t.toISODateTime(t.now());
    await pool.execute(`UPDATE otp_codes SET used = 1, used_at = ? WHERE id = ?`, [usedAt, rec.id]);

    return { ok: true };
}

/**
 * Randevu iptal SMS'i gönder
 * @param {Object} appointment - { id, customer_phone, customer_name, start_at }
 * @param {string} closureStart - "YYYY-MM-DD HH:MM:SS" formatında closure başlangıcı
 * @param {string} closureEnd - "YYYY-MM-DD HH:MM:SS" formatında closure bitişi
 */
async function sendCancellationSms(appointment, closureStart, closureEnd) {
    const customerName = appointment.customer_name || 'musterimiz';
    const appointmentDate = appointment.start_at ? appointment.start_at.slice(0, 10) : '';
    const { sendNotification } = require('./messageManager');
    await sendNotification({
        template: 'appointment_cancel',
        phone: appointment.customer_phone,
        headerVars: ['Ercan İncirkuş Berber Dükkanı'],
        bodyVars: ['Ercan İncirkuş Berber Dükkanı', appointmentDate],
        appointment_id: appointment.id,
        type: 'appointment_cancel'
    });
}

module.exports = {
    // OTP
    sendOtp,
    verifyOtp,

    // dışarı aç
    createOtpRecord,
    generateOtpCode,
    sha256,

    // sms/email
    sendSms,
    sendMail,
    sendCancellationSms,

    // WhatsApp
    sendWhatsApp,
    logWhatsAppToDb,
};
