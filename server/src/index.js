const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const multer = require("multer");
const OpenAI = require("openai");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { PrismaClient } = require("@prisma/client");

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 20
  }
});

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  const max = Math.max(1, Math.min(limit, items.length));
  let index = 0;

  const workers = Array.from({ length: max }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
};

const PORT = process.env.PORT || 3001;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const OPENAI_POLISH_MODEL = process.env.OPENAI_POLISH_MODEL || "gpt-4o-mini";
const OBJECT_STORAGE_BUCKET = process.env.OBJECT_STORAGE_BUCKET || "";
const OBJECT_STORAGE_REGION = process.env.OBJECT_STORAGE_REGION || "us-east-1";
const OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT || "";
const OBJECT_STORAGE_ACCESS_KEY_ID = process.env.OBJECT_STORAGE_ACCESS_KEY_ID || "";
const OBJECT_STORAGE_SECRET_ACCESS_KEY = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || "";
const OBJECT_STORAGE_FORCE_PATH_STYLE =
  (process.env.OBJECT_STORAGE_FORCE_PATH_STYLE || "false").toLowerCase() === "true";
const OBJECT_STORAGE_PREFIX =
  cleanStoragePrefix(process.env.OBJECT_STORAGE_PREFIX || "sales-tools-2026/attachments");
const defaultSyncOnStartup = process.env.NODE_ENV === "production" ? "false" : "true";
const SYNC_ON_STARTUP =
  (process.env.SYNC_ON_STARTUP || defaultSyncOnStartup).toLowerCase() === "true";
const SYNC_LOOKBACK_DAYS = Number(process.env.SYNC_LOOKBACK_DAYS || 30);

function cleanStoragePrefix(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return cleaned;
}

const objectStoreEnabled = Boolean(
  OBJECT_STORAGE_BUCKET &&
    OBJECT_STORAGE_ACCESS_KEY_ID &&
    OBJECT_STORAGE_SECRET_ACCESS_KEY &&
    OBJECT_STORAGE_ENDPOINT
);

const objectStoreClient = objectStoreEnabled
  ? new S3Client({
      region: OBJECT_STORAGE_REGION,
      endpoint: OBJECT_STORAGE_ENDPOINT,
      forcePathStyle: OBJECT_STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: OBJECT_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: OBJECT_STORAGE_SECRET_ACCESS_KEY
      }
    })
  : null;

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
      "readAt",
      "state",
      "tags",
      "createdAt",
      "raw"
    ],
    searchableFields: ["direction", "from", "to", "text", "status", "state"],
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
      readAt: "datetime",
      state: "string",
      tags: "json",
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
      "lastSelectedAt",
      "state",
      "bookmarked",
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
      lastSelectedAt: "datetime",
      state: "string",
      bookmarked: "boolean",
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
  },
  Contact: {
    fields: [
      "id",
      "firstName",
      "lastName",
      "email",
      "address",
      "company",
      "phoneNumbers",
      "linkedInProfiles",
      "importedAt",
      "source",
      "sourceImportMeta",
      "sourceDetails",
      "sourceExternalId",
      "googleRaw",
      "googleFieldValues",
      "createdAt",
      "updatedAt"
    ],
    searchableFields: ["firstName", "lastName", "email", "address", "company", "source"],
    fieldTypes: {
      id: "string",
      firstName: "string",
      lastName: "string",
      email: "string",
      address: "string",
      company: "string",
      phoneNumbers: "json",
      linkedInProfiles: "json",
      importedAt: "datetime",
      source: "string",
      sourceImportMeta: "json",
      sourceDetails: "json",
      sourceExternalId: "string",
      googleRaw: "json",
      googleFieldValues: "json",
      createdAt: "datetime",
      updatedAt: "datetime"
    },
    defaultSort: "updatedAt"
  },
  Attachment: {
    fields: [
      "id",
      "ownerNumber",
      "counterparty",
      "kind",
      "storage",
      "storageKey",
      "storageEtag",
      "fileName",
      "mimeType",
      "sizeBytes",
      "metadata",
      "createdAt",
      "updatedAt"
    ],
    searchableFields: ["ownerNumber", "counterparty", "kind", "fileName", "mimeType"],
    fieldTypes: {
      id: "string",
      ownerNumber: "string",
      counterparty: "string",
      kind: "string",
      storage: "string",
      storageKey: "string",
      storageEtag: "string",
      fileName: "string",
      mimeType: "string",
      sizeBytes: "number",
      metadata: "json",
      createdAt: "datetime",
      updatedAt: "datetime"
    },
    defaultSort: "createdAt"
  },
  MessageAttachment: {
    fields: ["id", "messageId", "attachmentId", "createdAt"],
    searchableFields: ["messageId", "attachmentId"],
    fieldTypes: {
      id: "string",
      messageId: "string",
      attachmentId: "string",
      createdAt: "datetime"
    },
    defaultSort: "createdAt"
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
    case "Contact":
      return prisma.contact;
    case "Attachment":
      return prisma.attachment;
    case "MessageAttachment":
      return prisma.messageAttachment;
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

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || "";
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || "";
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || "";
const oauthStateStore = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const cleanString = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const allowedAttachmentKinds = new Set([
  "FILE",
  "CONTACT",
  "MEDIA",
  "CAMERA",
  "LOCATION"
]);

const objectStoreAttachmentKinds = new Set(["FILE", "MEDIA", "CAMERA"]);
const allowedLocationMapApps = new Set(["google", "waze", "microsoft"]);

const normalizeAttachmentKind = (value, fallback = "FILE") => {
  const cleaned = cleanString(value)?.toUpperCase();
  if (!cleaned) {
    return fallback;
  }
  return allowedAttachmentKinds.has(cleaned) ? cleaned : fallback;
};

const normalizeAttachmentIds = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cleanString(item))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
};

