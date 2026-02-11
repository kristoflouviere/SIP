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
    const ownerNumber = message.direction === "inbound" ? message.to : message.from;
    const counterparty = message.direction === "inbound" ? message.from : message.to;

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

    if (message.direction === "inbound") {
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
        { from: owner, to: counterparty },
        { from: counterparty, to: owner }
      ]
    },
    orderBy: { createdAt: "asc" }
  });

  res.json({ messages });
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

  const direction = payload.direction || "inbound";
  const from = payload.from?.phone_number || payload.from || null;
  const to = payload.to?.[0]?.phone_number || payload.to || null;
  const text = payload.text || payload.body || null;

  if (!from || !to) {
    return res.status(200).json({ received: true });
  }

  try {
    const savedMessage = await prisma.message.create({
      data: {
        direction,
        from,
        to,
        text,
        status: payload.to?.[0]?.status || payload.status || null,
        telnyxMessageId: payload.id || null,
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
