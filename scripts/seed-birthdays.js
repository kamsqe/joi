// Seed birthday reminders into KV
// Run: node scripts/seed-birthdays.js > /tmp/bday-reminders.json
// Then: npx wrangler kv bulk put --namespace-id=0997f17add2045579ebdae1389b6145c /tmp/bday-reminders.json

const CHAT_ID = -1003199433987;
const KAMA_USER_ID = 1038120471;
const NOW = Date.now();

// 14:00 Almaty = 09:00 UTC
function toUTC(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 9, 0, 0, 0)).getTime();
}

const birthdays = [
  { name: "Ботик",    month: 2,  day: 14, vip: false },
  { name: "Макс",     month: 2,  day: 22, vip: true },
  { name: "Ажибек",   month: 4,  day: 28, vip: false },
  { name: "Алимбек",  month: 5,  day: 19, vip: false },
  { name: "Асеке",    month: 5,  day: 25, vip: true },
  { name: "Кама",     month: 9,  day: 6,  vip: true },
  { name: "Ера",      month: 9,  day: 27, vip: false },
  { name: "Чика",     month: 10, day: 21, vip: false },
  { name: "Руся",     month: 12, day: 10, vip: true },
  { name: "Данко",    month: 12, day: 13, vip: false },
  { name: "Босс",     month: 12, day: 27, vip: true },
];

const MS_DAY = 24 * 60 * 60 * 1000;
const kvEntries = [];
const allIds = [];

for (const b of birthdays) {
  const bdayBase = toUTC(2026, b.month, b.day);

  const points = [
    { suffix: "week",  offset: -7 * MS_DAY, desc: `ДР ${b.name} через неделю! Напомни пацанам подготовиться` },
    { suffix: "day",   offset: -1 * MS_DAY, desc: `ДР ${b.name} завтра! Напомни пацанам не забыть поздравить` },
    {
      suffix: "bday",
      offset: 0,
      desc: b.vip
        ? `🎂 Сегодня ДР у ${b.name}! Поздравь его красиво и тепло в чате, это важно!`
        : `🎂 Сегодня ДР у ${b.name}! Напомни пацанам поздравить его!`
    },
  ];

  for (const p of points) {
    let ts = bdayBase + p.offset;
    // If this reminder time already passed in 2026, bump to 2027
    if (ts < NOW) {
      const bdayNext = toUTC(2027, b.month, b.day);
      ts = bdayNext + p.offset;
    }

    const id = `rem_${CHAT_ID}_bday_${b.name.toLowerCase()}_${p.suffix}`;
    allIds.push(id);

    const reminder = {
      id,
      chatId: CHAT_ID,
      userId: KAMA_USER_ID,
      description: p.desc,
      remindAt: ts,
      recurrence: "yearly",
      createdAt: NOW,
    };

    kvEntries.push({
      key: `rem:${id}`,
      value: JSON.stringify(reminder),
      expiration_ttl: 60 * 60 * 24 * 400, // ~13 months
    });
  }
}

// Reminder index for the chat
kvEntries.push({
  key: `rem_idx:${CHAT_ID}`,
  value: JSON.stringify(allIds),
  expiration_ttl: 60 * 60 * 24 * 400,
});

console.log(JSON.stringify(kvEntries, null, 2));

// Summary
console.error(`\nCreated ${allIds.length} reminders for ${birthdays.length} birthdays`);
console.error("VIP auto-congrats:", birthdays.filter(b => b.vip).map(b => b.name).join(", "));