const shouldStoreAttachmentInObjectStore = (kind) => {
  if (!objectStoreEnabled || !objectStoreClient) {
    return false;
  }

  const normalizedKind = normalizeAttachmentKind(kind, "FILE");
  return objectStoreAttachmentKinds.has(normalizedKind);
};

const buildLocationMapUrl = ({ mapApp, latitude, longitude }) => {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return "";
  }

  if (mapApp === "waze") {
    return `https://www.waze.com/ul?ll=${latitude},${longitude}&navigate=yes`;
  }

  if (mapApp === "microsoft") {
    return `https://www.bing.com/maps?cp=${latitude}~${longitude}&lvl=16`;
  }

  return `https://www.google.com/maps?q=${latitude},${longitude}`;
};

const normalizeOutgoingLocationShare = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const mapApp = cleanString(value.mapApp)?.toLowerCase() || "google";
  const normalizedMapApp = allowedLocationMapApps.has(mapApp) ? mapApp : "google";
  const url = cleanString(value.url) || buildLocationMapUrl({
    mapApp: normalizedMapApp,
    latitude,
    longitude
  });

  return {
    mapApp: normalizedMapApp,
    latitude,
    longitude,
    accuracy: Number.isFinite(Number(value.accuracy)) ? Number(value.accuracy) : null,
    url
  };
};

const resolveOutgoingLocationText = ({ text, locationShare }) => {
  const baseText = cleanString(text) || "";
  const normalizedLocation = normalizeOutgoingLocationShare(locationShare);
  if (!normalizedLocation) {
    return baseText;
  }

  const mapUrl = cleanString(normalizedLocation.url);
  if (!mapUrl) {
    return baseText;
  }

  return mapUrl;
};

const resolvePublicApiBaseUrl = (req) => {
  const configured = cleanString(process.env.PUBLIC_API_BASE_URL);
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const host = req?.get?.("host");
  if (!host) {
    return "";
  }

  const forwardedProto = cleanString(req?.headers?.["x-forwarded-proto"]);
  const protocol = forwardedProto || req?.protocol || "http";
  return `${protocol}://${host}`.replace(/\/+$/, "");
};

const attachmentResponseSelect = {
  id: true,
  ownerNumber: true,
  counterparty: true,
  kind: true,
  storage: true,
  storageKey: true,
  storageEtag: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  metadata: true,
  createdAt: true,
  updatedAt: true
};

const serializeMessageWithAttachments = (message) => ({
  ...message,
  attachments: (message.attachmentLinks || []).map((link) => link.attachment),
  attachmentLinks: undefined
});

const sanitizeFileName = (value, fallback = "attachment.bin") => {
  const clean = cleanString(value);
  if (!clean) {
    return fallback;
  }
  return clean.replace(/[\\/:*?"<>|]+/g, "_");
};

const createStorageKey = ({ ownerNumber, counterparty, kind, fileName }) => {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const safeOwner = String(ownerNumber || "unknown").replace(/[^\w+.-]/g, "_");
  const safeCounterparty = String(counterparty || "unknown").replace(/[^\w+.-]/g, "_");
  const safeKind = String(kind || "FILE").toLowerCase();
  const unique =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeName = sanitizeFileName(fileName, "attachment.bin");
  const prefix = OBJECT_STORAGE_PREFIX ? `${OBJECT_STORAGE_PREFIX}/` : "";
  return `${prefix}${year}/${month}/${day}/${safeOwner}/${safeCounterparty}/${safeKind}/${unique}-${safeName}`;
};

const storeAttachmentPayload = async ({
  ownerNumber,
  counterparty,
  kind,
  fileName,
  mimeType,
  payload,
  metadata,
  forceDatabaseStorage = false
}) => {
  if (!forceDatabaseStorage && shouldStoreAttachmentInObjectStore(kind)) {
    const storageKey = createStorageKey({ ownerNumber, counterparty, kind, fileName });
    const putResult = await objectStoreClient.send(
      new PutObjectCommand({
        Bucket: OBJECT_STORAGE_BUCKET,
        Key: storageKey,
        Body: payload,
        ContentType: mimeType || "application/octet-stream"
      })
    );

    return {
      ownerNumber,
      counterparty,
      kind,
      storage: "OBJECT_STORE",
      storageKey,
      storageEtag: cleanString(putResult?.ETag),
      fileName,
      mimeType,
      sizeBytes: Number(payload?.length || 0),
      bytes: null,
      metadata
    };
  }

  return {
    ownerNumber,
    counterparty,
    kind,
    storage: "DATABASE",
    storageKey: null,
    storageEtag: null,
    fileName,
    mimeType,
    sizeBytes: Number(payload?.length || 0),
    bytes: payload,
    metadata
  };
};

const readAttachmentPayload = async (attachment) => {
  if (!attachment) {
    return null;
  }

  if (attachment.storage === "OBJECT_STORE") {
    if (!objectStoreEnabled || !objectStoreClient || !attachment.storageKey) {
      return null;
    }

    const result = await objectStoreClient.send(
      new GetObjectCommand({
        Bucket: OBJECT_STORAGE_BUCKET,
        Key: attachment.storageKey
      })
    );

    if (result?.Body?.transformToByteArray) {
      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes);
    }

    if (Buffer.isBuffer(result?.Body)) {
      return result.Body;
    }

    return null;
  }

  if (!attachment.bytes) {
    return null;
  }

  return Buffer.from(attachment.bytes);
};

const normalizeContactFieldArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => cleanString(item))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
};

