// scheduler.js
// Harici cronjob manager tarafından 5 dakikada bir tetiklenir
// İşlevler:
//  1. İşletme açık mı kontrol et
//  2. Geçmiş randevuları ayarlara göre otomatik işaretle (no_show, completed, cancelled veya atla)
//  3. Yaklaşan randevulara hatırlatma SMS'i gönder

const { pool } = require("./models");
const { sendSms } = require("./notification.service");
const { sendNotification } = require("./messageManager");
const t = require("./temporal_api.utils");

let isRunning = false;

/**
 * Harici cronjob manager veya manuel tetikleme için ana job fonksiyonu
 */
async function runJobs() {
    if (isRunning) {
        console.log("[SCHEDULER] Önceki işlem henüz sürüyor, atlanıyor");
        return;
    }

    isRunning = true;
    const startTime = Date.now();

    try {
        console.log("[SCHEDULER] İşlemler başladı...");
        console.log(`[SCHEDULER] Sunucu saati: ${new Date().toISOString()}`);
        console.log(`[SCHEDULER] Temporal now: ${t.toISODateTime(t.now())}`);

        // 1. İşletme saatleri kontrolü
        const isOpen = await isBusinessOpen();
        if (!isOpen) {
            console.log("[SCHEDULER] İşletme kapalı, işlemler atlanıyor");
            isRunning = false;
            return;
        }

        // 2. Otomatik işaretleme (auto_no_show_status ayarına göre)
        await autoMarkAppointments();

        // 3. Hatırlatma SMS'leri
        await sendReminders();

        const elapsed = Date.now() - startTime;
        console.log(`[SCHEDULER] İşlemler tamamlandı (${elapsed}ms)`);

    } catch (err) {
        console.error("[SCHEDULER] Hata:", err.message);
    } finally {
        isRunning = false;
    }
}

/**
 * İşletmenin açık olup olmadığını kontrol et
 */
async function isBusinessOpen() {
    try {
        const [rows] = await pool.execute(
            `SELECT settings_json FROM app_settings LIMIT 1`
        );

        if (!rows.length) {
            // Ayarlar yoksa açık kabul et
            return true;
        }

        // settings_json string veya object olabilir, ikisini de handle et
        let settings = rows[0].settings_json;
        if (typeof settings === 'string') {
            try {
                settings = JSON.parse(settings || "{}");
            } catch {
                settings = {};
            }
        } else if (typeof settings !== 'object' || settings === null) {
            settings = {};
        }
        const now = t.now();
        const hour = now.hour;
        const day = now.dayOfWeek; // 1=Pazartesi, 7=Pazar

        // Kapalı gün kontrolü (closedDays veya closed_days)
        const closedDays = settings.closedDays || settings.closed_days || [];

        // Çalışma saati kontrolü (start_hour/open_time ve end_hour/close_time ile uyumlu)
        const openHourStr = settings.start_hour ?? settings.open_time ?? "09:00";
        const closeHourStr = settings.end_hour ?? settings.close_time ?? "22:00";
        const openHour = parseInt(openHourStr.split(':')[0]);
        const closeHour = parseInt(closeHourStr.split(':')[0]);

        console.log(`[SCHEDULER] isBusinessOpen — saat: ${hour}, gün: ${day} (1=Pzt, 7=Paz)`);
        console.log(`[SCHEDULER] isBusinessOpen — çalışma: ${openHourStr}-${closeHourStr}, kapalı günler: ${JSON.stringify(closedDays)}`);

        if (closedDays.includes(day)) {
            return false;
        }

        return hour >= openHour && hour < closeHour;

    } catch (err) {
        console.error("[SCHEDULER] isBusinessOpen hata:", err.message);
        return true; // Hata olursa açık kabul et
    }
}

/**
 * Geçmiş confirmed randevuları ayarlardaki auto_no_show_status'a göre otomatik işaretle
 * - end_at (randevu bitiş saati) + grace period geçmiş randevular
 * - targetStatus: 'no_show' | 'completed' | 'cancelled' | 'confirmed' | 'none'
 *   'none' seçili ise hiçbir şey yapma
 * - cancelled_by / cancel_reason sadece 'cancelled' ve 'no_show' durumlarında set edilir
 * Not: 16:30'da 45dklık randevu -> end_at = 17:15, 17:45'te (grace=30) otomatik işaretlenir
 */
