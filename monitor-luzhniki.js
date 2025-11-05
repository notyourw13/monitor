// monitor-luzhniki.js
// --- Luzhniki Monitor — multi-proxy rotate + diff notifications (HTML) ---
import playwright from 'playwright';
import fetch from 'node-fetch';
import proxyChain from 'proxy-chain';
import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';
import fs from 'fs/promises';
import path from 'path';

const { chromium } = playwright;
const { HttpProxyAgent }  = httpProxyAgentPkg;
const { HttpsProxyAgent } = httpsProxyAgentPkg;
const { SocksProxyAgent } = socksProxyAgentPkg;

const TARGET_URL   = 'https://tennis.luzhniki.ru/';
const COURTS_URL   = 'https://tennis.luzhniki.ru/#courts';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
// TG_CHAT_ID can be single id or comma-separated list
const TG_CHAT_ID   = process.env.TG_CHAT_ID || '';
// PROXY_LIST env can override; otherwise default to the proxies you provided (SOCKS5)
const PROXY_LIST_ENV = (process.env.PROXY_LIST || '').trim();
// default proxies (you provided these) — we put HTTP or socks prefix if missing.
const DEFAULT_PROXIES = [
  'socks5://Darrli2299:serveDSo92@46.8.192.191:5501',
  'socks5://Darrli2299:serveDSo92@46.8.192.247:5501',
  'socks5://Darrli2299:serveDSo92@46.8.193.20:5501',
];
// If you also want to keep the working http one, you can add it here or via PROXY_LIST env
const PROXY_LIST = PROXY_LIST_ENV ? PROXY_LIST_ENV.split(/\r?\n/).map(s=>s.trim()).filter(Boolean) : DEFAULT_PROXIES;

const STATE_FILE = path.resolve('./last_state.json'); // persist previous scan here
const DEBUG = process.env.DEBUG === '1';

const SLOT_SEL =
  '[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],' +
  '[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]';

const log = (...a) => {
  if (DEBUG) console.log(new Date().toISOString(), ...a);
};

// ---------------- proxy helpers ----------------
function parseProxyLine(line) {
  if (!line) return null;
  const s = line.trim();
  if (!s) return null;
  // add scheme if missing? be conservative: if starts with digits:port -> http
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) return 'http://' + s;
  return s;
}

function buildFetchAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (proxyUrl.startsWith('https://')) return new HttpsProxyAgent(proxyUrl);
  if (proxyUrl.startsWith('http://'))  return new HttpProxyAgent(proxyUrl);
  if (proxyUrl.startsWith('socks5://')) return new SocksProxyAgent(proxyUrl);
  return undefined;
}

// ping proxy by fetching simple endpoint; choose http if proxy is http (avoid CONNECT)
async function testProxyReachable(u) {
  const agent = buildFetchAgent(u);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  const isHttp = u && u.startsWith('http://');
  const url = isHttp ? 'http://ifconfig.me/ip' : 'https://ifconfig.me/ip';
  try {
    const r = await fetch(url, { agent, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('status ' + r.status);
    const ip = (await r.text()).trim();
    if (!ip) throw new Error('empty ip');
    return ip;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// Launch Playwright chromium with proxy (support socks5 by anonymize via proxy-chain)
async function launchBrowserWithProxy(rawProxy) {
  let browserProxy = null;
  if (rawProxy) {
    if (rawProxy.startsWith('socks5://')) {
      // create local http bridge
      browserProxy = await proxyChain.anonymizeProxy(rawProxy);
    } else {
      browserProxy = rawProxy;
    }
  }
  const browser = await chromium.launch({
    headless: true,
    proxy: browserProxy ? { server: browserProxy } : undefined,
  });
  return { browser, browserProxy };
}

// close anonymized proxy bridge
async function closeBrowserProxy(browserProxy) {
  if (browserProxy && browserProxy.startsWith('http://127.0.0.1:')) {
    try { await proxyChain.closeAnonymizedProxy(browserProxy, true); } catch (e) {}
  }
}

// ---------------- telegram ----------------
async function sendTelegramHTML(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log('TG creds missing — would send:\n' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const ids = TG_CHAT_ID.split(',').map(s=>s.trim()).filter(Boolean);
  for (const id of ids) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: id,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(()=>'');
        log('Telegram error for', id, r.status, body);
      } else {
        log('Telegram sent to', id);
      }
    } catch (e) {
      log('Telegram exception for', id, e.message);
    }
  }
}

// ---------------- utils: state ----------------
async function loadLastState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {}; // no previous
  }
}
async function saveState(state) {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    // ignore
    log('Failed to write state:', e.message);
  }
}

