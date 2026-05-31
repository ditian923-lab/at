const state = {
  data: { jobs: [], sessions: [], pool: null },
  selectedTaskId: "",
  selectedJobId: "",
  activeView: localStorage.getItem("atxp.activeView") || "pool",
  toastTimer: null,
};

const stageLabels = {
  queued: "排队中",
  starting: "启动脚本",
  send_code: "发送验证码",
  wait_mail: "等待邮件",
  otp_found: "已找到 OTP",
  privy_auth: "提交 OTP",
  wallet: "初始化钱包",
  developer: "提取 Key",
  saved: "保存结果",
  success: "完成",
  failed: "失败",
  error: "报错",
  stopped: "已停止",
};

const statusLabels = {
  queued: "排队",
  running: "运行中",
  success: "成功",
  failed: "失败",
  stopped: "停止",
  completed: "已完成",
  completed_with_errors: "部分失败",
};

const stepOrder = [
  ["send_code", "发送验证码"],
  ["wait_mail", "读取验证邮件"],
  ["otp_found", "提取 OTP"],
  ["privy_auth", "提交 Privy 登录"],
  ["wallet", "初始化钱包"],
  ["developer", "获取 Developer Key"],
  ["saved", "保存 session"],
];

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(number);
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `$${number.toFixed(2)}`;
}

function formatRelativeTime(value) {
  if (!value) return "未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未同步";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.error?.message || data.error || response.statusText);
  }
  return data;
}

async function copyText(value, message) {
  await navigator.clipboard.writeText(value);
  showToast(message);
}

async function refreshState() {
  state.data = await fetchJson("/api/state");
  render();
}

function setView(view) {
  state.activeView = view;
  localStorage.setItem("atxp.activeView", view);
  render();
}

function getActiveJob() {
  return state.data.jobs.find((job) => ["running", "queued"].includes(job.status)) || state.data.jobs[0] || null;
}

function getSelectedTask() {
  const job = state.data.jobs.find((item) => item.id === state.selectedJobId) || getActiveJob();
  if (!job) return null;
  return job.tasks.find((task) => task.id === state.selectedTaskId) || job.tasks[0] || null;
}

function getAccountStats(email) {
  return state.data.pool?.stats?.accounts?.find((item) => item.email === email) || null;
}

function officialTransactionTitle(item) {
  if (item.model) return item.model;
  if (item.direction === "outgoing") return "支出";
  if (item.direction === "incoming") return "入账";
  return item.description || item.type || "流水";
}

function renderRecentOfficialTransactions(official) {
  const items = official?.transactions?.items || [];
  if (!items.length) {
    return `<div class="mini-transactions muted">暂无官方流水</div>`;
  }
  return `<div class="mini-transactions">
    ${items
      .slice(0, 3)
      .map((item) => {
        const title = officialTransactionTitle(item);
        const meta = [
          `${formatMoney(item.amount)}${item.currency ? ` ${item.currency}` : ""}`,
          item.totalTokens ? `${compactNumber(item.totalTokens)} tokens` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `<div class="mini-transaction-row">
          <span>${escapeHtml(formatTime(item.createdAt))}</span>
          <strong>${escapeHtml(title)}</strong>
          <em>${escapeHtml(meta)}</em>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderShell() {
  const isPool = state.activeView === "pool";
  $("#poolView").classList.toggle("active-view", isPool);
  $("#registerView").classList.toggle("active-view", !isPool);
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === state.activeView);
  });
  $("#pageTitle").textContent = isPool ? "号池管理" : "注册任务";
  $("#pageSubtitle").textContent = isPool ? "统一入口、账号资产和请求监控。" : "批量注册、邮件验证和 Developer Key 提取。";

  const pool = state.data.pool || {};
  $("#headerPoolCount").textContent = `${pool.keyCount || 0} Keys`;
  $("#headerRequestCount").textContent = `${pool.requestCount || 0} Requests`;
}

