// monitor-luzhniki.js
// Режим проверки: присылаем ВСЕ найденные слоты (SEND_ALL=1).
// Поддержка прокси: http/https, socks5 с авторизацией через proxy-chain (конвертация в локальный http).

import playwright from 'playwright';
import fetchDefault from 'node-fetch';
import proxyChainDefault from 'proxy-chain';

// proxy-agent пакеты — только для "быстрой" проверки прокси через fetch
import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';

const { chromium } = playwright;
const fetch = fetchDefault;
const proxyChain = proxyChainDefault;
const { HttpProxyAgent } = httpProxyAgentPkg;
const { HttpsProxyAgent } = httpsProxyAgentPkg;
const { SocksProxyAgent } = socksProxyAgentPkg;

// ==================== конфиг ====================
const TARGET_URL = 'https://tennis.luzhniki.ru/#courts';
const DEBUG = process.env.DEBUG === '1';
const SEND_ALL = process.env.SEND_ALL === '1';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

const PROXY_LIST = (process.env.PROXY_LIST || '')
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean);

function log(...args) { console.log(...args); }
function dlog(...args) { if (DEBUG) console.log(...args); }

// ==================== утилиты ====================

function maskCred(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return url;
  }
}

function pickProxy() {
  if (PROXY_LIST.length === 0) return null;
  // Берём первый из списка (можно рандомизировать при желании)
  return PROXY_LIST[0];
}

function agentFor(targetUrl, proxyUrl) {
  // Агент для node-fetch проверки
  const t = new URL(targetUrl);
  const p = new URL(proxyUrl);
  if (p.protocol.startsWith('socks')) {
    return new SocksProxyAgent(proxyUrl);
  }
  if (t.protocol === 'http:') {
    return new HttpProxyAgent(proxyUrl);
  }
  return new HttpsProxyAgent(proxyUrl);
}

