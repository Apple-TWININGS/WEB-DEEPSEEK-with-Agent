#!/usr/bin/env node
/**
 * DeepSeek Web · local server
 *
 * - Serves the static chat client (whitelisted files only).
 * - Proxies DeepSeek streaming chat without exposing the API key to the page.
 * - Runs a real Agent tool loop with diff-gated writes, .bak backups and a
 *   human approval step, following the safety patterns of Professional Agent.
 *
 * No third-party dependencies. Node >= 20.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import qrcode from "./vendor/qrcode.cjs";

let SOURCE_FILE = "";
try {
  SOURCE_FILE = fileURLToPath(import.meta.url);
} catch {
  SOURCE_FILE = process.argv[1] || "";
}
const ROOT = SOURCE_FILE ? path.dirname(SOURCE_FILE) : process.cwd();
const SEA_ASSETS = typeof globalThis.__DEEPSEEK_SEA_ASSETS__ === "function"
  ? globalThis.__DEEPSEEK_SEA_ASSETS__
  : null;
const DATA_ROOT = globalThis.__DEEPSEEK_SEA_DATA_ROOT__ || process.env.DEEPSEEK_WEB_DATA || ROOT;
const DEFAULT_WORKSPACE = path.join(DATA_ROOT, "agent-workspace");
const SECRETS_PATH = path.join(DATA_ROOT, "secrets.json");
const CONFIG_PATH = path.join(DATA_ROOT, "config.json");
const IMPORT_TOKEN_PATH = path.join(DATA_ROOT, "deepseek-web-token.json");
let WORKSPACE = loadWorkspaceSetting() || DEFAULT_WORKSPACE;
const VERSION = "1.2.7";
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const IS_LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "ds_lan_session";
const sessions = new Map();
const loginAttempts = new Map();
let ACCESS_PASSWORD = String(process.env.ACCESS_PASSWORD || "").trim();
let GENERATED_PASSWORD = false;
if (!ACCESS_PASSWORD && !IS_LOOPBACK) {
  ACCESS_PASSWORD = generateAccessPassword();
  GENERATED_PASSWORD = true;
}
const AUTH_REQUIRED = !!ACCESS_PASSWORD;
const API_BASE = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const CHAT_ENDPOINT = API_BASE.endsWith("/chat/completions") ? API_BASE : API_BASE + "/chat/completions";
const MODELS_ENDPOINT = API_BASE.replace(/\/chat\/completions$/, "") + "/models";
const MODEL_FLASH = process.env.DEEPSEEK_FLASH_MODEL || "deepseek-flash";
const MODEL_PRO = process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro";
const MODEL_CHAT = MODEL_FLASH;
const MODEL_REASONER = MODEL_PRO;
const MODEL_AGENT = process.env.DEEPSEEK_AGENT_MODEL || MODEL_PRO;
const AGENT_EFFORTS = ["none", "low", "high", "max"];
const AGENT_DEFAULT_EFFORT = "high";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_AGENT_ROUNDS = 15;
const MAX_TOOL_CALLS_PER_ROUND = 4;
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const READ_DEFAULT_CHARS = 50000;
const READ_MAX_CHARS = 200000;
const SEARCH_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 60;
const searchCache = new Map();
const SEARCH_PROVIDER = String(process.env.SEARCH_PROVIDER || "auto").toLowerCase();
const SEARXNG_URL = String(process.env.SEARXNG_URL || "").replace(/\/+$/, "");
const SERPER_API_KEY = String(process.env.SERPER_API_KEY || "").trim();
const TAVILY_API_KEY = String(process.env.TAVILY_API_KEY || "").trim();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/markdown.js", "markdown.js"],
  ["/markdown-worker.js", "markdown-worker.js"],
  ["/deepseek-icon.png", "deepseek-icon.png"],
]);

const agentRuns = new Map();

/* ============================================================
   Small utilities
   ============================================================ */
function log(...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}]`, ...args);
}

function normalizeEffort(value, fallback = AGENT_DEFAULT_EFFORT) {
  const effort = String(value || "").toLowerCase();
  return AGENT_EFFORTS.includes(effort) ? effort : fallback;
}

function reasoningPayload(effort) {
  const level = normalizeEffort(effort);
  return level === "none"
    ? { thinking: { type: "disabled" } }
    : { thinking: { type: "enabled" }, reasoning_effort: level };
}

function generateAccessPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  if (!AUTH_REQUIRED) return true;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function createSession(res) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  return token;
}

function clearSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function passwordMatches(input) {
  const a = Buffer.from(String(input || ""));
  const b = Buffer.from(ACCESS_PASSWORD);
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function clientAddress(req) {
  return String(req.socket.remoteAddress || "local");
}

function loginBlocked(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip);
  if (!item || item.reset < now) {
    loginAttempts.delete(ip);
    return false;
  }
  return item.count >= 8;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip);
  if (!item || item.reset < now) loginAttempts.set(ip, { count: 1, reset: now + 60_000 });
  else item.count++;
}

function lanAddresses() {
  const found = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (!found.includes(info.address)) found.push(info.address);
    }
  }
  found.sort((a, b) => {
    const score = (ip) => ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3;
    return score(a) - score(b);
  });
  return found;
}

function lanUrl() {
  if (IS_LOOPBACK) return "";
  const address = HOST === "0.0.0.0" ? (lanAddresses()[0] || "") : HOST;
  if (!address) return "";
  return `http://${address}:${PORT}`;
}

function makeQr(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr;
}

function qrSvg(text) {
  return makeQr(text).createSvgTag(5, 4);
}

function qrTerminal(text) {
  const qr = makeQr(text);
  const count = qr.getModuleCount();
  const quiet = 2;
  const dark = "\x1b[40m  \x1b[0m";
  const light = "\x1b[47m  \x1b[0m";
  const lines = [];
  for (let r = -quiet; r < count + quiet; r++) {
    let line = "";
    for (let c = -quiet; c < count + quiet; c++) {
      const on = r >= 0 && r < count && c >= 0 && c < count && qr.isDark(r, c);
      line += on ? dark : light;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function accessStatus(req) {
  return {
    required: AUTH_REQUIRED,
    authenticated: isAuthenticated(req),
    lan: !IS_LOOPBACK,
    lanUrl: lanUrl(),
    addresses: lanAddresses(),
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  // file:// pages and sandboxed iframes send "Origin: null". Never treat that
  // as same-origin: a localhost service must not accept opaque-origin POSTs.
  if (origin === "null") return false;
  const site = String(req.headers["sec-fetch-site"] || "");
  if (site && site !== "same-origin" && site !== "none") return false;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const protocolOk = parsed.protocol === "http:" || parsed.protocol === "https:";
    return protocolOk && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

function isJsonRequest(req) {
  return String(req.headers["content-type"] || "").toLowerCase().includes("application/json");
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体过大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求体不是合法 JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function abortError() {
  const err = new Error("请求已取消");
  err.name = "AbortError";
  return err;
}

function isAbortError(err) {
  return err && (err.name === "AbortError" || /aborted|取消/i.test(err.message || ""));
}

function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function htmlDecode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return htmlDecode(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/* ============================================================
   Key storage
   ============================================================ */
function readSecrets() {
  try {
    return safeJsonParse(fs.readFileSync(SECRETS_PATH, "utf8"), {}) || {};
  } catch {
    return {};
  }
}

function resolveKey() {
  return String(process.env.DEEPSEEK_API_KEY || readSecrets().api_key || "").trim();
}

function keyStatus() {
  const envKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  const secretKey = String(readSecrets().api_key || "").trim();
  const key = envKey || secretKey;
  let source = "未配置";
  if (envKey) source = "环境变量 DEEPSEEK_API_KEY";
  else if (secretKey) source = "secrets.json";
  return {
    configured: !!key,
    length: key.length,
    source,
    hint: key.length > 12 ? key.slice(0, 5) + "…" + key.slice(-4) : (key ? "已配置" : ""),
  };
}

async function saveApiKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (key && !/^[\x20-\x7E]+$/.test(key)) {
    return { ok: false, error: "Key 里混入了非 ASCII 字符，请重新复制。" };
  }
  if (key && key.length > 400) {
    return { ok: false, error: "Key 长度异常，请检查后重试。" };
  }
  try {
    const data = readSecrets();
    if (key) data.api_key = key;
    else delete data.api_key;
    const tmp = SECRETS_PATH + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    try { await fsp.chmod(tmp, 0o600); } catch { /* Windows may ignore */ }
    await fsp.rename(tmp, SECRETS_PATH);
    const envKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
    let message = key ? "Key 已保存到本机 secrets.json 并立即生效。" : "已清除本机保存的 Key。";
    if (envKey) message = key
      ? "已写入 secrets.json。但环境变量 DEEPSEEK_API_KEY 优先，当前仍使用环境变量。"
      : "已清除 secrets.json 中的 Key，但环境变量 DEEPSEEK_API_KEY 仍然生效。";
    return { ok: true, message, key: keyStatus() };
  } catch (err) {
    return { ok: false, error: "写入 secrets.json 失败：" + err.message };
  }
}

/* ============================================================
   Workspace selection
   ============================================================ */
function readAppConfig() {
  try {
    return safeJsonParse(fs.readFileSync(CONFIG_PATH, "utf8"), {}) || {};
  } catch {
    return {};
  }
}

function loadWorkspaceSetting() {
  const saved = String(readAppConfig().workspace || "").trim();
  if (!saved || !path.isAbsolute(saved)) return "";
  try {
    if (!fs.statSync(saved).isDirectory()) return "";
    return path.resolve(saved);
  } catch {
    return "";
  }
}

function saveWorkspaceSetting(target) {
  const data = readAppConfig();
  if (target) data.workspace = target;
  else delete data.workspace;
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

function isSubPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function validateWorkspaceTarget(input) {
  const target = path.resolve(String(input || "").trim());
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw Object.assign(new Error("目录不存在。"), { status: 400 });
  }
  if (!stat.isDirectory()) throw Object.assign(new Error("请选择一个文件夹，而不是文件。"), { status: 400 });
  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    throw Object.assign(new Error("这个目录不可写。"), { status: 400 });
  }
  if (isSubPath(target, DATA_ROOT)) {
    throw Object.assign(new Error("工作区不能是应用数据目录或其上级目录，否则 Agent 可能读到密钥。"), { status: 400 });
  }
  return target;
}

function browseDirectories(input) {
  if (!input) {
    const entries = [];
    if (process.platform === "win32") {
      for (let i = 65; i <= 90; i++) {
        const root = String.fromCharCode(i) + ":\\";
        try {
          if (fs.statSync(root).isDirectory()) entries.push({ name: root, path: root });
        } catch { /* skip missing drive */ }
      }
    } else {
      entries.push({ name: "/", path: "/" });
    }
    return { path: "", parent: null, entries };
  }
  const target = path.resolve(String(input));
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) throw new Error("不是文件夹。");
  const entries = [];
  const items = fs.readdirSync(target, { withFileTypes: true });
  for (const item of items) {
    if (!item.isDirectory()) continue;
    if (item.name === "$RECYCLE.BIN" || item.name === "System Volume Information") continue;
    entries.push({ name: item.name, path: path.join(target, item.name) });
    if (entries.length >= 300) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, entries };
}

function workspaceInfo() {
  return {
    path: WORKSPACE,
    defaultPath: DEFAULT_WORKSPACE,
    dataRoot: DATA_ROOT,
    exists: fs.existsSync(WORKSPACE),
  };
}

/* ============================================================
   chat.deepseek.com history import
   ============================================================ */
function readImportToken() {
  try {
    const data = safeJsonParse(fs.readFileSync(IMPORT_TOKEN_PATH, "utf8"), {}) || {};
    return typeof data.token === "string" ? data.token : "";
  } catch {
    return "";
  }
}

function saveImportToken(token) {
  const tmp = IMPORT_TOKEN_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ token }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, IMPORT_TOKEN_PATH);
}

function clearImportToken() {
  try { fs.unlinkSync(IMPORT_TOKEN_PATH); } catch { /* already absent */ }
}

function normalizeUserToken(raw) {
  let value = String(raw || "").trim();
  if (!value) throw new Error("请先粘贴 userToken。");
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      value = String(parsed.value || parsed.token || "").trim();
    } catch {
      throw new Error("userToken 的 JSON 格式无法解析。");
    }
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
  }
  if (value.length < 10 || value.length > 20000) throw new Error("userToken 长度异常。");
  return value;
}

function officialHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-app-version": "20240105.0",
    "x-client-locale": "zh_CN",
    "x-device-id": "ds-web-" + crypto.randomBytes(6).toString("hex"),
    "x-os": "web",
    "x-requested-with": "XMLHttpRequest",
    Origin: "https://chat.deepseek.com",
    Referer: "https://chat.deepseek.com/",
    "User-Agent": "Mozilla/5.0",
  };
}

async function officialJson(pathname, token) {
  const res = await fetch("https://chat.deepseek.com" + pathname, {
    headers: officialHeaders(token),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (text.length > 2_000_000) throw new Error("该 DeepSeek 响应超过 2M 字符。");
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("DeepSeek 返回的不是 JSON，可能登录态已失效。"); }
  if (!res.ok) throw new Error("DeepSeek 返回 HTTP " + res.status);
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(String(data.msg || "DeepSeek 接口返回错误 code=" + data.code));
  }
  if (data.data && data.data.biz_code !== undefined && data.data.biz_code !== 0) {
    throw new Error(String(data.data.biz_msg || "DeepSeek 接口返回业务错误"));
  }
  return data;
}

function officialSessions(data) {
  const root = (data && data.data) || data || {};
  const biz = root.biz_data || root;
  const list = biz.chat_sessions || biz.sessions || biz.chat_session_list || biz.list;
  return (Array.isArray(list) ? list : []).map((item) => ({
    id: String(item.id || item.chat_session_id || ""),
    title: String(item.title || "").slice(0, 160),
    updatedAt: item.updated_at || item.updatedAt || item.inserted_at || null,
  })).filter((item) => item.id);
}

function officialMessageText(message) {
  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  const pick = (type) => fragments
    .filter((f) => f && String(f.type || "").toUpperCase() === type)
    .map((f) => typeof f.content === "string" ? f.content : legacyValue(f.content))
    .filter((s) => s && s.trim())
    .join("\n\n");
  return {
    user: pick("REQUEST"),
    answer: pick("RESPONSE"),
    reasoning: pick("THINK"),
    fallback: legacyValue(message.content),
  };
}

function legacyValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => item && (item.text || item.content) ? String(item.text || item.content) : "").join("\n");
  if (typeof value === "object") return String(value.text || value.content || "");
  return String(value);
}

function officialMessages(data) {
  const root = (data && data.data) || data || {};
  const biz = root.biz_data || root;
  const list = biz.chat_messages || biz.messages || biz.chat_message_list || biz.history || biz.message_list;
  const rows = Array.isArray(list) ? list : [];
  const out = [];
  for (const message of rows) {
    const role = String(message.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    const text = officialMessageText(message);
    const content = role === "user" ? (text.user || text.fallback) : (text.answer || text.fallback);
    if (!content && !text.reasoning) continue;
    const seconds = Number(message.inserted_at);
    const createdAt = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
    out.push({
      role,
      content: content || (role === "user" ? "（附件消息，没有文字）" : "（这条回复没有正文）"),
      reasoning: role === "assistant" ? text.reasoning || "" : "",
      createdAt,
    });
  }
  return out;
}

/* ============================================================
   SSE helpers
   ============================================================ */
function startSSE(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  const timer = setInterval(() => {
    if (!closed) {
      try { res.write(": ping\n\n"); } catch { closed = true; }
    }
  }, 15000);

  return {
    send(event) {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    },
    end() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { res.end(); } catch { /* already gone */ }
    },
    get closed() { return closed; },
  };
}

/* ============================================================
   Web search (DuckDuckGo HTML, fallback Bing RSS)
   ============================================================ */
async function fetchWithTimeout(url, options, ms) {
  const timeout = AbortSignal.timeout(ms);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return fetch(url, { ...options, signal });
}

function decodeDdgUrl(href) {
  let url = htmlDecode(href);
  if (url.startsWith("//")) url = "https:" + url;
  try {
    const parsed = new URL(url);
    const target = parsed.searchParams.get("uddg");
    if (target) return decodeURIComponent(target);
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname === "/l/") {
      const target2 = parsed.searchParams.get("uddg");
      if (target2) return decodeURIComponent(target2);
    }
  } catch { /* ignore */ }
  return url;
}

async function searchDuckDuckGo(query, limit) {
  const res = await fetchWithTimeout(
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml",
      },
    },
    12000
  );
  if (!res.ok) throw new Error("搜索服务返回 " + res.status);
  const html = await res.text();
  const blocks = html.split(/<div[^>]*class="[^"]*result\s+results_links[^"]*"[^>]*>/i).slice(1);
  const results = [];
  for (const block of blocks) {
    const link = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippetMatch =
      block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const url = decodeDdgUrl(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/duckduckgo\.com\/y\.js|ad_domain|bing\.com\/aclick/i.test(url)) continue;
    results.push({
      title: stripTags(link[2]),
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : "",
    });
    if (results.length >= limit) break;
  }
  if (!results.length) throw new Error("没有解析到搜索结果");
  return results;
}

async function searchBingRss(query, limit) {
  const res = await fetchWithTimeout(
    "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(query),
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    },
    12000
  );
  if (!res.ok) throw new Error("搜索服务返回 " + res.status);
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const results = [];
  for (const item of items) {
    const title = item.match(/<title>([\s\S]*?)<\/title>/i);
    const link = item.match(/<link>([\s\S]*?)<\/link>/i);
    const desc = item.match(/<description>([\s\S]*?)<\/description>/i);
    if (!link) continue;
    const url = htmlDecode(link[1]).replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: title ? stripTags(title[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : url,
      url,
      snippet: desc ? stripTags(desc[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "",
    });
    if (results.length >= limit) break;
  }
  if (!results.length) throw new Error("没有解析到搜索结果");
  return results;
}

async function searchSearxng(query, limit) {
  if (!SEARXNG_URL) throw new Error("未配置 SEARXNG_URL");
  const endpoint = SEARXNG_URL.endsWith("/search") ? SEARXNG_URL : SEARXNG_URL + "/search";
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "zh-CN");
  url.searchParams.set("safesearch", "0");
  const res = await fetchWithTimeout(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "DeepSeek-Web/1.2" },
  }, 12000);
  if (!res.ok) throw new Error("SearXNG 返回 " + res.status);
  const data = await res.json();
  const rows = Array.isArray(data.results) ? data.results : [];
  return rows.slice(0, limit).map((r) => ({
    title: stripTags(r.title || r.url),
    url: r.url,
    snippet: stripTags(r.content || r.snippet || ""),
  }));
}

