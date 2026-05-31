const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Readable } = require("stream");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SCRIPT_PATH = path.join(ROOT, "atxp_register.js");
const SESSIONS_DIR = path.join(ROOT, "sessions");
const PORT = Number(process.env.PORT || 3131);
const LLM_BASE_URL = "https://llm.atxp.ai/v1";
const POOL_API_KEY = process.env.POOL_API_KEY || "123456";
const OFFICIAL_SYNC_INTERVAL_MS = Math.max(15000, Number(process.env.OFFICIAL_SYNC_INTERVAL_MS || 60000));
const OFFICIAL_FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.OFFICIAL_FETCH_TIMEOUT_MS || 15000));
const OFFICIAL_TRANSACTION_LIMIT = Math.max(
  1,
  Math.min(50, Number(process.env.OFFICIAL_TRANSACTION_LIMIT || 10)),
);

const jobs = new Map();
const eventClients = new Set();
const poolRequests = [];
const officialStatusCache = new Map();
let poolCursor = 0;
let officialSyncInFlight = false;

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function safeFileName(email) {
  return email.replace(/[^a-z0-9_.-]+/gi, "_");
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 3)}...${value.slice(-3)}`;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function toNumber(value, fallback = 0) {
  const normalized = typeof value === "string" ? value.replace(/[$,\s]/g, "") : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function parseEmail(line) {
  return String(line || "").trim().split("----")[0]?.trim() || "";
}

function isValidAccountLine(line) {
  const parts = String(line || "").trim().split("----");
  return parts.length >= 4 && parts[0] && parts[2] && parts.slice(3).join("----");
}

function parseAccountLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readSessionByEmail(email) {
  const fileName = `${safeFileName(email)}.json`;
  const filePath = path.join(SESSIONS_DIR, fileName);
  const data = readJson(filePath);
  if (!data) return null;
  return shapeSession(data, fileName);
}

function publicOfficialStatus(email) {
  return (
    officialStatusCache.get(email) || {
      email,
      ok: false,
      checking: false,
      checkedAt: "",
      balance: null,
      transactions: {
        items: [],
        count: 0,
        spent: 0,
        totalTokens: 0,
        lastAt: "",
      },
      lastError: "尚未同步",
    }
  );
}

function shapeSession(data, fileName) {
  const connectionString = data?.developer?.connectionString || "";
  const connectionToken = data?.developer?.connectionToken || data?.developer?.connection?.connectionToken || "";
  const atxpAccountId = data?.developer?.atxpAccountId || data?.developer?.connection?.atxpAccountId || "";
  const email = data.email || "";
  return {
    email,
    createdAt: data.createdAt || "",
    fileName,
    llmBaseUrl: LLM_BASE_URL,
    walletAddress: data?.walletEnsure?.data?.address || "",
    walletOk: data?.walletEnsure?.ok === true,
    developerMode: data?.developer?.status?.developerMode === true,
    atxpAccountId,
    connectionTokenMasked: maskSecret(connectionToken),
    connectionString,
    connectionStringMasked: connectionString
      ? connectionString.replace(connectionToken, maskSecret(connectionToken))
      : "",
    official: publicOfficialStatus(email),
  };
}

async function testModelsForEmail(email) {
  const session = readSessionByEmail(email);
  if (!session?.connectionString) {
    const error = new Error("Session or connection string not found");
    error.status = 404;
    throw error;
  }

  const response = await fetch(`${LLM_BASE_URL}/models`, {
    headers: {
      authorization: `Bearer ${session.connectionString}`,
    },
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    baseUrl: LLM_BASE_URL,
    kind:
      response.ok
        ? "usable"
        : response.status === 402
          ? "no_balance"
          : response.status === 401 || response.status === 403
            ? "auth_failed"
            : "request_failed",
    modelCount: Array.isArray(data?.data) ? data.data.length : 0,
    firstModels: Array.isArray(data?.data) ? data.data.slice(0, 5).map((item) => item.id) : [],
    error: response.ok ? "" : data?.error?.message || data?.message || text.slice(0, 300),
  };
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => shapeSession(readJson(path.join(SESSIONS_DIR, name)), name))
    .filter((item) => item.email)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function listPoolSessions() {
  return listSessions().filter((item) => item.connectionString);
}

function parseRequestMeta(bodyBuffer) {
  if (!bodyBuffer || !bodyBuffer.length) {
    return { model: "", stream: false };
  }
  try {
    const data = JSON.parse(bodyBuffer.toString("utf8"));
    return {
      model: data?.model || "",
      stream: data?.stream === true,
    };
  } catch {
    return { model: "", stream: false };
  }
}

function extractUsage(data) {
  const usage = data?.usage || data?.response?.usage || null;
  if (!usage) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const promptTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens || 0);
  return { promptTokens, completionTokens, totalTokens };
}

function extractUsageFromText(text) {
  if (!text) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  try {
    return extractUsage(JSON.parse(text));
  } catch {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}

function extractStreamUsage(text) {
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      const next = extractUsage(JSON.parse(payload));
      if (next.totalTokens || next.promptTokens || next.completionTokens) {
        usage = next;
      }
    } catch {
      // Ignore stream chunks that are not JSON payloads.
    }
  }
  return usage;
}

function extractErrorMessage(text) {
  if (!text) {
    return "";
  }
  try {
    const data = JSON.parse(text);
    return data?.error?.message || data?.message || "";
  } catch {
    return String(text).slice(0, 220);
  }
}

function getConnectionParts(connectionString) {
  try {
    const url = new URL(connectionString);
    return {
      baseUrl: `${url.protocol}//${url.host}`,
      token: url.searchParams.get("connection_token") || "",
    };
  } catch {
    return { baseUrl: "", token: "" };
  }
}

