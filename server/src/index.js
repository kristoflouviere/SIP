const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");

dotenv.config();

const app = express();
const prisma = new PrismaClient();

const PORT = process.env.PORT || 3001;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const defaultSyncOnStartup = process.env.NODE_ENV === "production" ? "false" : "true";
const SYNC_ON_STARTUP =
  (process.env.SYNC_ON_STARTUP || defaultSyncOnStartup).toLowerCase() === "true";
const SYNC_LOOKBACK_DAYS = Number(process.env.SYNC_LOOKBACK_DAYS || 30);

const tableConfig = {
  Message: {
    fields: [
      "id",
      "direction",
      "from",
      "to",
      "text",
      "status",
      "telnyxMessageId",
      "telnyxEventId",
      "occurredAt",
      "createdAt",
      "raw"
    ],
    searchableFields: ["direction", "from", "to", "text", "status"],
    fieldTypes: {
      id: "string",
      direction: "string",
      from: "string",
      to: "string",
      text: "string",
      status: "string",
      telnyxMessageId: "string",
      telnyxEventId: "string",
      occurredAt: "datetime",
      createdAt: "datetime",
      raw: "json"
    },
    defaultSort: "createdAt"
  },
  MessageEvent: {
    fields: [
      "id",
      "telnyxEventId",
      "telnyxMessageId",
      "eventType",
      "status",
      "occurredAt",
      "payload",
      "messageId",
      "createdAt"
    ],
    searchableFields: ["eventType", "status", "telnyxMessageId", "telnyxEventId"],
    fieldTypes: {
      id: "string",
      telnyxEventId: "string",
      telnyxMessageId: "string",
      eventType: "string",
      status: "string",
      occurredAt: "datetime",
      payload: "json",
      messageId: "string",
      createdAt: "datetime"
    },
    defaultSort: "occurredAt"
  },
  Conversation: {
    fields: [
      "id",
      "ownerNumber",
      "counterparty",
      "lastMessageAt",
      "lastMessageText",
      "lastMessageDirection",
      "lastMessageId",
      "unreadCount",
      "lastReadAt",
      "createdAt",
      "updatedAt"
    ],
    searchableFields: ["ownerNumber", "counterparty", "lastMessageText"],
    fieldTypes: {
      id: "string",
      ownerNumber: "string",
      counterparty: "string",
      lastMessageAt: "datetime",
      lastMessageText: "string",
      lastMessageDirection: "string",
      lastMessageId: "string",
      unreadCount: "number",
      lastReadAt: "datetime",
      createdAt: "datetime",
      updatedAt: "datetime"
    },
    defaultSort: "lastMessageAt"
  },
  FromNumber: {
    fields: ["id", "number", "firstUsedAt", "lastUsedAt"],
    searchableFields: ["number"],
    fieldTypes: {
      id: "string",
      number: "string",
      firstUsedAt: "datetime",
      lastUsedAt: "datetime"
    },
    defaultSort: "lastUsedAt"
  },
  ToNumber: {
    fields: ["id", "number", "firstUsedAt", "lastUsedAt"],
    searchableFields: ["number"],
    fieldTypes: {
      id: "string",
      number: "string",
      firstUsedAt: "datetime",
      lastUsedAt: "datetime"
    },
    defaultSort: "lastUsedAt"
  }
};

const getTableModel = (name) => {
  switch (name) {
    case "Message":
      return prisma.message;
    case "MessageEvent":
      return prisma.messageEvent;
    case "Conversation":
      return prisma.conversation;
    case "FromNumber":
      return prisma.fromNumber;
    case "ToNumber":
      return prisma.toNumber;
    default:
      return null;
  }
};

