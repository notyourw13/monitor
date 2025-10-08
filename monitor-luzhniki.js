// monitor-luzhniki.js
// Монитор новых слотов Лужники: Playwright + Telegram
// Версия с поддержкой прокси
// ---------------------------------------

import { chromium } from 'playwright';
import fs from 'fs';
import TelegramBot from 'node-telegram-bot-api';

const URL = 'https://tennis.luzhniki.ru/#courts';
const DATA_FILE = './known-slots.json';

// === НАСТРОЙКИ ПРОКСИ ===
// SOCKS5-прокси (например, бесплатный из списка)
const PROXY = 'socks5://212.119.236.86:1080';

// === Telegram ===
const BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const CHAT_ID = process.env.TG_CHAT_ID || '';
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// === Общие утилиты ===
const timeRe = /\b([01]\d|2[0-3]):[0-5]\d\b/; // время HH:MM

// Универсальная функция извлечения слотов из страницы/фрейма
async function extractSlots(frameOrPage) {
  await frameOrPage.waitForLoadState?.('networkidle').catch(() => {});
  await frameOrPage.waitForFunction(
    () => {
      const re = /\b([01]\d|2[0-3]):[0-5]\d\b/;
      return Array.from(document.querySelectorAll('button, a, div, span'))
        .some(el => re.test(el.textContent || ''));
    },
    { timeout: 60000 } // подольше — 60 сек
  );

  const keys = await frameOrPage.$$eval('button, a, div, span', (els) => {
    const timeRe = /\b([01]\d|2[0-3]):[0-5]\d\b/;
    const results = new Set();

    function findAbove(el, regexes, maxDepth = 6) {
      let p = el;
      for (let i = 0; i < maxDepth && p; i++) {
        const txt = (p.textContent || '').replace(/\s+/g, ' ').trim();
        for (const re of regexes) {
          const m = txt.match(re);
          if (m) return m[0];
        }
        p = p.parentElement;
      }
      return '';
    }

    for (const el of els) {
      const txt = el.textContent || '';
      const t = txt.match(timeRe)?.[0];
      if (!t) continue;

      // День
      const day = findAbove(el, [
        /(?:Пн|Вт|Ср|Чт|Пт|Сб|Вс)[^0-9\n]{0,6}\d{1,2}(?:[.\s]?(?:янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек|[01]?\d))?/i,
        /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/,
        /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i
      ]) || 'День?';

      // Корт
      const foundCourt = findAbove(el, [
        /корт[^\d]{0,3}(\d{1,2})/i,
        /court[^\d]{0,3}(\d{1,2})/i
      ]);
      const court = (foundCourt == null ? '' : foundCourt);

      const courtLabel = court
        ? (court.toLowerCase().startsWith('court') || court.toLowerCase().startsWith('корт')
          ? court.replace(/\s+/g, ' ').trim()
          : `Корт ${court}`)
        : 'Корт?';

      results.add([String(day).trim(), String(courtLabel).trim(), t].join(' | '));
    }
    return Array.from(results);
  });

  return keys.sort();
}

async function main() {
  // === Запуск браузера с прокси ===
  const browser = await chromium.launch({
    headless: true,
    args: [`--proxy-server=${PROXY}`]
  });

  const context = await browser.newContext({ locale: 'ru-RU' });
  const page = await context.newPage();

  console.log('Открываем страницу через прокси:', PROXY);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); // 60 сек

  // Если расписание внутри iframe, найдём фрейм
  let target = page;
  const frames = page.frames();
  if (frames.length > 1) {
    for (const f of frames) {
      if (f === page.mainFrame()) continue;
      try {
        await f.waitForFunction(
          () => {
            const re = /\b([01]\d|2[0-3]):[0-5]\d\b/;
            return Array.from(document.querySelectorAll('button, a, div, span'))
              .some(el => re.test(el.textContent || ''));
          },
          { timeout: 5000 }
        );
        target = f;
        break;
      } catch {}
    }
  }

  const slots = await extractSlots(target);
  const known = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : [];
  const knownSet = new Set(known);
  const fresh = slots.filter(k => !knownSet.has(k));

  if (fresh.length) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(slots, null, 2));
    const msg = `Новые слоты/дни на Лужниках:\n\n${fresh.join('\n')}\n\n${URL}`;
    if (bot && CHAT_ID) {
      await bot.sendMessage(CHAT_ID, msg);
      console.log('Отправлено в Telegram:', fresh.length, 'шт.');
    } else {
      console.log(msg);
      console.warn('ВНИМАНИЕ: TG_BOT_TOKEN/CHAT_ID не заданы, сообщение выведено в консоль.');
    }
  } else {
    console.log('Новых слотов не найдено');
  }

  await browser.close();
}

main().catch(err => {
  console.error('Ошибка:', err);
  process.exit(1);
});