// ---------------- scraping helpers (based on your last working logic) ----------------
const TIMES_RE = /\b(\d{1,2}):(\d{2})\b/;
const padTime = (h, m) => `${String(h).padStart(2,'0')}:${m}`;

async function ensureSlotsRendered(page) {
  await page.evaluate(()=>window.scrollTo({ top: 0 }));
  await page.waitForTimeout(120);
  const toggles = [page.locator('text=/^Утро$/i').first(), page.locator('text=/^Вечер$/i').first()];
  for (const sw of toggles) {
    if (await sw.isVisible().catch(()=>false)) {
      await sw.scrollIntoViewIfNeeded().catch(()=>{});
      await sw.click({ timeout: 400 }).catch(()=>{});
      await page.waitForTimeout(120);
    }
  }
  const containerSel = 'ul[class*="time-slot"], div[class*="time-slot"]';
  for (let i = 0; i < 4; i++) {
    if (await page.locator(containerSel).first().isVisible().catch(()=>false)) break;
    await page.waitForTimeout(800);
  }
  await page.evaluate(()=>window.scrollBy(0, window.innerHeight/3)).catch(()=>{});
  await page.waitForTimeout(500);
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

  // final nudge if empty
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

// find day buttons: similar logic - returns array of {label, btn}
async function findDayButtons(page) {
  const allBtns = page.locator('button');
  const cnt = await allBtns.count().catch(()=>0);
  const list = [];
  for (let i=0;i<cnt;i++) {
    const btn = allBtns.nth(i);
    const numDiv = btn.locator('div:nth-child(2)');
    if (!(await numDiv.count().catch(()=>0))) continue;
    const label = (await numDiv.innerText().catch(()=> '')).trim();
    if (!/^\d{1,2}$/.test(label)) continue;
    const disabled = (await btn.getAttribute('disabled').catch(()=>null)) !== null
                  || (await btn.getAttribute('aria-disabled').catch(()=>null)) === 'true';
    if (disabled) continue;
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

// click-through wizard to reach calendar
async function clickThroughWizard(page) {
  // banner
  const banner = page.locator('text=Аренда теннисных кортов').first();
  if (await banner.isVisible().catch(()=>false)) {
    await banner.click({ timeout: 20000 }).catch(()=>{});
    log('banner clicked');
    await page.waitForTimeout(300);
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const anyDay = page.locator('button div:nth-child(2)').filter({ hasText: /^\d{1,2}$/ }).first();
    if (await anyDay.isVisible().catch(()=>false)) break;

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
      log('clicked indoor card');
      await page.waitForTimeout(200);
    }

    const cont = page
      .locator('button:has-text("Продолжить"), [role="button"]:has-text("Продолжить"), text=/^Продолжить$/')
      .first();
    if (await cont.isVisible().catch(()=>false)) {
      await cont.click({ timeout: 5000 }).catch(()=>{});
      log('clicked continue');
      await page.waitForTimeout(400);
    }

    if (!(await anyDay.isVisible().catch(()=>false))) {
      await page.goto(COURTS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
      await page.waitForTimeout(400);
    } else {
      break;
    }
  }
  await page.waitForTimeout(250);
}

// ---------------- main scraping across days ----------------
async function scrapeAll(page) {
  await clickThroughWizard(page);
  const days = await findDayButtons(page);
  log('day candidates:', days.map(d=>d.label).join(','));
  const result = {};

  for (const d of days) {
    try {
      await d.btn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(()=>{});
      await d.btn.click({ timeout: 1200 }).catch(()=>{});

      // wait until selected updates (retries)
      for (let i=0;i<8;i++) {
        const sel = await getSelectedDayLabel(page);
        if (sel === d.label) break;
        if (i === 2) await d.btn.click({ timeout: 800, force: true }).catch(()=>{});
        if (i === 5) await d.btn.evaluate(el=>el.click()).catch(()=>{});
        await page.waitForTimeout(120);
      }
      const selectedFinal = await getSelectedDayLabel(page);
      if (selectedFinal !== d.label) {
        log('skip day (not selected):', d.label);
        continue;
      }

      await ensureSlotsRendered(page);
      await page.waitForTimeout(600);
      const times = await collectTimesCombined(page);
      if (times.length) result[d.label] = times;
      else await dump(page, `day-${d.label}`);
    } catch (e) {
      log('error collecting day', d.label, e.message);
    }
  }
  return result;
}

// ---------------- diff + format message ----------------
function getWeekdayAbbrevFromPage(pageMonthText, dayNumber) {
  // we don't have a direct reliable month/day->weekday mapping from site in headless easily.
  // We'll leave weekday empty unless the caller provides month/year. For now we'll compute using today's month/year.
  try {
    const d = new Date();
    // try to adjust to nearest dayNumber in current/next month - keep it simple:
    const candidate = new Date(d.getFullYear(), d.getMonth(), Number(dayNumber));
    if (candidate.getDate() === Number(dayNumber)) {
      return ['вс','пн','вт','ср','чт','пт','сб'][candidate.getDay()];
    }
  } catch (e) {}
  return '';
}

function formatDiffHTML(prevState, currState) {
  // prev/curr: { "11": ["07:00","22:00"], ... }
  // produce HTML message showing current state, with changes marked:
  // - present in prev & curr: plain
  // - present in prev & not in curr: <s>time</s>
  // - present in curr & not in prev: <u><b>time</b></u>

  const allDays = new Set([...Object.keys(prevState || {}), ...Object.keys(currState || {})].map(k=>String(k)));
  const sortedDays = Array.from(allDays).map(Number).filter(n=>!Number.isNaN(n)).sort((a,b)=>a-b).map(String);

  // If no prevState, just show curr plain
  const lines = ['🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ', ''];

  if (sortedDays.length === 0) {
    lines.push('(ничего не найдено)', '', COURTS_URL, '');
    return lines.join('\n');
  }

  for (const d of sortedDays) {
    const prev = (prevState && prevState[d]) ? prevState[d] : [];
    const curr = (currState && currState[d]) ? currState[d] : [];

    // If both empty - skip
    if (prev.length === 0 && curr.length === 0) continue;

    // weekday abbreviation
    const w = getWeekdayAbbrevFromPage('', d);
    const dayLabel = w ? `${d}, ${w}` : `${d}`;

    lines.push(`<b>📅 ${dayLabel}</b>`);

    // union of times
    const timesSet = new Set([...prev, ...curr]);
    const timesSorted = Array.from(timesSet).sort((a,b)=>a.localeCompare(b));

    if (timesSorted.length === 0) {
      lines.push('  (пусто)');
      lines.push('');
      continue;
    }

    const timePieces = timesSorted.map(t => {
      const inPrev = prev.includes(t);
      const inCurr = curr.includes(t);
      if (inPrev && inCurr) return `  ${t}`;
      if (inPrev && !inCurr) return `  <s>${t}</s>`;
      if (!inPrev && inCurr) return `  <u><b>${t}</b></u>`;
      return `  ${t}`;
    });

    for (const p of timePieces) lines.push(p);
    lines.push('');
  }

  lines.push(COURTS_URL);
  lines.push('');
  return lines.join('\n');
}

// ---------------- main ----------------
async function main() {
  const start = Date.now();

  // Normalize proxies
  const proxies = PROXY_LIST.map(parseProxyLine).filter(Boolean);

  // Try proxies in order: test them, keep results (ip/error)
  const probeResults = [];
  for (const p of proxies) {
    try {
      const ip = await testProxyReachable(p);
      probeResults.push({ proxy: p, ok: true, ip });
      // DON'T break here: we just want a map of reachable proxies — but we'll use first reachable for browser
    } catch (e) {
      probeResults.push({ proxy: p, ok: false, err: String(e.message || e) });
    }
  }

  // choose first reachable for browser; if none — will try without proxy
  const firstReachable = probeResults.find(r => r.ok);
  let chosenProxy = firstReachable ? firstReachable.proxy : null;

  // Also we'll attempt without proxy if none.
  let browser = null, browserProxyBridge = null, ctx = null, page = null;
  let scraped = {};
  let usedProxyDisplay = 'без прокси';
  try {
    const { browser: b, browserProxy } = await launchBrowserWithProxy(chosenProxy);
    browser = b;
    browserProxyBridge = browserProxy;
    ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    page = await ctx.newPage();

    // try open target; if fails and we had chosenProxy, try fallback: try other live proxies, then try without proxy
    try {
      log('Opening target with proxy bridge:', browserProxyBridge || '(none)');
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (errOpen) {
      log('Initial open failed:', String(errOpen.message || errOpen));
      // try other reachable proxies
      let opened = false;
      if (firstReachable) {
        // find other reachable proxies from probeResults
        for (const r of probeResults) {
          if (!r.ok) continue;
          if (r.proxy === chosenProxy) continue;
          log('Trying alternative proxy:', r.proxy);
          try {
            // close previous browser/context and reopen with new proxy
            try { await ctx.close(); } catch {}
            try { await browser.close(); } catch {}
            await closeBrowserProxy(browserProxyBridge);
          } catch (e) {}
          const { browser: b2, browserProxy: bp2 } = await launchBrowserWithProxy(r.proxy);
          browser = b2;
          browserProxyBridge = bp2;
          ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
          page = await ctx.newPage();
          try {
            await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            chosenProxy = r.proxy;
            opened = true;
            break;
          } catch (e2) {
            log('Still failed with', r.proxy, String(e2.message || e2));
            continue;
          }
        }
      }

      // try without proxy
      if (!opened) {
        log('Trying without proxy as last resort');
        try {
          try { await ctx.close(); } catch {}
          try { await browser.close(); } catch {}
          await closeBrowserProxy(browserProxyBridge);
        } catch (e) {}
        const { browser: b3 } = await launchBrowserWithProxy(null);
        browser = b3;
        browserProxyBridge = null;
        ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
        page = await ctx.newPage();
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        chosenProxy = null;
      }
    }

    usedProxyDisplay = chosenProxy ? chosenProxy : 'без прокси';

    // if page loaded — proceed to scrape
    scraped = await scrapeAll(page);

    // prepare message diff vs previous
    const prev = await loadLastState();
    const msgHtml = formatDiffHTML(prev, scraped);

    // include proxy summary and summary footer
    let proxySummary = '<b>Прокси:</b> ' + (chosenProxy ? chosenProxy : 'без прокси') + '\n\n';
    // Also include probe results (short)
    proxySummary += '<i>Проверка прокси:</i>\n';
    for (const pr of probeResults) {
      proxySummary += pr.ok ? `✔ ${pr.proxy} (${pr.ip})\n` : `✖ ${pr.proxy} (${pr.err || 'error'})\n`;
    }

    const finalMessage = `${msgHtml}\n\n${proxySummary}`;

    // Only send when there are changes vs prev; if no prev (first run) send full
    const prevJSON = JSON.stringify(prev || {});
    const currJSON = JSON.stringify(scraped || {});
    const changed = prevJSON !== currJSON;

    if (changed) {
      await sendTelegramHTML(finalMessage);
      await saveState(scraped);
    } else {
      // nothing changed — optionally send a "heartbeat" minimal message? For now we DON'T send full message.
      log('No changes since last run — not sending full message.');
      // but still send a short info (optional). We'll send nothing to reduce spam.
    }

    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
    await closeBrowserProxy(browserProxyBridge);
    log('Finished normally');
  } catch (err) {
    // On fatal errors — send error report with proxy probe results
    const probeLines = probeResults.map(pr => pr.ok ? `✔ ${pr.proxy} (${pr.ip})` : `✖ ${pr.proxy} (${pr.err || 'error'})`).join('\n');
    const errText = `⚠️ Лужники монитор упал\n${String(err && err.message ? err.message : err)}\n\nПроверка прокси:\n${probeLines}\n\nПрокси использовался: ${chosenProxy ? chosenProxy : 'без успешного подключения'}\n\nCall log: (см. логи Actions для трассы)\n`;
    await sendTelegramHTML(`<b>⚠️ Лужники монитор упал</b>\n\n<pre>${escapeHtml(String(err && err.stack ? err.stack : err))}</pre>\n\n<pre>${escapeHtml(probeLines)}</pre>`);
    try { await ctx?.close().catch(()=>{}); } catch(e){}
    try { await browser?.close().catch(()=>{}); } catch(e){}
    try { await closeBrowserProxy(browserProxyBridge); } catch(e){}
    // rethrow to make job fail if necessary
    throw err;
  } finally {
    log('Total time:', ((Date.now() - start)/1000).toFixed(1)+'s');
  }
}

// ---------------- helpers ----------------
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// run
await main();
