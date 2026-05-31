#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const tls = require("tls");

const PRIVY_APP_ID = "cma1jnfkk01mml20n6fyvsmll";
const PRIVY_CLIENT_ID = "client-WY6L6ApVtkaEUHas1qqZ4fFKtQuUF67ghGYyd82oa5PTw";
const PRIVY_CLIENT = "react-auth:3.10.2";
const ORIGIN = "https://accounts.atxp.ai";
const MAIL_API_BASE = "https://oauth2.wryx.cc";

function usage() {
  console.log(`Usage:
  node atxp_register.js --account "email----password----client_id----refresh_token"
  node atxp_register.js --account-file accounts.txt

Options:
  --account             One account line: email----password----id----token
  --account-file        File containing one or more account lines
  --timeout             Mail polling timeout in seconds, default 180
  --interval            Mail polling interval in seconds, default 5
  --out-dir             Output directory, default ./sessions
  --mailbox             Mailbox to poll, default INBOX
  --mail-api            Mail API base URL, default https://oauth2.wryx.cc
  --mail-api-endpoint   Mail API endpoint, default /api/mail_all
  --mail-method         Mail reader: api or imap, default api
  --fallback-imap       If API polling fails/times out, try Outlook IMAP
  --proxy-http          Optional http proxy passed to the mail API
  --proxy-socks5        Optional socks5 proxy passed to the mail API
  --no-verify-tls       Disable IMAP TLS certificate verification
  --help                Show this help

Notes:
  The password field is kept for compatibility with the source format but is not used.
  The id field is treated as the Microsoft OAuth client_id.
  The token field is treated as the Microsoft OAuth refresh_token.
  By default, OTP mail is read through oauth2.wryx.cc /api/mail_all.
`);
}

function parseArgs(argv) {
  const args = {
    timeout: 180,
    interval: 5,
    outDir: path.resolve(process.cwd(), "sessions"),
    verifyTls: true,
    mailbox: "INBOX",
    mailApi: MAIL_API_BASE,
    mailApiEndpoint: "/api/mail_all",
    mailMethod: "api",
    fallbackImap: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];

    if (key === "--help" || key === "-h") {
      args.help = true;
    } else if (key === "--account") {
      args.account = next;
      i += 1;
    } else if (key === "--account-file") {
      args.accountFile = next;
      i += 1;
    } else if (key === "--timeout") {
      args.timeout = Number(next);
      i += 1;
    } else if (key === "--interval") {
      args.interval = Number(next);
      i += 1;
    } else if (key === "--out-dir") {
      args.outDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (key === "--mailbox") {
      args.mailbox = next;
      i += 1;
    } else if (key === "--mail-api") {
      args.mailApi = next.replace(/\/+$/, "");
      i += 1;
    } else if (key === "--mail-api-endpoint") {
      args.mailApiEndpoint = next.startsWith("/") ? next : `/${next}`;
      i += 1;
    } else if (key === "--mail-method") {
      args.mailMethod = next;
      i += 1;
    } else if (key === "--fallback-imap") {
      args.fallbackImap = true;
    } else if (key === "--proxy-http") {
      args.proxyHttp = next;
      i += 1;
    } else if (key === "--proxy-socks5") {
      args.proxySocks5 = next;
      i += 1;
    } else if (key === "--no-verify-tls") {
      args.verifyTls = false;
    } else {
      throw new Error(`Unknown option: ${key}`);
    }
  }

  return args;
}

function parseAccountLine(line) {
  const parts = line.trim().split("----");
  if (parts.length < 4) {
    throw new Error("Account line must be: email----password----id----token");
  }

  const [email, password, clientId, ...tokenParts] = parts;
  const refreshToken = tokenParts.join("----");
  if (!email || !clientId || !refreshToken) {
    throw new Error("Account line is missing email, id/client_id, or token");
  }

  return {
    email: email.trim(),
    password,
    clientId: clientId.trim(),
    refreshToken: refreshToken.trim(),
  };
}

function loadAccounts(args) {
  const lines = [];
  if (args.account) {
    lines.push(args.account);
  }
  if (args.accountFile) {
    const content = fs.readFileSync(args.accountFile, "utf8");
    lines.push(
      ...content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  }
  if (!lines.length) {
    throw new Error("Provide --account or --account-file");
  }
  return lines.map(parseAccountLine);
}

function makePrivyHeaders(caId) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "privy-app-id": PRIVY_APP_ID,
    "privy-client-id": PRIVY_CLIENT_ID,
    "privy-client": PRIVY_CLIENT,
    "privy-ca-id": caId,
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data.error || data.message || data.msg || text || response.statusText;
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }
  return data;
}

