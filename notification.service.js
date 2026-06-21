// services/notification.service.js
const crypto = require("crypto");
const { pool } = require("./models");
const t = require("./temporal_api.utils");
const { getMailer, env } = require("./config");

// SMS Provider (MesajPaneli)
const {
    CredentialsUsernamePassword,
    MesajPaneliApi,
    TopluMesaj,
} = require("./MesajPaneliApi.js");

// --- OTP yardımcıları ---
function generateOtpCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function sha256(input) {
    return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function otpMessage(code) {
    return `Giriş kodun: ${code}. Bu kod 1 dakika geçerlidir.`;
}

/**
 * DB: otp_codes kaydı oluştur
 * user_type: 'staff_account' | 'customer'
 * otp_ttl_seconds: Ayarlardan çekilecek veya varsayılan 60 saniye
 */
async function createOtpRecord({
    user_type,
    user_id,
    destination,
    code,
    ttlSeconds = null,
}) {
    // Settings'den OTP TTL çek
    let otpTtl = 60;
    try {
        const [rows] = await pool.execute(
            `SELECT settings_json FROM app_settings LIMIT 1`
        );
        if (rows.length > 0) {
            const raw = rows[0].settings_json;
            console.log('[DEBUG createOtpRecord] raw settings_json:', raw, 'type:', typeof raw);
            const settings = typeof raw === 'string' ? JSON.parse(raw || "{}") : (raw || {});
            otpTtl = settings.otp_ttl_seconds ?? 60;
            console.log('[DEBUG createOtpRecord] otpTtl from settings:', otpTtl);
        }
    } catch (err) {
        console.error("[OTP] Settings okuma hatası, varsayılan kullanılıyor:", err.message);
    }

    const effectiveTtl = ttlSeconds ?? otpTtl;
    console.log('[DEBUG createOtpRecord] effectiveTtl:', effectiveTtl);
    const code_hash = sha256(code);

    // expires_at: Backend'de hesapla (MySQL NOW() kullanma - timezone sorunu olur)
    // db.sql'de expires_at VARCHAR(30) olarak tanımlı, DB'nin tarihe müdahalesi olmamalı
    const expiresAt = t.toISODateTime(t.now().add({ seconds: effectiveTtl }));

    // [DEBUG] expires_at boyutu ve değeri
    console.log('[DEBUG createOtpRecord] expiresAt:', expiresAt, 'length:', expiresAt.length);

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
    provider = "mesajpaneli",
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
 * SMS API instance (paket kullanım stiliyle)
 */
function createSmsApi() {
    const user = env("SMS_USER", "");
    const pass = env("SMS_PASS", "");
    const endpoint = env("SMS_ENDPOINT", "https://api.mesajpaneli.com/json_api/api");

    // Sertifika hatası alırsan env: SMS_VERIFY_SSL=false
    const verifySSL = String(env("SMS_VERIFY_SSL", "true")).toLowerCase() !== "false";

    const credentials = new CredentialsUsernamePassword(user, pass);

    return new MesajPaneliApi(credentials, {
        endpoint,
        verifySSL,
        timeout: 50_000,
    });
}

/**
 * SMS gönder (GERÇEK)
 * - MesajPaneliApi + TopluMesaj kullanım stili
 * - sms_messages loglar
 */
async function sendSms({ appointment_id = null, phone, message, type = "otp", source = "system" }) {
    const smsApi = createSmsApi();

    const baslik = env("SMS_BASLIK", "TBS AV.ORT.");

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
            type,
            provider: "mesajpaneli",
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
            type,
            provider: "mesajpaneli",
            status: "failed",
            provider_msg_id: null,
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

    const code = generateOtpCode();

    await createOtpRecord({
        user_type,
        user_id,
        destination,
        code,
        ttlSeconds: 60,
    });

    const message = otpMessage(code);

    await sendSms({ phone: destination, message, type: "otp" });

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
    const startTime = closureStart?.slice(11, 16) || '09:00';
    const endTime = closureEnd?.slice(11, 16) || '18:00';
    const message = `Sayın ${customerName}, randevu aldığınız personelimiz ${startTime} - ${endTime} saatleri arasında çalışmayacaktır. Daha sonrası için randevu alabilir, detaylı bilgi için işletmemizle iletişime geçebilirsiniz. İyi günler dileriz.`;
    await sendSms({
        appointment_id: appointment.id,
        phone: appointment.customer_phone,
        message: message,
        type: "cancellation"
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
};