async function autoMarkAppointments() {
    try {
        // Ayarlardan hedef statü ve grace period çek
        const [settingsRows] = await pool.execute(
            `SELECT settings_json FROM app_settings LIMIT 1`
        );

        let targetStatus = 'no_show';
        let graceMinutes = 30;

        if (settingsRows.length > 0) {
            let settings = settingsRows[0].settings_json;
            if (typeof settings === 'string') {
                try {
                    settings = JSON.parse(settings || "{}");
                } catch { settings = {}; }
            } else if (typeof settings !== 'object' || settings === null) {
                settings = {};
            }
            const rawStatus = settings.auto_no_show_status ?? 'no_show';
            const allowed = ['confirmed', 'completed', 'cancelled', 'no_show', 'none'];
            targetStatus = allowed.includes(rawStatus) ? rawStatus : 'no_show';
            graceMinutes = settings.auto_mark_grace_minutes ?? 30;
        }

        // 'none' sentinel: hiçbir şey yapma
        if (targetStatus === 'none') {
            console.log("[SCHEDULER] Otomatik işaretleme devre dışı (status=none)");
            return;
        }

        // 'confirmed' hedef olarak anlamsız (zaten WHERE confirmed) — yine de teknik olarak no-op olur
        console.log(`[SCHEDULER] Otomatik işaretleme: ${graceMinutes} dk grace, hedef: ${targetStatus}`);

        // cancelled_by ve cancel_reason sadece cancelled/no_show için set edilir
        const setSystemFields = (targetStatus === 'cancelled' || targetStatus === 'no_show');

        const [result] = await pool.execute(`
            UPDATE appointments
            SET status = ?,
                cancelled_by = ${setSystemFields ? "'system'" : 'cancelled_by'},
                cancel_reason = ${setSystemFields ? "'Otomatik işaretleme'" : 'cancel_reason'}
            WHERE status = 'confirmed'
              AND end_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
        `, [targetStatus, graceMinutes]);

        if (result.affectedRows > 0) {
            console.log(`[SCHEDULER] ${result.affectedRows} randevu '${targetStatus}' olarak işaretlendi`);
        }

    } catch (err) {
        console.error("[SCHEDULER] autoMarkAppointments hata:", err.message);
    }
}

/**
 * Yaklaşan randevulara hatırlatma SMS'i gönder
 * - 5-6 saat sonrasındaki randevular
 * - Daha önce hatırlatma gönderilmiş olanlar atlanır
 * - Ayarlarda sms_reminder açık olmalı
 */
async function sendReminders() {
    try {
        // Önce ayarlardan reminder_hours kontrol et
        const [settingsRows] = await pool.execute(
            `SELECT settings_json FROM app_settings LIMIT 1`
        );

        let reminderHours = 6;

        if (settingsRows.length > 0) {
            let settings = settingsRows[0].settings_json;
            if (typeof settings === 'string') {
                try {
                    settings = JSON.parse(settings || "{}");
                } catch { settings = {}; }
            } else if (typeof settings !== 'object' || settings === null) {
                settings = {};
            }
            reminderHours = settings.reminder_hours ?? settings.sms_reminder_before ?? 6;
        }

        // Hatırlatma süresine göre randevuları bul
        const windowStart = t.toISODateTime(t.now().add({ hours: reminderHours }));
        const windowEnd = t.toISODateTime(t.now().add({ hours: reminderHours + 1 }));
        console.log(`[SCHEDULER] Hatırlatma kontrolü: ${reminderHours} saat öncesi`);
        console.log(`[SCHEDULER] Hatırlatma penceresi: ${windowStart} — ${windowEnd}`);
        const [rows] = await pool.execute(`
            SELECT a.id, a.start_at, c.phone, c.display_name
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.status = 'confirmed'
              AND a.start_at BETWEEN DATE_ADD(NOW(), INTERVAL ? HOUR) AND DATE_ADD(NOW(), INTERVAL ?+1 HOUR)
        `, [reminderHours, reminderHours]);

        if (rows.length === 0) {
            console.log(`[SCHEDULER] Bu pencere içinde randevu BULUNMADI: ${windowStart} — ${windowEnd}`);
            return;
        }

        console.log(`[SCHEDULER] ${rows.length} randevu için hatırlatma kontrolü`);

        for (const appt of rows) {
            // Phone yoksa atla
            if (!appt.phone) {
                console.log(`[SCHEDULER] Randevu ${appt.id} için telefon yok, atlanıyor`);
                continue;
            }

            // Daha önce hatırlatma gönderilmiş mi? (SMS veya WhatsApp)
            const [existingReminder] = await pool.execute(`
                SELECT id FROM sms_messages
                WHERE appointment_id = ? AND type = 'reminder' AND status = 'sent'
                UNION
                SELECT id FROM whatsapp_messages
                WHERE appointment_id = ? AND type = 'reminder' AND status = 'sent'
            `, [appt.id, appt.id]);

            if (existingReminder.length > 0) {
                console.log(`[SCHEDULER] Randevu ${appt.id} için hatırlatma zaten gönderilmiş`);
                continue;
            }

            try {
                const result = await sendNotification({
                    template: 'appointment_reminder',
                    phone: appt.phone,
                    headerVars: ['Ercan İncirkuş Berber Dükkanı'],
                    bodyVars: ['Ercan İncirkuş Berber Dükkanı', t.formatDateTime(appt.start_at)],
                    appointment_id: appt.id,
                    type: 'appointment_reminder',
                    source: 'cron'
                });
                if (result.skipped) {
                    console.log(`[SCHEDULER] Randevu #${appt.id} hatırlatma ayarı kapalı, atlanıyor`);
                } else {
                    console.log(`[SCHEDULER] Hatırlatma gönderildi: Randevu #${appt.id}`);
                    console.log(`[SCHEDULER] sendNotification sonucu (randevu #${appt.id}):`, JSON.stringify(result));
                }
            } catch (err) {
                console.error(`[SCHEDULER] Hatırlatma hatası (randevu ${appt.id}):`, err.message);
            }
        }

    } catch (err) {
        console.error("[SCHEDULER] sendReminders hata:", err.message);
    }
}


module.exports = {
    runJobs,
    autoMarkAppointments,
    sendReminders,
    isBusinessOpen
};
