require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createWhatsAppProvider } = require('../whatsapp');

const TEST_PHONE = '905510608065';

const TEMPLATES = [
  {
    name: 'staff_appointment',
    lang: 'tr',
    header: [],
    body: ['MustafaC', '+905554441234', '19 Ağustos 2026 19:30']
  },
  {
    name: 'appointment_update',
    lang: 'en',
    header: ['Ercan İncirkuş'],
    body: ['MustafaC', '18 Ağustos 2026 19:30', '19 Ağustos 2026 18:00']
  },
  {
    name: 'appointment_cancel',
    lang: 'tr',
    header: ['Ercan İncirkuş'],
    body: ['MustafaC', '18 Ağustos 2026 19:30']
  },
  {
    name: 'appointment_reminder',
    lang: 'tr',
    header: ['Ercan İncirkuş'],
    body: ['MustafaC', '18 Ağustos 2026 19:30']
  },
  {
    name: 'appointment_created',
    lang: 'tr',
    header: [],
    body: ['Ercan İncirkuş', '18 Ağustos 2026 19:30', 'Saç Sakal Kesimi']
  },
  {
    name: 'login_t1',
    lang: 'en',
    header: ['123456'],
    body: ['2 Dakika', 'Ercan İncirkuş']
  }
];

async function send(wa, tpl) {
  const components = [];
  if (tpl.header.length) {
    components.push({ type: 'header', parameters: tpl.header.map(v => ({ type: 'text', text: v })) });
  }
  components.push({ type: 'body', parameters: tpl.body.map(v => ({ type: 'text', text: v })) });

  console.log(`\n→ ${tpl.name} (${tpl.lang})`);
  try {
    const res = await wa.sendTemplate(TEST_PHONE, tpl.name, components, tpl.lang);
    console.log(`  ✅ ${JSON.stringify(res).substring(0, 80)}`);
    return true;
  } catch (err) {
    console.log(`  ❌ ${err?.response?.data?.error?.message || err.message}`);
    return false;
  }
}

async function main() {
  const wa = createWhatsAppProvider();
  console.log('WhatsApp Template Test →', TEST_PHONE);

  const results = [];
  for (const tpl of TEMPLATES) {
    const ok = await send(wa, tpl);
    results.push({ name: tpl.name, ok });
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\n--- Summary ---');
  results.forEach(r => console.log(`${r.ok ? '✅' : '❌'} ${r.name}`));
}

main();