const formatContactAttachmentCard = (attachment, parsedPayload) => {
  const firstName = cleanString(parsedPayload?.firstName);
  const lastName = cleanString(parsedPayload?.lastName);
  const displayName = cleanString([firstName, lastName].filter(Boolean).join(" "));
  const email = cleanString(parsedPayload?.email);
  const company = cleanString(parsedPayload?.company);
  const address = cleanString(parsedPayload?.address);
  const phoneNumbers = normalizeContactFieldArray(parsedPayload?.phoneNumbers);

  const fileLabel = cleanString(attachment?.fileName)?.replace(/\.contact\.json$/i, "");
  const heading = displayName || email || phoneNumbers[0] || fileLabel || "Contact";
  const lines = [`Contact: ${heading}`];

  if (phoneNumbers.length > 0) {
    lines.push(`Phone: ${phoneNumbers.join(", ")}`);
  }
  if (email) {
    lines.push(`Email: ${email}`);
  }
  if (company) {
    lines.push(`Company: ${company}`);
  }
  if (address) {
    lines.push(`Address: ${address}`);
  }

  return lines.join("\n");
};

const enrichOutgoingTextWithContactAttachments = async ({ text, attachments }) => {
  const baseText = cleanString(text) || "";
  const sourceAttachments = Array.isArray(attachments) ? attachments : [];
  const contactAttachments = sourceAttachments.filter((attachment) => attachment?.kind === "CONTACT");

  if (contactAttachments.length === 0) {
    return baseText;
  }

  const contactCards = await mapWithConcurrency(contactAttachments, 4, async (attachment) => {
    try {
      const payloadBuffer = await readAttachmentPayload(attachment);
      if (!payloadBuffer) {
        return null;
      }

      const parsedPayload = JSON.parse(payloadBuffer.toString("utf8"));
      return formatContactAttachmentCard(attachment, parsedPayload);
    } catch (error) {
      return null;
    }
  });

  const usableCards = contactCards.filter(Boolean);
  if (usableCards.length === 0) {
    return baseText;
  }

  return `${baseText}\n\n${usableCards.join("\n\n")}`.trim();
};

const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cleanString(item))
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
};

const isPopulatedValue = (value) => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
};

const extractNonEmptyKeys = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([, item]) => isPopulatedValue(item))
    .map(([key]) => key);
};

const polishTranscriptionText = async (client, rawText) => {
  const content = (rawText || "").trim();
  if (!content) {
    return "";
  }

  const prompt =
    "You are a professional copy editor.\n" +
    "Fix grammar, spelling, capitalization, and punctuation.\n" +
    "Add sensible paragraph breaks if it improves readability.\n" +
    "Do NOT change meaning, do NOT add new facts, do NOT remove important details.\n" +
    "Return ONLY the corrected text.\n\n" +
    `TEXT:\n${content}`;

  const response = await client.chat.completions.create({
    model: OPENAI_POLISH_MODEL,
    messages: [{ role: "user", content: prompt }]
  });

  return (response.choices?.[0]?.message?.content || "").trim();
};

const resolveImportedFieldNames = (contactData, googleFieldValues) => {
  const fields = [];
  if (contactData.firstName) fields.push("firstName");
  if (contactData.lastName) fields.push("lastName");
  if (contactData.email) fields.push("email");
  if (contactData.address) fields.push("address");
  if (contactData.company) fields.push("company");
  if (Array.isArray(contactData.phoneNumbers) && contactData.phoneNumbers.length > 0) {
    fields.push("phoneNumbers");
  }
  if (
    Array.isArray(contactData.linkedInProfiles) &&
    contactData.linkedInProfiles.length > 0
  ) {
    fields.push("linkedInProfiles");
  }
  if (Array.isArray(googleFieldValues) && googleFieldValues.length > 0) {
    fields.push(...googleFieldValues.map((name) => `google.${name}`));
  }

  return fields.filter((item, index, arr) => arr.indexOf(item) === index);
};

const escapeVCardText = (value) => {
  const clean = cleanString(value);
  if (!clean) {
    return "";
  }

  return clean
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
};

const buildVCardPayload = (contact) => {
  const firstName = cleanString(contact?.firstName) || "";
  const lastName = cleanString(contact?.lastName) || "";
  const fullName = cleanString(`${firstName} ${lastName}`) || cleanString(contact?.email) || "Contact";
  const phoneNumbers = Array.isArray(contact?.phoneNumbers)
    ? contact.phoneNumbers.map((item) => cleanString(item)).filter(Boolean)
    : [];

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeVCardText(lastName)};${escapeVCardText(firstName)};;;`,
    `FN:${escapeVCardText(fullName)}`
  ];

  phoneNumbers.forEach((phone) => {
    lines.push(`TEL;TYPE=CELL:${escapeVCardText(phone)}`);
  });

  const email = cleanString(contact?.email);
  if (email) {
    lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardText(email)}`);
  }

  const company = cleanString(contact?.company);
  if (company) {
    lines.push(`ORG:${escapeVCardText(company)}`);
  }

  const address = cleanString(contact?.address);
  if (address) {
    lines.push(`ADR;TYPE=WORK:;;${escapeVCardText(address)};;;;`);
  }

  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
};

const buildContactVCardFileName = (contact) => {
  const firstName = cleanString(contact?.firstName) || "Contact";
  const lastName = cleanString(contact?.lastName) || "Card";
  const baseName = `${firstName}_${lastName}`;
  return sanitizeFileName(`${baseName}.vcf`, `${contact?.id || "contact"}.vcf`);
};

const parseCsvLine = (line) => {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
};

const parseCsvText = (csvText) => {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index] ?? "";
      return acc;
    }, {});
  });
};

const pickFirstValue = (row, keys) => {
  for (const key of keys) {
    const value = cleanString(row[key]);
    if (value) {
      return value;
    }
  }
  return null;
};