const parseFilterValue = (type, rawValue) => {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  switch (type) {
    case "number": {
      const parsed = Number(rawValue);
      return Number.isNaN(parsed) ? null : parsed;
    }
    case "boolean":
      if (rawValue === "true") {
        return true;
      }
      if (rawValue === "false") {
        return false;
      }
      return null;
    case "datetime": {
      const parsed = new Date(rawValue);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    case "json":
      try {
        return JSON.parse(rawValue);
      } catch (error) {
        return null;
      }
    default:
      return String(rawValue);
  }
};

const buildWhereClause = (config, { search, filters }) => {
  const and = [];

  if (search && config.searchableFields.length > 0) {
    and.push({
      OR: config.searchableFields.map((field) => ({
        [field]: {
          contains: search,
          mode: "insensitive"
        }
      }))
    });
  }

  if (Array.isArray(filters)) {
    for (const filter of filters) {
      const field = filter?.field;
      const op = filter?.op || "contains";
      if (!field || !config.fields.includes(field)) {
        continue;
      }

      const type = config.fieldTypes[field] || "string";
      const parsed = parseFilterValue(type, filter?.value);
      if (parsed === null) {
        continue;
      }

      if (type === "string") {
        and.push({
          [field]: {
            contains: String(parsed),
            mode: "insensitive"
          }
        });
        continue;
      }

      if (type === "datetime" && op === "gte") {
        and.push({ [field]: { gte: parsed } });
        continue;
      }

      if (type === "datetime" && op === "lte") {
        and.push({ [field]: { lte: parsed } });
        continue;
      }

      and.push({ [field]: parsed });
    }
  }

  return and.length > 0 ? { AND: and } : {};
};

const getMessageTime = (message) => {
  if (message?.occurredAt) {
    return new Date(message.occurredAt);
  }
  if (message?.createdAt) {
    return new Date(message.createdAt);
  }
  return new Date();
};

const updateConversationForMessage = async ({ message, countUnread }) => {
  if (!message) {
    return;
  }

  const ownerNumber = message.direction === "inbound" ? message.to : message.from;
  const counterparty = message.direction === "inbound" ? message.from : message.to;

  if (!ownerNumber || !counterparty) {
    return;
  }

  const messageTime = getMessageTime(message);
  const previewText = message.text || "(no text)";
  const lastData = {
    lastMessageAt: messageTime,
    lastMessageText: previewText,
    lastMessageDirection: message.direction || "unknown",
    lastMessageId: message.id
  };

  const existing = await prisma.conversation.findUnique({
    where: {
      owner_counterparty: {
        ownerNumber,
        counterparty
      }
    }
  });

  const shouldUpdateLast =
    !existing?.lastMessageAt || messageTime >= new Date(existing.lastMessageAt);

  let unreadCount = existing?.unreadCount ?? 0;
  if (countUnread && message.direction === "inbound") {
    const lastReadAt = existing?.lastReadAt ? new Date(existing.lastReadAt) : null;
    if (!lastReadAt || messageTime > lastReadAt) {
      unreadCount += 1;
    }
  }

  await prisma.conversation.upsert({
    where: {
      owner_counterparty: {
        ownerNumber,
        counterparty
      }
    },
    update: {
      ...(shouldUpdateLast ? lastData : {}),
      unreadCount
    },
    create: {
      ownerNumber,
      counterparty,
      ...lastData,
      unreadCount: countUnread && message.direction === "inbound" ? 1 : 0
    }
  });
};

const resolveEventStatus = (payload) =>
  payload?.to?.[0]?.status || payload?.status || null;

const resolveEventOccurredAt = (event, payload) => {
  const candidate =
    payload?.received_at || payload?.created_at || event?.created_at || null;
  if (!candidate) {
    return new Date();
  }
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const upsertMessageEvent = async ({
  telnyxEventId,
  telnyxMessageId,
  eventType,
  status,
  occurredAt,
  payload,
  messageId
}) => {
  const data = {
    telnyxEventId,
    telnyxMessageId,
    eventType,
    status,
    occurredAt,
    payload,
    messageId
  };

  if (telnyxEventId) {
    return prisma.messageEvent.upsert({
      where: { telnyxEventId },
      update: data,
      create: data
    });
  }

  return prisma.messageEvent.create({ data });
};

const rebuildConversations = async ({ owner }) => {
  const where = owner
    ? {
        OR: [{ from: owner }, { to: owner }]
      }
    : undefined;

  const messages = await prisma.message.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }]
  });

  const map = new Map();
  for (const message of messages) {
    let ownerNumber = message.direction === "inbound" ? message.to : message.from;
    let counterparty = message.direction === "inbound" ? message.from : message.to;

    if (owner) {
      if (message.from === owner) {
        ownerNumber = owner;
        counterparty = message.to;
      } else if (message.to === owner) {
        ownerNumber = owner;
        counterparty = message.from;
      } else {
        continue;
      }
    }

    if (!ownerNumber || !counterparty) {
      continue;
    }

    const key = `${ownerNumber}__${counterparty}`;
    if (!map.has(key)) {
      map.set(key, {
        ownerNumber,
        counterparty,
        lastMessageAt: getMessageTime(message),
        lastMessageText: message.text || "(no text)",
        lastMessageDirection: message.direction || "unknown",
        lastMessageId: message.id,
        unreadCount: 0
      });
    }

    if (owner ? message.to === owner : message.direction === "inbound") {
      const entry = map.get(key);
      entry.unreadCount += 1;
    }
  }

  if (owner) {
    await prisma.conversation.deleteMany({ where: { ownerNumber: owner } });
  } else {
    await prisma.conversation.deleteMany();
  }

  const data = Array.from(map.values());
  if (data.length > 0) {
    await prisma.conversation.createMany({ data });
  }

  return { count: data.length };
};

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/messages", async (req, res) => {
  const limit = Number(req.query.limit || 50);
  const messages = await prisma.message.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200)
  });

  res.json({ messages });
});

