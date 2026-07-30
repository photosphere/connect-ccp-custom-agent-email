// ============================================================
// email_m.html 前端逻辑（Vite 入口模块）
// 两列布局：左侧 Email Contact（Unread / Read 两个 Tab）
//           右侧 Email Information（邮件详情 + Reply / Forward + CCP）
// amazon-connect-streams 通过 CDN <script> 注入全局 connect
// ============================================================
import { EmailClient } from "@amazon-connect/email";

// ============================================================
// 配置常量
// ============================================================
const instanceURL = "https://connect-us-2025.my.connect.aws/";
const instanceCCPURL = instanceURL + "ccp-v2/";
const instanceRegion = "us-west-2";
const loginURL = "";

// 默认展示最新历史邮件条数
const READ_PAGE_SIZE = 20;

// ============================================================
// 全局状态
// ============================================================
let currentAgentUsername = null;
let emailClient = null;
let ccpInitialized = false;

// 当前选中的联系（用于 Reply / Forward）
// { id, subject, type: "unread" | "read", customerEmail, systemEmail, agent }
let currentContact = null;

// 历史邮件分页状态
let readPage = 1;
let readTotalPages = 1;

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

/** Date -> datetime-local 输入框需要的本地时间字符串（YYYY-MM-DDTHH:mm） */
function toDatetimeLocalValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ============================================================
// CCP 初始化（页面加载时执行一次，隐藏，不可见）
// 已登录则 Streams 会自动复用会话，不再弹出登录窗口。
// ============================================================
function subscribeToAgentEvents(agent) {
  try {
    currentAgentUsername = agent.getConfiguration().username;
  } catch (e) {}
  logOutput("座席已登录: " + agent.getName());
  $("agentStatus").textContent = "已登录: " + agent.getName();
  initEmailClient();
  // 登录完成后自动加载 Unread 列表
  loadUnread();
}

function initEmailClient() {
  if (emailClient) return;
  try {
    const getConfig =
      connect.core.getSDKClientConfig || connect.core.getSdkClientConfig;
    if (typeof getConfig !== "function") {
      throw new Error(
        "当前 amazon-connect-streams 版本不支持 getSDKClientConfig，请升级 Streams。"
      );
    }
    const connectClientConfig = getConfig.call(connect.core);
    emailClient = new EmailClient(connectClientConfig);
    logOutput("EmailClient 初始化成功");
  } catch (err) {
    logOutput(
      "EmailClient 初始化失败: " +
        (err && err.message ? err.message : String(err))
    );
  }
}