function makeConnectionAuthHeaders(connectionString) {
  const { token } = getConnectionParts(connectionString);
  if (!token) {
    throw new Error("connection_token 缺失");
  }
  return {
    authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
    "content-type": "application/json",
  };
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFFICIAL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const message = data?.error?.message || data?.error || data?.message || text || response.statusText;
      const error = new Error(`${response.status} ${response.statusText}: ${String(message).slice(0, 220)}`);
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("官方接口查询超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBalance(data) {
  const balance = data?.balance || data || {};
  const usdc = toNumber(balance.usdc ?? balance.totalUsdc ?? balance.usdcBalance ?? balance.usd);
  const iou = toNumber(balance.iou ?? balance.totalIou ?? balance.iouBalance);
  const explicitTotal = balance.total ?? balance.totalUsd ?? balance.totalBalance ?? data?.total;
  const total = explicitTotal == null ? usdc + iou : toNumber(explicitTotal);
  return {
    total: roundMoney(total),
    usdc: roundMoney(usdc),
    iou: roundMoney(iou),
  };
}

function pickTokenUsage(value) {
  const usage = value?.usage || value?.metadata?.usage || value?.details?.usage || value || {};
  const promptTokens = toNumber(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens);
  const completionTokens = toNumber(
    usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens,
  );
  const totalTokens = toNumber(
    usage.total_tokens ?? usage.totalTokens ?? usage.tokens ?? usage.tokenCount,
    promptTokens + completionTokens,
  );
  return { promptTokens, completionTokens, totalTokens };
}

function normalizeTransactions(data) {
  const rawItems = Array.isArray(data?.transactions)
    ? data.transactions
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];
  const items = rawItems.slice(0, OFFICIAL_TRANSACTION_LIMIT).map((item) => {
    const usage = pickTokenUsage(item);
    const amount = roundMoney(item.amount ?? item.usd ?? item.cost ?? item.value ?? 0);
    return {
      id: String(item.id || item.transactionId || item.hash || ""),
      type: String(item.type || item.kind || item.category || ""),
      amount,
      description: String(item.description || item.memo || item.reason || item.model || ""),
      model: String(item.model || item.metadata?.model || item.details?.model || ""),
      status: String(item.status || ""),
      createdAt: item.createdAt || item.created_at || item.date || item.timestamp || "",
      ...usage,
    };
  });

  const spent = items.reduce((sum, item) => {
    const text = `${item.type} ${item.description}`.toLowerCase();
    if (item.amount < 0) return sum + Math.abs(item.amount);
    if (/(spend|spent|usage|debit|charge|consume|payment|call|request)/i.test(text)) {
      return sum + Math.abs(item.amount);
    }
    return sum;
  }, 0);

  return {
    items,
    count: rawItems.length,
    spent: roundMoney(spent),
    totalTokens: items.reduce((sum, item) => sum + toNumber(item.totalTokens), 0),
    lastAt: items[0]?.createdAt || "",
  };
}

