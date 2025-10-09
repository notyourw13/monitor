// monitor-luzhniki.js
// Node 20, Playwright chromium. Шлём ВСЁ, но если пусто — даём развёрнутый DEBUG.

import fs from 'fs';
import process from 'process';
import fetch from 'node-fetch';               // v2
import { chromium } from 'playwright';
import pkgHttpAgent from 'http-proxy-agent';  // CJS -> default import
import pkgHttpsAgent from 'https-proxy-agent';

const { HttpProxyAgent } = pkgHttpAgent;
const { HttpsProxyAgent } = pkgHttpsAgent;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;
const PROXY_URL    = process.env.PROXY_URL || ''; // например: socks5://user:pass@host:port или http://user:pass@host:port
const DISABLE_PROXY= process.env.DISABLE_PROXY === '1';

const TARGET_URL   = 'https://tennis.luzhniki.ru/#courts';

const NOW = () => new Date().toISOString();
const log = (...a) => console.log(`[${NOW()}]`, ...a);

// ---------- Telegram ----------
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('⚠ TG envs not set, skipping send.');
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`Telegram send failed: ${res.status} ${t}`);
  }
}

// Пытаемся “пропинговать” прокси простым HTTP-запросом (не браузером)
async function quickProxyProbe(proxyUrl) {
  try {
    const isHttpish = proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://');
    const agent = isHttpish ? (proxyUrl.startsWith('https://') ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl)) : null;
    const res = await fetch('https://api.ipify.org?format=json', {
      // если socks5 — этот fetch не поддержит. Тогда просто пропускаем проверку.
      agent: agent || undefined,
      timeout: 6000
    });
    if (!res.ok) return { ok:false, err:`status ${res.status}` };
    const j = await res.json();
    return { ok:true, ip:j.ip };
  } catch (e) {
    return { ok:false, err: e.message || String(e) };
  }
}

// Надёжные клики по тексту/ролям с таймаутом и логом
async function clickByText(page, text, { timeout=8000, exact=false } = {}) {
  const locator = exact ? page.getByText(text, { exact: true }) : page.getByText(text);
  await locator.waitFor({ state: 'visible', timeout });
  await locator.first().click();
}

async function clickByRole(page, role, name, { timeout=8000, exact=false } = {}) {
  const loc = page.getByRole(role, { name, exact });
  await loc.waitFor({ state: 'visible', timeout });
  await loc.first().click();
}

// Ждём, пока SPA реально дорисует то, что нам надо
async function robustWait(page) {
  // сначала дождёмся какого-то сетевого затишья
  try { await page.waitForLoadState('load',       { timeout: 15000 }); } catch {}
  try { await page.waitForLoadState('networkidle',{ timeout: 15000 }); } catch {}
  // небольшой резерв
  await page.waitForTimeout(1000);
}

// Достаём видимый текст — для диагностики
async function grabVisibleText(page, limit = 2500) {
  try {
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    return (text || '').trim().slice(0, limit);
  } catch {
    return '';
  }
}

