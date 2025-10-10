// --- Luzhniki Monitor — robust multi-day scrape (skip disabled + verify selection + solid slots render) ---
import playwright from 'playwright';
import fetch from 'node-fetch';
import proxyChain from 'proxy-chain';
import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';
import fs from 'fs/promises';

const { chromium } = playwright;
const { HttpProxyAgent }  = httpProxyAgentPkg;
const { HttpsProxyAgent } = httpsProxyAgentPkg;
const { SocksProxyAgent } = socksProxyAgentPkg;

const TARGET_URL   = 'https://tennis.luzhniki.ru/';
const COURTS_URL   = 'https://tennis.luzhniki.ru/#courts';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_LIST   = (process.env.PROXY_LIST || '').trim();

const SLOT_SEL =
  '[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
  '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- proxy ----------
function parseProxyLine(line) {
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('socks5://')) return s;
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) return 'http://' + s;
  return s;
}
function buildFetchAgent(u) {
  if (!u) return undefined;
  if (u.startsWith('https://')) return new HttpsProxyAgent(u);
  if (u.startsWith('http://'))  return new HttpProxyAgent(u);
  if (u.startsWith('socks5://')) return new SocksProxyAgent(u);
  return undefined;
}
async function testProxyReachable(u) {
  const agent = buildFetchAgent(u);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://ifconfig.me/all.json', { agent, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    return j.ip_addr || 'ok';
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ---------- telegram ----------
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('TG creds missing; printing:\n' + text);
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error('Telegram ' + r.status + ' ' + (await r.text().catch(()=>'')));
}

// ---------- artifacts ----------
async function dump(page, tag) {
  try {
    await fs.writeFile(`art-${tag}.html`, await page.content(), 'utf8');
    await page.screenshot({ path: `art-${tag}.png`, fullPage: true });
  } catch {}
}

// ---------- browser ----------
async function launchBrowserWithProxy(raw) {
  let server = null;
  if (raw) server = raw.startsWith('socks5://') ? await proxyChain.anonymizeProxy(raw) : raw;
  const browser = await chromium.launch({ headless: true, proxy: server ? { server } : undefined });
  return { browser, server };
}