async function fetchOfficialStatusForSession(session) {
  const checkedAt = nowIso();
  if (!session?.connectionString) {
    return {
      email: session?.email || "",
      ok: false,
      checking: false,
      checkedAt,
      balance: null,
      transactions: normalizeTransactions([]),
      lastError: "没有可查询的 Key",
    };
  }

  const { baseUrl, token } = getConnectionParts(session.connectionString);
  if (!baseUrl || !token) {
    return {
      email: session.email,
      ok: false,
      checking: false,
      checkedAt,
      balance: null,
      transactions: normalizeTransactions([]),
      lastError: "connection string 格式不完整",
    };
  }

  const headers = makeConnectionAuthHeaders(session.connectionString);
  const [balanceResult, transactionsResult] = await Promise.allSettled([
    fetchJsonWithTimeout(`${baseUrl}/balance`, { headers }),
    fetchJsonWithTimeout(`${baseUrl}/api/transactions?limit=${OFFICIAL_TRANSACTION_LIMIT}`, { headers }),
  ]);

  const balanceOk = balanceResult.status === "fulfilled";
  const transactionsOk = transactionsResult.status === "fulfilled";
  const errors = [];
  if (!balanceOk) errors.push(`余额：${balanceResult.reason.message}`);
  if (!transactionsOk) errors.push(`流水：${transactionsResult.reason.message}`);

  return {
    email: session.email,
    accountId: session.atxpAccountId || "",
    ok: balanceOk || transactionsOk,
    checking: false,
    checkedAt,
    balance: balanceOk ? normalizeBalance(balanceResult.value) : null,
    transactions: transactionsOk ? normalizeTransactions(transactionsResult.value) : normalizeTransactions([]),
    lastError: errors.join("；"),
  };
}

async function refreshOfficialStatuses(email = "") {
  if (officialSyncInFlight) {
    return { ok: false, running: true, statuses: Array.from(officialStatusCache.values()) };
  }

  const sessions = email ? [readSessionByEmail(email)].filter(Boolean) : listPoolSessions();
  officialSyncInFlight = true;
  try {
    const statuses = [];
    for (const session of sessions) {
      officialStatusCache.set(session.email, {
        ...publicOfficialStatus(session.email),
        email: session.email,
        checking: true,
      });
      emitChanged();

      const status = await fetchOfficialStatusForSession(session);
      officialStatusCache.set(session.email, status);
      statuses.push(status);
      emitChanged();
    }
    return { ok: true, running: false, statuses };
  } finally {
    officialSyncInFlight = false;
  }
}

function getOfficialSummary(sessions) {
  const statuses = sessions.map((session) => publicOfficialStatus(session.email));
  const synced = statuses.filter((status) => status.checkedAt);
  const ok = statuses.filter((status) => status.ok);
  const syncedTimes = synced.map((status) => status.checkedAt).sort();
  return {
    totalCount: statuses.length,
    okCount: ok.length,
    checking: officialSyncInFlight || statuses.some((status) => status.checking),
    totalBalance: roundMoney(ok.reduce((sum, status) => sum + toNumber(status.balance?.total), 0)),
    totalSpentRecent: roundMoney(
      statuses.reduce((sum, status) => sum + toNumber(status.transactions?.spent), 0),
    ),
    totalOfficialTokens: statuses.reduce((sum, status) => sum + toNumber(status.transactions?.totalTokens), 0),
    lastSyncedAt: syncedTimes[syncedTimes.length - 1] || "",
  };
}