function renderPool() {
  const pool = state.data.pool || {};
  const official = pool.official || {};
  const officialRequests = Number(official.requestCount || 0);
  const localRequests = Number(pool.requestCount || 0);
  const tokenText = official.hasTokenUsage
    ? compactNumber(official.totalOfficialTokens || 0)
    : compactNumber(pool.totalTokens || 0);
  $("#poolBaseUrl").textContent = pool.baseUrl || "http://localhost:3131/pool/v1";
  $("#poolApiKey").textContent = pool.apiKey || "123456";
  $("#poolUpstream").textContent = pool.upstreamBaseUrl || "https://llm.atxp.ai/v1";
  $("#poolKeyCount").textContent = pool.keyCount ?? 0;
  $("#poolRequestCount").textContent = officialRequests || localRequests || 0;
  $("#poolRequestLabel").textContent = officialRequests ? "官方流水" : "本地代理记录";
  $("#poolSuccessRate").textContent = `${officialRequests ? official.successRate || 0 : pool.successRate || 0}%`;
  $("#poolSuccessLabel").textContent = officialRequests ? "官方流水" : "最近 100 条";
  $("#poolTotalTokens").textContent = tokenText;
  $("#poolTokenLabel").textContent = official.hasTokenUsage ? "官方流水" : "官方未返回，显示本地";
  $("#poolRemoteBalance").textContent = formatMoney(official.totalBalance);
  $("#poolRemoteStatus").textContent = official.checking
    ? "同步中"
    : `${official.okCount || 0}/${official.totalCount || 0} 已同步`;
  renderAccountCards();
  renderRequestRows();
}

function renderAccountCards() {
  const root = $("#accountCards");
  const sessions = state.data.sessions || [];
  if (!sessions.length) {
    root.innerHTML = `<p class="empty-state">sessions 目录里还没有保存结果。</p>`;
    return;
  }

  root.innerHTML = sessions
    .map((session) => {
      const keyReady = Boolean(session.connectionStringMasked);
      const stats = getAccountStats(session.email);
      const official = session.official || {};
      const officialRequests = Number(official.transactions?.requestCount || 0);
      const officialSuccessRate = Number(official.transactions?.successRate || 0);
      const tokenValue = official.transactions?.hasTokenUsage
        ? compactNumber(official.transactions?.totalTokens || 0)
        : compactNumber(stats?.totalTokens || 0);
      const tokenLabel = official.transactions?.hasTokenUsage ? "官方 Tokens" : "本地 Tokens";
      const statusText = official.checking ? "同步中" : keyReady && official.ok ? "可用" : keyReady ? "池中" : "无 Key";
      const statusClass = keyReady && !official.lastError ? "status-success" : keyReady ? "status-running" : "status-queued";
      const officialError = official.lastError ? `<p class="sync-error">${escapeHtml(official.lastError)}</p>` : "";
      return `<article class="account-card">
        <div class="account-head">
          <div>
            <div class="account-title">
              <span class="health-dot ${keyReady ? "good" : ""}"></span>
              <strong class="mono">${escapeHtml(session.email)}</strong>
            </div>
            <p>${escapeHtml(session.atxpAccountId || "-")}</p>
          </div>
          <span class="status ${statusClass}">${statusText}</span>
        </div>

        <div class="health-box">
          <div>
            <span>官方请求</span>
            <strong>${officialRequests || stats?.requestCount || 0}</strong>
          </div>
          <div>
            <span>成功率</span>
            <strong>${officialRequests ? `${officialSuccessRate}%` : "-"}</strong>
          </div>
          <div>
            <span>${tokenLabel}</span>
            <strong>${tokenValue}</strong>
          </div>
        </div>

        <div class="official-box ${official.ok ? "official-ok" : official.checking ? "official-loading" : ""}">
          <div>
            <span>官方余额</span>
            <strong>${formatMoney(official.balance?.total)}</strong>
          </div>
          <div>
            <span>近期消费</span>
            <strong>${formatMoney(official.transactions?.spent)}</strong>
          </div>
          <div>
            <span>官方 Tokens</span>
            <strong>${compactNumber(official.transactions?.totalTokens || 0)}</strong>
          </div>
          <div>
            <span>同步</span>
            <strong>${escapeHtml(formatRelativeTime(official.checkedAt))}</strong>
          </div>
        </div>
        ${officialError}
        ${renderRecentOfficialTransactions(official)}

        <div class="code-stack">
          <div class="kv-row">
            <span>Base URL</span>
            <code>${escapeHtml(session.llmBaseUrl || "https://llm.atxp.ai/v1")}</code>
          </div>
          <div class="kv-row">
            <span>API Key</span>
            <code>${escapeHtml(session.connectionStringMasked || "未获取到 Key")}</code>
          </div>
        </div>

        <div class="card-actions">
          <button class="small-button" data-copy-email="${escapeHtml(session.email)}" ${keyReady ? "" : "disabled"}>复制 Key</button>
          <button class="small-button" data-test-email="${escapeHtml(session.email)}" ${keyReady ? "" : "disabled"}>测试模型</button>
        </div>
      </article>`;
    })
    .join("");
}