async function quickProbe(proxyUrl) {
  // Быстро проверяем, что через прокси вообще что-то ходит
  const testUrl = 'https://httpbin.org/ip';
  try {
    const res = await fetch(testUrl, { agent: agentFor(testUrl, proxyUrl), timeout: 7000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { ok: true, ip: json.origin || JSON.stringify(json) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function sendToTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('[WARN] TG_BOT_TOKEN/TG_CHAT_ID не заданы — сообщение не будет отправлено.');
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
    const t = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${res.status} ${t}`);
  }
}

// ==================== парсинг ====================

// Парсим по тексту: вытаскиваем сегменты по дням Пн..Вс и внутри ищем времена HH:MM
function extractSlotsFromText(fullText) {
  const dayTokens = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const dayRegex = new RegExp(`\\b(${dayTokens.join('|')})\\b[^\n]*`, 'g');
  const timeRegex = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g;

  // Разобьём текст по дням, сохраняя порядок
  // Идея: найти индексы всех вхождений дня и вырезать блок до следующего дня
  const indices = [];
  let m;
  while ((m = dayRegex.exec(fullText)) !== null) {
    indices.push({ index: m.index, label: m[0] });
  }

  const result = {}; // { 'Пн ...': ['07:00','22:00'], ... }
  if (indices.length === 0) {
    // fallback: просто собрать все времена без привязки к дням
    const allTimes = Array.from(fullText.matchAll(timeRegex)).map(x => x[0]);
    if (allTimes.length > 0) {
      result['Без указания дня'] = Array.from(new Set(allTimes)).sort();
    }
    return result;
  }

  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].index;
    const end = (i + 1 < indices.length) ? indices[i + 1].index : fullText.length;
    const chunk = fullText.slice(start, end);
    const dayLine = (indices[i].label || '').trim();

    const times = Array.from(chunk.matchAll(timeRegex)).map(x => x[0]);
    if (times.length > 0) {
      const key = dayLine; // можно сюда добавить дату, если она есть в dayLine
      const uniqSorted = Array.from(new Set(times)).sort();
      result[key] = uniqSorted;
    }
  }
  return result;
}

async function scrapeLuzhniki(page) {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // даём странице подтянуть динамику
  await page.waitForTimeout(2000);

  // тянем весь видимый текст страницы
  const text = await page.evaluate(() => document.body?.innerText || '');
  if (DEBUG) {
    dlog(`[DEBUG] Длина текста страницы: ${text.length}`);
  }
  const byDay = extractSlotsFromText(text);

  return byDay; // объект { 'Пн ...': ['07:00', '22:00'], ... }
}

function composeAllMessage(byDay) {
  const lines = [];
  lines.push('ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ!');
  lines.push('');

  const dayKeys = Object.keys(byDay);
  if (dayKeys.length === 0) {
    lines.push('Сейчас свободных слотов не вижу.');
  } else {
    for (const key of dayKeys) {
      lines.push(`<b>${key}</b>`);
      const times = byDay[key] || [];
      if (times.length) {
        lines.push(times.join('\n'));
      } else {
        lines.push('(времени не найдено)');
      }
      lines.push(''); // пустая строка между днями
    }
  }

  lines.push('');
  lines.push(TARGET_URL);
  return lines.join('\n');
}

// ==================== основной поток ====================

async function withBrowser(proxyToUse, fn) {
  let browser;
  let serverToClose = null;
  try {
    let playwrightProxy = undefined;

    if (proxyToUse) {
      // Если socks5 с авторизацией — Playwright не умеет, поэтому через proxy-chain
      // Это сделает локальный "анонимный" http-прокси, который перенаправляет на исходный.
      const anonymized = await proxyChain.anonymizeProxy(proxyToUse);
      playwrightProxy = { server: anonymized };
      serverToClose = anonymized; // для корректного закрытия ниже
      dlog(`[DEBUG] Проксируем через локальный proxy-chain: ${maskCred(anonymized)}`);
    }

    browser = await chromium.launch({
      headless: true,
      proxy: playwrightProxy
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await fn(page);
    await ctx.close();
    await browser.close();

    // proxy-chain под капотом поднимает локальный сервер; закрыть:
    if (serverToClose) {
      try { await proxyChain.closeAnonymizedProxy(serverToClose, true); } catch {}
    }

    return res;
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    if (serverToClose) {
      try { await proxyChain.closeAnonymizedProxy(serverToClose, true); } catch {}
    }
    throw e;
  }
}

async function main() {
  const ts = new Date().toISOString();
  const proxy = pickProxy();
  if (proxy) log(`[${ts}] Используем прокси: ${maskCred(proxy)}`);
  else log(`[${ts}] Прокси не задан — пробуем без прокси`);

  // Быстрая проверка прокси (если он есть)
  if (proxy) {
    const probe = await quickProbe(proxy);
    if (probe.ok) {
      log(`[${ts}] Прокси отвечает. Внешний IP: ${probe.ip}`);
    } else {
      log(`[${ts}] Внимание: быстрый пинг прокси не удался: ${probe.error}`);
      // всё равно попробуем открыть страницу — иногда httpbin недоступен из конкретной сети
    }
  }

  try {
    const byDay = await withBrowser(proxy, async (page) => {
      log(`[${new Date().toISOString()}] Открываем ${TARGET_URL}`);
      const data = await scrapeLuzhniki(page);
      dlog('[DEBUG] Результат парсинга:', JSON.stringify(data, null, 2));
      return data;
    });

    // Всегда отправляем ВСЁ (режим SEND_ALL=1). На этот момент он у нас принудительно включён из workflow.
    const msg = composeAllMessage(byDay);
    await sendToTelegram(msg);
    log(`[${new Date().toISOString()}] Сообщение отправлено (${Object.keys(byDay).length} дней).`);
  } catch (e) {
    log(`[${new Date().toISOString()}] Завершено с ошибкой: ${e && e.message || e}`);
    throw e;
  }
}

main().catch(e => {
  // пусть GitHub Actions пометит как failed
  console.error('Фатальная ошибка:', e);
  process.exit(1);
});