function recordPoolRequest(entry) {
  poolRequests.unshift({
    id: makeId(),
    at: nowIso(),
    ...entry,
  });
  if (poolRequests.length > 300) {
    poolRequests.length = 300;
  }
  emitChanged();
}

function getPoolStats() {
  const sessions = listPoolSessions();
  const recent = poolRequests.slice(0, 100);
  const totalTokens = recent.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  const success = recent.filter((item) => item.ok).length;
  return {
    requestCount: poolRequests.length,
    recentCount: recent.length,
    successCount: success,
    failureCount: recent.length - success,
    successRate: recent.length ? Math.round((success / recent.length) * 1000) / 10 : 0,
    totalTokens,
    accounts: sessions.map((session) => {
      const accountRequests = recent.filter((item) => item.email === session.email);
      return {
        email: session.email,
        requestCount: accountRequests.length,
        totalTokens: accountRequests.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0),
        lastStatus: accountRequests[0]?.status || null,
        lastAt: accountRequests[0]?.at || "",
      };
    }),
  };
}

function getPoolInfo() {
  const sessions = listPoolSessions();
  const stats = getPoolStats();
  return {
    baseUrl: `http://localhost:${PORT}/pool/v1`,
    apiKey: POOL_API_KEY,
    upstreamBaseUrl: LLM_BASE_URL,
    keyCount: sessions.length,
    nextIndex: sessions.length ? poolCursor % sessions.length : 0,
    requestCount: stats.requestCount,
    successRate: stats.successRate,
    totalTokens: stats.totalTokens,
    official: getOfficialSummary(sessions),
    stats,
    requests: poolRequests.slice(0, 60),
  };
}

function getPoolOrder() {
  const sessions = listPoolSessions();
  if (!sessions.length) {
    return [];
  }
  const start = poolCursor % sessions.length;
  poolCursor = (poolCursor + 1) % sessions.length;
  return sessions.map((_, index) => sessions[(start + index) % sessions.length]);
}

function publicSession(session) {
  if (!session) return null;
  const clone = { ...session };
  delete clone.connectionString;
  return clone;
}

function publicTask(task) {
  return {
    id: task.id,
    email: task.email,
    status: task.status,
    stage: task.stage,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    error: task.error,
    logs: task.logs.slice(-200),
    result: publicSession(task.result),
  };
}

function publicJob(job) {
  const tasks = job.tasks.map(publicTask);
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stopRequested: job.stopRequested,
    options: job.options,
    totals: {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === "queued").length,
      running: tasks.filter((task) => task.status === "running").length,
      success: tasks.filter((task) => task.status === "success").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      stopped: tasks.filter((task) => task.status === "stopped").length,
    },
    logs: job.logs.slice(-500),
    tasks,
  };
}

function getState() {
  return {
    jobs: Array.from(jobs.values()).map(publicJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    sessions: listSessions().map(publicSession),
    pool: getPoolInfo(),
  };
}

function writeJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function writeText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readRawBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isPoolAuthorized(req) {
  const value = req.headers.authorization || "";
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match && match[1] === POOL_API_KEY;
}

function makeProxyHeaders(req, session) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      [
        "authorization",
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "accept-encoding",
      ].includes(lower)
    ) {
      continue;
    }
    headers[key] = value;
  }
  headers.authorization = `Bearer ${session.connectionString}`;
  return headers;
}

function writeProxyResponse(res, response, session, bodyBuffer) {
  const headers = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      [
        "connection",
        "content-encoding",
        "content-length",
        "keep-alive",
        "transfer-encoding",
      ].includes(lower)
    ) {
      return;
    }
    headers[key] = value;
  });
  headers["access-control-allow-origin"] = "*";
  headers["x-atxp-pool-email"] = session.email;
  headers["x-atxp-pool-account-id"] = session.atxpAccountId || "";
  if (bodyBuffer) {
    headers["content-length"] = String(bodyBuffer.length);
  }
  res.writeHead(response.status, headers);
}

function shouldRetryPoolStatus(status) {
  return [401, 402, 403, 429, 500, 502, 503, 504].includes(status);
}