async function sendPrivyCode(email, caId) {
  return fetchJson("https://auth.privy.io/api/v1/passwordless/init", {
    method: "POST",
    headers: makePrivyHeaders(caId),
    body: JSON.stringify({ email }),
  });
}

async function authenticatePrivyCode(email, code, caId) {
  return fetchJson("https://auth.privy.io/api/v1/passwordless/authenticate", {
    method: "POST",
    headers: makePrivyHeaders(caId),
    body: JSON.stringify({
      email,
      code,
      mode: "login-or-sign-up",
    }),
  });
}

async function getOutlookAccessToken(account) {
  const body = new URLSearchParams({
    client_id: account.clientId,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    scope: "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
  });

  const data = await fetchJson("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!data.access_token) {
    throw new Error("Microsoft token response did not include access_token");
  }
  return data.access_token;
}

class ImapClient {
  constructor({ host, port, rejectUnauthorized }) {
    this.host = host;
    this.port = port;
    this.rejectUnauthorized = rejectUnauthorized;
    this.tagNum = 1;
    this.buffer = "";
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(
        {
          host: this.host,
          port: this.port,
          servername: this.host,
          rejectUnauthorized: this.rejectUnauthorized,
        },
        () => resolve(),
      );

      this.socket.setEncoding("utf8");
      this.socket.on("data", (chunk) => {
        this.buffer += chunk;
      });
      this.socket.on("error", reject);
      this.socket.setTimeout(30000, () => {
        this.socket.destroy(new Error("IMAP socket timeout"));
      });
    }).then(() => this.waitForGreeting());
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
  }

  waitForGreeting() {
    return this.waitFor((text) => /^\* OK/m.test(text), 30000);
  }

  nextTag() {
    return `A${String(this.tagNum++).padStart(4, "0")}`;
  }

  async command(commandText, { sensitive = false } = {}) {
    const tag = this.nextTag();
    const full = `${tag} ${commandText}\r\n`;
    this.buffer = "";
    this.socket.write(full);

    const response = await this.waitFor((text) => {
      const done = new RegExp(`^${tag} (OK|NO|BAD)`, "m").test(text);
      const continuation = /^\+ /m.test(text);
      return done || continuation;
    }, 30000);

    if (/^\+ /m.test(response) && commandText.startsWith("AUTHENTICATE XOAUTH2 ")) {
      throw new Error("IMAP server requested extra auth data; XOAUTH2 failed");
    }

    if (new RegExp(`^${tag} (NO|BAD)`, "m").test(response)) {
      throw new Error(`IMAP command failed${sensitive ? "" : `: ${commandText}`}\n${response}`);
    }

    return response;
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate(this.buffer)) {
          clearInterval(timer);
          resolve(this.buffer);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for IMAP response. Last data:\n${this.buffer}`));
        }
      }, 50);
    });
  }

  async authenticateXoauth2(email, accessToken) {
    const payload = Buffer.from(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`).toString(
      "base64",
    );
    await this.command(`AUTHENTICATE XOAUTH2 ${payload}`, { sensitive: true });
  }

  async selectInbox() {
    await this.command("SELECT INBOX");
  }

  async searchRecent() {
    const since = imapDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const response = await this.command(`UID SEARCH SINCE ${since}`);
    const line = response
      .split(/\r?\n/)
      .find((item) => item.startsWith("* SEARCH"));
    if (!line) {
      return [];
    }
    return line
      .replace("* SEARCH", "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  async fetchMessage(uid) {
    return this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
  }
}

function imapDate(date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function decodeMimeWords(value) {
  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_, charset, encoding, text) => {
    try {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "binary");
      return bytes.toString(/^utf-?8$/i.test(charset) ? "utf8" : "latin1");
    } catch {
      return text;
    }
  });
}

function extractOtp(rawMessage) {
  const text =
    typeof rawMessage === "string"
      ? decodeMimeWords(rawMessage)
      : decodeMimeWords(JSON.stringify(rawMessage));
  const lower = text.toLowerCase();

  if (!/(atxp|privy|verification|verify|code|login|sign in|sign-in)/i.test(lower)) {
    return null;
  }

  const preferred = [
    /(?:code|verification code|verify code|login code|otp)[^\d]{0,40}(\d{6})/i,
    /(\d{6})[^\d]{0,40}(?:code|verification|verify|otp)/i,
  ];

  for (const pattern of preferred) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  const fallback = text.match(/(?<!\d)(\d{6})(?!\d)/);
  return fallback ? fallback[1] : null;
}

function flattenMailApiPayload(value, output = []) {
  if (value == null) {
    return output;
  }
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenMailApiPayload(item, output);
    }
    return output;
  }
  if (typeof value === "object") {
    const orderedKeys = ["subject", "text", "html", "send", "from", "date", "content", "body", "message"];
    for (const key of orderedKeys) {
      if (key in value) {
        flattenMailApiPayload(value[key], output);
      }
    }
    output.push(JSON.stringify(value));
  }
  return output;
}