function renderRequestRows() {
  const root = $("#requestRows");
  const requests = state.data.pool?.requests || [];
  if (!requests.length) {
    root.innerHTML = `<tr><td colspan="6" class="empty-cell">暂无聚合请求。</td></tr>`;
    return;
  }

  root.innerHTML = requests
    .map((request) => `<tr>
      <td>${escapeHtml(formatTime(request.at))}</td>
      <td class="mono">${escapeHtml(request.email || "-")}</td>
      <td class="mono">${escapeHtml(request.model || request.path || "-")}</td>
      <td>${statusBadge(request.ok ? "success" : "failed", request.status)}</td>
      <td>${escapeHtml(compactNumber(request.totalTokens || 0))}</td>
      <td>${escapeHtml(request.durationMs || 0)}ms</td>
    </tr>`)
    .join("");
}

function renderRegisterSummary() {
  const activeJob = getActiveJob();
  const totals = activeJob?.totals || { total: 0, success: 0, failed: 0, running: 0 };
  const running = activeJob && ["running", "queued"].includes(activeJob.status);
  $("#startButton").disabled = Boolean(running);
  $("#stopButton").disabled = !running;
  $("#activeJobText").textContent = activeJob
    ? `任务 ${activeJob.id}：${statusLabels[activeJob.status] || activeJob.status}，成功 ${totals.success}/${totals.total}`
    : "等待任务开始";
}

function renderLogs() {
  const activeJob = getActiveJob();
  const logList = $("#logList");
  const logs = activeJob?.logs || [];
  if (!logs.length) {
    logList.innerHTML = `<div class="muted">暂无日志</div>`;
    return;
  }
  logList.innerHTML = logs
    .slice(-250)
    .map((log) => {
      const cls = log.level === "error" ? "log-error" : log.level === "success" ? "log-success" : "";
      return `<div class="log-line ${cls}">
        <span class="log-time">${escapeHtml(formatTime(log.at))}</span>
        <span>${escapeHtml(log.message)}</span>
      </div>`;
    })
    .join("");
  logList.scrollTop = logList.scrollHeight;
}

function statusBadge(status, label) {
  return `<span class="status status-${escapeHtml(status)}">${escapeHtml(label || statusLabels[status] || status)}</span>`;
}