async function fetchWithPool(req, pathname, url, bodyBuffer) {
  const suffix = pathname.slice("/pool/v1".length) || "/";
  const upstreamUrl = `${LLM_BASE_URL}${suffix}${url.search}`;
  const orderedSessions = getPoolOrder();
  if (!orderedSessions.length) {
    const error = new Error("No keys in pool");
    error.status = 503;
    throw error;
  }

  let lastResult = null;
  for (let index = 0; index < orderedSessions.length; index += 1) {
    const session = orderedSessions[index];
    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers: makeProxyHeaders(req, session),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyBuffer,
      redirect: "manual",
    });

    if (shouldRetryPoolStatus(response.status) && index < orderedSessions.length - 1) {
      const text = await response.text();
      lastResult = { response, session, text };
      continue;
    }

    return { response, session };
  }

  return lastResult;
}

async function proxyPoolRequest(req, res, pathname, url) {
  const startedAt = Date.now();
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  if (!isPoolAuthorized(req)) {
    writeJson(res, 401, {
      error: {
        message: "Invalid local pool key",
        type: "auth_failed",
      },
    });
    return;
  }

  const bodyBuffer = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readRawBody(req);
  const requestMeta = parseRequestMeta(bodyBuffer);
  const result = await fetchWithPool(req, pathname, url, bodyBuffer);
  const { response, session, text } = result;
  const baseRecord = {
    method: req.method,
    path: `${pathname}${url.search}`,
    model: requestMeta.model,
    stream: requestMeta.stream,
    email: session.email,
    accountId: session.atxpAccountId || "",
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
  };

  if (text != null) {
    const buffer = Buffer.from(text);
    const usage = extractUsageFromText(text);
    recordPoolRequest({
      ...baseRecord,
      ...usage,
      error: response.ok ? "" : extractErrorMessage(text),
    });
    writeProxyResponse(res, response, session, buffer);
    res.end(buffer);
    return;
  }

  const contentType = response.headers.get("content-type") || "";
  if (response.body && contentType.includes("text/event-stream")) {
    writeProxyResponse(res, response, session);
    let streamText = "";
    const stream = Readable.fromWeb(response.body);
    stream.on("data", (chunk) => {
      streamText += chunk.toString("utf8");
      res.write(chunk);
    });
    stream.on("end", () => {
      recordPoolRequest({
        ...baseRecord,
        durationMs: Date.now() - startedAt,
        ...extractStreamUsage(streamText),
        error: response.ok ? "" : extractErrorMessage(streamText),
      });
      res.end();
    });
    stream.on("error", (error) => {
      recordPoolRequest({
        ...baseRecord,
        ok: false,
        status: 502,
        durationMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        error: error.message,
      });
      res.destroy(error);
    });
    return;
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const bodyText = buffer.toString("utf8");
  const usage = contentType.includes("json")
    ? extractUsageFromText(bodyText)
    : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  recordPoolRequest({
    ...baseRecord,
    durationMs: Date.now() - startedAt,
    ...usage,
    error: response.ok ? "" : extractErrorMessage(bodyText),
  });
  writeProxyResponse(res, response, session, buffer);
  res.end(buffer);
}

async function testPoolModels() {
  const fakeReq = {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  };
  const fakeUrl = new URL("http://localhost/pool/v1/models");
  const result = await fetchWithPool(fakeReq, "/pool/v1/models", fakeUrl, Buffer.alloc(0));
  const text = result.text != null ? result.text : await result.response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    ok: result.response.ok,
    status: result.response.status,
    selectedEmail: result.session.email,
    selectedAccountId: result.session.atxpAccountId,
    baseUrl: getPoolInfo().baseUrl,
    apiKey: POOL_API_KEY,
    modelCount: Array.isArray(data?.data) ? data.data.length : 0,
    firstModels: Array.isArray(data?.data) ? data.data.slice(0, 5).map((item) => item.id) : [],
    error: result.response.ok ? "" : data?.error?.message || data?.message || text.slice(0, 300),
  };
}

function emitChanged() {
  const payload = `data: ${JSON.stringify({ type: "changed", at: nowIso() })}\n\n`;
  for (const res of eventClients) {
    res.write(payload);
  }
}

