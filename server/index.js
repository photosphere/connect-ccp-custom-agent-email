import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import {
  ConnectClient,
  SearchContactsCommand,
  TransferContactCommand,
  ListUsersCommand,
  DescribeQueueCommand,
  ListAssociatedContactsCommand,
  ListContactReferencesCommand,
  GetAttachedFileCommand,
  DescribeContactCommand,
  DescribeUserCommand,
} from "@aws-sdk/client-connect";

// override: true 让 .env 成为权威来源，避免被 shell 里残留的同名环境变量覆盖
dotenv.config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ============================================================
// 从环境变量读取配置（.env，绝不通过 HTTP 暴露凭证）
// ============================================================
const PORT = process.env.PORT || 3001;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN;

const connectCfg = {
  instanceId: process.env.CONNECT_INSTANCE_ID,
  region: process.env.CONNECT_REGION || AWS_REGION,
  transferContactFlowId: process.env.CONNECT_TRANSFER_CONTACT_FLOW_ID,
  queueIds: (process.env.CONNECT_QUEUE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  searchLookbackDays: parseInt(process.env.SEARCH_LOOKBACK_DAYS, 10) || 7,
};

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !connectCfg.instanceId) {
  console.error("❌ 缺少必要的环境变量，请检查 .env 文件");
  console.error(
    "   需要: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, CONNECT_INSTANCE_ID"
  );
  process.exit(1);
}

// ============================================================
// 初始化 AWS Connect 客户端（凭证来自 .env）
// ============================================================
const connectClient = new ConnectClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    ...(AWS_SESSION_TOKEN ? { sessionToken: AWS_SESSION_TOKEN } : {}),
  },
});

// 用户名 -> userId 的简单缓存
const userIdCache = new Map();
// 队列ID -> 队列名 的缓存
const queueNameCache = new Map();
// userId -> 座席显示名（用户名/姓名）的缓存
const agentNameCache = new Map();

/**
 * 根据座席 userId 解析显示名：优先“姓 名”，否则用户名，命中缓存直接返回。
 */
