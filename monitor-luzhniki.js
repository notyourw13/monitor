// monitor-luzhniki.js
// Лужники: монитор НОВЫХ времен (и новых дней) + ротация прокси + Telegram

import { chromium } from 'playwright';
import fs from 'fs';
import TelegramBot from 'node-telegram-bot-api';

const URL = 'https://tennis.luzhniki.ru/#courts';
const DATA_FILE = './known-slots.json';

// === Прокси (по одному на строке / через запятую) ===
const PROXY_LIST = (process.env.PROXY_LIST || '')
  .split(/[\n,]+/)
  .map(s => s.trim())
  .filter(Boolean);

// Разрешить попробовать без прокси (если раннер/сервер в нужном регионе)
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

    // Блокируем тяжёлые ресурсы (ускорение)
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) return route.abort();
      route.continue();
    });

    const res = await fn(page);
    await browser.close();
    return res;
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

// Быстрый «пинг» прокси: сначала HTTP, затем HTTPS
async function quickProbe(proxy, i) {
  return await withBrowser(proxy, i, async (page) => {
    // 1) HTTP — 3с
    await page.goto('http://httpbin.org/ip', { timeout: 3000, waitUntil: 'domcontentloaded' });
    // 2) HTTPS — 6с (важно, т.к. цель HTTPS)
    await page.goto('https://example.com', { timeout: 6000, waitUntil: 'domcontentloaded' });
    return true;
  });
}

// Извлекаем ТОЛЬКО "день | HH:MM" из ВИДИМЫХ элементов
async function extractDayTimeKeys(frameOrPage) {
  await frameOrPage.waitForLoadState?.('networkidle').catch(() => {});
  await frameOrPage.waitForFunction(() => {
    const re = /\b([01]\d|2[0-3]):[0-5]\d\b/;
    const isVisible = (n) => {
      if (!n) return false;
      const s = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' &&
             parseFloat(s.opacity || '1') > 0.01 &&
             r.width > 0 && r.height > 0 &&
             document.contains(n) && n.offsetParent !== null;
    };
    return Array.from(document.querySelectorAll('button, a, div, span'))
      .some(el => re.test(el.textContent || '') && isVisible(el));
  }, { timeout: 60000 });

  const keys = await frameOrPage.$$eval('button, a, div, span', (els) => {
    const timeRe = /\b([01]\d|2[0-3]):[0-5]\d\b/;
    const isVisible = (n) => {
      if (!n) return false;
      const s = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' &&
             parseFloat(s.opacity || '1') > 0.01 &&
             r.width > 0 && r.height > 0 &&
             document.contains(n) && n.offsetParent !== null;
    };
    const findDayAbove = (el, maxDepth = 8) => {
      const dayRes = [
        /(?:Пн|Вт|Ср|Чт|Пт|Сб|Вс)\.?/i,
        /\b\d{1,2}\s*(?:янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек)\b/i,
        /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/,
      ];
      let p = el;
      for (let i = 0; i < maxDepth && p; i++) {
        const txt = (p.textContent || '').replace(/\s+/g,' ').trim();
        for (const re of dayRes) {
          const m = txt.match(re);
          if (m) return m[0];
        }
        p = p.parentElement;
      }
      return '';
    };

    const set = new Set();
    for (const el of els) {
      const txt = el.textContent || '';
      const m = txt.match(timeRe);
      if (!m) continue;
      if (!isVisible(el)) continue;
      const t = m[0];
      const day = findDayAbove(el) || 'День?';
      set.add(`${day} | ${t}`);
    }
    return Array.from(set);
  });

  return keys.sort();
}

async function tryOneProxy(proxy, i) {
  console.log(`▶ Пробуем прокси [${i + 1}] ${proxy || '(без прокси)'}`);

  // быстрый «пинг» (иначе перепрыгиваем к следующему)
  try {
    if (proxy) await quickProbe(proxy, i);
    else if (!ALLOW_DIRECT) throw new Error('DIRECT запрещён (ALLOW_DIRECT=0)');
  } catch (e) {
    console.warn(`✗ Отклонён на пинге: ${proxy || 'DIRECT'} — ${e?.message || e}`);
    throw e;
  }

  // основной заход
  return await withBrowser(proxy, i, async (page) => {
    console.log(`… Открываем цель: ${URL} через ${proxy || 'DIRECT'}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // если расписание в iframe — найдём его
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

    const keys = await extractDayTimeKeys(target);
    return keys;
  });
}

async function main() {
  const order = shuffle(PROXY_LIST);
  if (ALLOW_DIRECT) order.push(null);

  console.log(`Найдено прокси в списке: ${PROXY_LIST.length}. Порядок попыток: ${order.length}.`);

  let lastErr = null;
  const MAX_ATTEMPTS = Math.min(order.length, 30) || (ALLOW_DIRECT ? 1 : 0);

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const proxy = order[i];
    try {
      const keys = await tryOneProxy(proxy, i);

      // known = массив "День | HH:MM"
      const known = fs.existsSync(DATA_FILE)
        ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
        : [];
      const knownSet = new Set(known);

      // только новые ключи
      const freshKeys = keys.filter(k => !knownSet.has(k));

      if (freshKeys.length) {
        // обновляем базу
        const newAll = Array.from(new Set([...known, ...keys])).sort();
        fs.writeFileSync(DATA_FILE, JSON.stringify(newAll, null, 2));

        // в уведомлении — только список НОВЫХ времен (уникальных)
        const freshTimes = Array.from(new Set(
          freshKeys.map(k => k.split('|').pop().trim())
        )).sort((a, b) => a.localeCompare(b));

        const text = `НОВЫЕ СЛОТЫ ЛУЖНИКИ!\n${freshTimes.join('\n')}\n\n${URL}`;

        if (bot && CHAT_ID) {
          await bot.sendMessage(CHAT_ID, text);
          console.log('✓ Отправлено в Telegram:', freshTimes);
        } else {
          console.log(text);
          console.warn('! TG_BOT_TOKEN/CHAT_ID не заданы — сообщение в консоль.');
        }
      } else {
        console.log('Нет новых времен/дней — молчу.');
      }
      return; // успех — выходим
    } catch (e) {
      lastErr = e;
      console.warn(`⚠ Ошибка на прокси ${order[i] || 'DIRECT'}: ${e?.message || e}`);
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }
  }

  throw lastErr || new Error('Не удалось открыть сайт ни через один прокси');
}

main().catch(err => {
  console.error('Фатальная ошибка:', err);
  process.exit(1);
});