// ---------- wizard (robust) ----------
async function clickThroughWizard(page) {
  // Баннер (если виден)
  const banner = page.locator('text=Аренда теннисных кортов').first();
  if (await banner.isVisible().catch(()=>false)) {
    await banner.click({ timeout: 20000 }).catch(()=>{});
    log('✅ Баннер');
    await page.waitForTimeout(300);
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    // Уже календарь?
    const anyDay = page.locator('button div:nth-child(2)').filter({ hasText: /^\d{1,2}$/ }).first();
    if (await anyDay.isVisible().catch(()=>false)) {
      log('➡️ Уже на экране календаря');
      break;
    }

    // Карточка «Крытые»
    const indoorByText = page.locator('text=/Аренда\\s+крытых\\s+кортов/i').first();
    const indoorCard =
      (await indoorByText.isVisible().catch(()=>false)) ? indoorByText :
      page.locator('[class*="card"], [role="group"], [role="button"]').filter({ hasText: /Крыт/i }).first();

    if (await indoorCard.isVisible().catch(()=>false)) {
      const plus = indoorCard.locator('xpath=ancestor::*[self::div or self::section][1]//button[contains(.,"+")]').first();
      if (await plus.isVisible().catch(()=>false)) {
        await plus.click({ timeout: 2000 }).catch(()=>{});
      } else {
        await indoorCard.click({ timeout: 3000 }).catch(()=>{});
      }
      log('✅ Крытые');
      await page.waitForTimeout(200);
    }

    // «Продолжить»
    const cont = page
      .locator('button:has-text("Продолжить"), [role="button"]:has-text("Продолжить"), text=/^Продолжить$/')
      .first();
    if (await cont.isVisible().catch(()=>false)) {
      await cont.click({ timeout: 5000 }).catch(()=>{});
      log('✅ Продолжить');
      await page.waitForTimeout(400);
    }

    // Фоллбек в /#courts
    if (!(await anyDay.isVisible().catch(()=>false))) {
      await page.goto(COURTS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
      await page.waitForTimeout(400);
    } else {
      break;
    }
  }
  await page.waitForTimeout(250);
}

// ---------- days ----------
async function findDayButtons(page) {
  // собираем только видимые и НЕ отключённые кнопки
  const allBtns = page.locator('button');
  const cnt = await allBtns.count().catch(()=>0);
  const list = [];
  for (let i=0;i<cnt;i++) {
    const btn = allBtns.nth(i);
    // день — это кнопка, у которой второй див — число
    const numDiv = btn.locator('div:nth-child(2)');
    if (!(await numDiv.count().catch(()=>0))) continue;
    const label = (await numDiv.innerText().catch(()=> '')).trim();
    if (!/^\d{1,2}$/.test(label)) continue;

    // фильтр отключённых
    const disabled = (await btn.getAttribute('disabled').catch(()=>null)) !== null
                  || (await btn.getAttribute('aria-disabled').catch(()=>null)) === 'true';
    if (disabled) continue;

    // видимость/возможность кликнуть
    if (!(await btn.isVisible().catch(()=>false)) || !(await btn.isEnabled().catch(()=>false))) continue;

    const bb = await btn.boundingBox().catch(()=>null);
    if (!bb) continue;

    list.push({ label, btn, x: bb.x });
  }
  list.sort((a,b)=>a.x-b.x);
  return list;
}

async function getSelectedDayLabel(page) {
  const sel = page.locator('button[class*="Selected"] div:nth-child(2)').first();
  const t = (await sel.innerText().catch(()=> '')).trim();
  return /^\d{1,2}$/.test(t) ? t : '';
}

// ---------- slots (methods 1+4+5+7 объединённо) ----------
const TIMES_RE = /\b(\d{1,2}):(\d{2})\b/;
const padTime = (h, m) => `${String(h).padStart(2,'0')}:${m}`;

async function ensureSlotsRendered(page) {
  // прокрутка к секциям и легкий “шевелёж”
  await page.evaluate(()=>window.scrollTo({ top: 0 }));
  await page.waitForTimeout(120);
  const morning = page.locator('text=/^Утро$/i').first();
  const evening = page.locator('text=/^Вечер$/i').first();
  for (const sw of [morning, evening, morning]) {
    if (await sw.isVisible().catch(()=>false)) {
      await sw.scrollIntoViewIfNeeded().catch(()=>{});
      await sw.click({ timeout: 300 }).catch(()=>{});
      await page.waitForTimeout(90);
    }
  }
  // дождаться появления хотя бы одного “слота” или текста HH:MM
  await page.waitForSelector(`${SLOT_SEL}, text=/\\b\\d{1,2}:\\d{2}\\b/`, { timeout: 2000 }).catch(()=>{});
  await page.waitForTimeout(120);
}

async function collectTimesCombined(page) {
  const out = new Set();

  // 1) SLOT_SEL
  {
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // 4) ul:nth-child(2/4)+slot
  {
    for (const sel of ['ul:nth-child(2) '+SLOT_SEL, 'ul:nth-child(4) '+SLOT_SEL]) {
      const els = await page.locator(sel).all().catch(()=>[]);
      for (const el of els) {
        const t = (await el.innerText().catch(()=> '')).trim();
        const m = t.match(TIMES_RE);
        if (m) out.add(padTime(m[1], m[2]));
      }
    }
  }

  // 5) locator.filter(hasText)
  {
    const els = await page.locator(SLOT_SEL).filter({ hasText: /:\d{2}/ }).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // 7) slotDesktopWidth
  {
    const els = await page.locator('[class*="slotDesktopWidth"]').all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  // лёгкий нудж, если 0
  if (out.size === 0) {
    await page.evaluate(()=>window.scrollBy(0, Math.round(window.innerHeight*0.4))).catch(()=>{});
    await page.waitForTimeout(150);
    const els = await page.locator(SLOT_SEL).all().catch(()=>[]);
    for (const el of els) {
      const t = (await el.innerText().catch(()=> '')).trim();
      const m = t.match(TIMES_RE);
      if (m) out.add(padTime(m[1], m[2]));
    }
  }

  return Array.from(out).sort((a,b)=>a.localeCompare(b));
}

// ---------- scrape ----------
async function scrapeAll(page) {
  await clickThroughWizard(page);

  const days = await findDayButtons(page);
  log('📅 Дни (кликабельные):', days.map(d=>d.label).join(', '));

  const result = {};
  for (const d of days) {
    // центрируем и кликаем
    await d.btn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(()=>{});
    await d.btn.click({ timeout: 1200 }).catch(()=>{});
    // если не выделился — ещё раз через JS-Click
    for (let i=0; i<8; i++) {
      const selected = await getSelectedDayLabel(page);
      if (selected === d.label) break;
      if (i === 2) await d.btn.click({ timeout: 800, force: true }).catch(()=>{});
      if (i === 5) await d.btn.evaluate(el => el.click()).catch(()=>{});
      await page.waitForTimeout(120);
    }

    // финальная проверка: если день так и не выделился — ПРОПУСК
    const selectedFinal = await getSelectedDayLabel(page);
    if (selectedFinal !== d.label) {
      log(`↷ Пропускаем день ${d.label} — не выделился`);
      continue;
    }

    // гарантируем отрисовку секций и слотов
    await ensureSlotsRendered(page);

    const times = await collectTimesCombined(page);
    if (times.length) {
      result[d.label] = times;
    } else {
      await dump(page, `day-${d.label}`); // снимки для отладки точечно
    }
  }

  return result;
}

// ---------- main ----------
async function main() {
  const start = Date.now();

  let chosen = null;
  if (PROXY_LIST) {
    for (const p of PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean)) {
      try { await testProxyReachable(p); chosen = p; break; } catch {}
    }
  }

  const { browser, server } = await launchBrowserWithProxy(chosen);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  const page = await ctx.newPage();

  log('🌐 Открываем сайт:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  let all = {};
  try {
    all = await scrapeAll(page);
  } catch (e) {
    await dump(page, 'fatal');
    throw e;
  }

  // форматируем сообщение
  let text = '🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
  const keys = Object.keys(all).sort((a,b)=>(+a)-(+b));
  if (!keys.length) {
    text += '(ничего не найдено)\n\n';
  } else {
    for (const k of keys) {
      text += `📅 ${k}\n  ${all[k].join(', ')}\n\n`;
    }
  }
  text += COURTS_URL;

  await sendTelegram(text);
  log('✅ Сообщение отправлено.');

  await ctx.close();
  await browser.close();
  if (server?.startsWith('http://127.0.0.1:')) {
    try { await proxyChain.closeAnonymizedProxy(server, true); } catch {}
  }
  log('⏱ Время выполнения:', ((Date.now() - start) / 1000).toFixed(1) + 's');
}

await main();
