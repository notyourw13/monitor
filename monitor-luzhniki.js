// monitor-luzhniki.js
// Монитор слотов Лужники: Playwright + Telegram + ротация прокси

import { chromium } from 'playwright';
import fs from 'fs';
import TelegramBot from 'node-telegram-bot-api';

const URL = 'https://tennis.luzhniki.ru/#courts';
const DATA_FILE = './known-slots.json';

// === Прокси: список из env (по одному на строке / через запятую) ===
const PROXY_LIST = (process.env.PROXY_LIST || '')
  .split(/[\n,]+/)
  .map(s => s.trim())
  .filter(Boolean);

// Можно разрешить «пробовать без прокси» в самом конце (например, на VPS в РФ):
const ALLOW_DIRECT = (process.env.ALLOW_DIRECT || '0') === '1';

// === Telegram ===
const BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const CHAT_ID = process.env.TG_CHAT_ID || '';
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// === Утилиты ===
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function ua(i = 0) {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
  ];
  return uas[i % uas.length];
}

async function withBrowser(proxy, i, fn) {
  const launchOpts = { headless: true };
  if (proxy) {
    // поддерживаем и HTTP(S), и SOCKS5
    launchOpts.proxy = { server: proxy };
    launchOpts.args = [`--proxy-server=${proxy}`];
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    userAgent: ua(i),
  });
  try {
    const page = await context.newPage();
    const res = await fn(page);
    await browser.close();
    return res;
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

async function quickProbe(proxy, i) {
  // Быстрый «пинг» прокси: грузим лёгкую страницу с коротким таймаутом
  return await withBrowser(proxy, i, async (page) => {
    await page.goto('https://httpbin.org/ip', { timeout: 8000, waitUntil: 'domcontentloaded' });
    // Если нужно, можно считать JSON: const js = await page.textContent('pre');
    return true;
  });
}

async function extractSlots(frameOrPage) {
  // ждём, пока появится хотя бы одно время HH:MM
  await frameOrPage.waitForLoadState?.('networkidle').catch(() => {});
  await frameOrPage.waitForFunction(() => {
    const re = /\b([01]\d|2[0-3]):[0-5]\d\b/;
    return Array.from(document.querySelectorAll('button, a, div, span'))
      .some(el => re.test(el.textContent || ''));
  }, { timeout: 60_000 });

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

      const day = findAbove(el, [
        /(?:Пн|Вт|Ср|Чт|Пт|Сб|Вс)[^0-9\n]{0,6}\d{1,2}(?:[.\s]?(?:янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек|[01]?\d))?/i,
        /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/,
        /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i
      ]) || 'День?';

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

async function tryOneProxy(proxy, i) {
  console.log(`▶ Пробуем прокси [${i + 1}] ${proxy || '(без прокси)'}`);

  // 1) быстрый «пинг» прокси (чтобы не тратить 60–90с на мёртвые)
  try {
    if (proxy) await quickProbe(proxy, i);
    else if (!ALLOW_DIRECT) throw new Error('DIRECT запрещён (ALLOW_DIRECT=0)');
  } catch (e) {
    console.warn(`✗ Прокси отклонён на "пинге": ${proxy || 'DIRECT'} — ${e?.message || e}`);
    throw e;
  }

  // 2) основной заход на сайт
  return await withBrowser(proxy, i, async (page) => {
    console.log(`… Открываем цель: ${URL} через ${proxy || 'DIRECT'}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });

    // если расписание внутри iframe — найдём его
    let target = page;
    const frames = page.frames();
    if (frames.length > 1) {
      for (const f of frames) {
        if (f === page.mainFrame()) continue;
        try {
          await f.waitForFunction(() => {
            const re = /\b([01]\d|2[0-3]):[0-5]\d\b/;
            return Array.from(document.querySelectorAll('button, a, div, span'))
              .some(el => re.test(el.textContent || ''));
          }, { timeout: 5000 });
          target = f;
          break;
        } catch {}
      }
    }

    const slots = await extractSlots(target);
    return slots;
  });
}

async function main() {
  const order = shuffle(PROXY_LIST);
  if (ALLOW_DIRECT) order.push(null); // в самом конце — попробовать без прокси

  console.log(`Найдено прокси в списке: ${PROXY_LIST.length}. Порядок попыток: ${order.length}.`);

  let lastErr = null;
  // ограничим общее число попыток, чтобы job не висел бесконечно
  const MAX_ATTEMPTS = Math.min(order.length, 30) || (ALLOW_DIRECT ? 1 : 0);

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const proxy = order[i];
    try {
      const slots = await tryOneProxy(proxy, i);

      const known = fs.existsSync(DATA_FILE)
        ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
        : [];
      const knownSet = new Set(known);
      const fresh = slots.filter(k => !knownSet.has(k));

      if (fresh.length) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(slots, null, 2));
        const msg = `Новые слоты/дни на Лужниках:\n\n${fresh.join('\n')}\n\n${URL}`;
        if (bot && CHAT_ID) {
          await bot.sendMessage(CHAT_ID, msg);
          console.log('✓ Отправлено в Telegram:', fresh.length, 'шт.');
        } else {
          console.log(msg);
          console.warn('! TG_BOT_TOKEN/CHAT_ID не заданы — сообщение выведено в консоль.');
        }
      } else {
        console.log('Нет новых слотов.');
      }
      return; // успех — выходим
    } catch (e) {
      lastErr = e;
      console.warn(`⚠ Ошибка на прокси ${order[i] || 'DIRECT'}: ${e?.message || e}`);
      // маленькая пауза между попытками, чтобы не долбить подряд
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
  }

  throw lastErr || new Error('Не удалось открыть сайт ни через один прокси');
}

main().catch(err => {
  console.error('Фатальная ошибка:', err);
  process.exit(1);
});
