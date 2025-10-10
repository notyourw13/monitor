// --- Luzhniki Monitor (clickable days only + robust times) ---
import playwright from 'playwright';
import fetch from 'node-fetch';
import proxyChain from 'proxy-chain';
import httpProxyAgentPkg from 'http-proxy-agent';
import httpsProxyAgentPkg from 'https-proxy-agent';
import socksProxyAgentPkg from 'socks-proxy-agent';

const { chromium } = playwright;
const { HttpProxyAgent }  = httpProxyAgentPkg;
const { HttpsProxyAgent } = httpsProxyAgentPkg;
const { SocksProxyAgent } = socksProxyAgentPkg;

const TARGET_URL   = 'https://tennis.luzhniki.ru/';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || '';
const PROXY_LIST   = (process.env.PROXY_LIST || '').trim();

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- proxy ----------
function parseProxyLine(line){const s=line.trim();if(!s)return null;if(s.startsWith('http://')||s.startsWith('https://')||s.startsWith('socks5://'))return s;if(/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s))return'http://'+s;return s;}
function buildFetchAgent(u){if(!u)return; if(u.startsWith('https://'))return new HttpsProxyAgent(u); if(u.startsWith('http://'))return new HttpProxyAgent(u); if(u.startsWith('socks5://'))return new SocksProxyAgent(u);}
async function testProxyReachable(u){const agent=buildFetchAgent(u);const c=new AbortController();const t=setTimeout(()=>c.abort(),6000);try{const r=await fetch('https://ifconfig.me/all.json',{agent,signal:c.signal});clearTimeout(t);if(!r.ok)throw new Error('status '+r.status);const j=await r.json();return j.ip_addr||'ok';}catch(e){clearTimeout(t);throw e;}}

// ---------- telegram ----------
async function sendTelegram(text){
  if(!TG_BOT_TOKEN||!TG_CHAT_ID){log('TG creds missing; printing message:\n'+text);return;}
  const r=await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:TG_CHAT_ID,text,disable_web_page_preview:true})
  });
  if(!r.ok){throw new Error('Telegram '+r.status+' '+await r.text().catch(()=>''));}
}

// ---------- browser ----------
async function launchBrowserWithProxy(raw){
  let server=null;
  if(raw) server = raw.startsWith('socks5://') ? await proxyChain.anonymizeProxy(raw) : raw;
  const browser = await chromium.launch({ headless:true, proxy: server?{server}:undefined });
  return { browser, server };
}

// ---------- helpers ----------
async function clickThroughWizard(page){
  // баннер
  await page.locator('text=Аренда теннисных кортов').first().click({ timeout:20000 });
  log('✅ Баннер');
  // «Крытые»
  await page.locator('text=Аренда крытых кортов').first().click({ timeout:20000 });
  log('✅ Крытые');
  // «Продолжить»
  const cont = page.locator('button:has-text("Продолжить")').first();
  if(await cont.isVisible().catch(()=>false)) await cont.click({ timeout:5000 });
  else await page.locator('text=Продолжить').first().click({ timeout:5000 }).catch(()=>{});
  log('✅ Продолжить');
  await page.waitForTimeout(700);
}

// тест на кликабельность: видимая, не disabled, и Playwright может «trial-кликнуть»
async function isClickableDay(btn){
  try{
    const txt=(await btn.innerText()).trim();
    if(!/^\d{1,2}$/.test(txt)) return false;
    if(!(await btn.isVisible())) return false;
    if(await btn.isDisabled().catch(()=>false)) return false;
    await btn.click({ trial:true, timeout:150 }); // без реального клика
    return true;
  }catch{ return false; }
}