const mapOutlookRowToContact = (row) => {
  const firstName = pickFirstValue(row, ["First Name", "Given Name"]);
  const lastName = pickFirstValue(row, ["Last Name", "Surname"]);
  const email = pickFirstValue(row, [
    "E-mail Address",
    "E-mail 2 Address",
    "E-mail 3 Address",
    "Email Address"
  ]);
  const company = pickFirstValue(row, ["Company", "Company Name"]);

  const addressParts = [
    pickFirstValue(row, ["Business Street", "Home Street", "Other Street"]),
    pickFirstValue(row, ["Business City", "Home City", "Other City"]),
    pickFirstValue(row, ["Business State", "Home State", "Other State"]),
    pickFirstValue(row, ["Business Postal Code", "Home Postal Code", "Other Postal Code"]),
    pickFirstValue(row, ["Business Country/Region", "Home Country/Region", "Other Country/Region"])
  ].filter(Boolean);

  const phoneNumbers = normalizeStringArray([
    row["Business Phone"],
    row["Business Phone 2"],
    row["Mobile Phone"],
    row["Home Phone"],
    row["Home Phone 2"],
    row["Company Main Phone"],
    row["Primary Phone"]
  ]);

  const linkedInProfiles = normalizeStringArray([
    row["Web Page"],
    row["Business Web Page"]
  ]).filter((url) => url.toLowerCase().includes("linkedin.com"));

  return {
    firstName,
    lastName,
    email,
    address: addressParts.length > 0 ? addressParts.join(", ") : null,
    company,
    phoneNumbers,
    linkedInProfiles,
    source: "outlook_csv",
    sourceExternalId: null
  };
};

const cleanupOauthState = () => {
  const now = Date.now();
  for (const [state, value] of oauthStateStore.entries()) {
    if (now - value.createdAt > OAUTH_STATE_TTL_MS) {
      oauthStateStore.delete(state);
    }
  }
};

