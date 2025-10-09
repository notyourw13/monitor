// monitor-luzhniki.js
// Мониторинг сайта tennis.luzhniki.ru — уведомления о слотах
// При DUMP_ALL=1 бот присылает полный список слотов для проверки

import fs from 'fs';
import { chromium } from 'playwright';
import fetch from 'node-fetch';

// -------------------------
// Константы окружения
// -------------------------
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PROXY_LIST = (process.env.PROXY_LIST || '').split(/\r?\n/).filter(Boolean);
const DUMP_ALL = process.env.DUMP_ALL === '1'; // режим проверки — шлёт все слоты

// -------------------------
// Утилиты
// -------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: TG_CHAT_ID, text };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Telegram error ${res.status}`);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// -------------------------
// Форматирование сообщений
// -------------------------
const DAY_SHORT = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

function formatFullReport(slotsByDay) {
  const lines = ['ПОЛНЫЙ ОТЧЁТ ЛУЖНИКИ!'];
  const items = Array.from(
    (slotsByDay instanceof Map ? slotsByDay.values() : Object.values(slotsByDay))
  ).sort((a,b) => a.date - b.date);

  for (const d of items) {
    const dt = d.date instanceof Date ? d.date : new Date(d.date);
    const day = DAY_SHORT[dt.getDay()];
    const dd  = String(dt.getDate()).padStart(2,'0');
    const mm  = String(dt.getMonth()+1).padStart(2,'0');
    const label = `${day} ${dd}.${mm}`;
    const times = (d.times && d.times.length) ? d.times.join(', ') : '—';
    lines.push(`${label}: ${times} (${d.times.length} слотов)`);
  }
  lines.push('', 'https://tennis.luzhniki.ru/#courts');
  return lines.join('\n');
}

function formatNewSlots(newSlots) {
  const lines = ['НОВЫЕ СЛОТЫ ЛУЖНИКИ!'];
  for (const d of newSlots) {
    const dt = new Date(d.date);
    const day = DAY_SHORT[dt.getDay()];
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const label = `${day} ${dd}.${mm}`;
    const times = d.times.join(', ');
    lines.push(`${label}: ${times}`);
  }
  lines.push('', 'https://tennis.luzhniki.ru/#courts');
  return lines.join('\n');
}

// -------------------------
// Работа с браузером
// -------------------------
async function withBrowser(proxy, fn) {
  const browser = await chromium.launch({
    headless: true,
    proxy: proxy ? { server: `http://${proxy}` } : undefined,
  });
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function scrapeLuzhniki(page) {
  log('Открываем https://tennis.luzhniki.ru/#courts');
  await page.goto('https://tennis.luzhniki.ru/#courts', {
    timeout: 60000,
    waitUntil: 'domcontentloaded'
  });

  await page.waitForSelector('.react-calendar', { timeout: 10000 }).catch(() => {});
  await sleep(2000);

  const data = await page.evaluate(() => {
    const result = [];
    const days = document.querySelectorAll('.react-calendar__tile');
    days.forEach(day => {
      const dateAttr = day.getAttribute('aria-label');
      if (!dateAttr) return;
      const date = new Date(dateAttr);
      const times = Array.from(day.querySelectorAll('.time-slot')).map(e => e.textContent.trim());
      if (times.length) result.push({ date, times });
    });
    return result;
  });

  log(`Найдено ${data.length} дней с доступными слотами.`);
  return data;
}

// -------------------------
// Главная функция
// -------------------------
async function main() {
  let proxyToUse = null;
  if (PROXY_LIST.length) {
    proxyToUse = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
    log(`Используем прокси: ${proxyToUse}`);
  }

  const slots = await withBrowser(proxyToUse, scrapeLuzhniki);

  const saveFile = 'slots.json';
  let oldSlots = [];
  if (fs.existsSync(saveFile)) {
    oldSlots = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  }

  const groupByDay = {};
  for (const s of slots) {
    const key = new Date(s.date).toDateString();
    if (!groupByDay[key]) groupByDay[key] = { date: s.date, times: [] };
    groupByDay[key].times.push(...s.times);
  }

  // 🔍 Режим проверки — шлём полный отчёт
  if (DUMP_ALL) {
    await sendTelegram(formatFullReport(groupByDay));
    return;
  }

  const oldKeys = new Set(oldSlots.map(s => `${s.date}-${s.times.join(',')}`));
  const newOnes = slots.filter(s => !oldKeys.has(`${s.date}-${s.times.join(',')}`));

  if (newOnes.length) {
    log(`Найдено новых слотов: ${newOnes.length}`);
    await sendTelegram(formatNewSlots(newOnes));
    fs.writeFileSync(saveFile, JSON.stringify(slots, null, 2));
  } else {
    log('Новых слотов нет.');
  }
}

// -------------------------
main().catch(e => {
  console.error('Фатальная ошибка:', e);
  process.exit(1);
});