app.get("/events", async (req, res) => {
  const limit = Number(req.query.limit || 120);
  const events = await prisma.messageEvent.findMany({
    orderBy: { occurredAt: "desc" },
    take: Math.min(limit, 300),
    include: {
      message: {
        select: {
          id: true,
          direction: true,
          from: true,
          to: true,
          text: true
        }
      }
    }
  });

  res.json({ events });
});

app.get("/db/tables", (_req, res) => {
  const tables = Object.entries(tableConfig).map(([name, config]) => ({
    name,
    fields: config.fields,
    fieldTypes: config.fieldTypes,
    defaultSort: config.defaultSort
  }));

  res.json({ tables });
});

app.get("/db/table/:name", async (req, res) => {
  const name = req.params.name;
  const config = tableConfig[name];
  const model = getTableModel(name);

  if (!config || !model) {
    return res.status(404).json({ error: "Unknown table" });
  }

  const limit = Number(req.query.limit || 200);
  const offset = Number(req.query.offset || 0);
  const sortBy = config.fields.includes(req.query.sortBy)
    ? req.query.sortBy
    : config.defaultSort;
  const sortDir = req.query.sortDir === "asc" ? "asc" : "desc";
  const search = req.query.search ? String(req.query.search) : "";
  let filters = [];

  if (req.query.filters) {
    try {
      filters = JSON.parse(req.query.filters);
    } catch (error) {
      return res.status(400).json({ error: "Invalid filters JSON" });
    }
  }

  const where = buildWhereClause(config, { search, filters });

  const [count, rows] = await Promise.all([
    model.count({ where }),
    model.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      take: Math.min(limit, 500),
      skip: Math.max(offset, 0)
    })
  ]);

  res.json({ rows, count });
});

app.post("/db/table/:name/delete", async (req, res) => {
  const name = req.params.name;
  const config = tableConfig[name];
  const model = getTableModel(name);
  const ids = req.body?.ids;

  if (!config || !model) {
    return res.status(404).json({ error: "Unknown table" });
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array is required" });
  }

  const result = await model.deleteMany({
    where: { id: { in: ids } }
  });

  res.json({ deleted: result.count });
});