// собрать времена (через явные ul 2/4 + общий поиск HH:MM)
async function collectTimes(page){
  await page.waitForTimeout(150);
  await page.evaluate(()=>window.scrollBy(0,Math.round(window.innerHeight*0.4)));
  // дождёмся появления хотя бы одного HH:MM
  await page.waitForFunction(()=>{
    const re=/^\s*\d{1,2}:\d{2}\s*$/;
    const q=(root)=>!!root&&!!Array.from(root.querySelectorAll('[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]')).find(el=>re.test((el.textContent||'').trim()));
    return q(document.querySelector('ul:nth-child(2)'))||q(document.querySelector('ul:nth-child(4)'))||re.test(document.body?.innerText||'');
  },{timeout:3500}).catch(()=>{});

  const times = await page.evaluate(()=>{
    const acc=new Set(); const re=/^\s*(\d{1,2}):(\d{2})\s*$/;
    const pull=(root)=>{ if(!root)return;
      root.querySelectorAll('[class^="time-slot-module__slot___"],[class*="time-slot-module__slot___"],[class^="time-slot-module__slot__"],[class*="time-slot-module__slot__"]').forEach(el=>{
        const m=(el.textContent||'').trim().match(re); if(m) acc.add(m[1].padStart(2,'0')+':'+m[2]);
      });
    };
    pull(document.querySelector('ul:nth-child(2)'));
    pull(document.querySelector('ul:nth-child(4)'));
    if(acc.size===0){
      document.querySelectorAll('button,span,div,li').forEach(el=>{
        const m=(el.textContent||'').trim().match(re); if(m) acc.add(m[1].padStart(2,'0')+':'+m[2]);
      });
    }
    return Array.from(acc).sort();
  });

  return times;
}

// ---------- scrape ----------
async function scrapeAll(page){
  await clickThroughWizard(page);

  // берём кандидатов и оставляем только реально кликабельные дни
  const rawButtons = await page.locator('button').all();
  const days = [];
  for(const b of rawButtons){
    if(await isClickableDay(b)) days.push(b);
  }
  // отсортируем по X-координате (слева направо)
  const withPos = [];
  for(const b of days){
    const txt=(await b.innerText()).trim();
    const bb=await b.boundingBox().catch(()=>null);
    if(bb) withPos.push({btn:b, label:txt, x:bb.x});
  }
  withPos.sort((a,b)=>a.x-b.x);

  log('📅 Кликабельные дни:', withPos.map(d=>d.label).join(', '));

  const result = {};
  // пройдёмся по всем найденным (их немного — как раз 8–10)
  for(const d of withPos){
    await d.btn.scrollIntoViewIfNeeded().catch(()=>{});
    await d.btn.click({ timeout:1500 }).catch(()=>{});
    await page.waitForTimeout(400);
    const times = await collectTimes(page);
    if(times.length) result[d.label]=times;
  }
  return result;
}

// ---------- main ----------
async function main(){
  const start=Date.now();

  let chosen=null;
  if(PROXY_LIST){
    for(const p of PROXY_LIST.split(/\r?\n/).map(parseProxyLine).filter(Boolean)){
      try{ await testProxyReachable(p); chosen=p; break; }catch{}
    }
  }

  const { browser, server } = await launchBrowserWithProxy(chosen);
  const ctx = await browser.newContext({ viewport:{ width:1280, height:1600 } });
  const page = await ctx.newPage();

  log('🌐 Открываем сайт:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil:'domcontentloaded', timeout:30000 });

  const all = await scrapeAll(page);

  let text='🎾 ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n';
  const keys=Object.keys(all).sort((a,b)=>(+a)-(+b));
  if(!keys.length){
    text+='(ничего не найдено)\n\n';
  }else{
    for(const k of keys) text+=`📅 ${k}\n${all[k].join(', ')}\n\n`;
  }
  text+='https://tennis.luzhniki.ru/#courts';

  await sendTelegram(text);
  log('✅ Сообщение отправлено.');
  await ctx.close(); await browser.close();
  if(server?.startsWith('http://127.0.0.1:')){ try{ await proxyChain.closeAnonymizedProxy(server,true);}catch{} }
  log('⏱ Время выполнения:', ((Date.now()-start)/1000).toFixed(1)+'s');
}

await main();