async function searchSerper(query, limit) {
  if (!SERPER_API_KEY) throw new Error("未配置 SERPER_API_KEY");
  const res = await fetchWithTimeout("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": SERPER_API_KEY,
      Accept: "application/json",
    },
    body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: limit }),
  }, 12000);
  if (!res.ok) throw new Error("Serper 返回 " + res.status);
  const data = await res.json();
  return (Array.isArray(data.organic) ? data.organic : []).slice(0, limit).map((r) => ({
    title: stripTags(r.title || r.link),
    url: r.link,
    snippet: stripTags(r.snippet || ""),
  }));
}

async function searchTavily(query, limit) {
  if (!TAVILY_API_KEY) throw new Error("未配置 TAVILY_API_KEY");
  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: limit,
      include_answer: false,
    }),
  }, 12000);
  if (!res.ok) throw new Error("Tavily 返回 " + res.status);
  const data = await res.json();
  return (Array.isArray(data.results) ? data.results : []).slice(0, limit).map((r) => ({
    title: stripTags(r.title || r.url),
    url: r.url,
    snippet: stripTags(r.content || ""),
  }));
}

function configuredSearchProviders() {
  const plan = [];
  if (SEARCH_PROVIDER === "auto") {
    if (SEARXNG_URL) plan.push({ name: "searxng", fn: searchSearxng });
    if (SERPER_API_KEY) plan.push({ name: "serper", fn: searchSerper });
    if (TAVILY_API_KEY) plan.push({ name: "tavily", fn: searchTavily });
    plan.push({ name: "duckduckgo", fn: searchDuckDuckGo });
    plan.push({ name: "bing-rss", fn: searchBingRss });
    return plan;
  }
  if (SEARCH_PROVIDER === "searxng" && SEARXNG_URL) plan.push({ name: "searxng", fn: searchSearxng });
  if (SEARCH_PROVIDER === "serper" && SERPER_API_KEY) plan.push({ name: "serper", fn: searchSerper });
  if (SEARCH_PROVIDER === "tavily" && TAVILY_API_KEY) plan.push({ name: "tavily", fn: searchTavily });
  if (SEARCH_PROVIDER === "ddg" || SEARCH_PROVIDER === "duckduckgo") plan.push({ name: "duckduckgo", fn: searchDuckDuckGo });
  if (SEARCH_PROVIDER === "bing" || SEARCH_PROVIDER === "bing-rss") plan.push({ name: "bing-rss", fn: searchBingRss });
  return plan;
}

function searchProviderNames() {
  return configuredSearchProviders().map((p) => p.name);
}