const createOauthState = (provider) => {
  cleanupOauthState();
  const state = `${provider}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  oauthStateStore.set(state, { provider, createdAt: Date.now() });
  return state;
};

const consumeOauthState = (state, provider) => {
  cleanupOauthState();
  const saved = oauthStateStore.get(state);
  if (!saved || saved.provider !== provider) {
    return false;
  }
  oauthStateStore.delete(state);
  return true;
};

const exchangeGoogleCodeForToken = async (code) => {
  const response = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
      code
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );
  return response.data?.access_token || "";
};

const exchangeMicrosoftCodeForToken = async (code) => {
  const response = await axios.post(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      redirect_uri: MICROSOFT_REDIRECT_URI,
      grant_type: "authorization_code",
      code,
      scope: "offline_access User.Read Contacts.Read"
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );
  return response.data?.access_token || "";
};

const fetchGoogleContacts = async (accessToken) => {
  const contacts = [];
  const seenExternalIds = new Set();
  const stats = {
    connections: { pages: 0, received: 0, accepted: 0, skippedEmpty: 0, skippedDuplicate: 0 },
    otherContacts: { pages: 0, received: 0, accepted: 0, skippedEmpty: 0, skippedDuplicate: 0 },
    totalAccepted: 0
  };
  const googlePersonFields = [
    "addresses",
    "ageRanges",
    "biographies",
    "birthdays",
    "calendarUrls",
    "clientData",
    "coverPhotos",
    "emailAddresses",
    "events",
    "externalIds",
    "genders",
    "imClients",
    "interests",
    "locales",
    "locations",
    "memberships",
    "metadata",
    "miscKeywords",
    "names",
    "nicknames",
    "occupations",
    "organizations",
    "phoneNumbers",
    "photos",
    "relations",
    "sipAddresses",
    "skills",
    "urls",
    "userDefined"
  ].join(",");
  const googleOtherContactsFields = [
    "emailAddresses",
    "metadata",
    "names",
    "phoneNumbers",
    "photos"
  ].join(",");

  const pushGooglePeople = (people, sourceKey) => {
    for (const person of people) {
      stats[sourceKey].received += 1;
      const firstName = cleanString(person.names?.[0]?.givenName || person.names?.[0]?.displayName);
      const lastName = cleanString(person.names?.[0]?.familyName);
      const email = cleanString(person.emailAddresses?.[0]?.value);
      const address = cleanString(person.addresses?.[0]?.formattedValue);
      const company = cleanString(person.organizations?.[0]?.name);
      const phoneNumbers = normalizeStringArray((person.phoneNumbers || []).map((item) => item.value));
      const linkedInProfiles = normalizeStringArray(
        (person.urls || []).map((item) => item.value)
      ).filter((url) => url.toLowerCase().includes("linkedin.com"));
      const sourceExternalId = cleanString(person.resourceName);
      const googleFieldValues = extractNonEmptyKeys(person);

      if (
        !firstName &&
        !lastName &&
        !email &&
        !address &&
        !company &&
        phoneNumbers.length === 0 &&
        linkedInProfiles.length === 0
      ) {
        stats[sourceKey].skippedEmpty += 1;
        continue;
      }

      if (sourceExternalId && seenExternalIds.has(sourceExternalId)) {
        stats[sourceKey].skippedDuplicate += 1;
        continue;
      }

      contacts.push({
        firstName,
        lastName,
        email,
        address,
        company,
        phoneNumbers,
        linkedInProfiles,
        source: "gmail",
        sourceExternalId,
        googleRaw: person,
        googleFieldValues
      });

      if (sourceExternalId) {
        seenExternalIds.add(sourceExternalId);
      }

      stats[sourceKey].accepted += 1;
      stats.totalAccepted += 1;
    }
  };

  let pageToken = "";

  while (true) {
    stats.connections.pages += 1;
    const params = new URLSearchParams({
      personFields: googlePersonFields,
      pageSize: "500"
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await axios.get(
      `https://people.googleapis.com/v1/people/me/connections?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    pushGooglePeople(response.data?.connections || [], "connections");

    pageToken = response.data?.nextPageToken || "";
    if (!pageToken) {
      break;
    }
  }

  let otherContactsPageToken = "";

  while (true) {
    stats.otherContacts.pages += 1;
    const params = new URLSearchParams({
      readMask: googleOtherContactsFields,
      pageSize: "1000"
    });
    if (otherContactsPageToken) {
      params.set("pageToken", otherContactsPageToken);
    }

    const response = await axios.get(
      `https://people.googleapis.com/v1/otherContacts?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    pushGooglePeople(response.data?.otherContacts || [], "otherContacts");

    otherContactsPageToken = response.data?.nextPageToken || "";
    if (!otherContactsPageToken) {
      break;
    }
  }

  return { contacts, stats };
};

const fetchMicrosoftContacts = async (accessToken) => {
  const contacts = [];
  let nextUrl =
    "https://graph.microsoft.com/v1.0/me/contacts?$top=200&$select=id,givenName,surname,emailAddresses,businessPhones,mobilePhone,companyName,businessAddress,homeAddress";

  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const values = response.data?.value || [];
    for (const person of values) {
      const email = cleanString(person.emailAddresses?.[0]?.address);
      const company = cleanString(person.companyName);
      const addressSource = person.businessAddress || person.homeAddress || null;
      const address = addressSource
        ? cleanString(
            [
              addressSource.street,
              addressSource.city,
              addressSource.state,
              addressSource.postalCode,
              addressSource.countryOrRegion
            ]
              .map((item) => cleanString(item))
              .filter(Boolean)
              .join(", ")
          )
        : null;

      const phoneNumbers = normalizeStringArray([
        ...(person.businessPhones || []),
        person.mobilePhone
      ]);

      if (!person.givenName && !person.surname && !email && phoneNumbers.length === 0) {
        continue;
      }

      contacts.push({
        firstName: cleanString(person.givenName),
        lastName: cleanString(person.surname),
        email,
        address,
        company,
        phoneNumbers,
        linkedInProfiles: [],
        source: "office365",
        sourceExternalId: cleanString(person.id)
      });
    }

    nextUrl = response.data?.["@odata.nextLink"] || "";
  }

  return contacts;
};

const saveContacts = async (contacts) => {
  let created = 0;
  let updated = 0;

  for (const contact of contacts) {
    const sourceExternalId = cleanString(contact.sourceExternalId);
    const source = cleanString(contact.source) || "manual";
    const importedAt = new Date();
    const googleRaw =
      contact.googleRaw && typeof contact.googleRaw === "object" ? contact.googleRaw : null;
    const googleFieldValues = Array.isArray(contact.googleFieldValues)
      ? contact.googleFieldValues.filter(Boolean)
      : extractNonEmptyKeys(googleRaw);

    const data = {
      firstName: cleanString(contact.firstName),
      lastName: cleanString(contact.lastName),
      email: cleanString(contact.email),
      address: cleanString(contact.address),
      company: cleanString(contact.company),
      phoneNumbers: normalizeStringArray(contact.phoneNumbers),
      linkedInProfiles: normalizeStringArray(contact.linkedInProfiles),
      importedAt,
      source,
      sourceImportMeta: {
        source,
        importedAt: importedAt.toISOString()
      },
      sourceExternalId,
      googleRaw,
      googleFieldValues
    };

    const importedFields = resolveImportedFieldNames(data, googleFieldValues);
    data.sourceDetails = {
      source,
      importedFields
    };

    if (
      !data.firstName &&
      !data.lastName &&
      !data.email &&
      !data.address &&
      !data.company &&
      data.phoneNumbers.length === 0 &&
      data.linkedInProfiles.length === 0
    ) {
      continue;
    }

    if (sourceExternalId) {
      await prisma.contact.upsert({
        where: {
          source_sourceExternalId: {
            source,
            sourceExternalId
          }
        },
        create: data,
        update: data
      });
      updated += 1;
      continue;
    }

    await prisma.contact.create({ data });
    created += 1;
  }

  return {
    created,
    updated,
    total: created + updated
  };
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

const resolveDefaultState = (direction) =>
  direction === "inbound" ? "UNREAD" : "READ";

const normalizeTags = (value) => (Array.isArray(value) ? value : []);

const isMessageUnread = (message) => {
  if (!message) {
    return false;
  }
  if (message.state) {
    return message.state === "UNREAD";
  }
  return !message.readAt;
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

  const existingConversations = await prisma.conversation.findMany({
    where: owner ? { ownerNumber: owner } : undefined,
    select: {
      ownerNumber: true,
      counterparty: true,
      state: true,
      bookmarked: true,
      lastReadAt: true,
      lastSelectedAt: true
    }
  });

  const existingMap = new Map(
    existingConversations.map((item) => [
      `${item.ownerNumber}__${item.counterparty}`,
      item
    ])
  );

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
      const existing = existingMap.get(key);
      map.set(key, {
        ownerNumber,
        counterparty,
        lastMessageAt: getMessageTime(message),
        lastMessageText: message.text || "(no text)",
        lastMessageDirection: message.direction || "unknown",
        lastMessageId: message.id,
        unreadCount: 0,
        state: existing?.state || "ACTIVE",
        bookmarked: existing?.bookmarked ?? false,
        lastReadAt: existing?.lastReadAt || null,
        lastSelectedAt: existing?.lastSelectedAt || null
      });
    }

    if (
      (owner ? message.to === owner : message.direction === "inbound") &&
      isMessageUnread(message)
    ) {
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
    await prisma.conversation.createMany({ data, skipDuplicates: true });
  }

  return { count: data.length };
};

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/transcriptions/whisper", upload.single("audio"), async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(400).json({ error: "Missing OPENAI_API_KEY" });
  }

  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "audio file is required" });
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const uploadedFile = await OpenAI.toFile(
      req.file.buffer,
      req.file.originalname || "recording.webm",
      {
        type: req.file.mimetype || "audio/webm"
      }
    );

    const transcription = await client.audio.transcriptions.create({
      model: OPENAI_TRANSCRIBE_MODEL,
      file: uploadedFile
    });

    const rawText = (transcription.text || "").trim();
    const polishedText = await polishTranscriptionText(client, rawText);

    return res.json({
      ok: true,
      rawText,
      text: polishedText || rawText
    });
  } catch (error) {
    const details = error.response?.data || { message: error.message };
    return res.status(500).json({ error: "Whisper transcription failed", details });
  }
});

app.get("/messages", async (req, res) => {
  const limit = Number(req.query.limit || 50);
  const messages = await prisma.message.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
    include: {
      attachmentLinks: {
        include: {
          attachment: {
            select: attachmentResponseSelect
          }
        }
      }
    }
  });

  res.json({ messages: messages.map(serializeMessageWithAttachments) });
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

app.get("/contacts", async (req, res) => {
  const limit = Number(req.query.limit || 5000);
  const contacts = await prisma.contact.findMany({
    orderBy: { updatedAt: "desc" },
    take: Math.min(limit, 10000)
  });

  res.json({ contacts });
});

app.post("/contacts", async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    address,
    company,
    phoneNumbers,
    linkedInProfiles
  } = req.body || {};
  const manualImportedAt = new Date();

  const created = await prisma.contact.create({
    data: {
      importedAt: manualImportedAt,
      firstName: cleanString(firstName),
      lastName: cleanString(lastName),
      email: cleanString(email),
      address: cleanString(address),
      company: cleanString(company),
      phoneNumbers: normalizeStringArray(phoneNumbers),
      linkedInProfiles: normalizeStringArray(linkedInProfiles),
      source: "manual",
      sourceImportMeta: {
        source: "manual",
        importedAt: manualImportedAt.toISOString()
      },
      sourceDetails: {
        source: "manual",
        importedFields: resolveImportedFieldNames(
          {
            firstName: cleanString(firstName),
            lastName: cleanString(lastName),
            email: cleanString(email),
            address: cleanString(address),
            company: cleanString(company),
            phoneNumbers: normalizeStringArray(phoneNumbers),
            linkedInProfiles: normalizeStringArray(linkedInProfiles)
          },
          []
        )
      }
    }
  });

  res.status(201).json({ contact: created });
});

app.post("/contacts/bulk-delete", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array is required" });
  }

  const uniqueIds = ids
    .map((item) => cleanString(item))
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);

  if (uniqueIds.length === 0) {
    return res.status(400).json({ error: "No valid ids supplied" });
  }

  const result = await prisma.contact.deleteMany({
    where: {
      id: {
        in: uniqueIds
      }
    }
  });

  return res.json({ ok: true, deletedCount: result.count });
});

app.post("/contacts/import/outlook-csv", async (req, res) => {
  const csvText = req.body?.csvText;
  if (!cleanString(csvText)) {
    return res.status(400).json({ error: "csvText is required" });
  }

  const rows = parseCsvText(csvText);
  if (rows.length === 0) {
    return res.status(400).json({ error: "CSV appears empty or invalid" });
  }

  const mappedContacts = rows.map(mapOutlookRowToContact);
  const result = await saveContacts(mappedContacts);
  return res.json({ ok: true, imported: result.total, ...result });
});

app.get("/contacts/oauth/google/start", (_req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.status(400).json({
      error: "Missing Google OAuth config. Set GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI."
    });
  }

  const state = createOauthState("google");
  const query = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope:
      "openid email profile https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });

  return res.json({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`,
    state
  });
});

