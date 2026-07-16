// ============================================================
// 前端逻辑（Vite 入口模块）
// amazon-connect-streams 通过 CDN <script> 注入全局 connect
// ============================================================

// ============================================================
// 配置常量（硬编码到页面中）
// ============================================================
const instanceURL = "https://connect-us-2025.my.connect.aws/";
const instanceCCPURL = instanceURL + "ccp-v2/";
const instanceRegion = "us-west-2";
const loginURL = "";

// ============================================================
// 全局状态
// ============================================================
let currentAgentUsername = null;
let autoRefreshTimer = null;
// 可选队列列表（{id, name}）与当前选中的队列ID集合
let availableQueues = [];
let selectedQueueIds = new Set();
// 历史邮件分页状态
let historyPage = 1;
let historyTotalPages = 1;

function $(id) {
  return document.getElementById(id);
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

// ============================================================
// 日志
// ============================================================
function logOutput(text) {
  const textarea = $("message");
  textarea.value += text + "\n";
  const logDisplay = $("logDisplay");
  if (logDisplay) {
    logDisplay.value = textarea.value;
    scrollToBottom(logDisplay);
  }
}

function clearOutput() {
  $("message").value = "";
  if ($("logDisplay")) $("logDisplay").value = "";
}

function showLog() {
  const c = $("logContainer");
  c.classList.toggle("hidden");
  $("logContainer-btn").textContent = c.classList.contains("hidden")
    ? "日志"
    : "隐藏";
  if (!c.classList.contains("hidden")) {
    $("logDisplay").value = $("message").value;
    scrollToBottom($("logDisplay"));
  }
}

// ============================================================
// 时间工具
// ============================================================
function convertToLocalTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Date -> datetime-local 输入框需要的本地时间字符串（YYYY-MM-DDTHH:mm） */
function toDatetimeLocalValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ============================================================
// Connect Streams：座席初始化后记录用户名并加载邮件
// ============================================================
function subscribeToAgentEvents(agent) {
  try {
    currentAgentUsername = agent.getConfiguration().username;
  } catch (e) {}
  logOutput("座席已登录: " + agent.getName());
  loadEmails();
}

// ============================================================
// CCP 初始化（页面加载时自动执行）
// ============================================================
function initCcp() {
  window.localStorage.removeItem("connectPopupManager::connect::loginPopup");

  try {
    // 参考 connect-ccp-sso-regions：使用 connect.agentApp.initApp 初始化，
    // 弹窗登录（loginPopup: true），登录成功后弹窗自动关闭，CCP 内嵌显示在左侧容器。
    connect.agentApp.initApp("ccp", "container-div", instanceCCPURL, {
      style: "width:100%; height:100%;",
      ccpParams: {
        loginPopup: true,
        loginPopupAutoClose: true,
        ...(loginURL ? { loginUrl: loginURL } : {}),
        region: instanceRegion,
        softphone: {
          allowFramedSoftphone: true,
          disableRingtone: false,
        },
        pageOptions: {
          enableAudioDeviceSettings: true,
          enablePhoneTypeSettings: true,
        },
        ccpAckTimeout: 5000,
        ccpSynTimeout: 3000,
        ccpLoadTimeout: 10000,
      },
    });

    connect.agent(subscribeToAgentEvents);
  } catch (err) {
    logOutput("CCP初始化失败: " + JSON.stringify(err));
  }
}

// ============================================================
// 排队邮件列表（SearchContacts）
// 采用增量更新：对现有行原地修改、新增缺失行、移除已消失的行，
// 避免整表重建导致的屏幕闪烁。
// ============================================================

/** 仅在文本变化时更新，减少不必要的 DOM 写入 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** 移除表格中的非数据行（占位 / 空状态 / 错误提示） */
function removeNonDataRows(tbody) {
  tbody.querySelectorAll("tr:not([data-contact-id])").forEach((r) => r.remove());
}

/** 显示一条整行提示信息（空状态或错误） */
function showMessageRow(tbody, message, colorClass) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.setAttribute("colspan", "6");
  td.className = "px-3 py-6 text-center " + colorClass;
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

/** 创建一行邮件（结构固定，后续只更新文本） */
function createEmailRow(email) {
  const tr = document.createElement("tr");
  tr.setAttribute("data-contact-id", email.id);
  tr.className = "hover:bg-gray-50 border-b border-gray-100";

  const classes = [
    "px-3 py-2 text-blue-600 break-all text-xs underline cursor-pointer",
    "px-3 py-2 font-medium text-gray-800",
    "px-3 py-2 text-gray-600",
    "px-3 py-2 text-gray-600",
    "px-3 py-2 text-gray-600",
  ];
  classes.forEach((cls) => {
    const td = document.createElement("td");
    td.className = cls;
    tr.appendChild(td);
  });

  // Contact ID 列（第一列）可点击，等同于点击 View
  const idCell = tr.children[0];
  idCell.title = "点击查看邮件历史回复";
  idCell.addEventListener("click", () => viewHistory(email.id, email.name));

  const tdAction = document.createElement("td");
  tdAction.className = "px-3 py-2";
  const actionWrap = document.createElement("div");
  actionWrap.className = "flex gap-2";

  const viewBtn = document.createElement("button");
  viewBtn.className =
    "px-3 py-1 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium transition";
  viewBtn.textContent = "View";
  viewBtn.addEventListener("click", () => viewHistory(email.id, email.name));

  const btn = document.createElement("button");
  btn.className =
    "assign-btn px-3 py-1 text-xs bg-green-500 hover:bg-green-600 text-white rounded-lg font-medium transition";
  btn.textContent = "Reply";
  btn.addEventListener("click", () => assignToMe(email.id, btn));

  actionWrap.appendChild(viewBtn);
  actionWrap.appendChild(btn);
  tdAction.appendChild(actionWrap);
  tr.appendChild(tdAction);

  return tr;
}

/** 原地更新一行的文本内容 */
function updateEmailRow(row, email, now) {
  const enq = email.enqueueTimestamp || email.initiationTimestamp;
  const waiting = enq ? formatDuration(now - new Date(enq)) : "-";
  const cells = row.children;
  setText(cells[0], email.id);
  setText(cells[1], email.name);
  setText(cells[2], email.queueName || email.queueId || "-");
  setText(cells[3], convertToLocalTime(enq));
  setText(cells[4], waiting);
}

/** 增量渲染邮件列表 */
function renderEmails(emails) {
  const tbody = $("emailList");
  $("emailCount").textContent = emails.length;
  removeNonDataRows(tbody);

  if (emails.length === 0) {
    tbody.querySelectorAll("tr[data-contact-id]").forEach((r) => r.remove());
    showMessageRow(tbody, "当前没有排队中的邮件。", "text-gray-400");
    return;
  }

  // 建立现有行索引
  const existing = new Map();
  tbody
    .querySelectorAll("tr[data-contact-id]")
    .forEach((r) => existing.set(r.getAttribute("data-contact-id"), r));

  // 移除已不在队列中的行
  const incomingIds = new Set(emails.map((e) => e.id));
  existing.forEach((row, id) => {
    if (!incomingIds.has(id)) {
      row.remove();
      existing.delete(id);
    }
  });

  // 逐条更新或新增，并按顺序排列（appendChild 会移动已存在的节点）
  const now = Date.now();
  emails.forEach((email) => {
    let row = existing.get(email.id);
    if (!row) {
      row = createEmailRow(email);
    }
    updateEmailRow(row, email, now);
    tbody.appendChild(row);
  });
}

async function loadEmails() {
  try {
    // 已加载队列但一个都没选：直接展示空列表，不发请求
    if (availableQueues.length > 0 && selectedQueueIds.size === 0) {
      renderEmails([]);
      return;
    }
    // 若选择了部分队列，则作为查询参数传给后端进行筛选；全选时查询全部
    let url = "/api/emails";
    if (
      selectedQueueIds.size > 0 &&
      selectedQueueIds.size < availableQueues.length
    ) {
      const ids = [...selectedQueueIds].map(encodeURIComponent).join(",");
      url += "?queueIds=" + ids;
    }
    const resp = await fetch(url, { cache: "no-store" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "请求失败");
    renderEmails(data.emails || []);
  } catch (err) {
    logOutput("加载邮件失败: " + err.message);
    // 仅在当前没有任何数据行时才显示错误，避免刷新时清空造成闪烁
    const tbody = $("emailList");
    if (!tbody.querySelector("tr[data-contact-id]")) {
      removeNonDataRows(tbody);
      showMessageRow(tbody, "加载失败: " + err.message, "text-red-500");
    }
  }
}

// ============================================================
// Assign to Me（TransferContact 到当前座席个人队列）
// ============================================================
async function assignToMe(contactId, btn) {
  if (!currentAgentUsername) {
    alert("无法获取当前座席信息，请等待 CCP 登录完成。");
    return;
  }
  btn.disabled = true;
  btn.textContent = "处理中...";
  try {
    const resp = await fetch("/api/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contactId: contactId,
        username: currentAgentUsername,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || "转接失败");
    }
    logOutput(
      "已转接邮件到当前座席: " + contactId + " -> " + data.assignedUserId
    );
    btn.textContent = "已分配";
    btn.classList.remove("bg-green-500", "hover:bg-green-600");
    btn.classList.add("bg-gray-400");
    setTimeout(loadEmails, 1500);
  } catch (err) {
    logOutput("Reply 失败: " + err.message);
    alert("分配失败: " + err.message);
    btn.disabled = false;
    btn.textContent = "Reply";
  }
}

// ============================================================
// Reply（历史邮件）：为已完成邮件创建座席回复草稿并路由给当前座席
// 与“排队中的邮件”的 assignToMe 不同：已完成联系不能转接，需 CreateContact
// ============================================================
async function replyToEmail(contactId, btn) {
  if (!currentAgentUsername) {
    alert("无法获取当前座席信息，请等待 CCP 登录完成。");
    return;
  }
  btn.disabled = true;
  btn.textContent = "处理中...";
  try {
    const resp = await fetch("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contactId: contactId,
        username: currentAgentUsername,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || "回复失败");
    }
    logOutput(
      "已创建座席回复: 原邮件 " + contactId + " -> 新联系 " + data.contactId
    );
    btn.textContent = "已回复";
    btn.classList.remove("bg-green-500", "hover:bg-green-600");
    btn.classList.add("bg-gray-400");
  } catch (err) {
    logOutput("Reply 失败: " + err.message);
    alert("回复失败: " + err.message);
    btn.disabled = false;
    btn.textContent = "Reply";
  }
}