async function webSearch(query, limit = 6) {
  const q = truncate(String(query || "").replace(/\s+/g, " ").trim(), 240);
  if (!q) throw new Error("搜索词为空");
  const cacheKey = q.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEARCH_TTL_MS) {
    return cached.results.slice(0, limit);
  }

  const errors = [];
  const providers = configuredSearchProviders();
  if (!providers.length) {
    throw new Error("没有可用的搜索服务，请配置 SEARXNG_URL、SERPER_API_KEY 或 TAVILY_API_KEY");
  }
  for (const provider of providers) {
    try {
      const results = await provider.fn(q, limit);
      const unique = [];
      const seen = new Set();
      for (const item of results) {
        if (!/^https?:\/\//i.test(item.url) || seen.has(item.url)) continue;
        seen.add(item.url);
        unique.push(item);
      }
      if (!unique.length) throw new Error("搜索结果为空");
      searchCache.set(cacheKey, { ts: Date.now(), results: unique });
      while (searchCache.size > SEARCH_CACHE_MAX) {
        searchCache.delete(searchCache.keys().next().value);
      }
      return unique.slice(0, limit);
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error("联网搜索失败：" + errors.join("；"));
}

function formatSearchForModel(results) {
  return results.map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n摘要: ${truncate(r.snippet, 360)}`
  ).join("\n\n");
}

/* ============================================================
   Model API
   ============================================================ */
function mapUpstreamError(status, text) {
  let detail = "";
  const parsed = safeJsonParse(text);
  if (parsed) {
    detail = parsed.error?.message || parsed.message || parsed.error || "";
  }
  if (!detail) detail = truncate(String(text || "").replace(/\s+/g, " "), 240);
  if (status === 401) return new Error("API Key 无效或已过期（401）。请在设置中重新填写。");
  if (status === 402) return new Error("DeepSeek 账户余额不足（402）。");
  if (status === 429) return new Error("请求过于频繁（429），请稍后再试。");
  if (status === 400) return new Error("模型请求参数错误（400）：" + detail);
  if (status >= 500) return new Error("模型服务暂时不可用（" + status + "）。");
  return new Error("模型接口错误（" + status + "）：" + detail);
}

async function requestModel(payload, signal) {
  const key = resolveKey();
  if (!key) {
    const err = new Error("还没有配置 API Key。");
    err.code = "NO_KEY";
    throw err;
  }
  const timeout = AbortSignal.timeout(120000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(payload),
    signal: combined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw mapUpstreamError(res.status, text);
  }
  return res;
}

async function readModelStream(res, onDelta) {
  if (!res.body) throw new Error("模型没有返回流式响应。");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finishReason = "";
  let usage = null;
  const calls = new Map();

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const data = dataLines.join("\n");
      if (!data || data === "[DONE]") continue;
      const obj = safeJsonParse(data);
      if (!obj) continue;
      if (obj.usage) usage = obj.usage;
      const choice = obj.choices && obj.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onDelta?.({ reasoning: delta.reasoning_content });
      }
      if (delta.content) {
        content += delta.content;
        onDelta?.({ content: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const index = Number.isInteger(tc.index) ? tc.index : 0;
        const current = calls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) current.id = tc.id;
        if (tc.type) current.type = tc.type;
        if (tc.function?.name) current.function.name = tc.function.name;
        if (tc.function?.arguments) current.function.arguments += tc.function.arguments;
        calls.set(index, current);
      }
    }
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c], i) => ({
      id: c.id || "call_" + i,
      type: "function",
      function: { name: c.function.name, arguments: c.function.arguments || "{}" },
    }));

  return { content, reasoning, toolCalls, finishReason, usage };
}

async function readModelJson(res) {
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("模型返回了空结果。");
  const msg = choice.message || {};
  return {
    content: msg.content || "",
    reasoning: msg.reasoning_content || "",
    toolCalls: msg.tool_calls || [],
    finishReason: choice.finish_reason || "",
    usage: data.usage || null,
  };
}

/* ============================================================
   Chat route
   ============================================================ */
function normalizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input.slice(-30)) {
    if (!m || (m.role !== "user" && m.role !== "assistant" && m.role !== "system")) continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    out.push({ role: m.role, content: truncate(m.content, 48000) });
  }
  return out;
}

function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

async function maybeSearchForChat(messages, sse) {
  const query = lastUserContent(messages);
  if (!query) return messages;
  try {
    const results = await webSearch(query, 5);
    sse.send({
      type: "search",
      query: truncate(query, 120),
      sources: results.map((r) => ({ title: r.title, url: r.url, snippet: truncate(r.snippet, 240) })),
    });
    const context = [
      "以下是刚刚获取的联网搜索结果。请结合这些资料回答，引用时在句末标注 [1]、[2] 这样的编号。",
      "如果资料与问题无关，可以忽略，不要编造来源。",
      "",
      formatSearchForModel(results),
    ].join("\n");
    return [{ role: "system", content: context }, ...messages];
  } catch (err) {
    sse.send({ type: "search_error", message: truncate(err.message, 200) });
    return messages;
  }
}

async function handleChat(req, res, body) {
  const key = resolveKey();
  if (!key) return sendJson(res, 401, { error: "还没有配置 API Key。请先在设置中填写。" });
  const messages = normalizeMessages(body.messages);
  if (!messages.length) return sendJson(res, 400, { error: "消息不能为空。" });

  const legacyReasoner = body.model === "deepseek-reasoner";
  const wantsPro = body.model === "pro" || body.model === "deepseek-v4-pro" || body.model === MODEL_PRO || legacyReasoner;
  const model = wantsPro ? MODEL_PRO : MODEL_FLASH;
  const deepThink = body.deepThink === true || body.thinking === true || legacyReasoner;
  const sse = startSSE(res);
  const controller = new AbortController();
  let clientClosed = false;
  res.on("close", () => {
    clientClosed = true;
    if (!res.writableEnded) controller.abort();
  });

  try {
    let finalMessages = messages;
    if (body.webSearch) {
      finalMessages = await maybeSearchForChat(messages, sse);
    }
    sse.send({ type: "meta", model, search: !!body.webSearch, deepThink });

    const payload = {
      model,
      messages: finalMessages,
      stream: true,
      max_tokens: deepThink ? 8192 : 4096,
      ...reasoningPayload(deepThink ? "high" : "none"),
    };
    if (!deepThink) payload.temperature = 0.7;

    const upstream = await requestModel(payload, controller.signal);
    const result = await readModelStream(upstream, (delta) => {
      if (delta.reasoning) sse.send({ type: "reasoning", text: delta.reasoning });
      if (delta.content) sse.send({ type: "delta", text: delta.content });
    });

    if (!result.content.trim()) {
      if (result.reasoning.trim()) {
        sse.send({ type: "delta", text: result.reasoning });
      } else {
        throw new Error("模型没有返回内容，请重试。");
      }
    }
    if (result.finishReason === "length") {
      sse.send({ type: "delta", text: "\n\n…（回答达到长度上限，已截断）" });
    }
    sse.send({
      type: "usage",
      usage: result.usage || undefined,
      finishReason: result.finishReason || undefined,
    });
    sse.send({ type: "done" });
  } catch (err) {
    if (!clientClosed && !isAbortError(err)) {
      sse.send({ type: "error", message: friendlyModelError(err) });
    }
  } finally {
    sse.end();
  }
}

function friendlyModelError(err) {
  if (isAbortError(err)) return "模型请求超时或已取消。";
  const m = err?.message || "未知错误";
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(m)) {
    return "无法连接 DeepSeek 接口，请检查网络或代理。";
  }
  return m;
}

/* ============================================================
   Agent workspace + tools
   ============================================================ */
function workspacePath(rel, workspace = WORKSPACE) {
  const raw = String(rel || "").trim().replace(/\\/g, "/");
  if (!raw) throw new Error("缺少相对路径。");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\u0000")) {
    throw new Error("只允许当前工作区内的相对路径。");
  }
  const parts = raw.split("/");
  if (parts.some((p) => p === ".." || p === "")) throw new Error("路径包含非法片段。");
  const root = path.resolve(workspace || WORKSPACE);
  const abs = path.resolve(root, raw);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("路径越出了当前工作区。");
  }
  return { rel: path.relative(root, abs).replace(/\\/g, "/"), abs };
}

function allowedExtension(rel) {
  const ext = path.extname(rel).toLowerCase();
  return new Set([
    ".md", ".markdown", ".txt", ".json", ".csv", ".html", ".css", ".svg",
    ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".yml", ".yaml", ".xml", ".sql",
  ]).has(ext);
}

async function readWorkspaceText(rel, maxChars = READ_DEFAULT_CHARS, offset = 0, workspace = WORKSPACE) {
  const { rel: clean, abs } = workspacePath(rel, workspace);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error("不是文件：" + clean);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error("文件太大（" + Math.round(st.size / 1024 / 1024) + " MB），上限 " + Math.round(MAX_FILE_BYTES / 1024 / 1024) + " MB。");
  }
  const buffer = await fsp.readFile(abs);
  let text = buffer.toString("utf8");
  // Recover common Chinese legacy encodings instead of sending a screen of U+FFFD.
  if (text.includes("\uFFFD")) {
    try {
      const alt = new TextDecoder("gb18030").decode(buffer);
      if (alt && !alt.includes("\uFFFD")) text = alt;
    } catch { /* not available */ }
  }
  const totalChars = text.length;
  const start = clampInteger(offset, 0, totalChars, 0);
  const limit = clampInteger(maxChars, 1000, READ_MAX_CHARS, READ_DEFAULT_CHARS);
  const end = Math.min(totalChars, start + limit);
  return {
    rel: clean,
    abs,
    size: st.size,
    text: text.slice(start, end),
    totalChars,
    start,
    end,
    nextOffset: end < totalChars ? end : null,
  };
}

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function listWorkspace(rel = "", depth = 3, workspace = WORKSPACE) {
  const base = path.resolve(workspace || WORKSPACE);
  let root = base;
  if (rel) {
    const target = workspacePath(rel, base);
    root = target.abs;
  }
  await fsp.mkdir(base, { recursive: true });
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) throw new Error("不是文件夹：" + (rel || "工作区根目录"));
  const maxDepth = clampInteger(depth, 1, 3, 3);
  const entries = [];
  let truncated = false;

  async function walk(dir, level) {
    if (entries.length >= 200) {
      truncated = true;
      return;
    }
    const items = await fsp.readdir(dir, { withFileTypes: true });
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"));
    for (const item of items) {
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      const abs = path.join(dir, item.name);
      const relPath = path.relative(base, abs).replace(/\\/g, "/");
      if (item.isDirectory()) {
        entries.push({ name: relPath + "/", dir: true, size: 0 });
        if (level < maxDepth) await walk(abs, level + 1);
      } else {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* ignore */ }
        entries.push({ name: relPath, dir: false, size });
      }
      if (entries.length >= 200) {
        truncated = true;
        break;
      }
    }
  }

  await walk(root, 1);
  return { entries, truncated, root: rel || "" };
}

function diffLines(oldText, newText, rel) {
  const a = String(oldText ?? "").split(/\r?\n/);
  const b = String(newText ?? "").split(/\r?\n/);
  const n = a.length;
  const m = b.length;

  if (!oldText && newText) {
    return [
      "--- /dev/null",
      "+++ b/" + rel,
      `@@ -0,0 +1,${m} @@`,
      ...b.map((line) => "+" + line),
    ].join("\n");
  }

  // Large files: show a compact prefix/suffix diff instead of a quadratic table.
  if (n > 900 || m > 900) {
    let start = 0;
    while (start < n && start < m && a[start] === b[start]) start++;
    let endA = n - 1;
    let endB = m - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
    const del = a.slice(start, endA + 1);
    const add = b.slice(start, endB + 1);
    return [
      "--- a/" + rel,
      "+++ b/" + rel,
      `@@ -${start + 1},${del.length} +${start + 1},${add.length} @@`,
      ...del.slice(0, 180).map((line) => "-" + line),
      ...add.slice(0, 180).map((line) => "+" + line),
      ...(del.length > 180 || add.length > 180 ? ["…（文件较大，diff 已截断）"] : []),
    ].join("\n");
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i++] });
    } else {
      ops.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });

  const changed = ops.map((op, idx) => op.type === "same" ? -1 : idx).filter((idx) => idx >= 0);
  if (!changed.length) return "(无变化)";

  const hunks = [];
  let groupStart = changed[0];
  let groupEnd = changed[0];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - groupEnd <= 6) groupEnd = changed[k];
    else {
      hunks.push([groupStart, groupEnd]);
      groupStart = changed[k];
      groupEnd = changed[k];
    }
  }
  hunks.push([groupStart, groupEnd]);

  const out = ["--- a/" + rel, "+++ b/" + rel];
  for (const [first, last] of hunks) {
    const start = Math.max(0, first - 3);
    const end = Math.min(ops.length - 1, last + 3);
    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k].type !== "add") oldStart++;
      if (ops[k].type !== "del") newStart++;
    }
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((op) => op.type !== "add").length;
    const newCount = slice.filter((op) => op.type !== "del").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      out.push((op.type === "add" ? "+" : op.type === "del" ? "-" : " ") + op.text);
    }
  }
  return out.join("\n");
}

function validateFileContent(rel, content) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".json") {
    try { JSON.parse(content); }
    catch (err) { return "JSON 语法检查未通过：" + err.message; }
  }
  if (ext === ".html" && /<script[^>]*src=["']https?:/i.test(content)) {
    return "HTML 里引用了外部脚本。出于安全考虑，Agent 只写入自包含文件。";
  }
  if (ext === ".svg" && /<script|foreignObject|javascript:|\son\w+\s*=/i.test(content)) {
    return "SVG 含脚本或事件处理器。出于安全考虑，只允许纯静态矢量图。";
  }
  return "";
}

async function writeFileAtomic(abs, content) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + ".tmp-" + crypto.randomBytes(4).toString("hex");
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, abs);
}

async function backupFile(abs) {
  try {
    await fsp.access(abs);
  } catch {
    return false;
  }
  try {
    await fsp.access(abs + ".bak");
    await fsp.copyFile(abs + ".bak", abs + ".bak.1");
  } catch { /* no previous backup */ }
  await fsp.copyFile(abs, abs + ".bak");
  return true;
}

function artifactFor(rel, size, workspace) {
  const base = "/api/files/" + rel.split("/").map(encodeURIComponent).join("/");
  return {
    name: path.basename(rel),
    path: rel,
    size,
    url: base + (workspace ? "?ws=" + encodeURIComponent(workspace) : ""),
  };
}

function requestConfirmation(run, sse, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      run.pending.delete(payload.callId);
      resolve({ approved: false, timedOut: true });
    }, CONFIRM_TIMEOUT_MS);
    run.pending.set(payload.callId, {
      resolve: (value) => {
        clearTimeout(timer);
        run.pending.delete(payload.callId);
        resolve(value);
      },
      timer,
    });
    sse.send({
      type: "confirmation_required",
      id: payload.stepId,
      callId: payload.callId,
      runId: run.id,
      path: payload.rel,
      diff: truncate(payload.diff, 14000),
      isNew: payload.isNew,
      preview: truncate(payload.preview, 1800),
    });
  });
}

function toolLabel(name) {
  return {
    web_search: "联网搜索",
    read_file: "读取文件",
    list_files: "查看工作区",
    write_file: "写入文件",
    task_plan: "更新任务计划",
    get_current_time: "获取当前时间",
  }[name] || name;
}

function toolDetail(name, args) {
  if (name === "web_search") return truncate(args.query || "", 180);
  if (name === "read_file") return truncate(args.path || "", 180);
  if (name === "write_file") return truncate((args.dry_run ? "[预演] " : "") + (args.path || ""), 180);
  if (name === "task_plan") return args.action === "read" ? "读取当前计划" : "更新计划";
  if (name === "get_current_time") return "本地时间";
  return "";
}

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索最新资料。需要事实、新闻、产品或技术资料时调用。返回标题、链接和摘要。不要编造搜索结果。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词，尽量具体" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "分块读取当前工作区内的一个文本文件。大文件请使用 offset/limit 继续读取，不要一次读完。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对当前工作区的路径，例如 notes.md" },
          offset: { type: "number", description: "从第几个字符开始读，默认 0" },
          limit: { type: "number", description: "本次最多读取多少字符，默认 50000，最大 200000" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出当前工作区或子目录里的文件与目录，默认递归三层（最多 200 项）。如果文件在项目子目录里，用 path 指定目录，不要只看根目录就断言文件不存在。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对当前工作区的目录，省略则列出根目录，例如 villa-design" },
          depth: { type: "number", description: "递归深度 1-3，默认 3" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "在当前工作区内创建、覆盖或追加一个文本文件。单次 content 硬上限 2 MB；文件上限 24 MB。大文件用 append=true 追加。正式写入前系统会展示 diff 并等待用户确认；dry_run=true 只预演。修改已有文件会自动备份 .bak（上一代 .bak.1）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对当前工作区的路径，例如 reports/analysis.md" },
          content: { type: "string", description: "本次写入的内容；大文件分块写入，不要省略" },
          append: { type: "boolean", description: "true = 追加到现有文件末尾；false/省略 = 覆盖" },
          dry_run: { type: "boolean", description: "true = 只生成 diff 预览，不写入" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_plan",
      description: "读写落盘的任务计划（agent-workspace/.task-plan.md）。用于在长任务中记录进度和下一步。action=read 或 write。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "write"] },
          content: { type: "string", description: "action=write 时的新计划，建议用短清单" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前本地日期与时间。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

async function executeAgentTool(name, args, ctx) {
  const { run, sse, stepId, callId } = ctx;
  if (name === "web_search") {
    const query = String(args.query || "").trim();
    if (!query) return { ok: false, summary: "没有提供搜索词。", modelText: "错误：query 不能为空。" };
    const results = await webSearch(query, 6);
    const sources = results.map((r) => ({ title: r.title, url: r.url, snippet: truncate(r.snippet, 240) }));
    return {
      ok: true,
      summary: "找到 " + results.length + " 个网页",
      modelText: "联网搜索结果：\n\n" + formatSearchForModel(results),
      sources,
    };
  }

  if (name === "read_file") {
    const offset = clampInteger(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clampInteger(args.limit, 1000, READ_MAX_CHARS, READ_DEFAULT_CHARS);
    const file = await readWorkspaceText(args.path, limit, offset, run.workspace);
    const next = file.nextOffset == null ? "已到文件末尾" : `下一段从 offset=${file.nextOffset} 继续`;
    return {
      ok: true,
      summary: `已读取 ${file.start}-${file.end}/${file.totalChars} 字符`,
      modelText: `文件 ${file.rel}（${file.size} 字节，共 ${file.totalChars} 字符）\n读取范围：${file.start}-${file.end}；${next}\n\n\`\`\`\n${file.text}\n\`\`\``,
    };
  }

  if (name === "list_files") {
    const depth = clampInteger(args.depth, 1, 3, 3);
    const result = await listWorkspace(String(args.path || ""), depth, run.workspace);
    const files = result.entries;
    const text = files.length
      ? files.map((f) => `- ${f.name}${f.dir ? "" : "  (" + (f.size >= 1024 ? (f.size / 1024).toFixed(1) + " KB" : f.size + " B") + ")"}`).join("\n")
      : "(该目录为空)";
    return {
      ok: true,
      summary: files.length + " 个条目（含子目录）" + (result.truncated ? "，已截断" : ""),
      modelText: `当前工作区${result.root ? " / " + result.root : ""}（递归 ${depth} 层，最多 200 项）：\n` + text +
        (result.truncated ? "\n\n（条目过多，已截断；请用 path 缩小范围。）" : ""),
    };
  }

  if (name === "get_current_time") {
    const text = new Date().toLocaleString("zh-CN", { hour12: false });
    return { ok: true, summary: text, modelText: "当前本地时间：" + text };
  }

  if (name === "task_plan") {
    if (args.action === "read") {
      try {
        const file = await readWorkspaceText(".task-plan.md", 20000, 0, run.workspace);
        return { ok: true, summary: "已读取计划", modelText: "当前任务计划：\n" + file.text };
      } catch {
        return { ok: true, summary: "暂无计划", modelText: "当前没有落盘的任务计划。" };
      }
    }
    const content = String(args.content || "").trim();
    if (!content) return { ok: false, summary: "计划内容为空。", modelText: "错误：content 不能为空。" };
    await writeFileAtomic(path.join(run.workspace, ".task-plan.md"), content + "\n");
    const steps = content.split(/\r?\n/).map((l) => l.replace(/^[-*\d.、)\s]+/, "").trim()).filter(Boolean).slice(0, 8);
    sse.send({ type: "plan", steps });
    return { ok: true, summary: "计划已更新", modelText: "任务计划已更新：\n" + content };
  }

  if (name === "write_file") {
    const content = String(args.content ?? "");
    if (!content) return { ok: false, summary: "文件内容为空。", modelText: "错误：content 不能为空。" };
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return {
        ok: false,
        summary: `单次内容超过 ${MAX_WRITE_BYTES / 1024 / 1024} MB。`,
        modelText: `错误：单次 content 超过 ${MAX_WRITE_BYTES / 1024 / 1024} MB。请用 append=true 分块写入，或拆成多个文件。`,
      };
    }
    const { rel, abs } = workspacePath(args.path, run.workspace);
    if (!allowedExtension(rel)) {
      return { ok: false, summary: "不支持的文件类型。", modelText: "错误：只允许写入文本类文件（.md/.txt/.json/.csv/.html/.css/.svg/.js/.ts/.py/.yml/.xml/.sql）。" };
    }
    let oldText = "";
    let isNew = true;
    try {
      const old = await fsp.readFile(abs, "utf8");
      oldText = old;
      isNew = false;
    } catch {
      oldText = "";
      isNew = true;
    }
    const append = !!args.append && !isNew;
    const nextContent = append ? oldText + content : content;
    const finalSize = Buffer.byteLength(nextContent, "utf8");
    if (finalSize > MAX_FILE_BYTES) {
      return {
        ok: false,
        summary: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限。`,
        modelText: "错误：最终文件过大，请拆分文件或先清理内容。",
      };
    }
    const validation = validateFileContent(rel, nextContent);
    if (validation) {
      return { ok: false, summary: "写入前检查未通过。", modelText: "错误：" + validation + " 未写入任何文件。" };
    }
    const diff = diffLines(oldText, nextContent, rel);
    const dryRun = !!args.dry_run;
    if (dryRun) {
      return {
        ok: true,
        summary: "预演完成（未写入）：" + diff.split("\n").filter((l) => /^[+-]/.test(l)).length + " 行变更",
        modelText: `写入预演（未写入）${rel}${append ? "（追加）" : ""}：\n\n\`\`\`diff\n${truncate(diff, 12000)}\n\`\`\`\n\n如果确认无误，请再次调用 write_file，并把 dry_run 设为 false。`,
        diff,
      };
    }
    let decision;
    if (run.fullAccess) {
      decision = { approved: true, auto: true };
      sse.send({ type: "full_access_write", id: stepId, path: rel });
    } else {
      decision = await requestConfirmation(run, sse, {
        stepId, callId, rel, diff, isNew, preview: nextContent.slice(0, 1800),
      });
      sse.send({ type: "confirmation_result", id: stepId, approved: !!decision.approved, timedOut: !!decision.timedOut });
    }
    if (!decision.approved) {
      return {
        ok: false,
        summary: decision.timedOut ? "等待确认超时，未写入。" : "用户拒绝写入，未改动文件。",
        modelText: (decision.timedOut
          ? "用户确认超时。文件没有写入。"
          : "用户拒绝了这次写入。文件没有改动。") + "请根据反馈调整，不要声称已经写入。",
        rejected: true,
      };
    }
    if (run.controller.signal.aborted) throw abortError();
    const hadBackup = await backupFile(abs);
    await writeFileAtomic(abs, nextContent);
    const written = await fsp.stat(abs);
    if (written.size !== finalSize) {
      return {
        ok: false,
        summary: "写入后回读校验失败。",
        modelText: `错误：文件写入后大小不一致（期望 ${finalSize}，实际 ${written.size}），请检查磁盘空间或权限。`,
      };
    }
    const artifact = artifactFor(rel, finalSize, run.workspace);
    return {
      ok: true,
      summary: "已写入 " + rel + (hadBackup ? "（已备份 .bak）" : "（新文件）"),
      modelText: `已${append ? "追加" : "写入"} ${rel}，当前共 ${nextContent.split("\n").length} 行，${finalSize} 字节。` +
        (hadBackup ? "原文件已备份为 .bak，上一代在 .bak.1。" : "这是一个新文件。"),
      artifact,
      diff,
      autoApproved: !!decision.auto,
    };
  }

  return { ok: false, summary: "未知工具。", modelText: "错误：未知工具 " + name };
}

