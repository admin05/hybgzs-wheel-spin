import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const TARGET_URL = process.env.HYBGZS_WHEEL_URL || "https://cdk.hybgzs.com/entertainment/wheel";
const COOKIE = process.env.HYBGZS_COOKIE || "";
const MAX_DAILY_SPINS = Number(process.env.HYBGZS_MAX_DAILY_SPINS || 3);
const CLICK_INTERVAL_MS = Number(process.env.HYBGZS_CLICK_INTERVAL_MS || 9000);
const HEADLESS = process.env.HEADLESS !== "false";
const STATE_FILE = process.env.STATE_FILE || path.resolve("wheel-state.json");

function getTodayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function parseCookieHeader(cookieHeader, domain) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex === -1) {
        return null;
      }

      return {
        name: part.slice(0, separatorIndex),
        value: part.slice(separatorIndex + 1),
        domain,
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax"
      };
    })
    .filter(Boolean);
}

async function clickFirstVisible(locator) {
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);

    try {
      await item.waitFor({ state: "visible", timeout: 1500 });
      await item.click({ timeout: 5000 });
      return true;
    } catch {
      // Continue to the next likely control.
    }
  }

  return false;
}

async function clickSpin(page) {
  const candidates = [
    page.getByRole("button", { name: /抽奖|转动|开始|立即|签到|spin|start|draw/i }),
    page.locator("button, a, [role='button']").filter({
      hasText: /抽奖|转动|开始|立即|签到|spin|start|draw/i
    }),
    page.locator("[class*='spin'], [class*='wheel'], [class*='start'], [class*='draw'], [class*='lottery']"),
    page.locator("canvas")
  ];

  for (const locator of candidates) {
    if (await clickFirstVisible(locator)) {
      return true;
    }
  }

  return false;
}

function hasReachedDailyLimit(text) {
  return /今日.*(已|已经).*(用完|上限|完成)|次数不足|明天再来|已达.*上限|没有.*次数/.test(text);
}

async function main() {
  if (!COOKIE) {
    throw new Error("Missing HYBGZS_COOKIE. Put your logged-in browser Cookie header in this environment variable.");
  }

  const state = await readState();
  const today = getTodayKey();
  const used = Number(state[today]?.spins || 0);
  const remaining = Math.max(0, MAX_DAILY_SPINS - used);

  if (remaining === 0) {
    console.log(`[${today}] Already recorded ${used}/${MAX_DAILY_SPINS} spins. Nothing to do.`);
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
    });

    await context.addCookies(parseCookieHeader(COOKIE, "cdk.hybgzs.com"));

    const page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 60000 });

    let successCount = 0;

    for (let i = 0; i < remaining; i += 1) {
      const spinNumber = used + i + 1;
      console.log(`[${today}] Spin ${spinNumber}/${MAX_DAILY_SPINS}...`);

      const clicked = await clickSpin(page);

      if (!clicked) {
        throw new Error("Could not find the wheel spin button/control. The page selector may need adjustment.");
      }

      successCount += 1;
      await page.waitForTimeout(CLICK_INTERVAL_MS);

      const bodyText = await page.locator("body").innerText().catch(() => "");
      const summary = bodyText.slice(0, 500).replace(/\s+/g, " ").trim();

      if (summary) {
        console.log(`[${today}] Page text: ${summary}`);
      }

      if (hasReachedDailyLimit(bodyText)) {
        console.log(`[${today}] Page says daily limit reached.`);
        break;
      }
    }

    state[today] = {
      spins: used + successCount,
      updatedAt: new Date().toISOString()
    };

    await writeState(state);
    console.log(`[${today}] Done. Recorded ${state[today].spins}/${MAX_DAILY_SPINS} spins.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
