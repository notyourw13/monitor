// --- Luzhniki monitor (proxy-chain + fallback current day) ---
import fs from 'fs';
import { chromium } from 'playwright';
import proxyChain from 'proxy-chain';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';

// ===== ENV =====
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_URL    = (process.env.PROXY_URL || '').trim();
const PROXY_LIST   = (process.env.PROXY_LIST || '').split(/[\n, ]+/).map(s=>s.trim()).filter(Boolean);
const URL          = 'https://tennis.luzhniki.ru/#courts';

const LOGFILE = `run-${Date.now()}.log`;
function log(...a){ const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); try{ fs.appendFileSync(LOGFILE, line+'\n'); }catch{} }

// ===== TELEGRAM =====
async function sendTelegram(text){
  if(!TG_BOT_TOKEN || !TG_CHAT_ID){ log('TG creds missing; skip'); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview:true })
  });
  if(!r.ok){ const b = await r.text().catch(()=> ''); log('TG error', r.status, b); }
}

// ===== PROXY via proxy-chain (SOCKS5 auth -> HTTP bridge) =====
function pickProxy(){ return PROXY_URL || PROXY_LIST[0] || ''; }

async function testSocks(socksUrl){
  const agent = new SocksProxyAgent(socksUrl);
  try{
    const r1 = await fetch('https://ifconfig.me/ip', { agent, timeout: 8000 });
    if(r1.ok) return (await r1.text()).trim();
  }catch{}
  const r2 = await fetch('https://api.ipify.org', { agent, timeout: 8000 });
  if(!r2.ok) throw new Error('status '+r2.status);
  return (await r2.text()).trim();
}

async function prepareBridge(){
  const raw = pickProxy();
  if(!raw) return { server: '', close: async()=>{} };

  if(/^socks5:/i.test(raw)){
    log('SOCKS5 upstream:', raw.replace(/\/\/[^@]+@/,'//***:***@'));
    const ip = await testSocks(raw);
    log('SOCKS5 OK, IP:', ip);
    const http = await proxyChain.anonymizeProxy(raw); // -> http://127.0.0.1:XXXXX
    log('HTTP bridge:', http);
    return { server: http, close: ()=> proxyChain.closeAnonymizedProxy(http, true) };
  }

  if(/^https?:\/\//i.test(raw)){
    log('HTTP(S) proxy:', raw.replace(/\/\/[^@]+@/,'//***:***@'));
    return { server: raw, close: async()=>{} };
  }

  log('Unknown proxy format, ignoring');
  return { server:'', close: async()=>{} };
}

// ===== ARTIFACTS =====
async function dumpArtifacts(page, tag='snap'){
  try{ await page.waitForTimeout(200); }catch{}
  try{ await page.screenshot({ path:`art-${tag}.png`, fullPage:true }); }catch{}
  try{ const html = await page.content(); await fs.promises.writeFile(`art-${tag}.html`, html); }catch{}
}

function moscowTodayISO(){
  const now = new Date(new Date().toLocaleString('en-US', { timeZone:'Europe/Moscow' }));
  return now.toISOString().slice(0,10);
}

// ===== UI HELPERS =====
async function clickCovered(page){
  const sels = [
    'xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]//button',
    'xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]',
    'xpath=//button[contains(normalize-space(.),"+")]'
  ];
  for(const s of sels){
    const loc = page.locator(s).first();
    if(await loc.isVisible().catch(()=>false)){ await loc.click({timeout:4000}).catch(()=>{}); return true; }
  }
  return false;
}
async function clickContinue(page){
  const btn = page.locator('xpath=//button[contains(normalize-space(.),"Продолжить")]').first();
  if(await btn.isVisible().catch(()=>false)){ await btn.click({timeout:4000}).catch(()=>{}); return true; }
  return false;
}
async function findCalendarRoot(page){
  const sels = [
    'xpath=//*[contains(@class,"calendar")]',
    'xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]/ancestor::*[self::section or self::div][1]',
    'xpath=//main','xpath=//*'
  ];
  for(const s of sels){ const l = page.locator(s).first(); if(await l.isVisible().catch(()=>false)) return l; }
  return page.locator('xpath=//*').first();
}
async function getDayButtons(root){
  const nodes = await root.locator('xpath=.//*[self::button or @role="button"]').all();
  const out = [];
  for(const n of nodes){
    const t = (await n.innerText().catch(()=> '')).trim();
    if(/^\d{1,2}$/.test(t)) out.push(n);
  }
  return out;
}
async function collectTimesFromPage(page){
  // ищем в секциях с заголовками «Утро/Вечер», чтобы не собирать мусор
  const sections = await page.locator('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]/ancestor::*[self::section or self::div][1]').all();
  const acc = new Set();
  for(const s of sections){
    const list = await s.evaluate(el =>
      Array.from(el.querySelectorAll('*'))
        .map(n => (n.textContent||'').trim())
        .filter(t => /^\d{1,2}:\d{2}$/.test(t))
    ).catch(()=>[]);
    for(const t of list){
      const m = t.match(/^(\d{1,2}):(\d{2})$/);
      acc.add(m ? `${String(m[1]).padStart(2,'0')}:${m[2]}` : t);
    }
  }
  // если секций нет, пробуем по всей странице
  if(!acc.size){
    const all = await page.$$eval('*', ns => Array.from(ns).map(n => (n.textContent||'').trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t))).catch(()=>[]);
    for(const t of all){
      const m = t.match(/^(\d{1,2}):(\d{2})$/);
      acc.add(m ? `${String(m[1]).padStart(2,'0')}:${m[2]}` : t);
    }
  }
  return Array.from(acc).sort();
}