// ============================================================
// View：查看邮件历史来往记录（按 contact id 分组）
// ============================================================
function escapeText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 把一封邮件正文渲染到沙箱 iframe 中（禁用脚本，防止 XSS） */
function buildMessageFrame(msg) {
  const iframe = document.createElement("iframe");
  iframe.className = "w-full border border-gray-200 rounded bg-white";
  iframe.style.minHeight = "60px";
  // allow-same-origin 便于加载后自适应高度；不加 allow-scripts，脚本不会执行
  iframe.setAttribute("sandbox", "allow-same-origin");
  const isHtml = (msg.contentType || "").includes("html");
  iframe.srcdoc = isHtml
    ? msg.content
    : "<pre style='white-space:pre-wrap;font-family:sans-serif;margin:8px'>" +
      escapeText(msg.content) +
      "</pre>";
  iframe.addEventListener("load", () => {
    try {
      const h = iframe.contentDocument.body.scrollHeight;
      iframe.style.height = h + 24 + "px";
    } catch (e) {}
  });
  return iframe;
}

function renderHistory(data) {
  const body = $("historyBody");
  body.innerHTML = "";
  const groups = data.groups || [];
  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "text-center text-gray-400 py-6";
    empty.textContent = "没有历史记录。";
    body.appendChild(empty);
    return;
  }

  groups.forEach((g) => {
    const card = document.createElement("div");
    card.className = "border border-gray-200 rounded-lg";

    const inbound = g.initiationMethod === "INBOUND";
    const header = document.createElement("div");
    header.className =
      "flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-100";

    const left = document.createElement("div");
    left.className = "flex items-center gap-2";
    const badge = document.createElement("span");
    badge.className =
      "px-2 py-0.5 text-xs rounded-full " +
      (inbound ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700");
    badge.textContent = inbound ? "客户来信" : "座席回复";
    const subject = document.createElement("span");
    subject.className = "text-sm font-medium text-gray-800";
    subject.textContent = g.subject || "(无主题)";
    left.appendChild(badge);
    left.appendChild(subject);

    const time = document.createElement("span");
    time.className = "text-xs text-gray-500";
    time.textContent = convertToLocalTime(g.initiationTimestamp);

    header.appendChild(left);
    header.appendChild(time);

    const meta = document.createElement("div");
    meta.className = "px-4 pt-2 text-xs text-gray-400 break-all";
    meta.textContent = "Contact ID: " + g.contactId;

    const content = document.createElement("div");
    content.className = "p-4 space-y-3";
    if (!g.messages || g.messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "text-xs text-gray-400";
      empty.textContent = "(无邮件正文)";
      content.appendChild(empty);
    } else {
      g.messages.forEach((m) => content.appendChild(buildMessageFrame(m)));
    }

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(content);
    body.appendChild(card);
  });
}

