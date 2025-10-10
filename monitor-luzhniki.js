// --- Luzhniki Tennis Monitor (финальная версия) ---
// Полный цикл: заходим на главную → аренда теннисных кортов → крытые → продолжить → календарь
// Работает с SOCKS5 (через proxy-chain), шлёт слоты в Telegram

import playwright from 'playwright';
import fetchDefault from 'node-fetch';
import proxyChainDefault from 'proxy-chain';
import socksProxyAgentPkg from 'socks-proxy-agent';

const { chromium } = playwright;
const fetch = fetchDefault;
const proxyChain = proxyChainDefault;
const { SocksProxyAgent } = socksProxyAgentPkg;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const PROXY_LIST = (process.env.PROXY_LIST || '').trim();
const TARGET_URL = 'https://tennis.luzhniki.ru/';
const DEBUG = true;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- Telegram ----------
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('⚠️ TG credentials missing, printing:\n' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error('Telegram send failed: ' + r.status);
}

// ---------- Proxy ----------
function parseProxy(line) {
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith('socks5://')) return s;
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) return 'socks5://' + s;
  return s;
}

async function testProxy(proxyUrl) {
  const agent = new SocksProxyAgent(proxyUrl);
  try {
    const r = await fetch('https://ifconfig.me/ip', { agent, timeout: 5000 });
    const ip = (await r.text()).trim();
    log('SOCKS5 OK, IP:', ip);
    return true;
  } catch {
    return false;
  }
}

async function launchBrowserWithProxy(rawProxy) {
  let proxyServer = null;
  if (rawProxy) {
    log('SOCKS5 upstream:', rawProxy);
    proxyServer = await proxyChain.anonymizeProxy(rawProxy);
    log('HTTP bridge:', proxyServer);
  }
  const browser = await chromium.launch({
    headless: true,
    proxy: proxyServer ? { server: proxyServer } : undefined,
  });
  return { browser, proxyServer };
}

// ---------- Основная логика ----------
async function scrapeSlots(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 });

  // 1️⃣ Баннер на главной
  const banner = page.locator('text=Аренда теннисных кортов').first();
  await banner.waitFor({ timeout: 15000 });
  await banner.click();
  log('✅ Клик по баннеру «Аренда теннисных кортов»');

  // 2️⃣ Ждём карточку "Аренда крытых кортов"
  await page.waitForSelector('text=Аренда крытых кортов', { timeout: 20000 });
  const card = page.locator('text=Аренда крытых кортов').first();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  log('✅ Клик по карточке «Аренда крытых кортов»');

  // 3️⃣ Кнопка «Продолжить»
  const contBtn = page.locator('button:has-text("Продолжить"), text=Продолжить').first();
  await contBtn.waitFor({ timeout: 20000 });
  await contBtn.scrollIntoViewIfNeeded();
  await contBtn.click();
  log('✅ Нажали «Продолжить»');

  // 4️⃣ Календарь: ждём появление блока с месяцем
  await page.waitForSelector('text=Октябрь', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Пытаемся проскроллить календарь несколько раз (на всякий случай)
  const nextBtn = page.locator('button:has-text(">"), [aria-label*="вправо"]');
  for (let i = 0; i < 3; i++) {
    try {
      await nextBtn.click({ timeout: 1000 });
      await page.waitForTimeout(700);
    } catch {}
  }

  // 5️⃣ Сбор слотов
  const result = {};
  const dayButtons = await page.locator('button, [role="button"]').all();
  const candidates = [];
  for (const b of dayButtons) {
    const t = (await b.innerText().catch(() => '')).trim();
    if (/^\d{1,2}$/.test(t)) candidates.push(b);
  }
  log(`📅 Найдено ${candidates.length} кнопок-дней`);

  for (let i = 0; i < candidates.length; i++) {
    const btn = candidates[i];
    const label = await btn.innerText().catch(() => `День${i + 1}`);
    await btn.scrollIntoViewIfNeeded();
    await btn.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    const chips = await page.locator('text=/^\\d{1,2}:\\d{2}$/').all();
    const times = [];
    for (const c of chips) {
      const t = (await c.innerText().catch(() => '')).trim();
      if (/^\d{1,2}:\d{2}$/.test(t)) times.push(t.padStart(5, '0'));
    }
    if (times.length) result[label] = times;
  }

  return result;
}

// ---------- Главная функция ----------
async function main() {
  const start = Date.now();
  let proxy = null;
  if (PROXY_LIST) {
    const p = parseProxy(PROXY_LIST.split(/\r?\n/)[0]);
    if (p && (await testProxy(p))) proxy = p;
  }

  const { browser, proxyServer } = await launchBrowserWithProxy(proxy);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto(TARGET_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
    const data = await scrapeSlots(page);
    let msg = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
    if (Object.keys(data).length === 0) msg += '(ничего не найдено)\n';
    else {
      for (const [d, arr] of Object.entries(data)) {
        msg += `📅 ${d}\n${arr.join(', ')}\n\n`;
      }
    }
    msg += 'https://tennis.luzhniki.ru/#courts';
    await sendTelegram(msg);
    log('✅ Сообщение отправлено.');
  } catch (e) {
    log('❌ Ошибка:', e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    await browser.close();
    if (proxyServer && proxyServer.startsWith('http://127.0.0.1:'))
      await proxyChain.closeAnonymizedProxy(proxyServer, true);
    log('⏱ Время выполнения:', ((Date.now() - start) / 1000).toFixed(1) + 's');
  }
}

await main();