// ===== SCRAPE =====
async function scrapeWizard(page){
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });

  const ok1 = await clickCovered(page);
  if(!ok1) throw new Error('Не нашли карточку «Аренда крытых кортов»');

  await page.waitForTimeout(300);
  const ok2 = await clickContinue(page);
  if(!ok2) log('Кнопка «Продолжить» не найдена (возможно, шаг объединён)');

  await page.waitForTimeout(800);
  await page.waitForSelector('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]', { timeout: 30_000 }).catch(()=>{});

  const root = await findCalendarRoot(page);
  let days = await getDayButtons(root);
  if(!days.length) days = await getDayButtons(page.locator('xpath=//*'));
  log('Найдено кнопок-дней:', days.length);

  const iso = moscowTodayISO();
  const results = [];

  if(!days.length){
    const times = await collectTimesFromPage(page);
    log(`Текущий день: слотов ${times.length}`);
    if(!times.length) await dumpArtifacts(page, 'no-days');
    results.push({ date: iso, times });
    return results;
  }

  for(let i=0;i<Math.min(days.length,14);i++){
    const btn = days[i];
    const label = (await btn.innerText().catch(()=> '')).trim();
    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    await btn.click({ timeout: 5000 }).catch(()=>{});
    await page.waitForTimeout(400);
    const times = await collectTimesFromPage(page);
    log(`День ${label || i+1}: слотов ${times.length}`);
    if(!times.length) await dumpArtifacts(page, `day-${String(label || i+1).padStart(2,'0')}`);
    results.push({ date: iso, times });
  }

  // агрегируем по дате
  const by = new Map();
  for(const r of results){
    if(!by.has(r.date)) by.set(r.date, new Set());
    r.times.forEach(t => by.get(r.date).add(t));
  }
  return Array.from(by.entries()).map(([date,set])=>({ date, times: Array.from(set).sort() }));
}

function formatMessage(rows){
  if(!rows?.length || rows.every(r => !r.times?.length))
    return `ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n(ничего не найдено)\n\n${URL}`;
  let out = 'ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n';
  for(const r of rows){
    out += `\n${r.date}:\n`;
    for(const t of r.times) out += `  ${t}\n`;
  }
  out += `\n${URL}`;
  return out;
}

// ===== MAIN =====
(async () => {
  let bridge, browser, context;
  const start = Date.now();
  try{
    bridge = await prepareBridge();

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'],
      proxy: bridge.server ? { server: bridge.server } : undefined,
      timeout: 120_000
    });

    context = await browser.newContext({
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    });

    const page = await context.newPage();
    page.on('console', m => log('[page]', m.type(), m.text()));

    // goto с ретраями
    for(let i=1;i<=3;i++){
      try{
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        break;
      }catch(e){
        log(`[goto retry ${i}]`, e.message);
        if(i===3) throw e;
        await page.waitForTimeout(4000);
      }
    }

    const rows = await scrapeWizard(page);
    log('Итого:', JSON.stringify(rows));
    const msg = formatMessage(rows);
    await sendTelegram(msg);
  }catch(e){
    log('Ошибка:', e.message || e);
    try{
      const p = context?.pages?.()[0];
      if(p) await dumpArtifacts(p, 'error');
    }catch{}
    process.exitCode = 1;
  }finally{
    try{ await context?.close(); }catch{}
    try{ await browser?.close(); }catch{}
    try{ await bridge?.close?.(); }catch{}
    log('Время выполнения:', Math.round((Date.now()-start)/1000)+'s');
  }
})();
