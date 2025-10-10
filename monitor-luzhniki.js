// --- FINAL: Luzhniki Monitor (человеческий сценарий) ---
import fs from "fs";
import { chromium } from "playwright";
import proxyChain from "proxy-chain";
import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

// =========== ENV ===========
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const PROXY_URL = (process.env.PROXY_URL || "").trim();
const PROXY_LIST = (process.env.PROXY_LIST || "")
  .split(/[\n, ]+/)
  .map((s) => s.trim())
  .filter(Boolean);

const HOME_URL = "https://tennis.luzhniki.ru/";

const LOGFILE = `run-${Date.now()}.log`;
function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOGFILE, line + "\n");
  } catch {}
}

// =========== TELEGRAM ===========
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return log("TG creds missing; skip");
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) log("TG error", r.status, await r.text().catch(() => ""));
}

// =========== PROXY ===========
function pickProxy() {
  return PROXY_URL || PROXY_LIST[0] || "";
}

async function testSocks(socksUrl) {
  const agent = new SocksProxyAgent(socksUrl);
  const res = await fetch("https://api.ipify.org", { agent, timeout: 8000 });
  return (await res.text()).trim();
}

async function prepareBridge() {
  const raw = pickProxy();
  if (!raw) return { server: "", close: async () => {} };

  if (/^socks5:/i.test(raw)) {
    log("SOCKS5 upstream:", raw.replace(/\/\/[^@]+@/, "//***:***@"));
    const ip = await testSocks(raw);
    log("SOCKS5 OK, IP:", ip);
    const http = await proxyChain.anonymizeProxy(raw);
    log("HTTP bridge:", http);
    return { server: http, close: () => proxyChain.closeAnonymizedProxy(http, true) };
  }

  if (/^https?:\/\//i.test(raw)) {
    log("HTTP(S) proxy:", raw.replace(/\/\/[^@]+@/, "//***:***@"));
    return { server: raw, close: async () => {} };
  }

  return { server: "", close: async () => {} };
}

// =========== HELPERS ===========
async function snap(page, tag) {
  try {
    await page.screenshot({ path: `art-${tag}.png`, fullPage: true });
  } catch {}
  try {
    const html = await page.content();
    await fs.promises.writeFile(`art-${tag}.html`, html);
  } catch {}
}

function moscowTodayISO() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  return now.toISOString().slice(0, 10);
}

// =========== MAIN FLOW ===========
async function scrape(page) {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await snap(page, "home");

  // 1️⃣ Кликаем баннер «Аренда теннисных кортов»
  const banner = page.locator('xpath=//*[contains(normalize-space(.),"Аренда теннисных кортов")]').first();
  if (await banner.isVisible().catch(() => false)) {
    log("Кликаем баннер «Аренда теннисных кортов»");
    await banner.click({ timeout: 4000 }).catch(() => {});
  } else throw new Error("Баннер не найден");
  await page.waitForTimeout(1000);
  await snap(page, "after-banner");

  // 2️⃣ Карточка «Аренда крытых кортов»
  const card = page.locator('xpath=//*[contains(normalize-space(.),"Аренда крытых кортов")]').first();
  await card.waitFor({ timeout: 20000 });
  log("Кликаем «Аренда крытых кортов»");
  await card.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  await snap(page, "after-covered");

  // 3️⃣ Кнопка «Продолжить»
  const cont = page.locator('xpath=//*[self::button or self::a][contains(normalize-space(.),"Продолжить")]').first();
  await cont.waitFor({ timeout: 10000 });
  log("Кликаем «Продолжить»");
  await cont.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap(page, "after-continue");

  // 4️⃣ Календарь
  await page.waitForSelector('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]', {
    timeout: 20000,
  });
  await snap(page, "calendar");

  // 5️⃣ Слоты
  const sections = await page.locator('xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]').all();
  const acc = new Set();
  for (const s of sections) {
    const list = await s
      .evaluate((el) =>
        Array.from(el.querySelectorAll("*"))
          .map((n) => (n.textContent || "").trim())
          .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
      )
      .catch(() => []);
    list.forEach((t) => acc.add(t));
  }

  const times = Array.from(acc).sort();
  log("Найдено слотов:", times.length);
  if (!times.length) await snap(page, "no-slots");

  return [{ date: moscowTodayISO(), times }];
}

function formatMessage(rows) {
  if (!rows?.length || rows.every((r) => !r.times?.length))
    return `ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n(ничего не найдено)\n\nhttps://tennis.luzhniki.ru/#courts`;

  let out = "ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n";
  for (const r of rows) {
    out += `\n${r.date}:\n`;
    for (const t of r.times) out += `  ${t}\n`;
  }
  out += `\nhttps://tennis.luzhniki.ru/#courts`;
  return out;
}

// =========== RUN ===========
(async () => {
  let bridge, browser, context;
  const start = Date.now();
  try {
    bridge = await prepareBridge();
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      proxy: bridge.server ? { server: bridge.server } : undefined,
    });
    context = await browser.newContext({ locale: "ru-RU", timezoneId: "Europe/Moscow" });
    const page = await context.newPage();

    const rows = await scrape(page);
    const msg = formatMessage(rows);
    await sendTelegram(msg);
  } catch (e) {
    log("Ошибка:", e.message || e);
    const p = context?.pages?.()[0];
    if (p) await snap(p, "error");
    process.exitCode = 1;
  } finally {
    try {
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
    try {
      await bridge?.close?.();
    } catch {}
    log("Время выполнения:", Math.round((Date.now() - start) / 1000) + "s");
  }
})();