async function viewHistory(contactId, subjectHint) {
  const panel = $("historyPanel");
  const resizer = $("historyResizer");
  const body = $("historyBody");
  $("historyTitle").textContent =
    "邮件历史" + (subjectHint ? " - " + subjectHint : "");
  body.innerHTML =
    '<div class="text-center text-gray-400 py-6">加载中...</div>';
  resizer.classList.remove("hidden");
  panel.classList.remove("hidden");
  panel.classList.add("flex");
  try {
    const resp = await fetch(
      "/api/history?contactId=" + encodeURIComponent(contactId),
      { cache: "no-store" }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "请求失败");
    renderHistory(data);
  } catch (err) {
    logOutput("加载邮件历史失败: " + err.message);
    const el = document.createElement("div");
    el.className = "text-center text-red-500 py-6";
    el.textContent = "加载失败: " + err.message;
    body.innerHTML = "";
    body.appendChild(el);
  }
}

function closeHistory() {
  $("historyPanel").classList.add("hidden");
  $("historyPanel").classList.remove("flex");
  $("historyResizer").classList.add("hidden");
  $("historyBody").innerHTML = "";
}

// 拖拽分割条调整邮件历史面板高度
(function initHistoryResizer() {
  const resizer = $("historyResizer");
  const panel = $("historyPanel");
  let dragging = false;
  let startY = 0;
  let startH = 0;

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startH = panel.offsetHeight;
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // 向上拖动增大历史面板高度
    let h = startH + (startY - e.clientY);
    const maxH = window.innerHeight - 200;
    h = Math.max(120, Math.min(h, maxH));
    panel.style.height = h + "px";
  });
  window.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = "";
    }
  });
})();

