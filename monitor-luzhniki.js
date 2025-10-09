// monitor-luzhniki.js
// Запуск в GHA. Делает HTTP-мост для SOCKS5, идёт в браузер через него, парсит слоты и шлёт в TG.

import fs from 'fs';
import { chromium, devices } from 'playwright';
import proxyChain from 'proxy-chain';
import fetch from 'node-fetch'; // v2
import { SocksProxyAgent } from 'socks-proxy-agent';
import TelegramBot from 'node-telegram-bot-api';

const URL = 'https://tennis.luzhniki.ru/#courts';
const DESKTOP = devices['Desktop Chrome'];
const LOGFILE = `run-${Date.now()}.log`;

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOGFILE, line); } catch {}
}

function env(name, fallback = undefined) {
  return (process.env[name] ?? fallback)?.toString().trim();
}

function pickFromList(listStr) {
  if (!listStr) return null;
  const items = listStr.split(/[, \n\r]+/).map(s => s.trim()).filter(Boolean);
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

async function prepareBrowserProxy() {
  // Источник: PROXY_URL (socks5://USER:PASS@HOST:PORT) или PROXY_LIST (через запятую)
  const raw = env('PROXY_URL') || pickFromList(env('PROXY_LIST'));
  if (!raw) {
    throw new Error('Прокси не задан (PROXY_URL/PROXY_LIST пуст). Не запускаем Chromium без прокси.');
  }

  const isSocks = /^socks5:/i.test(raw);
  if (isSocks) {
    log('Проверяем SOCKS5 апстрим:', maskCreds(raw));

    // Быстрая проверка апстрима через socks-агент
    let res;
    try {
      const agent = new SocksProxyAgent(raw);
      res = await fetch('https://ifconfig.me', { agent, timeout: 10_000 });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const ip = await res.text();
      log('SOCKS5 живой, внешний IP:', ip);
    } catch (e) {
      throw new Error(`SOCKS5 upstream не прошёл проверку: ${e.message || e}`);
    }

    // Поднимаем локальный HTTP-мост (анонимизируем)
    try {
      const httpBridge = await proxyChain.anonymizeProxy(raw);
      log('HTTP-мост создан:', httpBridge);
      return { server: httpBridge, close: () => proxyChain.closeAnonymizedProxy(httpBridge, true) };
    } catch (e) {
      throw new Error('Не удалось создать HTTP-мост для SOCKS5: ' + (e.message || e));
    }
  }

  // Если это http(s) proxy — отдаём как есть
  if (/^https?:\/\//i.test(raw)) {
    log('HTTP(S) прокси задан:', maskCreds(raw));
    return { server: raw, close: async () => {} };
  }

  throw new Error('Неизвестный формат PROXY_URL. Ожидается socks5:// или http(s)://');
}

function maskCreds(u) {
  try {
    const url = new URL(u);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return u.replace(/\/\/[^@]+@/, '//***:***@');
  }
}

async function gotoWithRetries(page, url, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      log(`Переходим (${i}/${attempts}) → ${url}`);
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      // Ждём ключевой элемент первого экрана (SPA/антибот)
      await page.waitForSelector('text=Аренда крытых кортов', { timeout: 30_000 });
      return;
    } catch (e) {
      lastErr = e;
      log(`[goto retry ${i}]`, e.message || e);
      await page.waitForTimeout(5_000);
    }
  }
  throw lastErr;
}

async function dumpArtifacts(page, tag = 'fail') {
  try { await page.screenshot({ path: `art-${tag}.png`, fullPage: true }); } catch {}
  try {
    const html = await page.content();
    await fs.promises.writeFile(`art-${tag}.html`, html);
  } catch {}
}

function formatSlotsByDay(slots) {
  // slots: [{ date: '2025-10-11', times: ['07:00','22:00']}, ...]
  if (!slots?.length) return `ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n(ничего не найдено)\n\n${URL}`;
  const fmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: '2-digit', month: 'numeric' });
  let out = 'ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n';
  for (const day of [...slots].sort((a, b) => a.date.localeCompare(b.date))) {
    const d = new Date(day.date + 'T00:00:00+03:00');
    out += `\n${fmt.format(d)}:\n`;
    for (const t of [...(day.times || [])].sort()) out += `  ${t}\n`;
  }
  out += `\n${URL}`;
  return out;
}

async function sendTelegram(text) {
  const token = env('TG_BOT_TOKEN');
  const chatId = env('TG_CHAT_ID');
  if (!token || !chatId) {
    log('ВНИМАНИЕ: TG_BOT_TOKEN/TG_CHAT_ID не заданы — пропускаем отправку.');
    return;
  }
  const bot = new TelegramBot(token);
  await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
}

async function parseSlots(page) {
  // === ВАШ ПАРСИНГ СЛОТОВ ===
  // Оставляю безопасную заготовку, чтобы скрипт был исполняемым.
  // Если у вас уже есть рабочий код парсинга — ВСТАВЬТЕ его вместо этого блока.
  //
  // Заглушка: попробуем нажать нужные кнопки и собрать время по видимым слотам.
  try {
    // Первый экран
    const rentBtn = page.locator('text=Аренда крытых кортов');
    await rentBtn.first().click();
    const continueBtn = page.locator('text=Продолжить');
    await continueBtn.first().click();

    // Ожидаем появления секций времени
    await page.waitForSelector('text=Утро', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Простейший сбор времён (на реальном UI, вероятно, нужны точные селекторы)
    const times = await page.$$eval('*', nodes =>
      Array.from(nodes)
        .map(n => (n.textContent || '').trim())
        .filter(t => /^\d{1,2}:\d{2}$/.test(t))
    );

    const uniqueTimes = Array.from(new Set(times));
    const todayISO = new Date().toISOString().slice(0, 10);
    return uniqueTimes.length
      ? [{ date: todayISO, times: uniqueTimes }]
      : [];
  } catch (e) {
    log('parseSlots error:', e.message || e);
    return [];
  }
}

(async () => {
  let bridge = null;
  let browser;
  let context;
  const start = Date.now();

  try {
    // 1) Прокси
    const prepared = await prepareBrowserProxy();
    bridge = prepared;

    // 2) Браузер/контекст
    const launchOpts = {
      headless: true,
      ...DESKTOP,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ],
      timeout: 120_000,
      proxy: { server: bridge.server } // http://127.0.0.1:xxxxx от proxy-chain
    };

    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      userAgent: ua
    });
    const page = await context.newPage();

    page.on('console', msg => log('[page]', msg.type(), msg.text()));

    // 3) Навигация
    log('Открываем', URL);
    await gotoWithRetries(page, URL, 3);

    // 4) Парсинг
    const slots = await parseSlots(page);
    log('Найдено слотов:', JSON.stringify(slots));

    // 5) Сообщение
    const text = formatSlotsByDay(slots);
    await sendTelegram(text);

  } catch (e) {
    log('Завершено с ошибкой:', e.message || e);
    // Артефакты, если можно
    try {
      const pages = context?.pages?.() || [];
      if (pages[0]) await dumpArtifacts(pages[0], 'error');
    } catch {}
    process.exitCode = 1;
  } finally {
    // 6) Грейсфул-шатдаун
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
    try { await bridge?.close?.(); } catch {}
    log('Время выполнения:', `${Math.round((Date.now() - start)/1000)}s`);
  }
})();