app.post("/db/table/:name/clear", async (req, res) => {
  const name = req.params.name;
  const config = tableConfig[name];
  const model = getTableModel(name);

  if (!config || !model) {
    return res.status(404).json({ error: "Unknown table" });
  }

  const result = await model.deleteMany();
  res.json({ deleted: result.count });
});

app.get("/numbers/from", async (_req, res) => {
  const numbers = await prisma.fromNumber.findMany({
    orderBy: { lastUsedAt: "desc" }
  });
  res.json({ numbers });
});

app.get("/numbers/to", async (_req, res) => {
  const numbers = await prisma.toNumber.findMany({
    orderBy: { lastUsedAt: "desc" }
  });
  res.json({ numbers });
});

app.get("/conversations", async (req, res) => {
  const owner = req.query.owner;
  if (!owner) {
    return res.status(400).json({ error: "owner is required" });
  }

  const conversations = await prisma.conversation.findMany({
    where: { ownerNumber: owner },
    orderBy: { lastMessageAt: "desc" }
  });

  res.json({ conversations });
});

app.get("/conversations/history", async (req, res) => {
  const owner = req.query.owner;
  const counterparty = req.query.counterparty;
  if (!owner || !counterparty) {
    return res.status(400).json({ error: "owner and counterparty are required" });
  }

  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { direction: "outbound", from: owner, to: counterparty },
        { direction: "inbound", from: counterparty, to: owner }
      ]
    },
    orderBy: { createdAt: "asc" }
  });

  // Primary dedupe store keyed by Telnyx message ID when available.
  const dedupedMap = new Map();
  // Fallback buckets for messages missing Telnyx IDs.
  const fallbackBuckets = new Map();
  // Merge window to treat near-simultaneous updates as one message.
  const mergeWindowMs = 120000;

  // First pass: collect by Telnyx message ID or fallback bucket key.
  for (const message of messages) {
    const timestamp = getMessageTime(message);
    const key = message.telnyxMessageId
      ? `telnyx:${message.telnyxMessageId}`
      : null;

    if (key) {
      // Keep the latest version of a message with the same Telnyx ID.
      const existing = dedupedMap.get(key);
      if (!existing || timestamp > getMessageTime(existing)) {
        dedupedMap.set(key, message);
      }
      continue;
    }

    // Group messages without Telnyx IDs by from/to/text signature.
    const fallbackKey = `fallback:${message.from}|${message.to}|${
      message.text || ""
    }`;
    const bucket = fallbackBuckets.get(fallbackKey) || [];
    bucket.push(message);
    fallbackBuckets.set(fallbackKey, bucket);
  }

  // Second pass: dedupe fallback buckets and avoid duplicates of Telnyx-ID rows.
  for (const bucket of fallbackBuckets.values()) {
    bucket.sort((a, b) => getMessageTime(a) - getMessageTime(b));

    for (const message of bucket) {
      const timestamp = getMessageTime(message).getTime();
      // Skip if a near-time Telnyx-ID message matches this fallback entry.
      const bestMatch = Array.from(dedupedMap.values()).find((candidate) => {
        if (!candidate.telnyxMessageId) {
          return false;
        }
        if (candidate.from !== message.from || candidate.to !== message.to) {
          return false;
        }
        if ((candidate.text || "") !== (message.text || "")) {
          return false;
        }
        const candidateTime = getMessageTime(candidate).getTime();
        return Math.abs(candidateTime - timestamp) <= mergeWindowMs;
      });

      if (bestMatch) {
        continue;
      }

      // Otherwise, dedupe fallback entries within the same second.
      const fallbackTime = Math.floor(timestamp / 1000);
      const fallbackId = `fallback:${message.from}|${message.to}|${
        message.text || ""
      }|${fallbackTime}`;
      const existing = dedupedMap.get(fallbackId);
      if (!existing || timestamp > getMessageTime(existing)) {
        dedupedMap.set(fallbackId, message);
      }
    }
  }

  const dedupedMessages = Array.from(dedupedMap.values()).sort((a, b) => {
    const firstTime = getMessageTime(a).getTime();
    const secondTime = getMessageTime(b).getTime();
    return firstTime - secondTime;
  });

  res.json({ messages: dedupedMessages });
});