// ============================================================
// 标签页切换（排队中的邮件 / 历史邮件）
// ============================================================
const TAB_ACTIVE = ["bg-white", "text-blue-600", "border-gray-200"];
const TAB_INACTIVE = ["text-gray-500", "hover:text-gray-700"];

function switchTab(tab) {
  const isQueue = tab === "queue";
  const queueView = $("queueView");
  const historyView = $("historyEmailView");
  const tabQueue = $("tabQueue");
  const tabHistory = $("tabHistory");

  queueView.classList.toggle("hidden", !isQueue);
  queueView.classList.toggle("flex", isQueue);
  historyView.classList.toggle("hidden", isQueue);
  historyView.classList.toggle("flex", !isQueue);

  const active = isQueue ? tabQueue : tabHistory;
  const inactive = isQueue ? tabHistory : tabQueue;
  active.classList.add(...TAB_ACTIVE);
  active.classList.remove(...TAB_INACTIVE);
  inactive.classList.remove(...TAB_ACTIVE);
  inactive.classList.add(...TAB_INACTIVE);

  // 切换标签时收起底部的邮件历史详情面板
  closeHistory();

  // 首次进入历史邮件视图时自动加载一次
  if (!isQueue && !historyView.dataset.loaded) {
    historyView.dataset.loaded = "1";
    loadHistoryEmails(1);
  }
}

