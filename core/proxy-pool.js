import { fetch as wreqRequest } from "wreq-js";

const CONFIG = {
  listUrls: (process.env.PROXY_LIST_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
  validateSample: Number(process.env.PROXY_VALIDATE_SAMPLE) || 60,
  maxHealthy: Number(process.env.PROXY_MAX_HEALTHY) || 25,
  concurrency: Number(process.env.PROXY_CONCURRENCY) || 6,
  listTtlMs: Number(process.env.PROXY_LIST_TTL_MS) || 15 * 60 * 1000,
  tryMs: Number(process.env.PROXY_TRY_TIMEOUT_MS) || 20000,
  validateMs: Number(process.env.PROXY_VALIDATE_TIMEOUT_MS) || 8000,
  revalidateMs: Number(process.env.PROXY_REVALIDATE_MS) || 5 * 60 * 1000,
  maxAttempts: Number(process.env.PROXY_MAX_ATTEMPTS) || 3,
  checkUrl: process.env.PROXY_IP_CHECK_URL || "http://api.iplocate.io/ip",
  disabled: ["0", "off", "false", "no"].includes(String(process.env.PROXY_POOL).toLowerCase()),
};

const DEFAULT_LIST_URLS = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt",
  "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",
];

const PROXY_SUFFIXES = [
  ".anizone.to",
  ".reanime.to",
  ".kaa.lt",
  ".animeonsen.xyz",
  ".animenosub.to",
  ".anime-dunya.com",
];

const STATE = {
  list: new Map(),
  healthy: [],
  failures: new Map(),
  directIp: null,
  index: 0,
  refreshPromise: null,
  timer: null,
};

function isDisabled() {
  return CONFIG.disabled;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isProxiedTarget(url) {
  const host = hostOf(url);
  if (!host) return false;
  return PROXY_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

function classifyLine(line) {
  const value = String(line || "").trim();
  if (!value) return null;
  let scheme = "http";
  let address = value;
  const match = value.match(/^(socks4|socks5|socks5h|https?):\/\/(.+)$/);
  if (match) {
    if (match[1] === "socks5" || match[1] === "socks5h") scheme = "socks5";
    else if (match[1] === "socks4") scheme = "socks4";
    else scheme = "http";
    address = match[2];
  }
  const parts = address.split(":");
  if (parts.length !== 2) return null;
  const ip = parts[0];
  const port = parts[1];
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip) && !/^[0-9a-f:]+$/i.test(ip)) return null;
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  return { key: address, url: `${scheme}://${address}`, scheme };
}

async function fetchListText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`proxy list HTTP ${res.status}: ${url}`);
  return res.text();
}

async function refreshList() {
  const urls = CONFIG.listUrls.length ? CONFIG.listUrls : DEFAULT_LIST_URLS;
  const results = await Promise.allSettled(urls.map(fetchListText));
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const line of result.value.split(/\r?\n/)) {
      const entry = classifyLine(line);
      if (entry) STATE.list.set(entry.key, { ...entry, failures: 0, cooledUntil: 0 });
    }
  }
}

async function resolveDirectIp() {
  if (STATE.directIp) return STATE.directIp;
  try {
    const res = await fetch(CONFIG.checkUrl, { signal: AbortSignal.timeout(10000) });
    const text = (await res.text()).trim();
    if (ipLike(text)) STATE.directIp = text;
    return STATE.directIp || null;
  } catch {
    return STATE.directIp || null;
  }
}

function ipLike(text) {
  const value = String(text || "").trim();
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value)) return true;
  return value.includes(":") && /^[0-9a-fA-F:]+$/.test(value);
}