function agentSystemPrompt(workspace = WORKSPACE) {
  return [
    "你是 DeepSeek Agent，运行在一个以对话为主的本地网页端。用户显式切换到 Agent 模式，才执行多步任务。",
    "",
    `工作区：${workspace}。所有文件工具只能使用相对此目录的路径，不能访问工作区之外。`,
    "",
    "工作方式：",
    "1. 先理解目标和约束，用一两句话说明你准备怎么做，然后调用工具推进。",
    "2. 需要实时资料时调用 web_search，不要编造搜索结果；引用资料时使用 [1] 这样的编号。",
    "3. 写文件必须调用 write_file。系统会自动生成 diff 并向用户请求确认；只有工具返回 ok=true 才算写入成功。确认超时、拒绝或失败时，必须明确说文件未写入，不能声称成功。",
    "4. 修改已有文件前，可以先调用 write_file 并设置 dry_run=true 预演；确认无误后再正式写入。",
    "5. 用 task_plan 维护任务状态，尤其是步骤较多的任务。每完成一个阶段就更新一次。",
    "6. 不要请求执行 shell，不要读取工作区之外的路径，不要输出或猜测 API Key。",
    "7. 如果用户拒绝写入，明确说明文件未改动，并根据反馈调整。",
    "8. 写文档可以一次写较长的内容，单次 content 硬上限是 2 MB；超长内容用 append=true 分块，文件上限 24 MB。读大文件用 read_file 的 offset/limit 继续读。一次写不完就分多次 append，不要反复原样重试。",
    "9. 多文件任务先用 task_plan 落一份清单，每完成一项更新进度；轮次有限（15 轮），不要把预算浪费在重复读同一个文件上。",
    "10. list_files 默认递归三层；如果文件在项目子目录，用 path 指定目录查看。不要因为根目录只看到文件夹就断言文件不存在；写完产出后要用 read_file 或 list_files 再确认。",
    "11. 能力边界：可以写文本/Markdown/ASCII 图/代码、生成 SVG 矢量示意图（平面草图、流程图、架构图）、读写文件、搜索网页；不能生成照片级位图、CAD 二进制、视频或施工级图纸。遇到画图请求时，不要直接说做不到，先提出用 SVG 示意图替代；再问最多 3 个关键问题，其余参数给默认值。",
    "12. 最终用中文 Markdown 总结：完成了什么、产出文件在哪里、下一步建议。未完成的步骤必须明确列出，不要只写「已完成」。",
    "",
    "当前时间：" + new Date().toLocaleString("zh-CN", { hour12: false }),
    "对话是默认入口；Agent 只在被明确需要时工作，不要为了展示能力而调用无关工具。",
  ].join("\n");
}

