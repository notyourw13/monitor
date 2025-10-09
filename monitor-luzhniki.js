// monitor-luzhniki.js
import { chromium } from 'playwright';
import fetch from 'node-fetch';

// CJS-модули корректно через default-импорт:
import httpProxyAgentPkg from 'http-proxy-agent';
const { HttpProxyAgent } = httpProxyAgentPkg;

import httpsProxyAgentPkg from 'https-proxy-agent';
const { HttpsProxyAgent } = httpsProxyAgentPkg;

import socksProxyAgentPkg from 'socks-proxy-agent';
const { SocksProxyAgent } = socksProxyAgentPkg;

import proxyChainPkg from 'proxy-chain';
const { anonymizeProxy, closeAnonymizedProxy } = proxyChainPkg;

// --- Константы ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PROXY_LIST = process.env.PROXY_LIST || '';
const TARGET_URL = 'https://tennis.luzhniki.ru/#courts';
const LOG = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// --- Утилиты ---
function parseProxy(line) {
  const m = line.trim().match(/^(socks5|http|https):\/\/(?:(.+?):(.*?)@)?([^:\/]+):(\d+)$/i);
  if (!m) return null;
  const [, scheme, user, pass, host, port] = m;
  return {
    raw: line.trim(),
    scheme: scheme.toLowerCase(),
    host,
    port: Number(port),
    username: user || undefined,
    password: pass || undefined,
  };
}

async function quickProbe(p) {
  const testUrl = 'https://api.ipify.org?format=json';
  let agent;
  if (p.scheme === 'socks5') {
    agent = new SocksProxyAgent(`socks5://${p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : ''}${p.host}:${p.port}`);
  } else if (p.scheme === 'http') {
    agent = new HttpProxyAgent(`http://${p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : ''}${p.host}:${p.port}`);
  } else {
    agent = new HttpsProxyAgent(`http://${p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : ''}${p.host}:${p.port}`);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(testUrl, { agent, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`probe status ${res.status}`);
    const js = await res.json();
    return { ok: true, ip: js.ip };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.message || String(e) };
  }
}

async function notify(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    LOG('TG env not set; skip notify');
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!res.ok) LOG('Telegram send error:', res.status, await res.text());
  } catch (e) {
    LOG('Telegram send failed:', e.message || String(e));
  }
}

// Создаём пригодный для Playwright URL прокси.
// Если SOCKS5 без/с авторизацией — поднимем локальный HTTP-прокси через proxy-chain.
async function toPlaywrightProxy(proxyObj) {
  // Playwright Chromium: поддерживает HTTP/HTTPS proxy с auth, SOCKS5 — без auth.
  const isSocksWithAuth = proxyObj.scheme === 'socks5' && proxyObj.username;
  if (isSocksWithAuth) {
    const upstream = `socks5://${encodeURIComponent(proxyObj.username)}:${encodeURIComponent(proxyObj.password)}@${proxyObj.host}:${proxyObj.port}`;
    const localHttp = await anonymizeProxy(upstream); // вернёт что-то вроде http://127.0.0.1:XXXXX
    return { server: localHttp, _anonymized: localHttp }; // запомним для закрытия
  }
  // SOCKS5 без auth — Chromium не умеет auth, но без auth обычно ок. Всё равно надёжнее HTTP.
  if (proxyObj.scheme === 'socks5') {
    // завернём его тоже в локальный HTTP без auth, чтобы было стабильно
    const upstream = `socks5://${proxyObj.host}:${proxyObj.port}`;
    const localHttp = await anonymizeProxy(upstream);
    return { server: localHttp, _anonymized: localHttp };
  }
  // HTTP/HTTPS
  let auth = '';
  if (proxyObj.username) auth = `${encodeURIComponent(proxyObj.username)}:${encodeURIComponent(proxyObj.password)}@`;
  const server = `${proxyObj.scheme}://${auth}${proxyObj.host}:${proxyObj.port}`;
  // Для Playwright прокси указывается без auth в URL, а логин/пароль отдельными полями
  const pw = {
    server: `${proxyObj.scheme}://${proxyObj.host}:${proxyObj.port}`,
  };
  if (proxyObj.username) {
    pw.username = proxyObj.username;
    pw.password = proxyObj.password;
  }
  return pw;
}

async function withBrowser(proxyObj, fn) {
  // Преобразуем прокси в совместимый для Playwright формат
  const pwProxy = await toPlaywrightProxy(proxyObj);

  const browser = await chromium.launch({
    headless: true,
    proxy: pwProxy,
    timeout: 30000,
  });

  try {
    const ctx = await browser.newContext({ javaScriptEnabled: true });
    const page = await ctx.newPage();
    const res = await fn(page);
    await ctx.close();
    return res;
  } finally {
    await browser.close();
    // Если поднимали локальный анонимный прокси — закрываем
    if (pwProxy._anonymized) {
      try { await closeAnonymizedProxy(pwProxy._anonymized, true); } catch {}
    }
  }
}

async function scrapeLuzhniki(proxyObj) {
  LOG('Открываем', TARGET_URL);
  return await withBrowser(proxyObj, async (page) => {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    return true;
  });
}

async function main() {
  const list = PROXY_LIST.split('\n').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('PROXY_LIST пуст. Помести туда строку вида socks5://user:pass@host:port');

  const first = parseProxy(list[0]);
  if (!first) throw new Error('Неверный формат первой строки PROXY_LIST');

  LOG('Используем прокси:', `${first.scheme}://${first.host}:${first.port}${first.username ? ' (with auth)' : ''}`);

  const probe = await quickProbe(first);
  if (!probe.ok) {
    const msg = `Проба прокси не удалась: ${probe.error}`;
    LOG(msg);
    await notify(`❌ Прокси не прошёл проверку.\n${msg}`);
    throw new Error(msg);
  }
  LOG('Прокси отвечает. Внешний IP:', probe.ip);

  try {
    await scrapeLuzhniki(first);
    LOG('Страница открыта через прокси успешно.');
    await notify('✅ Прокси ок. Страница Лужников открылась.');
  } catch (e) {
    const err = e?.message || String(e);
    LOG('Фатальная ошибка:', err);
    await notify(`❌ Ошибка открытия Лужников через прокси:\n${err}`);
    throw e;
  }
}

main().catch(e => {
  LOG('Завершено с ошибкой:', e?.message || String(e));
  process.exit(1);
});