function getMailTimestamp(mail) {
  if (!mail || typeof mail !== "object") {
    return 0;
  }
  const keys = [
    "date",
    "receivedDateTime",
    "received_at",
    "receivedAt",
    "created_at",
    "createdAt",
    "time",
    "timestamp",
  ];

  for (const key of keys) {
    const value = mail[key];
    if (value == null) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1000000000000 ? value * 1000 : value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric < 1000000000000 ? numeric * 1000 : numeric;
      }
    }
  }
  return 0;
}

function isFreshEnough(mail, minDateMs) {
  if (!minDateMs) {
    return true;
  }
  const timestamp = getMailTimestamp(mail);
  return !timestamp || timestamp >= minDateMs - 2 * 60 * 1000;
}

function extractOtpFromMailApiResponse(response, minDateMs = 0) {
  const mails = Array.isArray(response?.data)
    ? response.data.slice()
    : Array.isArray(response)
      ? response.slice()
      : response?.data
        ? [response.data]
        : [];

  mails.sort((a, b) => {
    const ad = Date.parse(a?.date || 0) || 0;
    const bd = Date.parse(b?.date || 0) || 0;
    return bd - ad;
  });

  for (const mail of mails) {
    if (!isFreshEnough(mail, minDateMs)) {
      continue;
    }
    const candidate = [
      mail?.send,
      mail?.from,
      mail?.subject,
      mail?.text,
      mail?.html,
      mail?.content,
      mail?.body,
      mail?.message,
    ]
      .filter(Boolean)
      .join("\n");
    const code = extractOtp(candidate);
    if (code) {
      return code;
    }
  }

  if (minDateMs && mails.length) {
    return null;
  }

  const candidates = flattenMailApiPayload(response).slice(0, 20);
  for (const candidate of candidates) {
    const code = extractOtp(candidate);
    if (code) {
      return code;
    }
  }
  return null;
}

async function readMailApi(account, args, mailbox) {
  const body = {
    email: account.email,
    client_id: account.clientId,
    refresh_token: account.refreshToken,
    mailbox,
  };

  if (args.proxyHttp) {
    body.http = args.proxyHttp;
  }
  if (args.proxySocks5) {
    body.socks5 = args.proxySocks5;
  }

  const url = `${args.mailApi}${args.mailApiEndpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: args.mailApi,
      referer: `${args.mailApi}/doc`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  if (data.code && String(data.code) !== "200") {
    throw new Error(data.message || data.msg || `Mail API returned code ${data.code}`);
  }

  return data;
}

async function findOtpViaMailApi(account, args, minDateMs = 0) {
  const deadline = Date.now() + args.timeout * 1000;
  let lastError = null;
  const mailboxes = args.mailbox.toLowerCase() === "both" ? ["INBOX", "Junk"] : [args.mailbox];

  while (Date.now() < deadline) {
    for (const mailbox of mailboxes) {
      try {
        const data = await readMailApi(account, args, mailbox);
        const code = extractOtpFromMailApiResponse(data, minDateMs);
        if (code) {
          return code;
        }
      } catch (error) {
        lastError = error;
      }
    }

    await sleep(args.interval * 1000);
  }

  throw new Error(
    `Timed out waiting for OTP from mail API${lastError ? `. Last API error: ${lastError.message}` : ""}`,
  );
}

async function findOtpViaImap(account, { timeout, interval, verifyTls }) {
  const deadline = Date.now() + timeout * 1000;
  let lastError = null;

  while (Date.now() < deadline) {
    let imap;
    try {
      const accessToken = await getOutlookAccessToken(account);
      imap = new ImapClient({
        host: "outlook.office365.com",
        port: 993,
        rejectUnauthorized: verifyTls,
      });

      await imap.connect();
      await imap.authenticateXoauth2(account.email, accessToken);
      await imap.selectInbox();

      const uids = await imap.searchRecent();
      for (const uid of uids.slice(-20).reverse()) {
        const message = await imap.fetchMessage(uid);
        const code = extractOtp(message);
        if (code) {
          return code;
        }
      }
    } catch (error) {
      lastError = error;
    } finally {
      if (imap) {
        imap.close();
      }
    }

    await sleep(interval * 1000);
  }

  throw new Error(
    `Timed out waiting for OTP${lastError ? `. Last mail error: ${lastError.message}` : ""}`,
  );
}

function pickAccessToken(privyResponse) {
  const direct =
    privyResponse.token ||
    privyResponse.access_token ||
    privyResponse.privy_access_token ||
    privyResponse.session?.token ||
    privyResponse.session?.access_token ||
    null;

  if (direct) {
    return direct;
  }

  return findJwtLikeString(privyResponse);
}

function findJwtLikeString(value, seen = new Set()) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? value : null;
  }
  if (typeof value !== "object" || seen.has(value)) {
    return null;
  }
  seen.add(value);

  const preferredKeys = [
    "token",
    "access_token",
    "privy_access_token",
    "privyAccessToken",
    "jwt",
    "bearer",
    "authorization",
  ];

  for (const key of preferredKeys) {
    if (key in value) {
      const found = findJwtLikeString(value[key], seen);
      if (found) {
        return found;
      }
    }
  }

  for (const child of Object.values(value)) {
    const found = findJwtLikeString(child, seen);
    if (found) {
      return found;
    }
  }

  return null;
}

async function accountsJson(pathname, token, options = {}) {
  const response = await fetch(`https://accounts.atxp.ai${pathname}`, {
    method: options.method || "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      referer: `${ORIGIN}/developer`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data.error || data.message || data.msg || text || response.statusText;
    throw new Error(`${pathname} failed: ${response.status} ${message}`);
  }

  return data;
}