function evidenceSummary(evidence) {
  if (!evidence.length) return "（这一轮没有产生工具结果）";
  return evidence.slice(-10).map((item, i) => `- ${item.tool}: ${truncate(item.text, 220)}`).join("\n");
}

function gapSuffix(unfinished) {
  if (!unfinished || !unfinished.length) return "";
  const unique = [...new Set(unfinished)].slice(0, 8);
  return "\n\n---\n### 未完成 / 需要你确认\n" + unique.map((item) => "- " + item).join("\n");
}

async function finalizeWithEvidence(messages, evidence, run, unfinished = []) {
  const evidenceText = evidenceSummary(evidence);
  const instruction = [
    "工具轮次已经用尽。不要再调用任何工具。",
    "请只基于上面的工具结果，用中文给出最终答复。",
    "如果证据不足，如实说明缺口，不要编造。",
    "不要声称未实际完成的操作已经完成。",
    "",
    "【这一轮已经拿到的工具结果】",
    evidenceText,
    unfinished.length ? "\n【已知未完成项】\n" + unfinished.map((x) => "- " + x).join("\n") : "",
  ].join("\n");
  try {
    const res = await requestModel({
      model: run.model || MODEL_AGENT,
      messages: messages.concat([{ role: "user", content: instruction }]),
      stream: false,
      max_tokens: 2400,
      temperature: 0.3,
      ...reasoningPayload(run.effort || AGENT_DEFAULT_EFFORT),
    }, run.controller.signal);
    const data = await readModelJson(res);
    const text = (data.content || "").trim();
    if (text) return text + gapSuffix(unfinished);
  } catch (err) {
    if (isAbortError(err)) throw err;
    log("agent finalize fallback:", err.message);
  }
  return [
    "工具轮次已用尽，先把这一轮已经拿到的结果直接摆出来：",
    "",
    evidenceText,
    gapSuffix(unfinished).trim(),
    "",
    "你可以让我展开其中某一条，或者缩小范围再试一次。",
  ].filter(Boolean).join("\n");
}

async function runAgent(run, inputMessages, sse) {
  const messages = [{ role: "system", content: agentSystemPrompt(run.workspace) }, ...inputMessages];
  const evidence = [];
  const unfinished = [];
  const seenGaps = new Set();
  function addGap(text) {
    const value = truncate(String(text || ""), 260);
    if (!value || seenGaps.has(value)) return;
    seenGaps.add(value);
    if (unfinished.length < 10) unfinished.push(value);
  }
  let seq = 0;
  let lastSignature = "";
  let repeats = 0;
  let stopLoop = false;

  for (let round = 1; round <= MAX_AGENT_ROUNDS && !stopLoop; round++) {
    if (run.controller.signal.aborted) throw abortError();
    sse.send({
      type: "status",
      message: round === 1 ? "正在理解任务并规划…" : `正在继续第 ${round}/${MAX_AGENT_ROUNDS} 轮…`,
    });

    const result = await (async () => {
      const res = await requestModel({
        model: run.model || MODEL_AGENT,
        messages,
        stream: true,
        max_tokens: 8192,
        temperature: 0.4,
        tools: AGENT_TOOLS,
        tool_choice: "auto",
        ...reasoningPayload(run.effort || AGENT_DEFAULT_EFFORT),
      }, run.controller.signal);
      return readModelStream(res);
    })();

    const calls = (result.toolCalls || []).slice(0, MAX_TOOL_CALLS_PER_ROUND);
    if (!calls.length) {
      const finalText = (result.content || "").trim();
      if (finalText) {
        sse.send({ type: "final", content: finalText + gapSuffix(unfinished) });
        return;
      }
      const fallback = await finalizeWithEvidence(messages, evidence, run, unfinished);
      sse.send({ type: "final", content: fallback });
      return;
    }

    if ((result.content || "").trim()) {
      sse.send({
        type: "step",
        id: "note-" + (++seq),
        kind: "note",
        title: "思考",
        detail: truncate(result.content.trim(), 700),
        status: "done",
      });
    }

    messages.push({
      role: "assistant",
      content: result.content || "",
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments || "{}" },
      })),
    });

    for (let callIndex = 0; callIndex < calls.length; callIndex++) {
      const call = calls[callIndex];
      if (run.controller.signal.aborted) throw abortError();
      const name = call.function?.name || "unknown";
      const stepId = "tool-" + (++seq);
      let args = {};
      let parseError = "";
      if (result.finishReason === "length") {
        // A tool call that hit the output ceiling may be complete-looking but
        // still truncated. Do not execute it; let the model split the work.
        parseError = "模型输出达到上限，工具参数可能被截断";
      } else {
        try {
          args = JSON.parse(call.function?.arguments || "{}");
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("参数必须是对象");
        } catch (err) {
          parseError = err.message;
        }
      }

      sse.send({
        type: "tool_start",
        id: stepId,
        tool: name,
        label: toolLabel(name),
        detail: parseError ? "参数不完整，未执行" : toolDetail(name, args),
      });

      if (parseError) {
        const text = "工具参数不完整或不是合法 JSON，本次调用没有执行。请缩短参数或分次写入。错误：" + parseError;
        addGap(toolLabel(name) + " 未执行：" + parseError);
        sse.send({ type: "tool_end", id: stepId, status: "error", summary: "参数不完整，未执行。" });
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
        evidence.push({ tool: name, text });
        continue;
      }

      const signature = JSON.stringify([name, args]);
      if (signature === lastSignature) repeats++;
      else { repeats = 1; lastSignature = signature; }
      if (repeats >= 3) {
        sse.send({ type: "tool_end", id: stepId, status: "error", summary: "检测到重复调用，提前收尾。" });
        messages.push({ role: "tool", tool_call_id: call.id, content: "检测到重复调用，已停止继续执行。" });
        evidence.push({ tool: name, text: "同一工具调用重复出现 3 次，已停止。" });
        addGap("检测到重复工具调用，后续步骤没有执行。");
        // Every tool_call id in the assistant turn needs a tool reply, otherwise the
        // finalization request is an invalid OpenAI message sequence.
        for (let rest = callIndex + 1; rest < calls.length; rest++) {
          messages.push({
            role: "tool",
            tool_call_id: calls[rest].id,
            content: "任务已提前收尾，本次调用没有执行。",
          });
        }
        stopLoop = true;
        break;
      }

      let toolResult;
      const toolStarted = Date.now();
      try {
        toolResult = await executeAgentTool(name, args, { run, sse, stepId, callId: call.id, round });
      } catch (err) {
        if (isAbortError(err)) throw err;
        toolResult = {
          ok: false,
          summary: "工具执行失败：" + truncate(err.message, 160),
          modelText: "工具执行失败：" + err.message,
        };
      }
      if (!toolResult.ok) {
        addGap(toolLabel(name) + " 未完成：" + (toolResult.summary || "工具执行失败"));
      }
      log("agent tool", {
        name,
        argChars: JSON.stringify(args).length,
        ms: Date.now() - toolStarted,
        ok: !!toolResult.ok,
        summary: truncate(toolResult.summary || "", 120),
      });

      sse.send({
        type: "tool_end",
        id: stepId,
        status: toolResult.ok ? "done" : "error",
        summary: toolResult.summary || (toolResult.ok ? "完成" : "失败"),
        sources: toolResult.sources,
        artifact: toolResult.artifact,
        autoApproved: !!toolResult.autoApproved,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolResult.modelText + (toolResult.ok ? "" : "\n（本次操作没有成功，请据此调整。）"),
      });
      evidence.push({ tool: name, text: toolResult.modelText });
    }
  }

  if (!stopLoop) addGap(`达到最大工具轮次（${MAX_AGENT_ROUNDS}），任务可能没有全部完成。`);
  const fallback = await finalizeWithEvidence(messages, evidence, run, unfinished);
  sse.send({ type: "final", content: fallback });
}

