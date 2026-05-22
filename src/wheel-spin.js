import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.HYBGZS_WHEEL_URL || "https://cdk.hybgzs.com/entertainment/wheel";
const COOKIE = process.env.HYBGZS_COOKIE || "";
const MAX_DAILY_SPINS = Number(process.env.HYBGZS_MAX_DAILY_SPINS || 3);
const CLICK_INTERVAL_MS = Number(process.env.HYBGZS_CLICK_INTERVAL_MS || 9000);
const HEADLESS = process.env.HEADLESS !== "false";
const STATE_FILE = process.env.STATE_FILE || path.resolve("wheel-state.json");
const CHROME_BIN = process.env.CHROME_BIN || "";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);
const CHROME_NO_SANDBOX = process.env.CHROME_NO_SANDBOX !== "false";
const CHROME_VERBOSE = process.env.CHROME_VERBOSE === "true";
const BARK = (process.env.BARK || "").trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  await fs.mkdir(path.dirname(path.resolve(STATE_FILE)), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function resolveBarkConfig() {
  if (!BARK) {
    return null;
  }

  const isUrl = /^https?:\/\//i.test(BARK);

  if (!isUrl) {
    return {
      server: "https://api.day.app",
      key: BARK
    };
  }

  const parsed = new URL(BARK);
  const parts = parsed.pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    throw new Error("BARK URL must include Bark key, for example https://api.day.app/YOUR_KEY.");
  }

  return {
    server: `${parsed.protocol}//${parsed.host}`,
    key: parts[0]
  };
}

async function pushBark(title, body) {
  const bark = resolveBarkConfig();

  if (!bark) {
    console.warn("[bark] BARK is not set. Skipping push notification.");
    return;
  }

  const base = bark.server.replace(/\/+$/, "");
  const url = new URL(
    `${base}/${encodeURIComponent(bark.key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`
  );
  url.searchParams.set("group", "HYBGZS");

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bark push failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const result = await response.json().catch(() => null);

  if (result && result.code !== 200) {
    throw new Error(`Bark push failed: ${JSON.stringify(result)}`);
  }

  console.log("[bark] Push sent.");
}

async function safePushBark(title, body) {
  try {
    await pushBark(title, body);
  } catch (error) {
    console.error(`[bark] ${error.message}`);
  }
}

async function requireChromeBin() {
  if (!CHROME_BIN) {
    throw new Error("Missing CHROME_BIN. Please set Arcadia's Chromium executable path in CHROME_BIN.");
  }

  try {
    await fs.access(CHROME_BIN, fsConstants.X_OK);
  } catch (error) {
    throw new Error(
      [
        `CHROME_BIN points to a browser that cannot be executed: ${CHROME_BIN}`,
        `Access check failed: ${error.message}`,
        "Please set CHROME_BIN to the full Chromium executable path in Arcadia."
      ].join("\n")
    );
  }
}

async function getJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDevTools(port) {
  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 15000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await getJson(versionUrl, 2000);
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }

  throw new Error(`Chromium DevTools did not become ready on port ${port}. Last error: ${lastError?.message}`);
}

async function createPage(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT"
  });

  if (!response.ok) {
    throw new Error(`Could not create a Chromium tab. HTTP ${response.status} ${response.statusText}`);
  }

  const pageInfo = await response.json();

  if (!pageInfo.webSocketDebuggerUrl) {
    throw new Error("Chromium did not return a page WebSocket debugger URL.");
  }

  return pageInfo.webSocketDebuggerUrl;
}

function createCdpClient(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  let id = 0;
  const pending = new Map();
  const events = new Map();

  ws.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);

    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);

      if (data.error) {
        reject(new Error(data.error.message || JSON.stringify(data.error)));
      } else {
        resolve(data.result || {});
      }

      return;
    }

    const handlers = events.get(data.method) || [];
    for (const handler of handlers) {
      handler(data.params || {});
    }
  });

  function send(method, params = {}) {
    id += 1;
    const messageId = id;

    return new Promise((resolve, reject) => {
      pending.set(messageId, { resolve, reject });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
  }

  function on(method, handler) {
    const handlers = events.get(method) || [];
    handlers.push(handler);
    events.set(method, handlers);
  }

  async function waitOpen() {
    if (ws.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
  }

  return {
    close: () => ws.close(),
    on,
    send,
    waitOpen
  };
}

async function waitForLoad(cdp, timeoutMs = 60000) {
  let loaded = false;

  cdp.on("Page.loadEventFired", () => {
    loaded = true;
  });

  const deadline = Date.now() + timeoutMs;

  while (!loaded && Date.now() < deadline) {
    await sleep(300);
  }

  if (!loaded) {
    throw new Error(`Page did not finish loading within ${timeoutMs} ms.`);
  }

  await sleep(1500);
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed.");
  }

  return result.result?.value;
}

function parseCookieHeader(cookieHeader) {
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
        domain: "cdk.hybgzs.com",
        path: "/",
        secure: true
      };
    })
    .filter(Boolean);
}

