// --- Luzhniki monitor: кликаем «Крытые», «Продолжить», обходим дни и собираем слоты ---
// Работает с HTTP-прокси и c SOCKS5 с авторизацией (через proxy-chain -> локальный HTTP).
// Шлёт ВСЕ слоты по дням (для проверки). Когда всё ок — можно вернуть sendOnlyNew = true.

import playwright from 'playwright';
import fetchDefault from 'node-fetch';
import proxyChainDefault from 'proxy-chain';

import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';

const { chromium } = playwright;
const fetch = fetchDefault;
const proxyChain = proxyChainDefault;
const { HttpProxyAgent }  = httpProxyAgentPkg;
const { HttpsProxyAgent } = httpsProxyAgentPkg;
const { SocksProxyAgent } = socksProxyAgentPkg;

const TARGET_URL = 'https://tennis.luzhniki.ru/#courts';

const DEBUG = process.env.DEBUG === '1';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_LIST   = (process.env.PROXY_LIST || '').trim();

const sendOnlyNew = false; // сейчас присылаем ВСЁ для проверки

// Хранилище для «уже присылали» (чтобы потом включить sendOnlyNew)
const STATE_KEY = 'LZHN_STATE_V1';
let memoryState = {};

// ---------- утилиты ----------
const log = (...a) => { if (DEBUG) console.log(new Date().toISOString(), ...a); };

function parseProxyLine(line) {
  // Поддержка форматов:
  //  - http://user:pass@host:port
  //  - socks5://user:pass@host:port
  //  - host:port  (тогда считаем http://)
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('socks5://')) return s;
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) return 'http://' + s;
  return s; // оставляем как есть
}

function buildFetchAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
    return proxyUrl.startsWith('https://')
      ? new HttpsProxyAgent(proxyUrl)
      : new HttpProxyAgent(proxyUrl);
  }
  if (proxyUrl.startsWith('socks5://')) {
    return new SocksProxyAgent(proxyUrl);
  }
  return undefined;
}

async function testProxyReachable(proxyUrl) {
  // Быстрая проверка через httpbin
  const agent = buildFetchAgent(proxyUrl);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch('http://httpbin.org/ip', { agent, signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    return j.origin || 'ok';
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('TG creds missing; printing message:\n' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('Telegram error ' + r.status + ' ' + body);
  }
}

// ---------- браузер с прокси ----------
async function launchBrowserWithProxy(rawProxy) {
  let browserProxy = null;

  if (rawProxy) {
    // Если SOCKS с логином — Playwright ругается. Оборачиваем в HTTP через proxy-chain.
    if (rawProxy.startsWith('socks5://')) {
      log('Используем SOCKS5: через proxy-chain создаём локальный HTTP-туннель');
      browserProxy = await proxyChain.anonymizeProxy(rawProxy); // вернёт http://127.0.0.1:XXXXX
    } else {
      browserProxy = rawProxy; // http/https
    }
  }

  const browser = await chromium.launch({
    headless: true,
    proxy: browserProxy ? { server: browserProxy } : undefined,
  });

  return { browser, browserProxy };
}

// ---------- парсинг сайта ----------
async function scrapeAllSlots(page) {
  // 1) ждём окно выбора продукта
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
  // Иногда попап появляется чуть позже
  await page.waitForSelector('text=Аренда крытых кортов', { timeout: 20000 });

  // 2) клик по «Аренда крытых кортов»: у карточки справа «+»
  // Пробуем: либо плюс, либо просто клик по карточке
  const card = await page.locator('text=Аренда крытых кортов').first();
  await card.scrollIntoViewIfNeeded({ timeout: 5000 });

  // ищем кнопку «+» рядом
  const plusBtn = page.locator('button:has-text("+")').first();
  try {
    await plusBtn.click({ timeout: 2000 });
  } catch {
    // если не нашли плюс — кликнем по самой карточке
    await card.click({ timeout: 3000 });
  }

  // 3) ждём кнопку «Продолжить» и жмём
  await page.waitForSelector('button:has-text("Продолжить")', { timeout: 15000 });
  await page.click('button:has-text("Продолжить")');

  // 4) страница с календарём
  await page.waitForSelector('text=Октябрь', { timeout: 20000 }).catch(() => {});

  // Выберем все видимые «дни» в полоске календаря (кнопки с одной-двумя цифрами)
  // Берём кнопки, у которых текст — только число дня
  const dayButtons = await page.locator('button, [role="button"]').all();
  const candidates = [];
  for (const b of dayButtons) {
    const t = (await b.innerText().catch(() => '')).trim();
    if (/^\d{1,2}$/.test(t)) candidates.push(b);
  }
  // Если ничего не нашли, отдаём хотя бы текущий день
  if (candidates.length === 0 && dayButtons.length > 0) candidates.push(dayButtons[0]);

  const result = {}; // { 'Сб 11': ['07:00','22:00'], ... }

  for (let i = 0; i < candidates.length; i++) {
    const btn = candidates[i];
    let label = (await btn.innerText().catch(() => '')).trim();
    // «обогащаем» меткой дня недели, если рядом есть подпись
    try {
      const weekHeader = await btn.locator('xpath=ancestor::*[1]/preceding-sibling::*[1]').innerText({ timeout: 1000 }).catch(() => '');
      const w = weekHeader.trim().split('\n').pop() || '';
      if (/[А-Яа-я]{2,3}\.?/.test(w)) label = `${w} ${label}`;
    } catch {}

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 5000 }).catch(() => {});

    // ждём появление блоков «Утро/Вечер» (или списка слотов)
    await page.waitForTimeout(400); // небольшой debounce после клика
    // тайм-чипы выглядят как элементы с текстом вида 07:00, 22:00
    const chips = await page.locator('text=/^\\d{1,2}:\\d{2}$/').all();
    const times = [];
    for (const c of chips) {
      const t = (await c.innerText().catch(() => '')).trim();
      if (/^\d{1,2}:\d{2}$/.test(t)) times.push(normalizeTime(t));
    }
    const uniq = [...new Set(times)].sort(compareTime);
    result[label || `День ${i+1}`] = uniq;
  }

  return result;
}