// ============================================================
// 历史邮件列表（SearchContacts: EMAIL / AGENT_REPLY / COMPLETED）
// ============================================================
function renderHistoryEmails(data) {
  const tbody = $("historyEmailList");
  const emails = data.emails || [];
  tbody.innerHTML = "";

  $("historyEmailCount").textContent = data.total || 0;
  historyPage = data.page || 1;
  historyTotalPages = data.totalPages || 1;
  $("histPageInfo").textContent =
    "共 " + (data.total || 0) + " 条 · 第 " + historyPage + "/" + historyTotalPages + " 页";
  $("histPrevBtn").disabled = historyPage <= 1;
  $("histNextBtn").disabled = historyPage >= historyTotalPages;

  if (emails.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.setAttribute("colspan", "6");
    td.className = "px-3 py-6 text-center text-gray-400";
    td.textContent = "该时间范围内没有历史邮件。";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  emails.forEach((email) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-gray-50 border-b border-gray-100";

    // Contact ID（可点击，等同 View）
    const idTd = document.createElement("td");
    idTd.className =
      "px-3 py-2 text-blue-600 break-all text-xs underline cursor-pointer";
    idTd.textContent = email.id;
    idTd.title = "点击查看邮件历史回复";
    idTd.addEventListener("click", () => viewHistory(email.id, email.name));
    tr.appendChild(idTd);

    const cells = [
      { text: convertToLocalTime(email.initiationTimestamp), cls: "px-3 py-2 text-gray-600" },
      { text: email.systemEmail || "-", cls: "px-3 py-2 text-gray-600" },
      { text: email.customerEmail || "-", cls: "px-3 py-2 text-gray-600" },
      { text: email.agent || "-", cls: "px-3 py-2 text-gray-600" },
    ];
    cells.forEach((c) => {
      const td = document.createElement("td");
      td.className = c.cls;
      td.textContent = c.text;
      tr.appendChild(td);
    });

    // 操作列：View + Reply（与“排队中的邮件”一致）
    const tdAction = document.createElement("td");
    tdAction.className = "px-3 py-2";
    const actionWrap = document.createElement("div");
    actionWrap.className = "flex gap-2";

    const viewBtn = document.createElement("button");
    viewBtn.className =
      "px-3 py-1 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium transition";
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", () => viewHistory(email.id, email.name));

    const replyBtn = document.createElement("button");
    replyBtn.className =
      "assign-btn px-3 py-1 text-xs bg-green-500 hover:bg-green-600 text-white rounded-lg font-medium transition";
    replyBtn.textContent = "Reply";
    replyBtn.addEventListener("click", () => replyToEmail(email.id, replyBtn));

    actionWrap.appendChild(viewBtn);
    actionWrap.appendChild(replyBtn);
    tdAction.appendChild(actionWrap);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  });
}

async function loadHistoryEmails(page) {
  if (typeof page === "number") historyPage = page;
  const tbody = $("historyEmailList");
  tbody.innerHTML =
    '<tr><td colspan="6" class="px-3 py-6 text-center text-gray-400">加载中...</td></tr>';

  const startVal = $("histStart").value;
  const endVal = $("histEnd").value;
  const pageSize = $("histPageSize").value || "25";

  const params = new URLSearchParams();
  // datetime-local 是本地时间，转成 ISO 传给后端
  if (startVal) params.set("startTime", new Date(startVal).toISOString());
  if (endVal) params.set("endTime", new Date(endVal).toISOString());
  params.set("page", String(historyPage));
  params.set("pageSize", pageSize);

  try {
    const resp = await fetch("/api/history-emails?" + params.toString(), {
      cache: "no-store",
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "请求失败");
    renderHistoryEmails(data);
  } catch (err) {
    logOutput("加载历史邮件失败: " + err.message);
    tbody.innerHTML =
      '<tr><td colspan="6" class="px-3 py-6 text-center text-red-500">加载失败: ' +
      escapeText(err.message) +
      "</td></tr>";
  }
}

function historyPrevPage() {
  if (historyPage > 1) loadHistoryEmails(historyPage - 1);
}
function historyNextPage() {
  if (historyPage < historyTotalPages) loadHistoryEmails(historyPage + 1);
}

/** 初始化历史邮件时间范围（默认过去 7 天）与每页大小联动 */
(function initHistoryEmailControls() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  $("histEnd").value = toDatetimeLocalValue(now);
  $("histStart").value = toDatetimeLocalValue(weekAgo);
  // 改变每页大小时回到第 1 页重新查询
  $("histPageSize").addEventListener("change", () => loadHistoryEmails(1));
})();

