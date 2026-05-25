import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.HYBGZS_WHEEL_URL || "https://cdk.hybgzs.com/entertainment/wheel";
const COOKIE = process.env.HYBGZS_COOKIE || "";
const MAX_DAILY_SPINS = Number(process.env.HYBGZS_MAX_DAILY_SPINS || 3);
const CLICK_INTERVAL_MS = Number(process.env.HYBGZS_CLICK_INTERVAL_MS || 9000);
const SPIN_RESULT_TIMEOUT_MS = Number(process.env.HYBGZS_SPIN_RESULT_TIMEOUT_MS || Math.max(CLICK_INTERVAL_MS, 12000));
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

async function findSpinTarget(cdp) {
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
      "[onclick]",
      "[class*='spin']",
      "[class*='wheel']",
      "[class*='start']",
      "[class*='draw']",
      "[class*='lottery']",
      "canvas"
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter(isVisible);

    const scored = candidates.map((el, index) => {
      const rect = el.getBoundingClientRect();
      const text = el.innerText || el.textContent || "";
      const className = typeof el.className === "string" ? el.className : "";
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const hasClickHandler = typeof el.onclick === "function" || el.hasAttribute("onclick");
      const textMatches = textPattern.test(text);
      const classMatches = textPattern.test(className);
      const isNativeControl = tagName === "button" || tagName === "a" || role === "button";
      const isCanvas = tagName === "canvas";
      const area = rect.width * rect.height;
      let score = 0;

      if (isNativeControl) score += 100;
      if (hasClickHandler) score += 80;
      if (textMatches) score += 50;
      if (classMatches) score += 35;
      if (isCanvas) score += 20;
      if (area > 20000 && area < 250000) score += 10;
      if (area >= window.innerWidth * window.innerHeight * 0.35) score -= 80;
      if (/返回|首页|back|home/i.test(text)) score -= 120;

      return { el, index, score };
    }).filter(({ score }) => score > 0);

    const target = scored
      .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.el;

    if (!target) {
      return null;
    }

    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    const text = (target.innerText || target.textContent || "").replace(/\\s+/g, " ").trim();
    const className = typeof target.className === "string" ? target.className : "";

    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      tagName: target.tagName.toLowerCase(),
      className: className.slice(0, 120),
      text: text.slice(0, 120),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  })()`;

  return await evaluate(cdp, expression);
}

async function clickSpin(cdp) {
  const target = await findSpinTarget(cdp);

  if (!target) {
    return null;
  }

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    button: "none"
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1
  });

  return target;
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

function getAccountBalanceFromText(text) {
  const match = text.match(/\$(\d+(?:\.\d+)?)/);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function summarizeText(text) {
  return text.slice(0, 500).replace(/\s+/g, " ").trim();
}

function getSnapshotFromText(text) {
  return {
    text,
    summary: summarizeText(text),
    remaining: getRemainingSpinsFromText(text),
    balance: getAccountBalanceFromText(text),
    limitReached: hasReachedDailyLimit(text)
  };
}

async function getPageSnapshot(cdp) {
  return getSnapshotFromText(await getBodyText(cdp));
}

function describeTarget(target) {
  const label = target.text || target.className || `${target.width}x${target.height}`;
  return `${target.tagName} "${label}" at (${target.x}, ${target.y})`;
}

function isConfirmedSpin(before, after) {
  if (after.limitReached) {
    return true;
  }

  if (before.remaining !== null && after.remaining !== null) {
    return after.remaining < before.remaining;
  }

  if (before.balance !== null && after.balance !== null && after.balance !== before.balance) {
    return true;
  }

  if (before.remaining !== null || before.balance !== null) {
    return false;
  }

  return before.text !== after.text;
}

async function waitForConfirmedSpin(cdp, before, timeoutMs = SPIN_RESULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let latest = before;

  while (Date.now() < deadline) {
    await sleep(500);
    latest = await getPageSnapshot(cdp);

    if (isConfirmedSpin(before, latest)) {
      return {
        confirmed: true,
        snapshot: latest
      };
    }
  }

  return {
    confirmed: false,
    snapshot: latest
  };
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

    const initialSnapshot = await getPageSnapshot(cdp);
    const pageRemaining = initialSnapshot.remaining;
    const pageUsed = pageRemaining === null ? used : Math.max(0, MAX_DAILY_SPINS - pageRemaining);
    const remaining = pageRemaining === null ? Math.max(0, MAX_DAILY_SPINS - used) : pageRemaining;

    if (pageRemaining !== null && used !== pageUsed) {
      console.log(
        `[${today}] Local record ${used}/${MAX_DAILY_SPINS} differs from page ${pageUsed}/${MAX_DAILY_SPINS}; using page state.`
      );
    } else if (remaining === 0) {
      console.log(`[${today}] Already recorded ${used}/${MAX_DAILY_SPINS} spins. Verifying against page state.`);
    }

    if (pageRemaining === 0 || initialSnapshot.limitReached) {
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
    const spinLimit = remaining;

    for (let i = 0; i < spinLimit; i += 1) {
      const spinNumber = pageUsed + i + 1;
      console.log(`[${today}] Spin ${spinNumber}/${MAX_DAILY_SPINS}...`);

      const before = await getPageSnapshot(cdp);
      const target = await clickSpin(cdp);

      if (!target) {
        throw new Error("Could not find the wheel spin button/control. The page selector may need adjustment.");
      }

      console.log(`[${today}] Clicked ${describeTarget(target)}.`);

      const result = await waitForConfirmedSpin(cdp, before);
      const { snapshot } = result;

      if (snapshot.summary) {
        console.log(`[${today}] Page text: ${snapshot.summary}`);
      }

      if (!result.confirmed) {
        const details = [
          `Clicked target did not change page state within ${SPIN_RESULT_TIMEOUT_MS} ms.`,
          `Target: ${describeTarget(target)}.`,
          `Remaining before/after: ${before.remaining ?? "unknown"}/${snapshot.remaining ?? "unknown"}.`,
          `Balance before/after: ${before.balance ?? "unknown"}/${snapshot.balance ?? "unknown"}.`
        ];
        throw new Error(details.join(" "));
      }

      successCount += 1;

      if (snapshot.limitReached) {
        console.log(`[${today}] Page says daily limit reached.`);
        break;
      }
    }

    state[today] = {
      spins: Math.min(MAX_DAILY_SPINS, pageUsed + successCount),
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
