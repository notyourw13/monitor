// --- Luzhniki monitor: надёжные клики (баннер → крытые → Продолжить) + proxy-chain ---
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
const HOME_URL     = 'https://tennis.luzhniki.ru/';
const COURTS_URL   = 'https://tennis.luzhniki.ru/#courts';

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

// ===== PROXY via proxy-chain =====
function pickProxy(){ return PROXY_URL || PROXY_LIST[0] || ''; }

async function testSocks(socksUrl){
  const agent = new SocksProxyAgent(socksUrl);
  const res = await fetch('https://api.ipify.org', { agent, timeout: 8000 });
  return (await res.text()).trim();
}

async function prepareBridge(){
  const raw = pickProxy();
  if(!raw) return { server: '', close: async()=>{} };

  if(/^socks5:/i.test(raw)){
    log('SOCKS5 upstream:', raw.replace(/\/\/[^@]+@/,'//***:***@'));
    const ip = await testSocks(raw);
    log('SOCKS5 OK, IP:', ip);
    const http = await proxyChain.anonymizeProxy(raw);
    log('HTTP bridge:', http);
    return { server: http, close: ()=> proxyChain.closeAnonymizedProxy(http, true) };
  }

  if(/^https?:\/\//i.test(raw)){
    log('HTTP(S) proxy:', raw.replace(/\/\/[^@]+@/,'//***:***@'));
    return { server: raw, close: async()=>{} };
  }

  return { server:'', close: async()=>{} };
}

// ===== ARTIFACTS =====
async function snap(page, tag){
  try{ await page.screenshot({ path:`art-${tag}.png`, fullPage:true }); }catch{}
  try{ const html = await page.content(); await fs.promises.writeFile(`art-${tag}.html`, html); }catch{}
}
async function dumpOnError(page, tag){ try{ await page.waitForTimeout(200); await snap(page, tag); }catch{} }

function moscowTodayISO(){
  const now = new Date(new Date().toLocaleString('en-US', { timeZone:'Europe/Moscow' }));
  return now.toISOString().slice(0,10);
}

// ===== NAV HELPERS =====
async function acceptCookies(page){
  const sels = [
    'xpath=//button[contains(translate(normalize-space(.),"ПРИНЯТЬ","принять"),"принять")]',
    'xpath=//button[contains(translate(normalize-space(.),"СОГЛАСЕН","согласен"),"согласен")]',
    'xpath=//button[contains(translate(normalize-space(.),"OK","ok"),"ok")]'
  ];
  for(const s of sels){
    const b = page.locator(s).first();
    if(await b.isVisible().catch(()=>false)){ await b.click().catch(()=>{}); await page.waitForTimeout(200); break; }
  }
}