// Основной сбор слотов
async function scrapeLuzhniki(page) {
  log('Открываем', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await robustWait(page);

  // Шаг 1: щёлкнуть “Аренда крытых кортов”
  // Пробуем несколько стратегий: по тексту, затем по роли.
  let clickedIndoor = false;
  for (const tryFn of [
    async () => { await clickByText(page, 'Аренда крытых кортов', { timeout: 5000 }); },
    async () => { await clickByRole(page, 'link', /Аренда крытых кортов/i, { timeout: 5000 }); },
    async () => { await clickByRole(page, 'button', /Аренда крытых кортов/i, { timeout: 5000 }); },
  ]) {
    try { await tryFn(); clickedIndoor = true; break; } catch {}
  }
  if (clickedIndoor) {
    log('Кликнули: Аренда крытых кортов');
    await robustWait(page);
  } else {
    log('Не нашли “Аренда крытых кортов” — возможно, уже на нужном экране.');
  }

  // Шаг 2: кнопка “Продолжить”
  let clickedContinue = false;
  for (const tryFn of [
    async () => { await clickByText(page, 'Продолжить', { timeout: 5000 }); },
    async () => { await clickByRole(page, 'button', /Продолжить/i, { timeout: 5000 }); },
  ]) {
    try { await tryFn(); clickedContinue = true; break; } catch {}
  }
  if (clickedContinue) {
    log('Кликнули: Продолжить');
    await robustWait(page);
  } else {
    log('Кнопка “Продолжить” не найдена/не нужна — идём дальше.');
  }

  // На экране с днём должны появиться блоки “Утро/Вечер” и карточки со временем.
  // Сайт может менять классы, поэтому берём универсально:
  // 1) Снимаем весь видимый текст и вытаскиваем часы формата HH:MM.
  const pageText = await grabVisibleText(page, 15000);

  // 2) Пробуем выделить даты: строки вида “Пн 13”, “Сб 11” и т.п.
  //   Это эвристика. Если на сайте формат другой — хотя бы увидим его в DEBUG.
  const dayRegex = /(?:Пн|Вт|Ср|Чт|Пт|Сб|Вс)\s*\d{1,2}/g;
  const timeRegex = /\b([01]?\d|2[0-3]):[0-5]\d\b/g;

  // Будем пытаться сгруппировать: берём текущую “шапку дня” и следующие времена до следующей “шапки”.
  const lines = pageText.split('\n').map(s => s.trim()).filter(Boolean);

  const grouped = [];   // [{ day: 'Сб 11', times: ['07:00','22:00'] }, ...]
  let currentDay = 'Без указания дня';
  let bucket = [];

  for (const ln of lines) {
    const dayMatch = ln.match(dayRegex);
    if (dayMatch && dayMatch.length) {
      // сохранить предыдущий
      if (bucket.length) {
        grouped.push({ day: currentDay, times: Array.from(new Set(bucket)) });
        bucket = [];
      }
      currentDay = dayMatch[0];
      continue;
    }
    const times = ln.match(timeRegex);
    if (times && times.length) {
      for (const t of times) bucket.push(t);
    }
  }
  if (bucket.length) grouped.push({ day: currentDay, times: Array.from(new Set(bucket)) });

  // Удалим пустые группы, отсортируем времена
  for (const g of grouped) {
    g.times = g.times
      .map(t => t.length === 4 ? `0${t}` : t) // 7:00 -> 07:00
      .sort();
  }
  const nonEmpty = grouped.filter(g => g.times.length > 0);

  return { nonEmpty, pageTextSample: pageText.slice(0, 2000), atUrl: page.url() };
}

async function withBrowser(fn) {
  const launchOptions = {
    headless: true,
    timeout: 60000
  };

  if (!DISABLE_PROXY && PROXY_URL) {
    launchOptions.proxy = { server: PROXY_URL };
  }

  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // лог ошибок консоли/запросов — в рантайм логи Actions
    page.on('console', msg => log('console:', msg.type(), msg.text()));
    page.on('pageerror', err => log('pageerror:', err.message));
    page.on('requestfailed', req => log('requestfailed:', req.url(), req.failure()?.errorText || ''));

    return await fn(page);
  } finally {
    await browser.close().catch(()=>{});
  }
}

async function main() {
  log('Старт');

  if (!DISABLE_PROXY && PROXY_URL) {
    log('Пробуем прокси:', PROXY_URL);
    const probe = await quickProxyProbe(PROXY_URL);
    if (probe.ok) {
      log('Прокси откликнулся, внешний IP:', probe.ip);
    } else {
      log('Прокси не прошёл быстрый пинг:', probe.err);
      // продолжаем — браузерный прокси может повести себя по-другому
    }
  } else {
    log('Без прокси (DISABLE_PROXY=1 или нет PROXY_URL).');
  }

  let result;
  try {
    result = await withBrowser(page => scrapeLuzhniki(page));
  } catch (e) {
    log('Завершено с ошибкой:', e.message || String(e));
    await sendTelegram(`❌ Ошибка мониторинга Лужники:\n<code>${(e.message||String(e)).slice(0,1000)}</code>`);
    process.exit(1);
  }

  const { nonEmpty, pageTextSample, atUrl } = result;

  if (!nonEmpty.length) {
    // Отправляем развернутый DEBUG, чтобы понимать, где мы оказались и что видим на странице
    const dbg = [
      '⚠️ Не удалось выделить слоты, но страница что-то показывает.',
      `<b>URL:</b> ${atUrl}`,
      '<b>Фрагмент видимого текста:</b>',
      `<code>${pageTextSample.replace(/</g,'&lt;').slice(0, 1800)}</code>`,
      '',
      TARGET_URL
    ].join('\n');
    await sendTelegram(dbg);
    log('Слотов не найдено, отправили DEBUG.');
    return;
  }

  // Формируем человекочитаемое сообщение
  let lines = ['ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ!',''];
  for (const g of nonEmpty) {
    lines.push(`${g.day}:`);
    lines.push(g.times.join('\n'));
    lines.push(''); // пустая строка-разделитель
  }
  lines.push(TARGET_URL);

  const message = lines.join('\n');
  await sendTelegram(message);
  log('Готово. Сообщение отправлено.');
}

main().catch(e => {
  log('Фатальная ошибка:', e);
  process.exit(1);
});