app.get("/contacts/oauth/microsoft/start", (_req, res) => {
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_REDIRECT_URI) {
    return res.status(400).json({
      error:
        "Missing Microsoft OAuth config. Set MICROSOFT_CLIENT_ID and MICROSOFT_REDIRECT_URI."
    });
  }

  const state = createOauthState("microsoft");
  const query = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    response_type: "code",
    redirect_uri: MICROSOFT_REDIRECT_URI,
    response_mode: "query",
    scope: "offline_access User.Read Contacts.Read",
    state
  });

  return res.json({
    url: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${query.toString()}`,
    state
  });
});

app.post("/contacts/import/google", async (req, res) => {
  const { code, state } = req.body || {};
  if (!cleanString(code) || !cleanString(state)) {
    return res.status(400).json({ error: "code and state are required" });
  }

  if (!consumeOauthState(state, "google")) {
    return res.status(400).json({ error: "Invalid or expired OAuth state" });
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    return res.status(400).json({
      error:
        "Missing Google OAuth env vars. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI."
    });
  }

  try {
    const accessToken = await exchangeGoogleCodeForToken(code);
    if (!accessToken) {
      return res.status(400).json({ error: "Unable to acquire Google access token" });
    }
    const googleImport = await fetchGoogleContacts(accessToken);
    const contacts = googleImport.contacts || [];
    const result = await saveContacts(contacts);
    return res.json({
      ok: true,
      imported: result.total,
      ...result,
      diagnostics: googleImport.stats
    });
  } catch (error) {
    const details = error.response?.data || { message: error.message };
    return res.status(500).json({ error: "Google import failed", details });
  }
});

app.post("/contacts/import/microsoft", async (req, res) => {
  const { code, state } = req.body || {};
  if (!cleanString(code) || !cleanString(state)) {
    return res.status(400).json({ error: "code and state are required" });
  }

  if (!consumeOauthState(state, "microsoft")) {
    return res.status(400).json({ error: "Invalid or expired OAuth state" });
  }

  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !MICROSOFT_REDIRECT_URI) {
    return res.status(400).json({
      error:
        "Missing Microsoft OAuth env vars. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_REDIRECT_URI."
    });
  }

  try {
    const accessToken = await exchangeMicrosoftCodeForToken(code);
    if (!accessToken) {
      return res.status(400).json({ error: "Unable to acquire Microsoft access token" });
    }
    const contacts = await fetchMicrosoftContacts(accessToken);
    const result = await saveContacts(contacts);
    return res.json({ ok: true, imported: result.total, ...result });
  } catch (error) {
    const details = error.response?.data || { message: error.message };
    return res.status(500).json({ error: "Office 365 import failed", details });
  }
});

app.post("/attachments/upload", attachmentUpload.array("files", 20), async (req, res) => {
  const ownerNumber = cleanString(req.body?.owner);
  const counterparty = cleanString(req.body?.counterparty);
  const kind = normalizeAttachmentKind(req.body?.kind, "FILE");
  const files = Array.isArray(req.files) ? req.files : [];

  if (!ownerNumber || !counterparty) {
    return res.status(400).json({ error: "owner and counterparty are required" });
  }

  if (files.length === 0) {
    return res.status(400).json({ error: "At least one file is required" });
  }

  try {
    const created = await Promise.all(
      files.map(async (file) => {
        const fileName = sanitizeFileName(
          cleanString(file.originalname) || `upload-${Date.now()}`,
          `upload-${Date.now()}.bin`
        );
        const mimeType = cleanString(file.mimetype) || "application/octet-stream";
        const attachmentData = await storeAttachmentPayload({
          ownerNumber,
          counterparty,
          kind,
          fileName,
          mimeType,
          payload: file.buffer,
          metadata: {
            uploadedVia: "composer",
            uploadedAt: new Date().toISOString()
          }
        });

        return prisma.attachment.create({
          data: attachmentData,
          select: attachmentResponseSelect
        });
      })
    );

    return res.status(201).json({ ok: true, attachments: created });
  } catch (error) {
    return res.status(500).json({ error: "Attachment upload failed", details: error.message });
  }
});

app.post("/attachments/contact", async (req, res) => {
  const ownerNumber = cleanString(req.body?.owner);
  const counterparty = cleanString(req.body?.counterparty);
  const contactIds = normalizeAttachmentIds(req.body?.contactIds);

  if (!ownerNumber || !counterparty) {
    return res.status(400).json({ error: "owner and counterparty are required" });
  }
  if (contactIds.length === 0) {
    return res.status(400).json({ error: "contactIds are required" });
  }

  try {
    const contacts = await prisma.contact.findMany({
      where: {
        id: {
          in: contactIds
        }
      }
    });

    if (contacts.length === 0) {
      return res.status(404).json({ error: "No matching contacts found" });
    }

    const created = await Promise.all(
      contacts.map((contact) => {
        const vCardPayload = buildVCardPayload(contact);
        const content = Buffer.from(vCardPayload, "utf8");
        const fileName = buildContactVCardFileName(contact);

        return storeAttachmentPayload({
          ownerNumber,
          counterparty,
          kind: "CONTACT",
          fileName,
          mimeType: "text/vcard; charset=utf-8",
          payload: content,
          metadata: {
            sourceContactId: contact.id,
            label: fileName,
            format: "VCARD"
          }
        }).then((attachmentData) =>
          prisma.attachment.create({
            data: attachmentData,
            select: attachmentResponseSelect
          })
        );
      })
    );

    return res.status(201).json({ ok: true, attachments: created });
  } catch (error) {
    return res.status(500).json({ error: "Contact attachment failed", details: error.message });
  }
});

app.post("/attachments/location", async (req, res) => {
  return res.status(410).json({
    error:
      "Location attachments are deprecated. Insert a map URL into the message text instead."
  });
});

app.get("/attachments/:id/download", async (req, res) => {
  const attachmentId = cleanString(req.params.id);
  if (!attachmentId) {
    return res.status(400).json({ error: "attachment id is required" });
  }

  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      storage: true,
      storageKey: true,
      fileName: true,
      mimeType: true,
      bytes: true
    }
  });

  if (!attachment) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const payload = await readAttachmentPayload(attachment);
  if (!payload) {
    return res.status(404).json({ error: "Attachment payload not found" });
  }

  const fileName = encodeURIComponent(attachment.fileName || `attachment-${attachmentId}`);
  res.setHeader("Content-Type", attachment.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${fileName}`);
  return res.send(payload);
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

  const withActivePreview = await mapWithConcurrency(
    conversations,
    4,
    async (conversation) => {
      const activeMessage = await prisma.message.findFirst({
        where: {
          AND: [
            {
              OR: [
                { direction: "outbound", from: owner, to: conversation.counterparty },
                { direction: "inbound", from: conversation.counterparty, to: owner }
              ]
            },
            { state: { in: ["READ", "UNREAD"] } }
          ]
        },
        orderBy: [{ createdAt: "desc" }, { occurredAt: "desc" }]
      });

      if (!activeMessage) {
        return {
          ...conversation,
          lastMessageText: "",
          lastMessageAt: null
        };
      }

      return {
        ...conversation,
        lastMessageText: activeMessage.text || "",
        lastMessageAt: getMessageTime(activeMessage),
        lastMessageDirection: activeMessage.direction || conversation.lastMessageDirection,
        lastMessageId: activeMessage.id
      };
    }
  );

  const selectedConversation = conversations
    .filter((item) => item.lastSelectedAt)
    .sort(
      (a, b) =>
        new Date(b.lastSelectedAt).getTime() - new Date(a.lastSelectedAt).getTime()
    )[0];

  res.json({
    conversations: withActivePreview,
    selectedCounterparty: selectedConversation?.counterparty || null
  });
});