async function resolveAgentName(userId) {
  if (!userId) return null;
  if (agentNameCache.has(userId)) return agentNameCache.get(userId);
  try {
    const resp = await connectClient.send(
      new DescribeUserCommand({
        InstanceId: connectCfg.instanceId,
        UserId: userId,
      })
    );
    const u = resp.User || {};
    const info = u.IdentityInfo || {};
    const fullName = [info.FirstName, info.LastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    const name = fullName || u.Username || userId;
    agentNameCache.set(userId, name);
    return name;
  } catch (err) {
    console.error("DescribeUser 失败:", userId, err.message);
    return userId; // 兜底返回 userId
  }
}

/**
 * 根据队列ID获取队列名：命中缓存直接返回，
 * 未命中则调用 DescribeQueue 获取并写入缓存。
 */
async function resolveQueueName(queueId) {
  if (!queueId) return null;
  if (queueNameCache.has(queueId)) return queueNameCache.get(queueId);
  try {
    const resp = await connectClient.send(
      new DescribeQueueCommand({
        InstanceId: connectCfg.instanceId,
        QueueId: queueId,
      })
    );
    const name = (resp.Queue && resp.Queue.Name) || queueId;
    queueNameCache.set(queueId, name);
    return name;
  } catch (err) {
    console.error("DescribeQueue 失败:", queueId, err.message);
    return queueId; // 兜底返回队列ID
  }
}

const app = express();
app.disable("etag");
app.use(express.json());

// API 响应禁用缓存，避免浏览器命中 304 拿到过期数据
app.use("/api", (req, res, next) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// ============================================================
// 返回可供筛选的队列列表（配置的监控队列 + 名称）
// ============================================================
app.get("/api/queues", async (req, res) => {
  try {
    const ids = connectCfg.queueIds || [];
    await Promise.all(ids.map(resolveQueueName));
    const queues = ids.map((id) => ({
      id,
      name: queueNameCache.get(id) || id,
    }));
    res.json({ queues });
  } catch (err) {
    console.error("获取队列列表失败:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ============================================================
// 查询在配置队列中排队的邮件（SearchContacts）
// 支持通过 ?queueIds=a,b,c 只查询指定队列（须为已配置的监控队列子集）
// ============================================================
app.get("/api/emails", async (req, res) => {
  try {
    const lookbackDays = connectCfg.searchLookbackDays || 7;
    const endTime = new Date();
    const startTime = new Date(
      endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000
    );

    const searchCriteria = {
      Channels: ["EMAIL"],
    };
    // 前端传入的筛选队列（逗号分隔）；只保留配置中允许的队列
    const requestedQueueIds = (req.query.queueIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowed = connectCfg.queueIds || [];
    let effectiveQueueIds = allowed;
    if (requestedQueueIds.length > 0) {
      effectiveQueueIds =
        allowed.length > 0
          ? requestedQueueIds.filter((id) => allowed.includes(id))
          : requestedQueueIds;
    }
    if (effectiveQueueIds && effectiveQueueIds.length > 0) {
      searchCriteria.QueueIds = effectiveQueueIds;
    }

    const contacts = [];
    let nextToken;
    do {
      const command = new SearchContactsCommand({
        InstanceId: connectCfg.instanceId,
        TimeRange: {
          Type: "INITIATION_TIMESTAMP",
          StartTime: startTime,
          EndTime: endTime,
        },
        SearchCriteria: searchCriteria,
        MaxResults: 100,
        NextToken: nextToken,
      });
      const resp = await connectClient.send(command);
      (resp.Contacts || []).forEach((c) => contacts.push(c));
      nextToken = resp.NextToken;
    } while (nextToken);

    // 仅保留仍在队列中排队（未分配座席、未断开）的邮件
    const queued = contacts
      .filter((c) => {
        const inQueue = !!(c.QueueInfo && c.QueueInfo.Id);
        const notAssigned = !(c.AgentInfo && c.AgentInfo.Id);
        const notDisconnected = !c.DisconnectTimestamp;
        return inQueue && notAssigned && notDisconnected;
      })
      .map((c) => ({
        id: c.Id,
        name: c.Name || "(无主题)",
        channel: c.Channel,
        queueId: c.QueueInfo && c.QueueInfo.Id,
        initiationMethod: c.InitiationMethod,
        initiationTimestamp: c.InitiationTimestamp,
        enqueueTimestamp: c.QueueInfo && c.QueueInfo.EnqueueTimestamp,
      }))
      .sort(
        (a, b) =>
          new Date(a.enqueueTimestamp || a.initiationTimestamp) -
          new Date(b.enqueueTimestamp || b.initiationTimestamp)
      );

    // 解析队列名（命中缓存直接用，否则调用 DescribeQueue 并写入缓存）
    const uniqueQueueIds = [
      ...new Set(queued.map((q) => q.queueId).filter(Boolean)),
    ];
    await Promise.all(uniqueQueueIds.map(resolveQueueName));
    queued.forEach((q) => {
      q.queueName = queueNameCache.get(q.queueId) || q.queueId;
    });

    res.json({ emails: queued });
  } catch (err) {
    console.error("SearchContacts 失败:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ============================================================
// 历史邮件（已完成的座席回复）：SearchContacts
//   固定条件：Channel=EMAIL，InitiationMethod=AGENT_REPLY
//   按时间范围（INITIATION_TIMESTAMP）筛选，服务端分页
// 说明：SearchContacts 的 SearchCriteria 不支持 contactState 过滤，
//   因此“COMPLETED”通过结果中存在 DisconnectTimestamp 来判定（已断开=已完成）。
// ============================================================
app.get("/api/history-emails", async (req, res) => {
  try {
    // 时间范围：默认过去 7 天
    const now = new Date();
    let endTime = req.query.endTime ? new Date(req.query.endTime) : now;
    let startTime = req.query.startTime
      ? new Date(req.query.startTime)
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (isNaN(endTime.getTime())) endTime = now;
    if (isNaN(startTime.getTime()))
      startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 分页参数：pageSize 仅允许 25/50/100
    const allowedSizes = [25, 50, 100];
    let pageSize = parseInt(req.query.pageSize, 10) || 25;
    if (!allowedSizes.includes(pageSize)) pageSize = 25;
    let page = parseInt(req.query.page, 10) || 1;
    if (page < 1) page = 1;

    // 拉取全部匹配的联系（分页遍历），设置安全上限避免失控
    const MAX_FETCH = 2000;
    const contacts = [];
    let nextToken;
    do {
      const command = new SearchContactsCommand({
        InstanceId: connectCfg.instanceId,
        TimeRange: {
          Type: "INITIATION_TIMESTAMP",
          StartTime: startTime,
          EndTime: endTime,
        },
        SearchCriteria: {
          Channels: ["EMAIL"],
          InitiationMethods: ["AGENT_REPLY"],
        },
        Sort: {
          FieldName: "INITIATION_TIMESTAMP",
          Order: "DESCENDING",
        },
        MaxResults: 100,
        NextToken: nextToken,
      });
      const resp = await connectClient.send(command);
      (resp.Contacts || []).forEach((c) => contacts.push(c));
      nextToken = resp.NextToken;
    } while (nextToken && contacts.length < MAX_FETCH);

    // contactState=COMPLETED：仅保留已断开（已完成）的联系
    const completed = contacts.filter((c) => !!c.DisconnectTimestamp);

    // 服务端分页
    const total = completed.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (page > totalPages) page = totalPages;
    const startIdx = (page - 1) * pageSize;
    const pageItems = completed.slice(startIdx, startIdx + pageSize);

    // 逐条 DescribeContact 补充系统/客户邮箱与座席信息（仅当前页）
    const emails = await Promise.all(
      pageItems.map(async (c) => {
        let systemEmail = "-";
        let customerEmail = "-";
        let agentName = "-";
        let agentId = c.AgentInfo && c.AgentInfo.Id;
        try {
          const d = await connectClient.send(
            new DescribeContactCommand({
              InstanceId: connectCfg.instanceId,
              ContactId: c.Id,
            })
          );
          const contact = d.Contact || {};
          if (contact.SystemEndpoint && contact.SystemEndpoint.Address) {
            systemEmail = contact.SystemEndpoint.Address;
          }
          if (contact.CustomerEndpoint && contact.CustomerEndpoint.Address) {
            customerEmail = contact.CustomerEndpoint.Address;
          }
          if (!agentId && contact.AgentInfo && contact.AgentInfo.Id) {
            agentId = contact.AgentInfo.Id;
          }
        } catch (e) {
          console.error("DescribeContact 失败:", c.Id, e.message);
        }
        if (agentId) {
          agentName = await resolveAgentName(agentId);
        }
        return {
          id: c.Id,
          name: c.Name || "(无主题)",
          initiationTimestamp: c.InitiationTimestamp,
          systemEmail,
          customerEmail,
          agent: agentName,
        };
      })
    );

    res.json({ total, page, pageSize, totalPages, emails });
  } catch (err) {
    console.error("历史邮件查询失败:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ============================================================
// 读取某个邮件联系的历史来往记录（按 contact id 分组）
// 链路：ListAssociatedContacts（邮件线程内的所有联系）
//   -> ListContactReferences(EMAIL_MESSAGE)（每个联系的邮件内容引用）
//   -> GetAttachedFile（拿到预签名下载 URL）
//   -> fetch 下载并解析 { contentType, messageContent }
// ============================================================

/** 读取单个联系的邮件正文（可能有多条引用） */
async function loadEmailMessages(contactId, contactArn) {
  const messages = [];
  try {
    const refResp = await connectClient.send(
      new ListContactReferencesCommand({
        InstanceId: connectCfg.instanceId,
        ContactId: contactId,
        ReferenceTypes: ["EMAIL_MESSAGE"],
      })
    );
    for (const ref of refResp.ReferenceSummaryList || []) {
      const em = ref.EmailMessage;
      if (!em || !em.Name) continue;
      try {
        const gf = await connectClient.send(
          new GetAttachedFileCommand({
            InstanceId: connectCfg.instanceId,
            FileId: em.Name,
            AssociatedResourceArn: contactArn,
          })
        );
        const url = gf.DownloadUrlMetadata && gf.DownloadUrlMetadata.Url;
        if (!url) continue;
        const resp = await fetch(url);
        const json = await resp.json();
        messages.push({
          contentType: json.contentType || "text/plain",
          content: json.messageContent || "",
        });
      } catch (e) {
        messages.push({
          contentType: "text/plain",
          content: "(无法读取邮件内容: " + e.message + ")",
        });
      }
    }
  } catch (e) {
    console.error("ListContactReferences 失败:", contactId, e.message);
  }
  return messages;
}

app.get("/api/history", async (req, res) => {
  try {
    const contactId = req.query.contactId;
    if (!contactId) {
      return res.status(400).json({ error: "缺少 contactId" });
    }

    // 1. 获取邮件线程内的所有联系（分页）
    const summaries = [];
    let nextToken;
    do {
      const resp = await connectClient.send(
        new ListAssociatedContactsCommand({
          InstanceId: connectCfg.instanceId,
          ContactId: contactId,
          MaxResults: 100,
          NextToken: nextToken,
        })
      );
      (resp.ContactSummaryList || []).forEach((s) => summaries.push(s));
      nextToken = resp.NextToken;
    } while (nextToken);

    // 按发起时间升序（最早的在前）
    summaries.sort(
      (a, b) => new Date(a.InitiationTimestamp) - new Date(b.InitiationTimestamp)
    );

    // 2. 逐个联系获取主题与邮件正文
    const groups = [];
    for (const s of summaries) {
      let subject = null;
      try {
        const d = await connectClient.send(
          new DescribeContactCommand({
            InstanceId: connectCfg.instanceId,
            ContactId: s.ContactId,
          })
        );
        subject = d.Contact && d.Contact.Name;
      } catch (e) {
        // 主题拿不到不影响正文展示
      }

      const messages = await loadEmailMessages(s.ContactId, s.ContactArn);
      groups.push({
        contactId: s.ContactId,
        channel: s.Channel,
        initiationMethod: s.InitiationMethod,
        initiationTimestamp: s.InitiationTimestamp,
        subject: subject || "(无主题)",
        messages,
      });
    }

    res.json({ contactId, groups });
  } catch (err) {
    console.error("获取邮件历史失败:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ============================================================
// 根据用户名解析座席的 userId（用于转接到个人队列）
// ============================================================
async function resolveUserId(username) {
  if (!username) return null;
  if (userIdCache.has(username)) return userIdCache.get(username);

  let nextToken;
  do {
    const resp = await connectClient.send(
      new ListUsersCommand({
        InstanceId: connectCfg.instanceId,
        MaxResults: 100,
        NextToken: nextToken,
      })
    );
    for (const u of resp.UserSummaryList || []) {
      if (u.Username) {
        userIdCache.set(u.Username, u.Id);
      }
      if (u.Username === username) {
        return u.Id;
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  return userIdCache.get(username) || null;
}

// ============================================================
// 将邮件转接到当前登录座席的个人队列（TransferContact）
// ============================================================
app.post("/api/assign", async (req, res) => {
  try {
    const { contactId, username, userId: providedUserId } = req.body || {};
    if (!contactId) {
      return res.status(400).json({ error: "缺少 contactId" });
    }

    let userId = providedUserId;
    if (!userId) {
      userId = await resolveUserId(username);
    }
    if (!userId) {
      return res
        .status(400)
        .json({ error: "无法确定当前座席的 userId，请检查用户名: " + username });
    }

    const flowId = connectCfg.transferContactFlowId;
    if (!flowId || flowId.includes("xxxx")) {
      return res.status(400).json({
        error:
          "CONNECT_TRANSFER_CONTACT_FLOW_ID 未正确配置（当前值: " +
          (flowId || "空") +
          "）。请检查 .env 并重启服务。",
      });
    }

    const command = new TransferContactCommand({
      InstanceId: connectCfg.instanceId,
      ContactId: contactId,
      ContactFlowId: flowId,
      UserId: userId,
    });
    const resp = await connectClient.send(command);

    res.json({
      success: true,
      contactId: resp.ContactId,
      contactArn: resp.ContactArn,
      assignedUserId: userId,
    });
  } catch (err) {
    console.error("TransferContact 失败:", {
      contactId: req.body && req.body.contactId,
      flowId: connectCfg.transferContactFlowId,
      message: err.message,
    });
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ============================================================
// 生产环境直接托管 Vite 构建产物 dist/
// ============================================================
if (process.env.NODE_ENV === "production") {
  const distPath = path.join(ROOT, "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "email.html"));
  });
}

app.listen(PORT, () => {
  console.log(`✅ Amazon Connect Email Handler API 已启动: http://localhost:${PORT}`);
  console.log(`   Connect 实例: ${connectCfg.instanceId}`);
  console.log(`   区域: ${AWS_REGION}`);
  console.log(`   转接流(TransferContactFlowId): ${connectCfg.transferContactFlowId || "(未配置)"}`);
  console.log(`   监控队列: ${connectCfg.queueIds.join(", ") || "(未配置)"}`);
  if (
    !connectCfg.transferContactFlowId ||
    connectCfg.transferContactFlowId.includes("xxxx")
  ) {
    console.warn(
      "⚠️  CONNECT_TRANSFER_CONTACT_FLOW_ID 未正确配置，Assign to Me 会失败（Resource not found）。"
    );
  }
});