async function ensureOnCourts(page) {
  // если мы на главной — кликаем баннер «Аренда теннисных кортов», иначе идём напрямую
  if (!/\/courts/i.test(page.url())) {
    const btn = page.locator('xpath=//*[contains(normalize-space(.),"Аренда теннисных кортов")]').first();
    if (await btn.isVisible().catch(() => false)) {
      log('Нашли баннер «Аренда теннисных кортов», кликаем');
      await btn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    if (!/\/courts/i.test(page.url())) {
      log('Переходим напрямую на /#courts');
      await page.goto(COURTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }
  await acceptCookies(page);
  await snap(page,'after-courts-open');
}

// ——— поиск карточки «Аренда крытых кортов» (в модалке/оверлее) ———
async function openCovered(page){
  // 1) ждём появление окна-выбора
  await page.waitForTimeout(400);
  // кандидаты на «крытые»
  const candidates = [
    // явные кнопки
    'xpath=//button[contains(translate(normalize-space(.),"КРЫТ","крт"),"к")]',
    // кликабельные блоки/плитки
    'xpath=//*[self::button or @role="button" or self::a or self::div][contains(translate(normalize-space(.),"КРЫТ","крт"),"к")]',
    // текстовая карточка
    'xpath=//*[contains(normalize-space(.),"Аренда") and contains(translate(normalize-space(.),"КРЫТ","крт"),"к")]'
  ];
  for(const s of candidates){
    const loc = page.locator(s).first();
    if(await loc.isVisible().catch(()=>false)){
      await loc.scrollIntoViewIfNeeded().catch(()=>{});
      await loc.click({ timeout: 4000 }).catch(()=>{});
      await page.waitForTimeout(250);
      await snap(page,'after-covered-click');
      return true;
    }
  }
  return false;
}

async function clickContinue(page){
  // иногда это <button>, иногда это ссылка-стилизованная кнопка
  const btn = page.locator(
    'xpath=//*[self::button or self::a][contains(normalize-space(.),"Продолжить")]'
  ).first();

  // подождём до 10с — контент грузится лениво
  for(let i=0;i<20;i++){
    if(await btn.isVisible().catch(()=>false)) break;
    await page.waitForTimeout(500);
  }

  if(await btn.isVisible().catch(()=>false)){
    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    await btn.click({ timeout: 4000 }).catch(()=>{});
    await page.waitForTimeout(400);
    await snap(page,'after-continue-click');
    return true;
  }
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
  const sections = await page.locator('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]/ancestor::*[self::section or self::div][1]').all();
  const acc = new Set();
  for(const s of sections){
    const list = await s.evaluate(el =>
      Array.from(el.querySelectorAll('*'))
        .map(n => (n.textContent||'').trim())
        .filter(t => /^\d{1,2}:\d{2}$/.test(t))
    ).catch(()=>[]);
    list.forEach(t=>{
      const m=t.match(/^(\d{1,2}):(\d{2})$/);
      acc.add(m?`${String(m[1]).padStart(2,'0')}:${m[2]}`:t);
    });
  }
  if(!acc.size){
    const all = await page.$$eval('*', ns => Array.from(ns).map(n => (n.textContent||'').trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t))).catch(()=>[]);
    all.forEach(t=>{
      const m=t.match(/^(\d{1,2}):(\d{2})$/);
      acc.add(m?`${String(m[1]).padStart(2,'0')}:${m[2]}`:t);
    });
  }
  return Array.from(acc).sort();
}

// ===== SCRAPE =====
async function scrapeWizard(page){
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
  await ensureOnCourts(page);

  // 1) кликаем «крытые»
  const hasCovered = await openCovered(page);
  if(!hasCovered){
    await dumpOnError(page,'no-covered');
    throw new Error('Не нашли карточку «Аренда крытых кортов»');
  }

  // 2) жмём «Продолжить» (если есть)
  const ok2 = await clickContinue(page);
  if(!ok2) log('Кнопка «Продолжить» не найдена (возможно, шаг объединён)');

  // 3) ждём, пока появится расписание/слоты
  await page.waitForTimeout(800);
  await page.waitForSelector('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]', { timeout: 20_000 }).catch(()=>{});
  await snap(page,'after-wizard');

  const root = await findCalendarRoot(page);
  let days = await getDayButtons(root);
  if(!days.length) days = await getDayButtons(page.locator('xpath=//*'));
  log('Найдено кнопок-дней:', days.length);

  const iso = moscowTodayISO();
  const results = [];

  if(!days.length){
    const times = await collectTimesFromPage(page);
    log(`Текущий день: слотов ${times.length}`);
    if(!times.length) await dumpOnError(page, 'no-days');
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
    if(!times.length) await dumpOnError(page, `day-${String(label || i+1).padStart(2,'0')}`);
    results.push({ date: iso, times });
  }

  const by = new Map();
  for(const r of results){
    if(!by.has(r.date)) by.set(r.date, new Set());
    r.times.forEach(t => by.get(r.date).add(t));
  }
  return Array.from(by.entries()).map(([date,set])=>({ date, times: Array.from(set).sort() }));
}

function formatMessage(rows){
  if(!rows?.length || rows.every(r => !r.times?.length))
    return `ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n(ничего не найдено)\n\n${COURTS_URL}`;
  let out = 'ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n';
  for(const r of rows){
    out += `\n${r.date}:\n`;
    for(const t of r.times) out += `  ${t}\n`;
  }
  out += `\n${COURTS_URL}`;
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
      args: ['--no-sandbox','--disable-dev-shm-usage'],
      proxy: bridge.server ? { server: bridge.server } : undefined
    });
    context = await browser.newContext({ locale:'ru-RU', timezoneId:'Europe/Moscow' });
    const page = await context.newPage();

    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const rows = await scrapeWizard(page);
    const msg = formatMessage(rows);
    await sendTelegram(msg);
  }catch(e){
    log('Ошибка:', e.message || e);
    try{ const p = context?.pages?.()[0]; if(p) await dumpOnError(p, 'error'); }catch{}
    process.exitCode = 1;
  }finally{
    try{ await context?.close(); }catch{}
    try{ await browser?.close(); }catch{}
    try{ await bridge?.close?.(); }catch{}
    log('Время выполнения:', Math.round((Date.now()-start)/1000)+'s');
  }
})();
