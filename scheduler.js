// scheduler.js
// Harici cronjob manager tarafından 5 dakikada bir tetiklenir
// İşlevler:
//  1. İşletme açık mı kontrol et
//  2. Geçmiş randevuları no_show olarak işaretle
//  3. Yaklaşan randevulara hatırlatma SMS'i gönder

const { pool } = require("./models");
const { sendSms } = require("./notification.service");
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

        // 1. İşletme saatleri kontrolü
        const isOpen = await isBusinessOpen();
        if (!isOpen) {
            console.log("[SCHEDULER] İşletme kapalı, işlemler atlanıyor");
            isRunning = false;
            return;
        }

        // 2. No-show kontrolü
        await markNoShows();

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
        if (closedDays.includes(day)) {
            return false;
        }

        // Çalışma saati kontrolü (start_hour/open_time ve end_hour/close_time ile uyumlu)
        const openHourStr = settings.start_hour ?? settings.open_time ?? "09:00";
        const closeHourStr = settings.end_hour ?? settings.close_time ?? "22:00";
        const openHour = parseInt(openHourStr.split(':')[0]);
        const closeHour = parseInt(closeHourStr.split(':')[0]);

        return hour >= openHour && hour < closeHour;

    } catch (err) {
        console.error("[SCHEDULER] isBusinessOpen hata:", err.message);
        return true; // Hata olursa açık kabul et
    }
}

/**
 * Geçmiş confirmed randevuları no_show olarak işaretle
 * - end_at (randevu bitiş saati) geçmiş ve grace period ek süre geçmiş randevular
 * - Sadece son window saat içindekiler (eskileri karıştırmamak için)
 * Not: 16:30'da 45dklık randevu -> end_at = 17:15, 17:45'te no_show olur
 */
async function markNoShows() {
    try {
        // Ayarlardan no-show sürelerini çek
        const [settingsRows] = await pool.execute(
            `SELECT settings_json FROM app_settings LIMIT 1`
        );

        let noShowGraceMinutes = 30;
        let noShowWindowHours = 24;

        if (settingsRows.length > 0) {
            let settings = settingsRows[0].settings_json;
            if (typeof settings === 'string') {
                try {
                    settings = JSON.parse(settings || "{}");
                } catch { settings = {}; }
            } else if (typeof settings !== 'object' || settings === null) {
                settings = {};
            }
            noShowGraceMinutes = settings.no_show_grace_minutes ?? 30;
            noShowWindowHours = settings.no_show_window_hours ?? 24;
        }

        console.log(`[SCHEDULER] No-show kontrolü: ${noShowGraceMinutes} dk grace, ${noShowWindowHours} saat pencere`);

        const [result] = await pool.execute(`
            UPDATE appointments
            SET status = 'no_show',
                cancelled_by = 'system',
                cancel_reason = 'Sistem tarafından gelmedi olarak işaretlendi'
            WHERE status = 'confirmed'
              AND end_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
              AND end_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
        `, [noShowGraceMinutes, noShowWindowHours]);

        if (result.affectedRows > 0) {
            console.log(`[SCHEDULER] ${result.affectedRows} randevu 'no_show' olarak işaretlendi`);
        }

    } catch (err) {
        console.error("[SCHEDULER] markNoShows hata:", err.message);
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
        // Önce ayarlardan sms_reminder ve reminder_hours kontrol et
        const [settingsRows] = await pool.execute(
            `SELECT settings_json FROM app_settings LIMIT 1`
        );

        let smsReminderEnabled = true;
        let reminderHours = 6; // Varsayılan: 6 saat önce

        if (settingsRows.length > 0) {
            let settings = settingsRows[0].settings_json;
            if (typeof settings === 'string') {
                try {
                    settings = JSON.parse(settings || "{}");
                } catch { settings = {}; }
            } else if (typeof settings !== 'object' || settings === null) {
                settings = {};
            }
            smsReminderEnabled = settings.sms_reminder !== false;
            reminderHours = settings.reminder_hours ?? settings.sms_reminder_before ?? 6;
        }

        if (!smsReminderEnabled) {
            console.log("[SCHEDULER] SMS hatırlatma kapalı, işlem atlanıyor");
            return;
        }

        // Hatırlatma süresine göre randevuları bul
        console.log(`[SCHEDULER] Hatırlatma kontrolü: ${reminderHours} saat öncesi`);
        const [rows] = await pool.execute(`
            SELECT a.id, a.start_at, c.phone, c.display_name
            FROM appointments a
            JOIN customers c ON a.customer_id = c.id
            WHERE a.status = 'confirmed'
              AND a.start_at BETWEEN DATE_ADD(NOW(), INTERVAL ? HOUR) AND DATE_ADD(NOW(), INTERVAL ?+1 HOUR)
        `, [reminderHours, reminderHours]);

        if (rows.length === 0) {
            console.log("[SCHEDULER] Hatırlatılacak randevu yok");
            return;
        }

        console.log(`[SCHEDULER] ${rows.length} randevu için hatırlatma kontrolü`);

        for (const appt of rows) {
            // Phone yoksa atla
            if (!appt.phone) {
                console.log(`[SCHEDULER] Randevu ${appt.id} için telefon yok, atlanıyor`);
                continue;
            }

            // Daha önce hatırlatma gönderilmiş mi?
            const [sent] = await pool.execute(`
                SELECT id FROM sms_messages
                WHERE appointment_id = ? AND type = 'reminder' AND status = 'sent'
            `, [appt.id]);

            if (sent.length > 0) {
                console.log(`[SCHEDULER] Randevu ${appt.id} için hatırlatma zaten gönderilmiş`);
                continue;
            }

            // SMS mesajı oluştur
            const timeStr = t.formatDateTime(appt.start_at);
            const message = `Merhaba ${appt.display_name}, ${timeStr} randevunuzu hatırlatmak isteriz. - Ercan İncirkuş Berber Dükkanı`;

            try {
                await sendSms({
                    appointment_id: appt.id,
                    phone: appt.phone,
                    message: message,
                    type: "reminder",
                    source: "cron"
                });
                console.log(`[SCHEDULER] Hatırlatma SMS gönderildi: Randevu #${appt.id}`);
            } catch (smsErr) {
                console.error(`[SCHEDULER] SMS hatası (randevu ${appt.id}):`, smsErr.message);
            }
        }

    } catch (err) {
        console.error("[SCHEDULER] sendReminders hata:", err.message);
    }
}


module.exports = {
    runJobs
};