// ============================================================
// 自动刷新
// ============================================================
function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(loadEmails, 10000);
}
function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

$("autoRefresh").addEventListener("change", (e) => {
  if (e.target.checked) startAutoRefresh();
  else stopAutoRefresh();
});

// ============================================================
// 队列多选下拉筛选
// ============================================================
/** 更新下拉按钮上的文字，反映当前选中情况 */
function updateQueueFilterLabel() {
  const label = $("queueFilterLabel");
  const total = availableQueues.length;
  const n = selectedQueueIds.size;
  if (total === 0) {
    label.textContent = "队列: 无";
  } else if (n === 0 || n === total) {
    label.textContent = "队列: 全部";
  } else if (n === 1) {
    const id = [...selectedQueueIds][0];
    const q = availableQueues.find((x) => x.id === id);
    label.textContent = "队列: " + (q ? q.name : id);
  } else {
    label.textContent = "队列: 已选 " + n + " 个";
  }
}

/** 渲染下拉里的队列复选框列表 */
function renderQueueFilterList() {
  const list = $("queueFilterList");
  list.innerHTML = "";
  if (availableQueues.length === 0) {
    const empty = document.createElement("div");
    empty.className = "px-1 py-2 text-xs text-gray-400";
    empty.textContent = "没有可用的队列。";
    list.appendChild(empty);
    return;
  }
  availableQueues.forEach((q) => {
    const label = document.createElement("label");
    label.className =
      "flex items-center gap-2 px-1 py-1 text-sm text-gray-700 rounded hover:bg-gray-50 cursor-pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "rounded";
    cb.value = q.id;
    cb.checked = selectedQueueIds.has(q.id);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedQueueIds.add(q.id);
      else selectedQueueIds.delete(q.id);
      updateQueueFilterLabel();
      loadEmails();
    });
    const span = document.createElement("span");
    span.className = "break-all";
    span.textContent = q.name;
    label.appendChild(cb);
    label.appendChild(span);
    list.appendChild(label);
  });
}

/** 从后端拉取可选队列并初始化选中状态（默认全选） */
async function loadQueues() {
  try {
    const resp = await fetch("/api/queues", { cache: "no-store" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "请求失败");
    availableQueues = data.queues || [];
    // 默认全选（即查询全部）
    selectedQueueIds = new Set(availableQueues.map((q) => q.id));
    renderQueueFilterList();
    updateQueueFilterLabel();
  } catch (err) {
    logOutput("加载队列列表失败: " + err.message);
    const list = $("queueFilterList");
    list.innerHTML =
      '<div class="px-1 py-2 text-xs text-red-500">加载失败: ' +
      escapeText(err.message) +
      "</div>";
  }
}

(function initQueueFilter() {
  const btn = $("queueFilterBtn");
  const menu = $("queueFilterMenu");
  const wrap = $("queueFilter");

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });

  // 点击菜单外部时关闭
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) menu.classList.add("hidden");
  });

  $("queueSelectAll").addEventListener("click", () => {
    selectedQueueIds = new Set(availableQueues.map((q) => q.id));
    renderQueueFilterList();
    updateQueueFilterLabel();
    loadEmails();
  });

  $("queueClearAll").addEventListener("click", () => {
    selectedQueueIds.clear();
    renderQueueFilterList();
    updateQueueFilterLabel();
    loadEmails();
  });

  loadQueues();
})();

// ============================================================
// 暴露给 HTML 内联事件（onclick）使用
// ============================================================
Object.assign(window, {
  showLog,
  clearOutput,
  loadEmails,
  closeHistory,
  switchTab,
  loadHistoryEmails,
  historyPrevPage,
  historyNextPage,
});

// 默认激活“排队中的邮件”标签
switchTab("queue");

// 页面加载即自动初始化 CCP（无需登录按钮）
initCcp();
