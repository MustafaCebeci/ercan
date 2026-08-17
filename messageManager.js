// messageManager.js
// SMS ve WhatsApp kanallarını birleştiren soyut katman
// communication_channel ayarına göre SMS veya WhatsApp üzerinden mesaj gönderir
// SMS kanalında ilgili setting açık değilse gönderilmez (OTP hariç)

const { pool } = require('./models');
const { logWhatsAppToDb } = require('./notification.service');
const { createWhatsAppProvider } = require('./whatsapp');

// Template tanımları
const TEMPLATES = {
  staff_appointment: {
    name: 'staff_appointment',
    lang: 'tr',
    hasHeader: false,
    bodyVarCount: 3,
  },
  appointment_update: {
    name: 'appointment_update',
    lang: 'en',
    hasHeader: true,
    headerVarCount: 1,
    bodyVarCount: 3,
  },
  appointment_cancel: {
    name: 'appointment_cancel',
    lang: 'tr',
    hasHeader: true,
    headerVarCount: 1,
    bodyVarCount: 2,
  },
  appointment_reminder: {
    name: 'appointment_reminder',
    lang: 'tr',
    hasHeader: true,
    headerVarCount: 1,
    bodyVarCount: 2,
  },
  appointment_created: {
    name: 'appointment_created',
    lang: 'tr',
    hasHeader: false,
    bodyVarCount: 3,
  },
  login_t1: {
    name: 'login_t1',
    lang: 'en',
    hasHeader: true,
    headerVarCount: 1,
    bodyVarCount: 2,
  },
};

// Template → SMS setting key eşleşmesi (null = her zaman gider)
const TEMPLATE_SMS_SETTING = {
  staff_appointment:     'sms_staff_appointment',
  appointment_update:    'sms_appointment_update',
  appointment_cancel:    'sms_appointment_cancel',
  appointment_reminder:  'sms_appointment_reminder',
  appointment_created:   'sms_appointment_created',
  login_t1:             null, // OTP — her zaman gider
};

// ──────────────────────────────────────────

async function getSettings() {
  try {
    const [rows] = await pool.execute(
      `SELECT settings_json FROM app_settings LIMIT 1`
    );
    if (!rows.length || !rows[0].settings_json) return {};
    const raw = rows[0].settings_json;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

async function getCommunicationChannel() {
  const settings = await getSettings();
  return settings?.communication_channel || 'sms';
}

function buildWaComponents(template, headerVars, bodyVars) {
  const tpl = TEMPLATES[template];
  const components = [];

  if (tpl.hasHeader && headerVars?.length) {
    components.push({
      type: 'header',
      parameters: headerVars.map(v => ({ type: 'text', text: v })),
    });
  }

  if (bodyVars?.length) {
    components.push({
      type: 'body',
      parameters: bodyVars.map(v => ({ type: 'text', text: v })),
    });
  }

  return components;
}

function buildSmsBody(template, bodyVars, headerVars = []) {
  const BODIES = {
    staff_appointment: (v) =>
      `Yeni randevu;\nMüşteri: ${v[0]} - ${v[1]}\nTarih: ${v[2]}\nİyi çalışmalar.`,
    appointment_update: (v) =>
      `Merhaba ${v[0]}, ${v[1]} tarihli randevunuz ${v[2]} olarak güncellenmiştir. İyi günler dileriz.`,
    appointment_cancel: (v) =>
      `Merhaba ${v[0]}, ${v[1]} tarihli randevunuz iptal edilmiştir. İyi günler dileriz.`,
    appointment_reminder: (v) =>
      `Merhaba ${v[0]}, ${v[1]} tarihli randevunuzu hatırlatırız. İyi günler dileriz.`,
    appointment_created: (v) =>
      `Merhaba, ${v[0]} için ${v[1]} tarihli ${v[2]} randevunuz oluşturulmuştur. İyi günler dileriz.`,
    // login_t1: v[0]=OTP kodu (headerVars'dan gelir), v[1]=ttlLabel, v[2]=businessName
    login_t1: (v) =>
      `Kodunuz: ${v[0]}. ${v[1]}'dır. ${v[2]} - İyi günler dileriz.`,
  };
  return BODIES[template]?.(bodyVars) || bodyVars.join(' ');
}

/**
 * Birleşik bildirim gönderme
 *
 * @param {Object} opts
 * @param {string} opts.template     — template key
 * @param {string} opts.phone        — alıcı telefon
 * @param {string[]} opts.headerVars — header değişkenleri (varsa)
 * @param {string[]} opts.bodyVars   — body değişkenleri
 * @param {number|null} opts.appointment_id
 * @param {number|null} opts.customer_id
 * @param {string} opts.type         — bildirim tipi
 * @param {string} [opts.source='system']
 */
async function sendNotification({
  template,
  phone,
  headerVars = [],
  bodyVars = [],
  appointment_id = null,
  customer_id = null,
  type,
  source = 'system',
}) {
  const tpl = TEMPLATES[template];
  if (!tpl) throw new Error(`Bilinmeyen template: ${template}`);
  if (!phone) throw new Error('Telefon numarası zorunludur');

  const channel = await getCommunicationChannel();

  if (channel === 'wa') {
    // WhatsApp — her zaman gider
    const waApi = createWhatsAppProvider();
    const components = buildWaComponents(template, headerVars, bodyVars);

    try {
      const resp = await waApi.sendTemplate(phone, tpl.name, components, tpl.lang);
      const waMsgId = resp?.wa_message_id ?? resp?.message_id ?? null;

      await logWhatsAppToDb({
        appointment_id,
        customer_id,
        to_phone: phone,
        body: JSON.stringify({ template: tpl.name, components }),
        type,
        provider: 'whatsapp_cloud',
        status: 'sent',
        wa_message_id: waMsgId,
        error_message: null,
        source,
      });

      return { channel: 'wa', ok: true, message_id: waMsgId };
    } catch (e) {
      const errText = e?.message || String(e);
      await logWhatsAppToDb({
        appointment_id,
        customer_id,
        to_phone: phone,
        body: JSON.stringify({ template: tpl.name, components }),
        type,
        provider: 'whatsapp_cloud',
        status: 'failed',
        wa_message_id: null,
        error_message: errText,
        source,
      });
      throw new Error(errText);
    }
  } else {
    // SMS kanalı — setting kontrolü
    const settingKey = TEMPLATE_SMS_SETTING[template];

    if (settingKey !== null) {
      const settings = await getSettings();
      if (settings[settingKey] !== true) {
        console.log(`[messageManager] ${settingKey} kapalı, gönderilmedi (${template})`);
        return { channel: 'sms', ok: false, skipped: true };
      }
    }

    // headerVars varsa (login_t1 gibi) SMS body'ye header'ı ekle
    const smsBodyVars = headerVars.length > 0
      ? [...headerVars, ...bodyVars]  // OTP kodu + diğer değişkenler
      : bodyVars;

    const message = buildSmsBody(template, smsBodyVars);
    try {
      // Lazy require to avoid circular dependency
      const { sendSms } = require('./notification.service');
      await sendSms({ appointment_id, phone, message, type, source });
      return { channel: 'sms', ok: true };
    } catch (e) {
      throw new Error(e?.message || String(e));
    }
  }
}

module.exports = {
  sendNotification,
  getCommunicationChannel,
  TEMPLATES,
};