/* ============================================================
   Agent HTTP route
   ============================================================ */
async function handleAgent(req, res, body) {
  if (!resolveKey()) return sendJson(res, 401, { error: "还没有配置 API Key。请先在设置中填写。" });
  const messages = normalizeMessages(body.messages);
  if (!messages.length) return sendJson(res, 400, { error: "消息不能为空。" });

  const runId = typeof body.runId === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(body.runId)
    ? body.runId
    : crypto.randomUUID();
  let runWorkspace = WORKSPACE;
  if (body.workspace) {
    try {
      runWorkspace = validateWorkspaceTarget(body.workspace);
    } catch (err) {
      return sendJson(res, 400, { error: err.message || "工作区无效。" });
    }
  }
  const run = {
    id: runId,
    controller: new AbortController(),
    pending: new Map(),
    startedAt: Date.now(),
    workspace: runWorkspace,
    model: body.model === "flash" ? MODEL_FLASH : MODEL_PRO,
    effort: normalizeEffort(body.reasoningEffort),
    fullAccess: !!(body.fullAccess === true && body.fullAccessAck === true),
  };
  agentRuns.set(runId, run);

  const sse = startSSE(res);
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    agentRuns.delete(runId);
    for (const [, pending] of run.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ approved: false, timedOut: true });
    }
    run.pending.clear();
  };

  req.on("close", () => {
    if (!res.writableEnded) {
      run.controller.abort();
      cleanup();
    }
  });

  try {
    sse.send({ type: "run", runId, model: run.model, effort: run.effort });
    await runAgent(run, messages, sse);
    sse.send({
      type: "done",
      durationMs: Date.now() - run.startedAt,
      usage: null,
    });
  } catch (err) {
    if (!isAbortError(err)) {
      sse.send({ type: "error", message: friendlyModelError(err) });
    }
  } finally {
    cleanup();
    sse.end();
  }
}

async function handleDecision(req, res, body) {
  const runId = String(body.runId || "");
  const callId = String(body.callId || "");
  const run = agentRuns.get(runId);
  if (!run) return sendJson(res, 404, { error: "这个 Agent 任务已经结束或不存在。" });
  const pending = run.pending.get(callId);
  if (!pending) return sendJson(res, 404, { error: "这次写入请求已经处理过了。" });
  pending.resolve({ approved: !!body.approved, timedOut: false });
  sendJson(res, 200, { ok: true, approved: !!body.approved });
}

/* ============================================================
   Static / files
   ============================================================ */
async function readStaticAsset(file) {
  if (SEA_ASSETS) {
    const data = SEA_ASSETS(file);
    if (!data) throw new Error("内嵌资源不存在：" + file);
    return Buffer.from(data);
  }
  return fsp.readFile(path.join(ROOT, file));
}

async function serveStatic(res, pathname) {
  const file = STATIC_FILES.get(pathname);
  if (!file) return false;
  try {
    const data = await readStaticAsset(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    res.end(data);
    return true;
  } catch (err) {
    sendJson(res, 500, { error: "读取页面文件失败：" + err.message });
    return true;
  }
}

function openBrowser(url) {
  if (process.env.DEEPSEEK_WEB_OPEN_BROWSER !== "1") return;
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* the URL is also printed in the console */
  }
}