async function setCookies(cdp) {
  const cookies = parseCookieHeader(COOKIE);

  if (cookies.length === 0) {
    throw new Error("HYBGZS_COOKIE did not contain any valid cookie pairs.");
  }

  await cdp.send("Network.setCookies", { cookies });
}

async function clickSpin(cdp) {
  const expression = `(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
    };

    const textPattern = /抽奖|转动|开始|立即|签到|spin|start|draw/i;
    const selectors = [
      "button",
      "a",
      "[role='button']",
      "[class*='spin']",
      "[class*='wheel']",
      "[class*='start']",
      "[class*='draw']",
      "[class*='lottery']",
      "canvas"
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter(isVisible);

    let target = candidates.find((el) => {
      const text = el.innerText || el.textContent || "";
      const className = typeof el.className === "string" ? el.className : "";
      return textPattern.test(text) || textPattern.test(className);
    });

    if (!target) {
      target = candidates
        .slice()
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        })[0];
    }

    if (!target) {
      return false;
    }

    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y
      }));
    }

    if (typeof target.click === "function") {
      target.click();
    }

    return true;
  })()`;

  return Boolean(await evaluate(cdp, expression));
}

async function getBodyText(cdp) {
  return (await evaluate(cdp, "document.body ? document.body.innerText : ''")) || "";
}

function hasReachedDailyLimit(text) {
  return /今日.*(已|已经).*(用完|上限|完成)|今日剩余转盘次数\s*:\s*0\s*\/\s*\d+|次数不足|明天再来|已达.*上限|没有.*次数/.test(text);
}

function getRemainingSpinsFromText(text) {
  const match = text.match(/今日剩余转盘次数\s*:\s*(\d+)\s*\/\s*(\d+)/);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

async function createUserDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hybgzs-wheel-chrome-"));
}

function launchChrome(userDataDir) {
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1280,900"
  ];

  if (CHROME_NO_SANDBOX) {
    args.push("--no-sandbox");
  }

  if (HEADLESS) {
    args.push("--headless=new");
  }

  args.push("about:blank");

  console.log("[browser] Launching Chromium.");

  const chrome = spawn(CHROME_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (CHROME_VERBOSE) {
    chrome.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[chromium] ${text}`);
    });

    chrome.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) console.error(`[chromium] ${text}`);
    });
  }

  return chrome;
}

async function main() {
  if (!COOKIE) {
    throw new Error("Missing HYBGZS_COOKIE. Put your logged-in browser Cookie header in this environment variable.");
  }

  await requireChromeBin();

  const state = await readState();
  const today = getTodayKey();
  const used = Number(state[today]?.spins || 0);
  const remaining = Math.max(0, MAX_DAILY_SPINS - used);

  if (remaining === 0) {
    console.log(`[${today}] Already recorded ${used}/${MAX_DAILY_SPINS} spins. Nothing to do.`);
    return;
  }

  const userDataDir = await createUserDataDir();
  const chrome = launchChrome(userDataDir);
  let cdp;

  try {
    chrome.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") {
        console.error(`[browser] Chromium exited unexpectedly. code=${code} signal=${signal}`);
      }
    });

    await waitForDevTools(DEBUG_PORT);
    const webSocketUrl = await createPage(DEBUG_PORT);
    cdp = createCdpClient(webSocketUrl);
    await cdp.waitOpen();

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" });
    await cdp.send("Emulation.setLocaleOverride", { locale: "zh-CN" });
    await setCookies(cdp);

    await cdp.send("Page.navigate", { url: TARGET_URL });
    await waitForLoad(cdp);

    const initialBodyText = await getBodyText(cdp);
    const pageRemaining = getRemainingSpinsFromText(initialBodyText);

    if (pageRemaining === 0 || hasReachedDailyLimit(initialBodyText)) {
      console.log(`[${today}] Page says no spins remain today. Recording ${MAX_DAILY_SPINS}/${MAX_DAILY_SPINS}.`);
      state[today] = {
        spins: MAX_DAILY_SPINS,
        updatedAt: new Date().toISOString()
      };
      await writeState(state);
      await safePushBark("幸运转盘", `${today} 今日剩余次数 0/${MAX_DAILY_SPINS}，已记录完成。`);
      return;
    }

    let successCount = 0;
    const spinLimit = pageRemaining === null ? remaining : Math.min(remaining, pageRemaining);

    for (let i = 0; i < spinLimit; i += 1) {
      const spinNumber = used + i + 1;
      console.log(`[${today}] Spin ${spinNumber}/${MAX_DAILY_SPINS}...`);

      const clicked = await clickSpin(cdp);

      if (!clicked) {
        throw new Error("Could not find the wheel spin button/control. The page selector may need adjustment.");
      }

      successCount += 1;
      await sleep(CLICK_INTERVAL_MS);

      const bodyText = await getBodyText(cdp);
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
    await safePushBark(
      "幸运转盘",
      `${today} 执行完成，本次点击 ${successCount} 次，已记录 ${state[today].spins}/${MAX_DAILY_SPINS}。`
    );
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(error);
  await safePushBark("幸运转盘失败", error.message || String(error));
  process.exit(1);
});