function initCcp() {
  if (ccpInitialized) return;
  ccpInitialized = true;
  window.localStorage.removeItem("connectPopupManager::connect::loginPopup");

  try {
    // CCP 内嵌到隐藏容器；若已登录则不会弹出登录窗口（复用现有会话）。
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
// CCP 显示 / 隐藏
// ============================================================
function showCcp() {
  const host = $("ccpHost");
  host.classList.remove("ccp-hidden");
  host.classList.add("flex");
}

function hideCcp() {
  const host = $("ccpHost");
  host.classList.remove("flex");
  host.classList.add("ccp-hidden");
}

// ============================================================
// 左侧列表项渲染（Unread / Read 共用样式）
// ============================================================
/**
 * 创建一个邮件联系卡片
 * @param {object} email  列表项数据
 * @param {"unread"|"read"} type
 */
function createContactCard(email, type) {
  const card = document.createElement("div");
  card.className =
    "contact-card cursor-pointer rounded-lg border border-gray-200 p-3 hover:border-blue-400 hover:bg-blue-50/40 transition";
  card.setAttribute("data-contact-id", email.id);

  const time =
    type === "unread"
      ? email.enqueueTimestamp || email.initiationTimestamp
      : email.initiationTimestamp;

  const subject = document.createElement("div");
  subject.className = "text-sm font-semibold text-gray-800 truncate";
  subject.textContent = email.name || "(无主题)";
  subject.title = email.name || "";

  const customer = document.createElement("div");
  customer.className = "mt-1 text-xs text-gray-600 truncate";
  customer.textContent = "客户: " + (email.customerEmail || "-");

  const cid = document.createElement("div");
  cid.className = "mt-1 text-[11px] text-gray-400 break-all";
  cid.textContent = "Contact ID: " + email.id;

  const t = document.createElement("div");
  t.className = "mt-1 text-[11px] text-gray-400";
  t.textContent =
    (type === "unread" ? "入队时间: " : "发起时间: ") + convertToLocalTime(time);

  card.appendChild(subject);
  card.appendChild(customer);
  card.appendChild(cid);
  card.appendChild(t);

  card.addEventListener("click", () => selectContact(email, type, card));
  return card;
}

/** 高亮当前选中的卡片 */
function highlightCard(card) {
  document
    .querySelectorAll(".contact-card")
    .forEach((c) =>
      c.classList.remove("border-blue-500", "bg-blue-50", "ring-1", "ring-blue-300")
    );
  if (card) {
    card.classList.add("border-blue-500", "bg-blue-50", "ring-1", "ring-blue-300");
  }
}

// ============================================================
// Unread：排队中的邮件（/api/emails）
// ============================================================
async function loadUnread() {
  const list = $("unreadList");
  list.innerHTML =
    '<div class="text-center text-gray-400 text-sm py-6">加载中...</div>';
  try {
    const resp = await fetch("/api/emails", { cache: "no-store" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "请求失败");
    const emails = data.emails || [];
    $("unreadCount").textContent = emails.length;
    list.innerHTML = "";
    if (emails.length === 0) {
      list.innerHTML =
        '<div class="text-center text-gray-400 text-sm py-6">当前没有排队中的邮件。</div>';
      return;
    }
    emails.forEach((email) => list.appendChild(createContactCard(email, "unread")));
  } catch (err) {
    logOutput("加载排队邮件失败: " + err.message);
    list.innerHTML =
      '<div class="text-center text-red-500 text-sm py-6">加载失败: ' +
      escapeText(err.message) +
      "</div>";
  }
}

// ============================================================
// Read：历史邮件（/api/history-emails）
// ============================================================
async function loadRead(page) {
  if (typeof page === "number") readPage = page;
  const list = $("readList");
  list.innerHTML =
    '<div class="text-center text-gray-400 text-sm py-6">加载中...</div>';

  const startVal = $("histStart").value;
  const endVal = $("histEnd").value;

  const params = new URLSearchParams();
  if (startVal) params.set("startTime", new Date(startVal).toISOString());
  if (endVal) params.set("endTime", new Date(endVal).toISOString());
  params.set("page", String(readPage));
  params.set("pageSize", String(READ_PAGE_SIZE));

  try {
    const resp = await fetch("/api/history-emails?" + params.toString(), {
      cache: "no-store",
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "请求失败");

    const emails = data.emails || [];
    $("readCount").textContent = data.total || 0;
    readPage = data.page || 1;
    readTotalPages = data.totalPages || 1;
    $("readPageInfo").textContent =
      "共 " + (data.total || 0) + " 条 · 第 " + readPage + "/" + readTotalPages + " 页";
    $("readPrevBtn").disabled = readPage <= 1;
    $("readNextBtn").disabled = readPage >= readTotalPages;

    list.innerHTML = "";
    if (emails.length === 0) {
      list.innerHTML =
        '<div class="text-center text-gray-400 text-sm py-6">该时间范围内没有历史邮件。</div>';
      return;
    }
    emails.forEach((email) => list.appendChild(createContactCard(email, "read")));
  } catch (err) {
    logOutput("加载历史邮件失败: " + err.message);
    list.innerHTML =
      '<div class="text-center text-red-500 text-sm py-6">加载失败: ' +
      escapeText(err.message) +
      "</div>";
  }
}

function readPrevPage() {
  if (readPage > 1) loadRead(readPage - 1);
}
function readNextPage() {
  if (readPage < readTotalPages) loadRead(readPage + 1);
}

// ============================================================
// 选中一个联系：右侧 Email Information 加载详情，隐藏 CCP
// ============================================================
function selectContact(email, type, card) {
  currentContact = {
    id: email.id,
    subject: email.name || "(无主题)",
    type,
    customerEmail: email.customerEmail || "-",
    systemEmail: email.systemEmail || "-",
    agent: email.agent || "-",
    time:
      type === "unread"
        ? email.enqueueTimestamp || email.initiationTimestamp
        : email.initiationTimestamp,
  };
  highlightCard(card);
  // 切换联系时自动隐藏 CCP
  hideCcp();
  renderEmailInfo();
}

// ============================================================
// 邮件正文渲染（沙箱 iframe，禁用脚本防 XSS）
// ============================================================
function buildMessageFrame(msg) {
  const iframe = document.createElement("iframe");
  iframe.className = "w-full border border-gray-200 rounded bg-white";
  iframe.style.minHeight = "60px";
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

/** 在右侧渲染联系元信息 + Reply/Forward 按钮 + 邮件线程 */
async function renderEmailInfo() {
  const panel = $("emailInfo");
  const c = currentContact;
  panel.innerHTML = "";

  // 元信息卡片
  const metaCard = document.createElement("div");
  metaCard.className = "border border-gray-200 rounded-lg mb-4";

  const metaHead = document.createElement("div");
  metaHead.className =
    "px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3 flex-wrap";

  const titleWrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "text-base font-semibold text-gray-800";
  title.textContent = c.subject;
  const badge = document.createElement("span");
  badge.className =
    "inline-block mt-1 px-2 py-0.5 text-xs rounded-full " +
    (c.type === "unread"
      ? "bg-amber-100 text-amber-700"
      : "bg-green-100 text-green-700");
  badge.textContent = c.type === "unread" ? "Unread（排队中）" : "Read（历史邮件）";
  titleWrap.appendChild(title);
  titleWrap.appendChild(badge);

  // Reply / Forward 按钮
  const btnWrap = document.createElement("div");
  btnWrap.className = "flex items-center gap-2";

  const replyBtn = document.createElement("button");
  replyBtn.id = "replyBtn";
  replyBtn.className =
    "px-4 py-1.5 text-sm bg-green-500 hover:bg-green-600 text-white rounded-lg font-medium transition";
  replyBtn.textContent = "Reply";
  replyBtn.addEventListener("click", () => doReply(replyBtn));

  const forwardBtn = document.createElement("button");
  forwardBtn.className =
    "px-4 py-1.5 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium transition";
  forwardBtn.textContent = "Forward";
  forwardBtn.addEventListener("click", () => doForward(forwardBtn));

  btnWrap.appendChild(replyBtn);
  btnWrap.appendChild(forwardBtn);

  metaHead.appendChild(titleWrap);
  metaHead.appendChild(btnWrap);

  // 明细字段
  const metaBody = document.createElement("div");
  metaBody.className = "px-4 py-3 text-sm text-gray-600 space-y-1";
  const rows = [
    ["Contact ID", c.id],
    ["客户邮箱", c.customerEmail],
    ["系统邮箱", c.systemEmail],
  ];
  if (c.type === "read") rows.push(["座席", c.agent]);
  rows.push([c.type === "unread" ? "入队时间" : "发起时间", convertToLocalTime(c.time)]);
  rows.forEach(([k, v]) => {
    const row = document.createElement("div");
    row.className = "flex gap-2";
    const key = document.createElement("span");
    key.className = "text-gray-400 w-20 flex-shrink-0";
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "text-gray-700 break-all";
    val.textContent = v || "-";
    row.appendChild(key);
    row.appendChild(val);
    metaBody.appendChild(row);
  });

  metaCard.appendChild(metaHead);
  metaCard.appendChild(metaBody);
  panel.appendChild(metaCard);

  // 邮件线程标题
  const threadTitle = document.createElement("h3");
  threadTitle.className = "text-sm font-semibold text-gray-700 mb-2";
  threadTitle.textContent = "邮件内容";
  panel.appendChild(threadTitle);

  const threadWrap = document.createElement("div");
  threadWrap.id = "threadWrap";
  threadWrap.className = "space-y-4";
  threadWrap.innerHTML =
    '<div class="text-center text-gray-400 py-6">加载中...</div>';
  panel.appendChild(threadWrap);

  // 加载邮件历史内容（等同 email.html 的 View）
  await loadThread(c.id, threadWrap);
}

/** 加载并渲染某个联系的邮件往来记录 */
async function loadThread(contactId, container) {
  try {
    const resp = await fetch(
      "/api/history?contactId=" + encodeURIComponent(contactId),
      { cache: "no-store" }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "请求失败");
    // 若期间用户已切换到其它联系，则不再渲染这批结果
    if (!currentContact || currentContact.id !== contactId) return;

    const groups = data.groups || [];
    container.innerHTML = "";
    if (groups.length === 0) {
      container.innerHTML =
        '<div class="text-center text-gray-400 py-6">没有邮件内容。</div>';
      return;
    }
    groups.forEach((g) => {
      const inbound = g.initiationMethod === "INBOUND";
      const card = document.createElement("div");
      card.className = "border border-gray-200 rounded-lg";

      const header = document.createElement("div");
      header.className =
        "flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-100";
      const left = document.createElement("div");
      left.className = "flex items-center gap-2";
      const b = document.createElement("span");
      b.className =
        "px-2 py-0.5 text-xs rounded-full " +
        (inbound
          ? "bg-amber-100 text-amber-700"
          : "bg-green-100 text-green-700");
      b.textContent = inbound ? "客户来信" : "座席回复";
      const subj = document.createElement("span");
      subj.className = "text-sm font-medium text-gray-800";
      subj.textContent = g.subject || "(无主题)";
      left.appendChild(b);
      left.appendChild(subj);
      const time = document.createElement("span");
      time.className = "text-xs text-gray-500";
      time.textContent = convertToLocalTime(g.initiationTimestamp);
      header.appendChild(left);
      header.appendChild(time);

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
      card.appendChild(content);
      container.appendChild(card);
    });
  } catch (err) {
    logOutput("加载邮件内容失败: " + err.message);
    container.innerHTML =
      '<div class="text-center text-red-500 py-6">加载失败: ' +
      escapeText(err.message) +
      "</div>";
  }
}

// ============================================================
// Reply：
//   Unread -> assignToMe（转接到当前座席个人队列）
//   Read   -> replyToEmail（创建座席回复草稿）
// 两者都会显示 CCP 供座席回复。
// ============================================================
async function doReply(btn) {
  if (!currentContact) return;
  // 显示 CCP 进行回复
  showCcp();
  if (currentContact.type === "unread") {
    await assignToMe(currentContact.id, btn);
  } else {
    await replyToEmail(currentContact.id, btn);
  }
}

// Forward：显示 CCP，供座席在 CCP 中转发处理
function doForward(btn) {
  if (!currentContact) return;
  showCcp();
  logOutput("Forward: 打开 CCP 转发邮件 " + currentContact.id);
}

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
      body: JSON.stringify({ contactId, username: currentAgentUsername }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.error || "转接失败");
    logOutput("已转接邮件到当前座席: " + contactId + " -> " + data.assignedUserId);
    btn.textContent = "已分配";
    btn.classList.remove("bg-green-500", "hover:bg-green-600");
    btn.classList.add("bg-gray-400");
    // 刷新排队列表
    setTimeout(loadUnread, 1500);
  } catch (err) {
    logOutput("Reply 失败: " + err.message);
    alert("分配失败: " + err.message);
    btn.disabled = false;
    btn.textContent = "Reply";
  }
}

async function replyToEmail(contactId, btn) {
  if (!currentAgentUsername) {
    alert("无法获取当前座席信息，请等待 CCP 登录完成。");
    return;
  }
  btn.disabled = true;
  btn.textContent = "处理中...";
  try {
    // 改由后端（服务端 IAM 凭证）创建回复草稿，规避座席联邦会话缺少
    // connect:CreateContact 权限导致的 AccessDeniedException。
    const resp = await fetch("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId, username: currentAgentUsername }),
    });
    // 防御性解析：后端异常时可能返回 HTML（如 404 页），直接 resp.json() 会抛
    // “JSON.parse: unexpected character”。先读文本再尝试解析，给出可读错误。
    const raw = await resp.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        "服务端返回了非 JSON 响应（HTTP " +
          resp.status +
          "）。/api/reply 可能不存在，请重启后端服务。原始响应: " +
          raw.slice(0, 120)
      );
    }
    if (!resp.ok || !data.success) throw new Error(data.error || "回复失败");
    logOutput(
      "已创建座席回复草稿: 原邮件 " +
        contactId +
        " -> 新联系 " +
        (data.contactId || "(未知)")
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
// Tab 切换（Unread / Read）
// ============================================================
const TAB_ACTIVE = ["text-blue-600", "border-blue-600", "bg-blue-50"];
const TAB_INACTIVE = ["text-gray-500", "border-transparent", "hover:text-gray-700"];

function switchTab(tab) {
  const isUnread = tab === "unread";
  const unreadView = $("unreadView");
  const readView = $("readView");
  const tabUnread = $("tabUnread");
  const tabRead = $("tabRead");

  unreadView.classList.toggle("hidden", !isUnread);
  unreadView.classList.toggle("flex", isUnread);
  readView.classList.toggle("hidden", isUnread);
  readView.classList.toggle("flex", !isUnread);

  const active = isUnread ? tabUnread : tabRead;
  const inactive = isUnread ? tabRead : tabUnread;
  active.classList.remove(...TAB_INACTIVE);
  active.classList.add(...TAB_ACTIVE);
  inactive.classList.remove(...TAB_ACTIVE);
  inactive.classList.add(...TAB_INACTIVE);

  // 首次进入 Read 视图时自动查询一次（默认最新 20 条）
  if (!isUnread && !readView.dataset.loaded) {
    readView.dataset.loaded = "1";
    loadRead(1);
  }
}

// ============================================================
// 左右列拖拽分隔符
// ============================================================
(function initColResizer() {
  const resizer = $("colResizer");
  const split = $("split");
  const leftCol = $("leftCol");
  let dragging = false;

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    let w = e.clientX - rect.left;
    const min = 220;
    const max = rect.width - 320;
    w = Math.max(min, Math.min(w, max));
    leftCol.style.width = w + "px";
  });
  window.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = "";
    }
  });
})();

// ============================================================
// 历史邮件时间范围默认值（过去 7 天）
// ============================================================
(function initReadControls() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  $("histEnd").value = toDatetimeLocalValue(now);
  $("histStart").value = toDatetimeLocalValue(weekAgo);
})();

// ============================================================
// 暴露给 HTML 内联事件（onclick）使用
// ============================================================
Object.assign(window, {
  showLog,
  clearOutput,
  switchTab,
  loadUnread,
  loadRead,
  readPrevPage,
  readNextPage,
  hideCcp,
});

// 默认激活 Unread 标签
switchTab("unread");

// 页面加载即初始化 CCP（隐藏，仅做登录验证；已登录则复用会话）
initCcp();