app.post("/conversations/mark-read", async (req, res) => {
  const { owner, counterparty } = req.body || {};
  if (!owner || !counterparty) {
    return res.status(400).json({ error: "owner and counterparty are required" });
  }

  const existing = await prisma.conversation.findUnique({
    where: {
      owner_counterparty: {
        ownerNumber: owner,
        counterparty
      }
    }
  });

  if (!existing) {
    return res.json({ ok: true, conversation: null });
  }

  const updated = await prisma.conversation.update({
    where: {
      owner_counterparty: {
        ownerNumber: owner,
        counterparty
      }
    },
    data: {
      unreadCount: 0,
      lastReadAt: new Date()
    }
  });

  res.json({ ok: true, conversation: updated });
});

app.post("/conversations/rebuild", async (req, res) => {
  try {
    const { owner } = req.body || {};
    const result = await rebuildConversations({ owner });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error("Conversation rebuild failed", error);
    res.status(500).json({ error: "Rebuild failed" });
  }
});

const syncInboundMessages = async ({ since }) => {
  if (!TELNYX_API_KEY) {
    return { synced: 0, skipped: 0 };
  }

  let pageNumber = 1;
  const pageSize = 50;
  let synced = 0;
  let skipped = 0;
  const sinceDate = since ? new Date(since) : new Date(Date.now() - SYNC_LOOKBACK_DAYS * 86400000);

  while (pageNumber <= 200) {
    const response = await axios.get("https://api.telnyx.com/v2/messages", {
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`
      },
      params: {
        "filter[direction]": "inbound",
        "filter[created_at][gte]": sinceDate.toISOString(),
        "page[number]": pageNumber,
        "page[size]": pageSize
      }
    });

    const data = response.data?.data || [];
    if (data.length === 0) {
      break;
    }

    for (const item of data) {
      const telnyxMessageId = item.id || null;
      if (!telnyxMessageId) {
        skipped += 1;
        continue;
      }

      try {
        const existing = await prisma.message.findFirst({
          where: { telnyxMessageId }
        });

        let savedMessage = null;
        if (existing) {
          savedMessage = await prisma.message.update({
            where: { id: existing.id },
            data: {
              status: item.to?.[0]?.status || item.status || null,
              occurredAt: item.created_at ? new Date(item.created_at) : null,
              raw: item
            }
          });
        } else {
          savedMessage = await prisma.message.create({
            data: {
              direction: item.direction || "inbound",
              from: item.from?.phone_number || item.from || "",
              to: item.to?.[0]?.phone_number || item.to || "",
              text: item.text || item.body || null,
              status: item.to?.[0]?.status || item.status || null,
              telnyxMessageId,
              occurredAt: item.created_at ? new Date(item.created_at) : null,
              raw: item
            }
          });
        }
        await updateConversationForMessage({ message: savedMessage, countUnread: false });
        synced += 1;
      } catch (error) {
        skipped += 1;
      }
    }

    pageNumber += 1;
  }

  return { synced, skipped };
};

app.post("/messages/sync", async (req, res) => {
  try {
    const { since } = req.body || {};
    const result = await syncInboundMessages({ since });
    res.json(result);
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };
    console.error("Inbound sync failed", status, details);
    res.status(status).json({ error: "Sync failed", details });
  }
});

app.post("/messages/send", async (req, res) => {
  const { from, to, text } = req.body || {};

  if (!from || !to || !text) {
    return res.status(400).json({ error: "from, to, and text are required" });
  }

  if (!TELNYX_API_KEY) {
    return res.status(500).json({ error: "TELNYX_API_KEY is not set" });
  }

  try {
    const response = await axios.post(
      "https://api.telnyx.com/v2/messages",
      {
        from,
        to,
        text
      },
      {
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const messageData = response.data?.data || {};

    const saved = await prisma.message.create({
      data: {
        direction: "outbound",
        from,
        to,
        text,
        status: messageData?.to?.[0]?.status || messageData?.status || null,
        telnyxMessageId: messageData?.id || null,
        occurredAt: messageData?.created_at ? new Date(messageData.created_at) : null,
        raw: response.data
      }
    });

    await upsertMessageEvent({
      telnyxEventId: null,
      telnyxMessageId: messageData?.id || null,
      eventType: "message.sent",
      status: messageData?.to?.[0]?.status || messageData?.status || null,
      occurredAt: messageData?.created_at
        ? new Date(messageData.created_at)
        : new Date(),
      payload: response.data,
      messageId: saved.id
    });

    await updateConversationForMessage({ message: saved, countUnread: false });

    await Promise.all([
      prisma.fromNumber.upsert({
        where: { number: from },
        update: { lastUsedAt: new Date() },
        create: { number: from }
      }),
      prisma.toNumber.upsert({
        where: { number: to },
        update: { lastUsedAt: new Date() },
        create: { number: to }
      })
    ]);

    res.json({ message: saved, telnyx: response.data });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || { message: error.message };
    const message =
      details?.errors?.[0]?.detail ||
      details?.errors?.[0]?.title ||
      details?.message ||
      error.message;
    res.status(status).json({ error: "Failed to send", message, details });
  }
});

app.post("/webhooks/telnyx", async (req, res) => {
  const event = req.body || {};
  const eventData = event.data || {};
  const payload = eventData.payload || {};

  const eventType = event.type || "message.unknown";
  const telnyxEventId = event.id || null;
  const telnyxMessageId = payload.id || payload.message_id || null;
  const status = resolveEventStatus(payload);
  const occurredAt = resolveEventOccurredAt(event, payload);
  const messageRef = telnyxMessageId
    ? await prisma.message.findFirst({
        where: { telnyxMessageId }
      })
    : null;

  try {
    await upsertMessageEvent({
      telnyxEventId,
      telnyxMessageId,
      eventType,
      status,
      occurredAt,
      payload: event,
      messageId: messageRef?.id || null
    });
  } catch (error) {
    console.error("Failed to store event log", error);
  }

  const direction = payload.direction || "inbound";
  const from = payload.from?.phone_number || payload.from || null;
  const to = payload.to?.[0]?.phone_number || payload.to || null;
  const text = payload.text || payload.body || null;

  if (!from || !to) {
    return res.status(200).json({ received: true });
  }

  try {
    const telnyxMessageIdForSave = payload.id || payload.message_id || null;
    const existing = telnyxMessageIdForSave
      ? await prisma.message.findFirst({
          where: { telnyxMessageId: telnyxMessageIdForSave }
        })
      : null;

    const savedMessage = existing
      ? await prisma.message.update({
          where: { id: existing.id },
          data: {
            status,
            occurredAt: payload.received_at ? new Date(payload.received_at) : null,
            raw: event
          }
        })
      : await prisma.message.create({
          data: {
            direction,
            from,
            to,
            text,
            status,
            telnyxMessageId: telnyxMessageIdForSave,
            telnyxEventId: event?.id || null,
            occurredAt: payload.received_at ? new Date(payload.received_at) : null,
            raw: event
          }
        });

    await updateConversationForMessage({ message: savedMessage, countUnread: true });
  } catch (error) {
    console.error("Failed to store webhook message", error);
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  if (SYNC_ON_STARTUP) {
    syncInboundMessages({}).catch((error) => {
      const status = error.response?.status || 500;
      const details = error.response?.data || { message: error.message };
      console.error("Inbound sync failed", status, details);
    });
  }
});