function pushLog(job, task, level, message) {
  const entry = { at: nowIso(), level, email: task?.email || "", message };
  job.logs.push(entry);
  if (task) task.logs.push(entry);
  updateStageFromLine(task, message, level);
  emitChanged();
}

function updateStageFromLine(task, line, level) {
  if (!task || task.status !== "running") return;
  if (/Sending Privy email code/i.test(line)) task.stage = "send_code";
  else if (/Waiting for OTP mail/i.test(line)) task.stage = "wait_mail";
  else if (/OTP found/i.test(line)) task.stage = "otp_found";
  else if (/Submitting OTP/i.test(line)) task.stage = "privy_auth";
  else if (/Touching ATXP wallet/i.test(line)) task.stage = "wallet";
  else if (/Extracting developer connection string/i.test(line)) task.stage = "developer";
  else if (/Done\. Saved/i.test(line)) task.stage = "saved";
  else if (level === "error") task.stage = "error";
}

function buildScriptArgs(line, options) {
  const args = [
    SCRIPT_PATH,
    "--account",
    line,
    "--timeout",
    String(options.timeout),
    "--interval",
    String(options.interval),
    "--out-dir",
    SESSIONS_DIR,
    "--mailbox",
    options.mailbox,
    "--mail-method",
    options.mailMethod,
  ];
  if (options.fallbackImap) args.push("--fallback-imap");
  if (options.proxyHttp) args.push("--proxy-http", options.proxyHttp);
  if (options.proxySocks5) args.push("--proxy-socks5", options.proxySocks5);
  return args;
}

async function runJob(job) {
  job.status = "running";
  job.startedAt = nowIso();
  emitChanged();

  for (const task of job.tasks) {
    if (job.stopRequested) {
      task.status = "stopped";
      task.stage = "stopped";
      task.finishedAt = nowIso();
      continue;
    }

    task.status = "running";
    task.stage = "starting";
    task.startedAt = nowIso();
    pushLog(job, task, "info", `[${task.email}] Start task`);

    await new Promise((resolve) => {
      const child = childProcess.spawn(process.execPath, buildScriptArgs(task.line, job.options), {
        cwd: ROOT,
        windowsHide: true,
        env: process.env,
      });
      job.currentChild = child;

      const handleChunk = (level, chunk) => {
        String(chunk)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => pushLog(job, task, level, line));
      };

      child.stdout.on("data", (chunk) => handleChunk("info", chunk));
      child.stderr.on("data", (chunk) => handleChunk("error", chunk));
      child.on("error", (error) => {
        task.error = error.message;
        pushLog(job, task, "error", `[${task.email}] ${error.message}`);
      });
      child.on("close", (code) => {
        task.exitCode = code;
        task.finishedAt = nowIso();
        job.currentChild = null;

        if (job.stopRequested) {
          task.status = "stopped";
          task.stage = "stopped";
          task.error = "Task stopped";
        } else if (code === 0) {
          task.status = "success";
          task.stage = "success";
          task.result = readSessionByEmail(task.email);
          pushLog(job, task, "success", `[${task.email}] Success`);
        } else {
          task.status = "failed";
          if (!task.stage || task.stage === "starting") {
            task.stage = "failed";
          }
          task.error = task.error || `Process exited with code ${code}`;
          pushLog(job, task, "error", `[${task.email}] Failed: ${task.error}`);
        }

        emitChanged();
        resolve();
      });
    });
  }

  job.finishedAt = nowIso();
  if (job.stopRequested) {
    job.status = "stopped";
  } else if (job.tasks.some((task) => task.status === "failed")) {
    job.status = "completed_with_errors";
  } else {
    job.status = "completed";
  }
  emitChanged();
}