async function ensureAtxpWalletIfPossible(privyResponse) {
  const token = pickAccessToken(privyResponse);
  if (!token) {
    return { skipped: true, reason: "No obvious Privy access token field found" };
  }

  try {
    const response = await fetch("https://accounts.atxp.ai/wallets/ensure", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        origin: ORIGIN,
        referer: `${ORIGIN}/`,
      },
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    return { skipped: true, reason: error.message };
  }
}

async function extractDeveloperConnection(privyResponse) {
  const token = pickAccessToken(privyResponse);
  if (!token) {
    return { skipped: true, reason: "No obvious Privy access token field found" };
  }

  try {
    let status = null;
    try {
      status = await accountsJson("/developer-mode/status", token);
    } catch (error) {
      status = { error: error.message };
    }

    if (!status || status.developerMode !== true) {
      await accountsJson("/developer-mode", token, {
        method: "POST",
        body: { developer: true },
      });
      status = { developerMode: true, enabledByScript: true };
    }

    const connection = await accountsJson("/connection-token", token);
    const connectionToken = connection.connectionToken || connection.connection_token || null;
    const atxpAccountId = connection.atxpAccountId || connection.account_id || null;
    const connectionString =
      connectionToken && atxpAccountId
        ? `https://accounts.atxp.ai?connection_token=${encodeURIComponent(
            connectionToken,
          )}&account_id=${encodeURIComponent(atxpAccountId)}`
        : null;

    return {
      status,
      connection,
      connectionToken,
      atxpAccountId,
      connectionString,
    };
  } catch (error) {
    return { skipped: true, reason: error.message };
  }
}

function safeFileName(email) {
  return email.replace(/[^a-z0-9_.-]+/gi, "_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOne(account, args) {
  const caId = crypto.randomUUID();
  const otpRequestedAt = Date.now();
  console.log(`[${account.email}] Sending Privy email code...`);
  await sendPrivyCode(account.email, caId);

  console.log(`[${account.email}] Waiting for OTP mail via ${args.mailMethod}...`);
  let code;
  try {
    code =
      args.mailMethod === "imap"
        ? await findOtpViaImap(account, args)
        : await findOtpViaMailApi(account, args, otpRequestedAt);
  } catch (error) {
    if (args.mailMethod === "api" && args.fallbackImap) {
      console.warn(`[${account.email}] Mail API failed, falling back to IMAP: ${error.message}`);
      code = await findOtpViaImap(account, args);
    } else {
      throw error;
    }
  }
  console.log(`[${account.email}] OTP found: ${code}`);

  console.log(`[${account.email}] Submitting OTP to Privy...`);
  const privy = await authenticatePrivyCode(account.email, code, caId);

  console.log(`[${account.email}] Touching ATXP wallet init endpoint if token is present...`);
  const walletEnsure = await ensureAtxpWalletIfPossible(privy);

  console.log(`[${account.email}] Extracting developer connection string...`);
  const developer = await extractDeveloperConnection(privy);

  fs.mkdirSync(args.outDir, { recursive: true });
  const outFile = path.join(args.outDir, `${safeFileName(account.email)}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        email: account.email,
        createdAt: new Date().toISOString(),
        caId,
        privy,
        walletEnsure,
        developer,
      },
      null,
      2,
    ),
  );

  console.log(`[${account.email}] Done. Saved: ${outFile}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }

  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error("--timeout must be a positive number");
  }
  if (!Number.isFinite(args.interval) || args.interval <= 0) {
    throw new Error("--interval must be a positive number");
  }
  if (!["api", "imap"].includes(args.mailMethod)) {
    throw new Error("--mail-method must be api or imap");
  }

  const accounts = loadAccounts(args);
  for (const account of accounts) {
    await runOne(account, args);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