async function checkProxy(entry) {
  try {
    const res = await wreqRequest(CONFIG.checkUrl, {
      browser: "chrome_149",
      os: "windows",
      proxy: entry.url,
      signal: AbortSignal.timeout(CONFIG.validateMs),
    });
    const text = await res.text();
    const maskedIp = text.trim();
    if (res.ok && ipLike(maskedIp) && maskedIp !== STATE.directIp) {
      return { ok: true, ip: maskedIp };
    }
    return { ok: false, reason: res.status };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function removeHealthy(entryKey) {
  STATE.healthy = STATE.healthy.filter((item) => item.key !== entryKey);
  STATE.list.delete(entryKey);
}

async function validate(entry) {
  if (entry.cooledUntil > Date.now()) return;
  const result = await checkProxy(entry);
  if (result.ok) {
    const existing = STATE.healthy.find((item) => item.key === entry.key);
    if (existing) existing.lastVerified = Date.now();
    else if (STATE.healthy.length < CONFIG.maxHealthy) {
      STATE.healthy.push({ key: entry.key, url: entry.url, scheme: entry.scheme, lastVerified: Date.now() });
    }
    STATE.list.set(entry.key, { ...entry, failures: 0 });
  } else {
    entry.failures = (entry.failures || 0) + 1;
    if (entry.failures >= 2) STATE.list.delete(entry.key);
    else {
      entry.cooledUntil = Date.now() + 10 * 60 * 1000;
      STATE.list.set(entry.key, entry);
    }
  }
}

function shuffled(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function validatePool() {
  if (isDisabled()) return;
  await resolveDirectIp();
  const now = Date.now();
  const candidates = shuffled(STATE.list.values())
    .filter((entry) => !STATE.healthy.some((item) => item.key === entry.key) && entry.cooledUntil <= now)
    .slice(0, CONFIG.validateSample);
  for (let i = 0; i < candidates.length; i += CONFIG.concurrency) {
    await Promise.all(candidates.slice(i, i + CONFIG.concurrency).map(validate));
  }
  for (const item of STATE.healthy) {
    if (now - item.lastVerified > CONFIG.revalidateMs) {
      const entry = STATE.list.get(item.key);
      if (entry) await validate(entry);
    }
  }
}

export async function startProxyPool() {
  if (isDisabled()) return;
  if (STATE.refreshPromise) return STATE.refreshPromise;
  STATE.refreshPromise = (async () => {
    await refreshList();
    await validatePool();
    STATE.index = 0;
    STATE.timer = setInterval(async () => {
      STATE.index = 0;
      await refreshList();
      await validatePool();
    }, CONFIG.listTtlMs);
    if (STATE.timer.unref) STATE.timer.unref();
  })();
  await STATE.refreshPromise.catch(() => {});
  return Promise.resolve();
}

export function getHealthyProxy() {
  if (isDisabled() || !STATE.healthy.length) return null;
  const item = STATE.healthy[STATE.index % STATE.healthy.length];
  STATE.index++;
  return item;
}

export function reportProxyFailure(key) {
  const existing = STATE.healthy.find((item) => item.key === key);
  if (existing) {
    const entry = STATE.list.get(key);
    const failures = (entry?.failures ?? 0) + 1;
    if (failures >= 2) STATE.healthy = STATE.healthy.filter((item) => item.key !== key);
    else if (entry) {
      entry.failures = failures;
      entry.cooledUntil = Date.now() + 10 * 60 * 1000;
      STATE.list.set(key, entry);
    }
  }
}

export async function fetchViaProxy(url, options = {}) {
  if (isDisabled() || !STATE.healthy.length) return null;
  const { headers, method = "GET", body } = options;
  const attempts = shuffled(STATE.healthy).slice(0, CONFIG.maxAttempts);
  for (const item of attempts) {
    try {
      const res = await wreqRequest(url, {
        browser: "chrome_149",
        os: "windows",
        proxy: item.url,
        method,
        headers,
        body,
        signal: options.signal ?? AbortSignal.timeout(CONFIG.tryMs),
        redirect: "follow",
      });
      return res;
    } catch (err) {
      reportProxyFailure(item.key);
    }
  }
  return null;
}

function looksBlocked(status) {
  return status === 403 || status === 429 || status >= 500;
}

export function installProxyFetch() {
  if (isDisabled()) return () => {};
  const originalFetch = globalThis.fetch;
  const proxied = async (url, options = {}) => {
    if (!isProxiedTarget(url)) return originalFetch(url, options);
    try {
      const direct = await originalFetch(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(CONFIG.tryMs),
      });
      if (!looksBlocked(direct.status)) return direct;
    } catch {}
    const viaProxy = await fetchViaProxy(url, options);
    if (viaProxy) return viaProxy;
    return originalFetch(url, options);
  };
  globalThis.fetch = proxied;
  return proxied;
}

export function proxyPoolStatus() {
  return {
    disabled: isDisabled(),
    entries: STATE.list.size,
    healthy: STATE.healthy.map((item) => ({ url: item.url, lastVerified: item.lastVerified })),
    directIp: STATE.directIp,
    sources: CONFIG.listUrls.length ? CONFIG.listUrls : DEFAULT_LIST_URLS,
    checkUrl: CONFIG.checkUrl,
  };
}