function startJob(payload) {
  const lines = parseAccountLines(payload.accountsText);
  const invalidLines = lines.filter((line) => !isValidAccountLine(line));
  if (!lines.length) {
    const error = new Error("请先粘贴至少一行账号");
    error.status = 400;
    throw error;
  }
  if (invalidLines.length) {
    const error = new Error(`有 ${invalidLines.length} 行格式不对，应为 邮箱----密码----id----token`);
    error.status = 400;
    throw error;
  }

  const options = {
    timeout: Math.max(15, Math.min(900, Number(payload.timeout || 180))),
    interval: Math.max(1, Math.min(60, Number(payload.interval || 5))),
    mailbox: payload.mailbox === "Junk" || payload.mailbox === "INBOX" ? payload.mailbox : "both",
    mailMethod: payload.mailMethod === "imap" ? "imap" : "api",
    fallbackImap: Boolean(payload.fallbackImap),
    proxyHttp: String(payload.proxyHttp || "").trim(),
    proxySocks5: String(payload.proxySocks5 || "").trim(),
  };

  const job = {
    id: makeId(),
    status: "queued",
    createdAt: nowIso(),
    startedAt: "",
    finishedAt: "",
    stopRequested: false,
    currentChild: null,
    options,
    logs: [],
    tasks: lines.map((line, index) => ({
      id: `${index + 1}`,
      line,
      email: parseEmail(line),
      status: "queued",
      stage: "queued",
      startedAt: "",
      finishedAt: "",
      exitCode: null,
      error: "",
      logs: [],
      result: null,
    })),
  };

  jobs.set(job.id, job);
  setImmediate(() => runJob(job));
  emitChanged();
  return job;
}

function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.stopRequested = true;
  if (job.currentChild) {
    job.currentChild.kill();
  }
  emitChanged();
  return true;
}

function serveStatic(req, res, pathname) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalizedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    writeText(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      writeText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
      }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === "/pool/v1" || pathname.startsWith("/pool/v1/")) {
      await proxyPoolRequest(req, res, pathname, url);
      return;
    }

    if (req.method === "GET" && pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "connected", at: nowIso() })}\n\n`);
      eventClients.add(res);
      req.on("close", () => eventClients.delete(res));
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      writeJson(res, 200, getState());
      return;
    }

    if (req.method === "POST" && pathname === "/api/jobs") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const job = startJob(body);
      writeJson(res, 201, { job: publicJob(job) });
      return;
    }

    const stopMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      const ok = stopJob(stopMatch[1]);
      writeJson(res, ok ? 200 : 404, { ok });
      return;
    }

    if (req.method === "GET" && pathname === "/api/session") {
      const email = url.searchParams.get("email") || "";
      const session = readSessionByEmail(email);
      if (!session) {
        writeJson(res, 404, { error: "Session not found" });
        return;
      }
      writeJson(res, 200, session);
      return;
    }

    if (req.method === "GET" && pathname === "/api/session/test") {
      const email = url.searchParams.get("email") || "";
      writeJson(res, 200, await testModelsForEmail(email));
      return;
    }

    if (req.method === "GET" && pathname === "/api/pool/test") {
      writeJson(res, 200, await testPoolModels());
      return;
    }

    if (req.method === "POST" && pathname === "/api/official/refresh") {
      const body = JSON.parse((await readBody(req)) || "{}");
      writeJson(res, 200, await refreshOfficialStatuses(String(body.email || "").trim()));
      return;
    }

    if (req.method === "GET" && pathname === "/api/export.txt") {
      const lines = listSessions()
        .filter((item) => item.connectionString)
        .map((item) => `${item.email}----${item.connectionString}`);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"atxp_keys.txt\"",
        "cache-control": "no-store",
      });
      res.end(lines.join("\n"));
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res, pathname);
      return;
    }

    writeJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    writeJson(res, error.status || 500, { error: error.message || String(error) });
  }
}

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function startOfficialSyncLoop() {
  setTimeout(() => {
    refreshOfficialStatuses().catch((error) => {
      console.warn(`Official status sync failed: ${error.message}`);
    });
  }, 2000).unref?.();

  setInterval(() => {
    refreshOfficialStatuses().catch((error) => {
      console.warn(`Official status sync failed: ${error.message}`);
    });
  }, OFFICIAL_SYNC_INTERVAL_MS).unref?.();
}

http.createServer(route).listen(PORT, () => {
  console.log(`ATXP register console is running: http://localhost:${PORT}`);
  startOfficialSyncLoop();
});