async function serveWorkspaceFile(res, pathname, searchParams) {
  let rel;
  try {
    rel = pathname.slice("/api/files/".length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return sendJson(res, 400, { error: "文件名编码不正确。" });
  }
  let workspace = WORKSPACE;
  const requestedWorkspace = String(searchParams?.get("ws") || "").trim();
  if (requestedWorkspace) {
    try {
      workspace = validateWorkspaceTarget(requestedWorkspace);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  let info;
  try {
    info = workspacePath(rel, workspace);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (info.rel.startsWith(".") || info.rel.includes("/.") || /\.bak(\.\d+)?$/i.test(info.rel)) {
    return sendJson(res, 404, { error: "文件不存在。" });
  }
  try {
    const st = await fsp.stat(info.abs);
    if (!st.isFile()) return sendJson(res, 404, { error: "文件不存在。" });
    const data = await fsp.readFile(info.abs);
    const name = path.basename(info.abs);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(name)] || "application/octet-stream",
      "Content-Length": data.length,
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "文件不存在。" });
  }
}

/* ============================================================
   HTTP server
   ============================================================ */
const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "127.0.0.1"));

  if (req.method === "POST" && !sameOrigin(req)) {
    return sendJson(res, 403, { error: "跨站请求已被拒绝。" });
  }
  if (req.method === "POST" && !isJsonRequest(req)) {
    return sendJson(res, 415, { error: "POST 请求必须使用 application/json。" });
  }

  const publicPaths = new Set([
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/lan-info",
    "/api/lan-qr.svg",
  ]);
  if (url.pathname.startsWith("/api/") && AUTH_REQUIRED && !isAuthenticated(req) && !publicPaths.has(url.pathname)) {
    return sendJson(res, 401, { error: "需要访问口令。", authRequired: true });
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/auth/status") {
      return sendJson(res, 200, Object.assign({ ok: true, version: VERSION }, accessStatus(req)));
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      if (!AUTH_REQUIRED) return sendJson(res, 200, { ok: true, required: false });
      const ip = clientAddress(req);
      if (loginBlocked(ip)) {
        return sendJson(res, 429, { error: "尝试次数过多，请 1 分钟后再试。" });
      }
      const body = await readJson(req, 16 * 1024);
      if (!passwordMatches(body.password)) {
        recordLoginFailure(ip);
        return sendJson(res, 401, { error: "访问口令不正确。" });
      }
      loginAttempts.delete(ip);
      createSession(res);
      return sendJson(res, 200, { ok: true, required: true });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      clearSession(req, res);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/lan-info") {
      return sendJson(res, 200, {
        ok: true,
        lan: !IS_LOOPBACK,
        url: lanUrl(),
        addresses: lanAddresses(),
        authRequired: AUTH_REQUIRED,
        port: PORT,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/lan-qr.svg") {
      const target = lanUrl();
      if (!target) return sendJson(res, 404, { error: "当前没有可用的局域网地址。" });
      const svg = qrSvg(target);
      res.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(svg),
      });
      return res.end(svg);
    }

    if (req.method === "GET" && url.pathname === "/api/workspace") {
      return sendJson(res, 200, Object.assign({ ok: true }, workspaceInfo()));
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/check") {
      const body = await readJson(req, 64 * 1024);
      try {
        const target = validateWorkspaceTarget(body.path);
        return sendJson(res, 200, { ok: true, path: target });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || "工作区无效。" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/workspace") {
      if (agentRuns.size > 0) {
        return sendJson(res, 409, { error: "Agent 正在执行任务，结束后再切换工作区。" });
      }
      const body = await readJson(req, 64 * 1024);
      const requested = String(body.path || "").trim();
      const target = requested ? validateWorkspaceTarget(requested) : DEFAULT_WORKSPACE;
      try {
        saveWorkspaceSetting(requested ? target : "");
        WORKSPACE = target;
        fs.mkdirSync(WORKSPACE, { recursive: true });
      } catch (err) {
        return sendJson(res, 500, { error: "保存工作区失败：" + err.message });
      }
      log("Agent 工作区已切换:", WORKSPACE);
      return sendJson(res, 200, Object.assign({ ok: true }, workspaceInfo()));
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/browse") {
      try {
        const data = browseDirectories(url.searchParams.get("path") || "");
        return sendJson(res, 200, Object.assign({ ok: true }, data));
      } catch (err) {
        return sendJson(res, 400, { error: "无法浏览目录：" + err.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/deepseek-web/status") {
      return sendJson(res, 200, { ok: true, configured: !!readImportToken() });
    }

    if (req.method === "POST" && url.pathname === "/api/deepseek-web/token") {
      const body = await readJson(req, 64 * 1024);
      try {
        const token = normalizeUserToken(body.token);
        saveImportToken(token);
        return sendJson(res, 200, { ok: true, configured: true });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/deepseek-web/clear") {
      clearImportToken();
      return sendJson(res, 200, { ok: true, configured: false });
    }

    if (req.method === "GET" && url.pathname === "/api/deepseek-web/sessions") {
      const token = readImportToken();
      if (!token) return sendJson(res, 400, { error: "请先配置 userToken。" });
      try {
        const data = await officialJson("/api/v0/chat_session/fetch_page?count=100", token);
        return sendJson(res, 200, { ok: true, sessions: officialSessions(data) });
      } catch (err) {
        return sendJson(res, 502, { error: "获取对话目录失败：" + err.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/deepseek-web/history") {
      const token = readImportToken();
      if (!token) return sendJson(res, 400, { error: "请先配置 userToken。" });
      const body = await readJson(req, 64 * 1024);
      const sessionId = String(body.sessionId || "").trim();
      if (!/^[A-Za-z0-9_-]{4,120}$/.test(sessionId)) return sendJson(res, 400, { error: "sessionId 无效。" });
      try {
        const data = await officialJson("/api/v0/chat/history_messages?chat_session_id=" + encodeURIComponent(sessionId), token);
        const messages = officialMessages(data);
        if (!messages.length) return sendJson(res, 400, { error: "该对话没有可导入的文本消息。" });
        return sendJson(res, 200, { ok: true, sessionId, messages });
      } catch (err) {
        return sendJson(res, 502, { error: "读取对话失败：" + err.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const key = keyStatus();
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        key,
        models: {
          flash: MODEL_FLASH,
          pro: MODEL_PRO,
          chat: MODEL_FLASH,
          reasoner: MODEL_PRO,
          agent: MODEL_AGENT,
        },
        modelOptions: [
          { id: "flash", label: "Flash", description: "快，支持图像理解" },
          { id: "pro", label: "Pro", description: "更强，适合复杂任务" },
        ],
        agentEfforts: AGENT_EFFORTS,
        agentDefaultEffort: AGENT_DEFAULT_EFFORT,
        agentModels: [
          { id: "flash", label: "V4.1 Flash" },
          { id: "pro", label: "V4 Pro" },
        ],
        search: true,
        searchProviders: searchProviderNames(),
        searchConfig: {
          searxng: !!SEARXNG_URL,
          serper: !!SERPER_API_KEY,
          tavily: !!TAVILY_API_KEY,
          provider: SEARCH_PROVIDER,
        },
        authRequired: AUTH_REQUIRED,
        lanUrl: lanUrl(),
        lanAddresses: lanAddresses(),
        agent: true,
        workspace: WORKSPACE,
        host: HOST,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, version: VERSION, uptime: process.uptime() });
    }

    if (req.method === "POST" && url.pathname === "/api/key") {
      const body = await readJson(req);
      return sendJson(res, 200, await saveApiKey(body.key));
    }

    if (req.method === "POST" && url.pathname === "/api/test") {
      await readJson(req).catch(() => ({}));
      if (!resolveKey()) return sendJson(res, 400, { error: "还没有配置 API Key。" });
      try {
        const upstream = await fetchWithTimeout(MODELS_ENDPOINT, {
          headers: { Authorization: "Bearer " + resolveKey(), Accept: "application/json" },
        }, 15000);
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "");
          throw mapUpstreamError(upstream.status, text);
        }
        const data = await upstream.json();
        const count = Array.isArray(data.data) ? data.data.length : 0;
        return sendJson(res, 200, {
          ok: true,
          message: "连接成功，模型服务可用" + (count ? "（" + count + " 个模型）" : ""),
        });
      } catch (err) {
        return sendJson(res, 502, { error: friendlyModelError(err) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req, 3 * 1024 * 1024);
      return await handleChat(req, res, body);
    }

    if (req.method === "POST" && url.pathname === "/api/agent") {
      const body = await readJson(req, 3 * 1024 * 1024);
      return await handleAgent(req, res, body);
    }

    if (req.method === "POST" && url.pathname === "/api/agent/decision") {
      const body = await readJson(req, 64 * 1024);
      return await handleDecision(req, res, body);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
      return await serveWorkspaceFile(res, url.pathname, url.searchParams);
    }

    if (req.method === "POST" && url.pathname === "/api/reveal") {
      const body = await readJson(req, 64 * 1024);
      let workspace;
      try {
        workspace = body.workspace ? validateWorkspaceTarget(body.workspace) : WORKSPACE;
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      let info;
      try {
        info = workspacePath(body.path, workspace);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      if (info.rel.startsWith(".") || info.rel.includes("/.") || /\.bak(\.\d+)?$/i.test(info.rel)) {
        return sendJson(res, 404, { error: "文件不存在。" });
      }
      try {
        const stat = await fsp.stat(info.abs);
        if (!stat.isFile()) return sendJson(res, 404, { error: "文件不存在。" });
      } catch {
        return sendJson(res, 404, { error: "文件不存在。" });
      }
      try {
        if (process.platform === "win32") {
          spawn("explorer.exe", ["/select,", info.abs], { detached: true, stdio: "ignore" }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", ["-R", info.abs], { detached: true, stdio: "ignore" }).unref();
        } else {
          spawn("xdg-open", [path.dirname(info.abs)], { detached: true, stdio: "ignore" }).unref();
        }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: "无法打开文件夹：" + err.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "GET") {
      if (url.pathname === "/") {
        const served = await serveStatic(res, "/");
        if (served) return;
      }
      if (STATIC_FILES.has(url.pathname)) {
        return await serveStatic(res, url.pathname);
      }
      if (url.pathname.startsWith("/debug")) {
        return sendJson(res, 403, { error: "调试路径未开放。" });
      }
      return sendJson(res, 404, { error: "页面不存在。" });
    }

    return sendJson(res, 405, { error: "不支持的请求方法。" });
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) {
      return sendJson(res, status, { error: err.message || "服务器内部错误" });
    }
    try { res.end(); } catch { /* ignore */ }
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const url = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
    if (process.env.DEEPSEEK_WEB_OPEN_BROWSER === "1") {
      log("服务已经在运行，打开现有页面：", url);
      openBrowser(url);
      setTimeout(() => process.exit(0), 400);
      return;
    }
    console.error(`端口 ${PORT} 已被占用。请关闭占用 ${PORT} 的进程，或设置 PORT 后重试。`);
  } else {
    console.error("服务器启动失败：", err);
  }
  process.exitCode = 1;
});

fs.mkdirSync(WORKSPACE, { recursive: true });

server.listen(PORT, HOST, () => {
  const status = keyStatus();
  const url = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
  log("DeepSeek Web 已启动:", url);
  log("模型:", MODEL_FLASH, "/", MODEL_PRO, "/ agent:", MODEL_AGENT);
  log("API Key:", status.configured ? `已配置（${status.source}，${status.hint}）` : "未配置（演示模式）");
  log("工作区:", WORKSPACE);
  if (AUTH_REQUIRED) {
    log("访问口令:", GENERATED_PASSWORD ? ACCESS_PASSWORD : "已通过 ACCESS_PASSWORD 配置");
    log("登录后 7 天内免输；重启服务会失效。");
  } else if (!IS_LOOPBACK) {
    log("警告：局域网模式没有访问口令，任何同一网络的人都能调用接口。");
  }
  const phoneUrl = lanUrl();
  if (phoneUrl) {
    log("手机访问:", phoneUrl);
    try {
      console.log(qrTerminal(phoneUrl));
      log("用手机相机扫描上面的二维码；口令见上一行。");
    } catch (err) {
      log("二维码生成失败，请在设置 → 手机访问 中查看。", err.message);
    }
  }
  if (!IS_LOOPBACK) {
    log("警告：服务已绑定局域网地址，请确认只在可信网络使用。");
  }
  openBrowser(url);
});

process.on("SIGINT", () => {
  log("正在关闭…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200).unref();
});

process.on("uncaughtException", (err) => {
  console.error("未捕获异常：", err);
});
