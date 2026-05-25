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

    const textPattern = /抽奖|转动|开始|立即|签到|spin|start|draw|lottery|wheel/i;
    const strongTextPattern = /^(抽奖|转动|开始|立即抽奖|立即转动|spin|start|draw)$/i;
    const rejectTextPattern = /返回|首页|back|home|^\$\d+(?:\.\d+)?$|^\d+(?:\.\d+)?$/i;
    const getTargetInfo = (target, reason = "candidate") => {
      target.scrollIntoView({ block: "center", inline: "center" });
      const rect = target.getBoundingClientRect();
      const text = (target.innerText || target.textContent || "").replace(/\\s+/g, " ").trim();
      const className = typeof target.className === "string" ? target.className : "";
      const isCanvas = target.tagName.toLowerCase() === "canvas";

      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height * (isCanvas ? 0.58 : 0.5)),
        tagName: target.tagName.toLowerCase(),
        className: className.slice(0, 120),
        text: text.slice(0, 120),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        reason
      };
    };
    const startTextElements = Array.from(document.querySelectorAll("body *"))
      .filter(isVisible)
      .filter((el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() === "开始")
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) < window.innerWidth * 0.35 &&
          rect.top > window.innerHeight * 0.25;
      });
    const startTarget = startTextElements
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const ac = Math.abs(ar.left + ar.width / 2 - window.innerWidth / 2);
        const bc = Math.abs(br.left + br.width / 2 - window.innerWidth / 2);
        return ac - bc || (ar.width * ar.height) - (br.width * br.height);
      })[0];

    if (startTarget) {
      return getTargetInfo(startTarget, "start-text");
    }

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
      const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      const className = typeof el.className === "string" ? el.className : "";
      const id = el.id || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const hasClickHandler = typeof el.onclick === "function" || el.hasAttribute("onclick");
      const semantic = [text, className, id, ariaLabel].join(" ");
      const textMatches = textPattern.test(text);
      const strongTextMatches = strongTextPattern.test(text);
      const semanticMatches = textPattern.test(semantic);
      const isNativeControl = tagName === "button" || tagName === "a" || role === "button";
      const isCanvas = tagName === "canvas";
      const area = rect.width * rect.height;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const nearPageCenter = Math.abs(centerX - window.innerWidth / 2) < window.innerWidth * 0.3 &&
        centerY > window.innerHeight * 0.25;
      let score = 0;

      if (rejectTextPattern.test(text)) return { el, index, score: -Infinity };
      if (centerY < window.innerHeight * 0.18) return { el, index, score: -Infinity };
      if (!semanticMatches && !hasClickHandler && !isCanvas) return { el, index, score: -Infinity };

      if (strongTextMatches) score += 180;
      if (textMatches) score += 80;
      if (semanticMatches) score += 60;
      if (nearPageCenter) score += 60;
      if (hasClickHandler) score += 80;
      if (isNativeControl) score += tagName === "a" ? 15 : 60;
      if (isCanvas) score += 20;
      if (area > 20000 && area < 250000) score += 10;
      if (area >= window.innerWidth * window.innerHeight * 0.35) score -= 80;
      if (tagName === "a" && !strongTextMatches && !semanticMatches) score -= 80;

      return { el, index, score };
    }).filter(({ score }) => Number.isFinite(score) && score > 0);

    const target = scored
      .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.el;

    if (!target) {
      return null;
    }

    return getTargetInfo(target);
  })()`;

  return await evaluate(cdp, expression);
}

async function clickSpin(cdp) {
  const target = await findSpinTarget(cdp);

  if (!target) {
    return null;
  }

  if (isRejectedTarget(target)) {
    return null;
  }

  await dispatchDomClickAtPoint(cdp, target.x, target.y);

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

async function dispatchDomClickAtPoint(cdp, x, y) {
  const expression = `((x, y) => {
    const base = document.elementFromPoint(x, y);

    if (!base) {
      return false;
    }

    const path = [];
    let current = base;

    while (current && current !== document.body && path.length < 6) {
      path.push(current);
      current = current.parentElement;
    }

    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y
    };

    for (const el of path) {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const EventCtor = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
        el.dispatchEvent(new EventCtor(type, {
          ...common,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: type.endsWith("down") ? 1 : 0
        }));
      }

      if (typeof el.click === "function") {
        el.click();
      }
    }

    if (window.TouchEvent && window.Touch) {
      const touch = new Touch({
        identifier: Date.now(),
        target: base,
        clientX: x,
        clientY: y,
        screenX: window.screenX + x,
        screenY: window.screenY + y,
        pageX: window.scrollX + x,
        pageY: window.scrollY + y
      });

      for (const type of ["touchstart", "touchend"]) {
        base.dispatchEvent(new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: type === "touchend" ? [] : [touch],
          targetTouches: type === "touchend" ? [] : [touch],
          changedTouches: [touch]
        }));
      }
    }

    return true;
  })(${Math.round(x)}, ${Math.round(y)})`;

  await evaluate(cdp, expression);
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
  const reason = target.reason ? ` via ${target.reason}` : "";
  return `${target.tagName} "${label}" at (${target.x}, ${target.y})${reason}`;
}

function isRejectedTarget(target) {
  return /返回|首页|back|home|^\$\d+(?:\.\d+)?$|^\d+(?:\.\d+)?$/i.test(target.text || "");
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

async function getCapNonce(cdp) {
  const expression = `fetch("/api/cap/challenge", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ action: "wheel_spin" })
  }).then(async (response) => {
    const text = await response.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {}

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      json,
      text: text.slice(0, 500)
    };
  })`;

  const result = await evaluate(cdp, expression);

  if (!result?.ok || !result.json?.success || !result.json?.nonce) {
    const message = result?.json?.error || result?.text || result?.statusText || "unknown error";
    throw new Error(`CAP challenge failed: HTTP ${result?.status ?? "unknown"} ${message}`);
  }

  return result.json.nonce;
}

async function solveCapToken(cdp) {
  const nonce = await getCapNonce(cdp);
  console.log("[cap] Challenge nonce received. Solving CAP token...");

  const expression = `new Promise(async (resolve) => {
    const scriptUrl = "/_next/static/chunks/0wra6jwa~oum_.js";
    const timeout = setTimeout(() => resolve({ ok: false, error: "CAP solve timeout" }), 90000);

    try {
      if (!customElements.get("cap-widget") && !window.Cap) {
        await new Promise((resolveScript, rejectScript) => {
          const existing = Array.from(document.scripts).find((script) => script.src.includes("0wra6jwa~oum_.js"));

          if (existing) {
            existing.addEventListener("load", resolveScript, { once: true });
            existing.addEventListener("error", rejectScript, { once: true });
            setTimeout(resolveScript, 3000);
            return;
          }

          const script = document.createElement("script");
          script.src = scriptUrl;
          script.async = true;
          script.onload = resolveScript;
          script.onerror = () => rejectScript(new Error("Could not load CAP widget chunk"));
          document.head.appendChild(script);
        });
      }

      const readyDeadline = Date.now() + 10000;
      while (!customElements.get("cap-widget") && !window.Cap && Date.now() < readyDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }

      if (!customElements.get("cap-widget") && !window.Cap) {
        throw new Error("CAP widget did not become available");
      }

      window.CAP_CUSTOM_FETCH = async (url, options = {}) => {
        const headers = new Headers(options.headers);
        return fetch(url, {
          ...options,
          headers
        });
      };

      const widget = document.createElement("cap-widget");
      widget.setAttribute("data-cap-api-endpoint", "https://cap.hybgzs.com/f96f595e4c/");
      widget.setAttribute("data-cap-disable-haptics", "");
      widget.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;";
      document.body.appendChild(widget);

      widget.addEventListener("progress", (event) => {
        window.__HYBGZS_CAP_PROGRESS = event?.detail?.progress ?? 0;
      });

      widget.addEventListener("solve", (event) => {
        const token = event?.detail?.token || widget.token || widget.tokenValue;
        clearTimeout(timeout);
        widget.remove();
        resolve(token ? { ok: true, token } : { ok: false, error: "CAP solved without token" });
      }, { once: true });

      widget.addEventListener("error", (event) => {
        clearTimeout(timeout);
        const message = event?.detail?.message || event?.message || "CAP widget error";
        widget.remove();
        resolve({ ok: false, error: message });
      }, { once: true });

      if (typeof widget.solve !== "function") {
        throw new Error("CAP widget solve() is unavailable");
      }

      const result = await widget.solve();
      const token = result?.token || widget.token || widget.tokenValue;

      if (token) {
        clearTimeout(timeout);
        widget.remove();
        resolve({ ok: true, token });
      }
    } catch (error) {
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message || String(error) });
    }
  })`;

  const result = await evaluate(cdp, expression);

  if (!result?.ok || !result.token) {
    throw new Error(`CAP solve failed: ${result?.error || "unknown error"}`);
  }

  return {
    capNonce: nonce,
    capToken: result.token
  };
}

async function callWheelSpinApi(cdp, capPayload = null) {
  const body = JSON.stringify(capPayload || {});
  const expression = `fetch("/api/wheel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "include",
    body: ${JSON.stringify(body)}
  }).then(async (response) => {
    const text = await response.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {}

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      json,
      text: text.slice(0, 500)
    };
  })`;

  const result = await evaluate(cdp, expression);

  if (!result?.ok) {
    const message = result?.json?.error || result?.text || result?.statusText || "unknown error";
    if (result?.status === 400 && /人机验证|验证/.test(message) && !capPayload) {
      console.log("[cap] Wheel API requires human verification.");
      const solvedCapPayload = await solveCapToken(cdp);
      return await callWheelSpinApi(cdp, solvedCapPayload);
    }

    throw new Error(`Wheel API failed: HTTP ${result?.status ?? "unknown"} ${message}`);
  }

  if (result.json?.success === false) {
    throw new Error(`Wheel API failed: ${result.json.error || JSON.stringify(result.json)}`);
  }

  if (!result.json?.data) {
    throw new Error(`Wheel API returned unexpected response: ${JSON.stringify(result.json)}`);
  }

  return result.json.data;
}

function describePrize(data) {
  const prizeName = data?.prize?.name || "unknown prize";
  const amount = Number(data?.prize?.amount || 0);
  const reward = amount > 0 ? ` +$${(amount / 500000).toFixed(2)}` : "";
  const remaining = typeof data?.remainingSpins === "number" ? `, remaining ${data.remainingSpins}` : "";
  return `${prizeName}${reward}${remaining}`;
}

async function createUserDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hybgzs-wheel-chrome-"));
}

async function waitForProcessExit(process, timeoutMs = 5000) {
  if (process.exitCode !== null || process.signalCode !== null) {
    return true;
  }

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      process.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    process.once("exit", onExit);
  });
}

async function removeUserDataDir(userDataDir) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      return;
    } catch (error) {
      if (attempt === 5) {
        console.warn(`[browser] Could not remove temporary Chromium profile ${userDataDir}: ${error.message}`);
        return;
      }

      await sleep(300 * attempt);
    }
  }
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

      console.log(`[${today}] Calling wheel API...`);
      const result = await callWheelSpinApi(cdp);
      console.log(`[${today}] Wheel API result: ${describePrize(result)}.`);
      successCount += 1;

      if (typeof result.remainingSpins === "number" && result.remainingSpins <= 0) {
        console.log(`[${today}] Wheel API says daily limit reached.`);
        break;
      }

      await sleep(CLICK_INTERVAL_MS);
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
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGTERM");
      const exited = await waitForProcessExit(chrome);
      if (!exited) {
        chrome.kill("SIGKILL");
        await waitForProcessExit(chrome, 2000);
      }
    }
    await removeUserDataDir(userDataDir);
  }
}

main().catch(async (error) => {
  console.error(error);
  await safePushBark("幸运转盘失败", error.message || String(error));
  process.exit(1);
});
