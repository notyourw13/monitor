// monitor-luzhniki.js
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { SocksProxyAgent } from "socks-proxy-agent";
import fetch from "node-fetch";

// Telegram уведомления
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PROXY_URL = process.env.PROXY_URL || "";
const PROXY_LIST = (process.env.PROXY_LIST || "").split(",").map((x) => x.trim()).filter(Boolean);
const TARGET_URL = "https://tennis.luzhniki.ru/#courts";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    log("❌ Нет токена Telegram");
    return;
  }
  const resp = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
  });
  const data = await resp.json();
  if (!data.ok) log("Ошибка отправки в TG:", data);
  else log("Отправлено в TG");
}

function moscowTodayISO() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const moscow = new Date(utc + 3 * 3600000);
  return moscow.toISOString().split("T")[0];
}

// подключение через SOCKS5
async function startBrowser() {
  let proxyServer = PROXY_URL || PROXY_LIST[0] || "";
  if (proxyServer) {
    log("Проверяем SOCKS5 upstream:", proxyServer.replace(/:\/\/.*@/, "://***:***@"));
    const agent = new SocksProxyAgent(proxyServer);
    try {
      const res = await fetch("https://ifconfig.me", { agent, timeout: 8000 });
      const ip = await res.text();
      log("SOCKS5 работает, IP:", ip.trim());
    } catch (err) {
      log("⚠️ SOCKS5 не отвечает:", err.message);
      proxyServer = "";
    }
  }

  const args = [];
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", ...args],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, page };
}

async function clickCoveredCard(page) {
  const card = page.locator('text="Аренда крытых кортов"');
  if (await card.count()) {
    await card.first().click();
    return true;
  }
  return false;
}

async function clickContinue(page) {
  const btn = page.locator('text="Продолжить"');
  if (await btn.count()) {
    await btn.first().click();
    return true;
  }
  return false;
}

async function findCalendarRoot(page) {
  const xpath = '//div[contains(@class,"Calendar")]';
  const el = page.locator(xpath);
  return el;
}

async function getDayButtons(root) {
  const btns = root.locator('xpath=.//button[contains(@class,"Day")]');
  const count = await btns.count();
  const arr = [];
  for (let i = 0; i < count; i++) arr.push(btns.nth(i));
  return arr;
}

async function collectTimesFromPage(page) {
  const times = await page.locator('xpath=//*[contains(@class,"time") or contains(text(),":")]').allInnerTexts().catch(() => []);
  return times
    .map((t) => t.trim().match(/^\d{1,2}:\d{2}$/)?.[0])
    .filter(Boolean);
}

async function dumpArtifacts(page, name) {
  const html = await page.content();
  const png = await page.screenshot({ fullPage: true });
  fs.writeFileSync(`art-${name}.html`, html);
  fs.writeFileSync(`art-${name}.png`, png);
}

// ===================== новая версия функции =====================
async function scrapeWizard(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });

  const ok1 = await clickCoveredCard(page);
  if (!ok1) throw new Error('Не нашли карточку «Аренда крытых кортов»');

  await page.waitForTimeout(300);
  const ok2 = await clickContinue(page);
  if (!ok2) log('Кнопка «Продолжить» не найдена (возможно, шаг объединён)');

  // ждём, пока появятся секции расписания для выбранного дня
  await page.waitForTimeout(800);
  await page.waitForSelector(
    'xpath=//*[contains(normalize-space(.),"Утро") or contains(normalize-space(.),"Вечер")]',
    { timeout: 30_000 }
  ).catch(() => {});

  const root = await findCalendarRoot(page);

  // попытаемся найти кнопки дней
  let days = await getDayButtons(root);
  if (!days.length) {
    // fallback по всей странице
    days = await getDayButtons(page.locator('xpath=//*'));
  }
  log('Найдено кнопок-дней:', days.length);

  const results = [];
  const isoToday = moscowTodayISO();

  if (!days.length) {
    // ✅ Нет кнопок дней → хотя бы спарсим текущий выбранный день
    const times = await collectTimesFromPage(page);
    log(`Текущий день (без кнопок): слотов ${times.length}`);
    if (!times.length) await dumpArtifacts(page, 'no-days');
    results.push({ date: isoToday, times });
    return results;
  }

  // иначе обойдём видимые дни (не больше 14, чтобы не зависнуть)
  for (let i = 0; i < Math.min(days.length, 14); i++) {
    const dBtn = days[i];
    const label = (await dBtn.innerText().catch(() => '')).trim();
    await dBtn.scrollIntoViewIfNeeded().catch(() => {});
    await dBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);

    const times = await collectTimesFromPage(page);
    log(`День ${label || i + 1}: слотов ${times.length}`);
    if (!times.length)
      await dumpArtifacts(page, `day-${String(label || i + 1).padStart(2, '0')}`);
    results.push({ date: isoToday, times });
  }

  // агрегация по дате
  const by = new Map();
  for (const r of results) {
    if (!by.has(r.date)) by.set(r.date, new Set());
    r.times.forEach((t) => by.get(r.date).add(t));
  }

  return Array.from(by.entries()).map(([date, set]) => ({
    date,
    times: Array.from(set).sort(),
  }));
}
// ===============================================================

async function main() {
  const { browser, page } = await startBrowser();
  const start = Date.now();

  try {
    log("Открываем", TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const data = await scrapeWizard(page);

    log("Итого слотов:", JSON.stringify(data, null, 2));
    const message =
      "ТЕКУЩИЕ СЛОТЫ ЛУЖНИКИ\n\n" +
      (data
        .filter((d) => d.times.length)
        .map((d) => `${d.date}\n  ${d.times.join("\n  ")}`)
        .join("\n\n") || "(ничего не найдено)") +
      "\n\nhttps://tennis.luzhniki.ru/#courts";
    await sendTelegram(message);
  } catch (err) {
    log("❌ Ошибка:", err);
    await dumpArtifacts(page, "error");
  } finally {
    await browser.close();
    log("Время выполнения:", ((Date.now() - start) / 1000).toFixed(1) + "s");
  }
}

main();