function normalizeTime(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  const hh = m[1].padStart(2, '0');
  return `${hh}:${m[2]}`;
}

function compareTime(a, b) {
  // '07:00' vs '22:00'
  return a.localeCompare(b);
}

// ---------- главный сценарий ----------
async function main() {
  // выбираем прокси (если есть)
  let chosenProxy = null;
  if (PROXY_LIST) {
    const lines = PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
    if (lines.length) {
      // берём первый рабочий
      for (const p of lines) {
        try {
          log('Пробуем прокси:', p);
          const ip = await testProxyReachable(p);
          log('Прокси отвечает. Внешний IP:', ip);
          chosenProxy = p;
          break;
        } catch (e) {
          log('Прокси не подошёл:', p, String(e));
        }
      }
    }
  }

  const { browser, browserProxy } = await launchBrowserWithProxy(chosenProxy);
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    log('Открываем', TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const all = await scrapeAllSlots(page);

    // формируем сообщение
    let text = 'ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ!\n\n';
    const dayKeys = Object.keys(all);

    if (dayKeys.length === 0) {
      text += 'Ничего не нашлось.\n\n';
    } else {
      for (const d of dayKeys) {
        const times = all[d] || [];
        if (times.length === 0) continue;
        text += `${d}\n`;
        for (const t of times) text += `${t}\n`;
        text += '\n';
      }
    }

    text += '\nhttps://tennis.luzhniki.ru/#courts';

    await sendTelegram(text);
    log('Отправлено.');

    await ctx.close();
    await browser.close();

    // если создавали локальный http-прокси через proxy-chain — закрыть
    if (browserProxy && browserProxy.startsWith('http://127.0.0.1:')) {
      try { await proxyChain.closeAnonymizedProxy(browserProxy, true); } catch {}
    }

  } catch (e) {
    log('Завершено с ошибкой:', String(e));
    if (browserProxy && browserProxy.startsWith('http://127.0.0.1:')) {
      try { await proxyChain.closeAnonymizedProxy(browserProxy, true); } catch {}
    }
    process.exitCode = 1;
  }
}

await main();
