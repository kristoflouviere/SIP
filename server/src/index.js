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

        if (existing) {
          await prisma.message.update({
            where: { id: existing.id },
            data: {
              status: item.to?.[0]?.status || item.status || null,
              occurredAt: item.created_at ? new Date(item.created_at) : null,
              raw: item
            }
          });
        } else {
          await prisma.message.create({
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
    await prisma.message.create({
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