app.post("/conversations/select", async (req, res) => {
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
    return res.status(404).json({ error: "Conversation not found" });
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.conversation.updateMany({
      where: {
        ownerNumber: owner,
        counterparty: { not: counterparty }
      },
      data: {
        lastSelectedAt: null
      }
    }),
    prisma.conversation.update({
      where: {
        owner_counterparty: {
          ownerNumber: owner,
          counterparty
        }
      },
      data: {
        lastSelectedAt: now
      }
    })
  ]);

  return res.json({ ok: true, owner, counterparty, lastSelectedAt: now });
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
    orderBy: { createdAt: "asc" },
    include: {
      attachmentLinks: {
        include: {
          attachment: {
            select: attachmentResponseSelect
          }
        }
      }
    }
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

  res.json({ messages: dedupedMessages.map(serializeMessageWithAttachments) });
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

app.post("/conversations/update", async (req, res) => {
  const { owner, counterparty, state, bookmarked } = req.body || {};
  if (!owner || !counterparty) {
    return res.status(400).json({ error: "owner and counterparty are required" });
  }

  const data = {};
  const allowedStates = new Set(["ACTIVE", "ARCHIVED", "DELETED"]);
  if (state) {
    if (!allowedStates.has(state)) {
      return res.status(400).json({ error: "Invalid state" });
    }
    data.state = state;
  }
  if (bookmarked !== undefined) {
    data.bookmarked = Boolean(bookmarked);
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "state or bookmarked is required" });
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
    return res.status(404).json({ error: "Conversation not found" });
  }

  const updated = await prisma.conversation.update({
    where: {
      owner_counterparty: {
        ownerNumber: owner,
        counterparty
      }
    },
    data
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
              state: resolveDefaultState(item.direction || "inbound"),
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
  const attachmentIds = normalizeAttachmentIds(req.body?.attachmentIds);
  const locationShare = req.body?.locationShare;

  if (!from || !to) {
    return res.status(400).json({ error: "from and to are required" });
  }

  if (!cleanString(text) && attachmentIds.length === 0 && !locationShare) {
    return res.status(400).json({ error: "text, attachmentIds, or locationShare is required" });
  }

  if (!TELNYX_API_KEY) {
    return res.status(500).json({ error: "TELNYX_API_KEY is not set" });
  }

  try {
    const validAttachments = attachmentIds.length > 0
      ? await prisma.attachment.findMany({
          where: {
            id: {
              in: attachmentIds
            },
            ownerNumber: from,
            counterparty: to
          },
          select: {
            id: true,
            kind: true
          }
        })
      : [];

    const publicApiBaseUrl = resolvePublicApiBaseUrl(req);
    const contactMediaUrls = validAttachments
      .filter((attachment) => attachment.kind === "CONTACT")
      .map((attachment) =>
        publicApiBaseUrl ? `${publicApiBaseUrl}/attachments/${attachment.id}/download` : null
      )
      .filter(Boolean)
      .filter((url, index, list) => list.indexOf(url) === index);

    const locationAwareText = cleanString(resolveOutgoingLocationText({ text, locationShare })) ||
      cleanString(text) || null;

    const outboundPayload = {
      from,
      to,
      ...(locationAwareText ? { text: locationAwareText } : {}),
      ...(contactMediaUrls.length > 0 ? { media_urls: contactMediaUrls } : {})
    };

    if (!outboundPayload.text && contactMediaUrls.length === 0) {
      return res.status(400).json({
        error:
          "Contact attachments require a public API URL. Set PUBLIC_API_BASE_URL so Telnyx can fetch /attachments/:id/download."
      });
    }

    const response = await axios.post(
      "https://api.telnyx.com/v2/messages",
      outboundPayload,
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
        text: locationAwareText,
        status: messageData?.to?.[0]?.status || messageData?.status || null,
        telnyxMessageId: messageData?.id || null,
        occurredAt: messageData?.created_at ? new Date(messageData.created_at) : null,
        state: "READ",
        raw: response.data
      }
    });

    if (validAttachments.length > 0) {
      await prisma.messageAttachment.createMany({
        data: validAttachments.map((attachment) => ({
          messageId: saved.id,
          attachmentId: attachment.id
        })),
        skipDuplicates: true
      });
    }

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

    const savedWithAttachments = await prisma.message.findUnique({
      where: { id: saved.id },
      include: {
        attachmentLinks: {
          include: {
            attachment: {
              select: attachmentResponseSelect
            }
          }
        }
      }
    });

    res.json({
      message: savedWithAttachments
        ? serializeMessageWithAttachments(savedWithAttachments)
        : saved,
      telnyx: response.data
    });
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

app.post("/messages/mark-read", async (req, res) => {
  const { owner, counterparty, ids } = req.body || {};
  if (!owner || !counterparty || !Array.isArray(ids) || ids.length === 0) {
    return res
      .status(400)
      .json({ error: "owner, counterparty, and ids are required" });
  }

  await prisma.message.updateMany({
    where: {
      id: { in: ids },
      readAt: null
    },
    data: {
      readAt: new Date(),
      state: "READ"
    }
  });

  const unreadCount = await prisma.message.count({
    where: {
      direction: "inbound",
      from: counterparty,
      to: owner,
      readAt: null
    }
  });

  const conversation = await prisma.conversation.findUnique({
    where: {
      owner_counterparty: {
        ownerNumber: owner,
        counterparty
      }
    }
  });

  if (conversation) {
    await prisma.conversation.update({
      where: {
        owner_counterparty: {
          ownerNumber: owner,
          counterparty
        }
      },
      data: {
        unreadCount,
        lastReadAt: new Date()
      }
    });
  }

  res.json({ ok: true, unreadCount });
});

app.post("/messages/bulk-update", async (req, res) => {
  const { ids, state, toggleTag } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array is required" });
  }

  if (!state && !toggleTag) {
    return res.status(400).json({ error: "state or toggleTag is required" });
  }

  let updatedStateCount = 0;
  let updatedTagCount = 0;

  if (state) {
    const data = { state };
    if (state === "READ") {
      data.readAt = new Date();
    }
    if (state === "UNREAD") {
      data.readAt = null;
    }
    const result = await prisma.message.updateMany({
      where: { id: { in: ids } },
      data
    });
    updatedStateCount = result.count;
  }

  if (toggleTag) {
    const tag = String(toggleTag);
    const messages = await prisma.message.findMany({
      where: { id: { in: ids } },
      select: { id: true, tags: true }
    });

    await Promise.all(
      messages.map((message) => {
        const tags = normalizeTags(message.tags);
        const hasTag = tags.includes(tag);
        const nextTags = hasTag
          ? tags.filter((item) => item !== tag)
          : [...tags, tag];
        return prisma.message.update({
          where: { id: message.id },
          data: { tags: nextTags }
        });
      })
    );
    updatedTagCount = messages.length;
  }

  res.json({ ok: true, updatedStateCount, updatedTagCount });
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
            state: resolveDefaultState(direction),
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
