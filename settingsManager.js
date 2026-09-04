// settingsManager.js
// Backend-side settings repository: defaults, DB read/write, init

const { pool } = require('./models');

const DEFAULT_SETTINGS = {
  end_hour: "22:00",
  start_hour: "09:00",
  sms_appointment_created: true,
  sms_staff_appointment: true,
  sms_appointment_update: true,
  sms_appointment_cancel: true,
  sms_appointment_reminder: true,
  no_show_limit: 3,
  cancel_deadline_hours: 2,
  multiple_appointment_count: 2,
  booking_coming_day_range: 2,
  closed_days: [],
  reminder_hours: 6,
  no_show_grace_minutes: 30,
  no_show_window_hours: 24,
  auto_no_show: true,
  otp_ttl_seconds: 60,
  printer_enabled: true,
  printer_auto_print_new: false,
  printer_daily_report: false,
  print_iban: false,
  communication_channel: 'sms'
};

/**
 * app_settings tablosundaki settings_json'u okur.
 * Eksik key'leri DEFAULT_SETTINGS ile tamamlar ve gerektiğinde DB'ye yazar.
 * Sunucu başlangıcında bir kez çağrılmalı.
 */
async function ensureSettingsDefaults() {
  const [rows] = await pool.execute(
    `SELECT settings_json FROM app_settings WHERE id = 1 LIMIT 1`
  );

  let current = {};
  if (rows.length > 0 && rows[0].settings_json) {
    const raw = rows[0].settings_json;
    current = typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  let changed = false;
  for (const [key, defaultVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in current)) {
      current[key] = defaultVal;
      changed = true;
    }
  }

  if (changed) {
    await pool.execute(
      `INSERT INTO app_settings (id, settings_json) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE settings_json = ?`,
      [JSON.stringify(current), JSON.stringify(current)]
    );
    console.log('[settingsManager] Default settings tamamlandı');
  }
}

/**
 * Tüm settings'i döner (DB'deki hali, defaults ile merge edilmiş)
 */
async function getSettings() {
  const [rows] = await pool.execute(
    `SELECT settings_json FROM app_settings WHERE id = 1 LIMIT 1`
  );
  if (!rows.length || !rows[0].settings_json) return { ...DEFAULT_SETTINGS };
  const current = typeof rows[0].settings_json === 'string'
    ? JSON.parse(rows[0].settings_json)
    : rows[0].settings_json;

  return { ...DEFAULT_SETTINGS, ...current };
}

/**
 * Tek bir key'nin değerini döner
 */
async function getSetting(key) {
  const all = await getSettings();
  return all[key];
}

/**
 * Bir key'yi günceller
 */
async function setSetting(key, value) {
  const all = await getSettings();
  all[key] = value;
  await pool.execute(
    `INSERT INTO app_settings (id, settings_json) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE settings_json = ?`,
    [JSON.stringify(all), JSON.stringify(all)]
  );
}

/**
 * Birden fazla key'yi günceller (partial update)
 */
async function updateSettings(partial) {
  const all = await getSettings();
  Object.assign(all, partial);
  await pool.execute(
    `INSERT INTO app_settings (id, settings_json) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE settings_json = ?`,
    [JSON.stringify(all), JSON.stringify(all)]
  );
}

module.exports = {
  DEFAULT_SETTINGS,
  ensureSettingsDefaults,
  getSettings,
  getSetting,
  setSetting,
  updateSettings
};