function renderTasks() {
  const activeJob = getActiveJob();
  const tbody = $("#taskRows");
  if (!activeJob || !activeJob.tasks.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">还没有任务。</td></tr>`;
    renderDetail();
    return;
  }

  if (!state.selectedJobId) {
    state.selectedJobId = activeJob.id;
    state.selectedTaskId = activeJob.tasks[0]?.id || "";
  }

  tbody.innerHTML = activeJob.tasks
    .map((task) => {
      const selected = task.id === state.selectedTaskId ? ` aria-selected="true"` : "";
      const accountId = task.result?.atxpAccountId || "-";
      const copyDisabled = task.result?.email ? "" : "disabled";
      return `<tr data-job-id="${escapeHtml(activeJob.id)}" data-task-id="${escapeHtml(task.id)}"${selected}>
        <td class="mono">${escapeHtml(task.email)}</td>
        <td>${statusBadge(task.status)}</td>
        <td>${escapeHtml(stageLabels[task.stage] || task.stage)}</td>
        <td class="mono">${escapeHtml(accountId)}</td>
        <td>
          <div class="table-actions">
            <button class="small-button" data-copy-email="${escapeHtml(task.email)}" ${copyDisabled}>复制 Key</button>
            <button class="small-button" data-test-email="${escapeHtml(task.email)}" ${copyDisabled}>测试模型</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
  renderDetail();
}

function renderDetail() {
  const task = getSelectedTask();
  const pane = $("#detailPane");
  if (!task) {
    pane.innerHTML = `<h3>账号详情</h3><p class="muted">选择一行任务后显示链路详情。</p>`;
    return;
  }

  const activeIndex = stepOrder.findIndex(([key]) => key === task.stage);
  const failed = task.status === "failed";
  const steps = stepOrder
    .map(([key, label], index) => {
      let cls = "";
      if (failed && index === activeIndex) cls = "failed";
      else if (task.status === "success" || index < activeIndex) cls = "done";
      else if (index === activeIndex) cls = "active";
      return `<div class="step ${cls}">
        <span class="step-dot" aria-hidden="true"></span>
        <div>
          <strong>${escapeHtml(label)}</strong>
          <div class="muted">${key === task.stage ? "当前步骤" : ""}</div>
        </div>
      </div>`;
    })
    .join("");

  const result = task.result;
  const secret = result?.connectionStringMasked
    ? `<div class="secret-box">
        <div class="kv-row">
          <span>Base URL</span>
          <code>${escapeHtml(result.llmBaseUrl || "https://llm.atxp.ai/v1")}</code>
        </div>
        <div class="kv-row">
          <span>API Key</span>
          <code>${escapeHtml(result.connectionStringMasked)}</code>
        </div>
      </div>`
    : `<p class="muted">该账号暂时还没有保存 connection string。</p>`;

  pane.innerHTML = `<h3 class="mono">${escapeHtml(task.email)}</h3>
    <div>${statusBadge(task.status)} <span class="muted">${escapeHtml(stageLabels[task.stage] || task.stage)}</span></div>
    <div class="step-list">${steps}</div>
    ${task.error ? `<p class="log-error">${escapeHtml(task.error)}</p>` : ""}
    ${secret}`;
}

function render() {
  renderShell();
  renderPool();
  renderRegisterSummary();
  renderLogs();
  renderTasks();
}

async function copyKey(email) {
  const session = await fetchJson(`/api/session?email=${encodeURIComponent(email)}`);
  if (!session.connectionString) {
    showToast("这个账号没有 connection string");
    return;
  }
  await copyText(session.connectionString, "完整 Key 已复制");
}

async function testModels(email) {
  const result = await fetchJson(`/api/session/test?email=${encodeURIComponent(email)}`);
  if (result.ok) {
    showToast(`模型测试通过：${result.modelCount} 个模型`);
    return;
  }
  if (result.kind === "no_balance") {
    showToast("Key 有效，但余额为 $0，不能调用模型");
    return;
  }
  if (result.kind === "auth_failed") {
    showToast("Key 无效或已失效，请重新注册/提取");
    return;
  }
  showToast(`模型测试失败：${result.status} ${result.error || ""}`);
}

async function testPool() {
  const result = await fetchJson("/api/pool/test");
  if (result.ok) {
    showToast(`号池可用：${result.modelCount} 个模型，本次使用 ${result.selectedEmail}`);
    return;
  }
  showToast(`号池测试失败：${result.status} ${result.error || ""}`);
}

async function refreshOfficialStatus() {
  const result = await fetchJson("/api/official/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (result.running) {
    showToast("官方状态正在同步中");
  } else {
    showToast(`官方状态已同步：${result.statuses?.length || 0} 个账号`);
  }
  await refreshState();
}

async function startJob(event) {
  event.preventDefault();
  const payload = {
    accountsText: $("#accountsText").value,
    mailbox: $("#mailbox").value,
    mailMethod: $("#mailMethod").value,
    timeout: $("#timeout").value,
    interval: $("#interval").value,
    fallbackImap: $("#fallbackImap").checked,
    proxyHttp: $("#proxyHttp").value,
    proxySocks5: $("#proxySocks5").value,
  };
  try {
    const data = await fetchJson("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.selectedJobId = data.job.id;
    state.selectedTaskId = data.job.tasks[0]?.id || "";
    setView("register");
    showToast("任务已启动");
    await refreshState();
  } catch (error) {
    showToast(error.message);
  }
}

async function stopActiveJob() {
  const activeJob = getActiveJob();
  if (!activeJob || !["running", "queued"].includes(activeJob.status)) return;
  await fetchJson(`/api/jobs/${encodeURIComponent(activeJob.id)}/stop`, { method: "POST" });
  showToast("已请求停止当前任务");
  await refreshState();
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  $("#jobForm").addEventListener("submit", startJob);
  $("#stopButton").addEventListener("click", stopActiveJob);
  $("#refreshButton").addEventListener("click", refreshState);
  $("#refreshPoolButton").addEventListener("click", refreshState);
  $("#refreshOfficialButton").addEventListener("click", refreshOfficialStatus);
  $("#copyPoolBaseButton").addEventListener("click", () => {
    copyText($("#poolBaseUrl").textContent, "号池 Base URL 已复制");
  });
  $("#copyPoolKeyButton").addEventListener("click", () => {
    copyText($("#poolApiKey").textContent, "统一 Key 已复制");
  });
  $("#testPoolButton").addEventListener("click", testPool);

  document.body.addEventListener("click", async (event) => {
    const copyButton = event.target.closest("[data-copy-email]");
    if (copyButton) {
      event.stopPropagation();
      await copyKey(copyButton.dataset.copyEmail);
      return;
    }

    const testButton = event.target.closest("[data-test-email]");
    if (testButton) {
      event.stopPropagation();
      await testModels(testButton.dataset.testEmail);
      return;
    }

    const row = event.target.closest("[data-task-id]");
    if (row) {
      state.selectedJobId = row.dataset.jobId;
      state.selectedTaskId = row.dataset.taskId;
      renderDetail();
    }
  });

  const events = new EventSource("/api/events");
  events.onmessage = () => refreshState().catch(() => {});
  events.onerror = () => {};
  setInterval(() => refreshState().catch(() => {}), 5000);
}

bindEvents();
refreshState().catch((error) => showToast(error.message));
