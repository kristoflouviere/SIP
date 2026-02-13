import { useEffect, useMemo, useRef, useState } from "react";
import {
  getCountries,
  getCountryCallingCode,
  validatePhoneNumberLength
} from "libphonenumber-js/max";
import "./App.css";

const defaultBaseUrl = "http://localhost:3001";
const callingCodeSet = new Set(
  getCountries().map((country) => getCountryCallingCode(country))
);

const findCallingCode = (value) => {
  if (!value.startsWith("+")) {
    return "";
  }
  const digits = value.slice(1);
  let code = "";
  for (let i = 1; i <= 3 && i <= digits.length; i += 1) {
    const candidate = digits.slice(0, i);
    if (callingCodeSet.has(candidate)) {
      code = candidate;
    }
  }
  return code;
};

const sanitizeE164 = (value) => {
  const trimmed = value.replace(/[^+\d]/g, "");
  if (!trimmed.includes("+")) {
    return trimmed;
  }
  return trimmed.startsWith("+")
    ? "+" + trimmed.slice(1).replace(/\+/g, "")
    : trimmed.replace(/\+/g, "");
};

const analyzeNumber = (value) => {
  const clean = sanitizeE164(value);
  if (!clean.startsWith("+")) {
    return {
      clean,
      code: "",
      isCodeValid: false,
      lengthStatus: "MISSING",
      isPossible: false
    };
  }

  const code = findCallingCode(clean);
  const isCodeValid = Boolean(code);
  let lengthStatus = "INCOMPLETE";

  if (isCodeValid) {
    try {
      const status = validatePhoneNumberLength(clean);
      lengthStatus = status || "IS_POSSIBLE";
    } catch (error) {
      lengthStatus = "INVALID";
    }
  }

  return {
    clean,
    code,
    isCodeValid,
    lengthStatus,
    isPossible: lengthStatus === "IS_POSSIBLE"
  };
};

const getLengthMessage = (meta) => {
  if (!meta.clean) {
    return "Enter a number";
  }
  if (meta.clean === "+") {
    return "Enter a country code";
  }
  if (!meta.isCodeValid) {
    return "Invalid country code";
  }
  switch (meta.lengthStatus) {
    case "IS_POSSIBLE":
      return "Length looks good";
    case "TOO_SHORT":
      return "Number is too short";
    case "TOO_LONG":
      return "Number is too long";
    case "INVALID_LENGTH":
      return "Invalid length";
    default:
      return "Incomplete number";
  }
};

function App() {
  const baseUrl = useMemo(
    () => import.meta.env.VITE_API_BASE_URL || defaultBaseUrl,
    []
  );
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [fromNumbers, setFromNumbers] = useState([]);
  const [toNumbers, setToNumbers] = useState([]);
  const [form, setForm] = useState({ from: "", to: "", text: "" });
  const [status, setStatus] = useState({ loading: false, error: "", success: "" });
  const [eventStatus, setEventStatus] = useState({ loading: false, error: "" });
  const [activeView, setActiveView] = useState("app");
  const [dbTables, setDbTables] = useState([]);
  const [dbState, setDbState] = useState({});
  const [selectedOwner, setSelectedOwner] = useState("");
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState("");
  const [conversationMessages, setConversationMessages] = useState([]);
  const [conversationMenuId, setConversationMenuId] = useState("");
  const [messageMenuId, setMessageMenuId] = useState("");
  const [conversationStatus, setConversationStatus] = useState({
    loading: false,
    error: ""
  });
  const [conversationDraft, setConversationDraft] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const [messageFilter, setMessageFilter] = useState("active");
  const [conversationView, setConversationView] = useState("recent");
  const realtimePollMs = Number(import.meta.env.VITE_REALTIME_POLL_MS || 3000);
  const threadBodyRef = useRef(null);
  const pendingReadIdsRef = useRef(new Set());
  const readFlushRef = useRef(null);

  const loadMessages = async () => {
    setStatus((prev) => ({ ...prev, error: "" }));
    try {
      const response = await fetch(`${baseUrl}/messages`);
      const data = await response.json();
      setMessages(data.messages || []);
    } catch (error) {
      setStatus((prev) => ({ ...prev, error: error.message }));
    }
  };

  const loadDbTables = async () => {
    try {
      const response = await fetch(`${baseUrl}/db/tables`);
      const data = await response.json();
      const tables = data.tables || [];
      setDbTables(tables);
      setDbState((prev) => {
        const next = { ...prev };
        tables.forEach((table) => {
          if (!next[table.name]) {
            next[table.name] = {
              open: false,
              rows: [],
              count: 0,
              loading: false,
              error: "",
              search: "",
              sortBy: table.defaultSort,
              sortDir: "desc",
              filters: {},
              selected: {}
            };
          } else if (!next[table.name].sortBy) {
            next[table.name] = {
              ...next[table.name],
              sortBy: table.defaultSort
            };
          }
        });
        return next;
      });
    } catch (error) {
      setDbState((prev) => ({
        ...prev,
        metaError: error.message
      }));
    }
  };

  const flushReadMessages = async () => {
    if (!selectedOwner || !selectedConversation) {
      pendingReadIdsRef.current.clear();
      return;
    }
    const ids = Array.from(pendingReadIdsRef.current);
    if (ids.length === 0) {
      return;
    }

    pendingReadIdsRef.current.clear();
    try {
      await fetch(`${baseUrl}/messages/mark-read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: selectedOwner,
          counterparty: selectedConversation,
          ids
        })
      });
      await loadConversations(selectedOwner);
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };


  const fetchTableRows = async (tableName, overrides = {}) => {
    const table = dbTables.find((item) => item.name === tableName);
    if (!table) {
      return;
    }

    const current = dbState[tableName] || {
      open: true,
      rows: [],
      count: 0,
      loading: false,
      error: "",
      search: "",
      sortBy: table.defaultSort,
      sortDir: "desc",
      filters: {}
    };
    const nextState = { ...current, ...overrides };

    setDbState((prev) => ({
      ...prev,
      [tableName]: { ...nextState, loading: true, error: "" }
    }));

    const filters = Object.entries(nextState.filters || {})
      .filter(([, value]) => value !== "")
      .map(([field, value]) => ({ field, value }));

    const query = new URLSearchParams({
      limit: "200",
      sortBy: nextState.sortBy,
      sortDir: nextState.sortDir,
      search: nextState.search || "",
      filters: JSON.stringify(filters)
    });

    try {
      const response = await fetch(
        `${baseUrl}/db/table/${encodeURIComponent(tableName)}?${query}`
      );
      const data = await response.json();
      setDbState((prev) => ({
        ...prev,
        [tableName]: {
          ...nextState,
          rows: data.rows || [],
          count: data.count || 0,
          loading: false,
          error: ""
        }
      }));
    } catch (error) {
      setDbState((prev) => ({
        ...prev,
        [tableName]: { ...nextState, loading: false, error: error.message }
      }));
    }
  };

  const loadEvents = async () => {
    setEventStatus((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const response = await fetch(`${baseUrl}/events`);
      const data = await response.json();
      setEvents(data.events || []);
      setEventStatus((prev) => ({ ...prev, loading: false }));
    } catch (error) {
      setEventStatus({ loading: false, error: error.message });
    }
  };

  const loadNumbers = async () => {
    try {
      const [fromResponse, toResponse] = await Promise.all([
        fetch(`${baseUrl}/numbers/from`),
        fetch(`${baseUrl}/numbers/to`)
      ]);
      const fromData = await fromResponse.json();
      const toData = await toResponse.json();
      setFromNumbers(fromData.numbers || []);
      setToNumbers(toData.numbers || []);
    } catch (error) {
      setStatus((prev) => ({ ...prev, error: error.message }));
    }
  };

  const loadConversations = async (ownerNumber, options = {}) => {
    const { silent = false } = options;
    if (!ownerNumber) {
      setConversations([]);
      return;
    }
    if (!silent) {
      setConversationStatus((prev) => ({ ...prev, loading: true, error: "" }));
    }
    try {
      const response = await fetch(
        `${baseUrl}/conversations?owner=${encodeURIComponent(ownerNumber)}`
      );
      const data = await response.json();
      setConversations(data.conversations || []);
      setConversationStatus((prev) => ({ ...prev, loading: false }));
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  const loadConversationMessages = async (ownerNumber, counterparty) => {
    if (!ownerNumber || !counterparty) {
      setConversationMessages([]);
      return;
    }
    try {
      const response = await fetch(
        `${baseUrl}/conversations/history?owner=${encodeURIComponent(
          ownerNumber
        )}&counterparty=${encodeURIComponent(counterparty)}`
      );
      const data = await response.json();
      setConversationMessages(data.messages || []);
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  const markConversationRead = async (ownerNumber, counterparty) => {
    if (!ownerNumber || !counterparty) {
      return;
    }
    try {
      await fetch(`${baseUrl}/conversations/mark-read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: ownerNumber, counterparty })
      });
      setConversations((prev) =>
        prev.map((item) =>
          item.counterparty === counterparty
            ? { ...item, unreadCount: 0 }
            : item
        )
      );
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  const updateConversation = async ({ counterparty, state, bookmarked }) => {
    if (!selectedOwner || !counterparty) {
      return;
    }
    try {
      await fetch(`${baseUrl}/conversations/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: selectedOwner,
          counterparty,
          state,
          bookmarked
        })
      });
      if (state && state !== "ACTIVE" && selectedConversation === counterparty) {
        setSelectedConversation("");
      }
      if (
        state === "ACTIVE" &&
        conversationView === "archived" &&
        selectedConversation === counterparty
      ) {
        setSelectedConversation("");
      }
      await loadConversations(selectedOwner);
      setConversationMenuId("");
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  const toggleSelectionMode = () => {
    setSelectionMode((prev) => !prev);
  };

  const toggleMessageSelection = (messageId) => {
    setSelectedMessageIds((prev) =>
      prev.includes(messageId)
        ? prev.filter((id) => id !== messageId)
        : [...prev, messageId]
    );
  };

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedMessageIds(visibleConversationMessages.map((msg) => msg.id));
    } else {
      setSelectedMessageIds([]);
    }
  };

  const bulkUpdateMessages = async ({ state, toggleTag }) => {
    if (selectedMessageIds.length === 0) {
      return;
    }

    try {
      await fetch(`${baseUrl}/messages/bulk-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedMessageIds, state, toggleTag })
      });
      setSelectedMessageIds([]);
      setSelectionMode(false);
      await Promise.all([
        loadConversationMessages(selectedOwner, selectedConversation),
        loadConversations(selectedOwner)
      ]);
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  const toggleFavoriteTag = async (messageId) => {
    try {
      await fetch(`${baseUrl}/messages/bulk-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [messageId], toggleTag: "Favorite" })
      });
      await loadConversationMessages(selectedOwner, selectedConversation);
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  const runMessageMenuAction = async (messageId, action) => {
    if (!messageId) {
      return;
    }

    if (action === "select") {
      if (!selectionMode) {
        setSelectionMode(true);
      }
      toggleMessageSelection(messageId);
      setMessageMenuId("");
      return;
    }

    const payload = { ids: [messageId] };
    if (action === "delete") {
      payload.state = "DELETED";
    } else if (action === "archive") {
      payload.state = "ARCHIVED";
    } else if (action === "bookmark") {
      payload.toggleTag = "Favorite";
    } else if (action === "tag") {
      payload.toggleTag = "Tagged";
    } else {
      return;
    }

    try {
      await fetch(`${baseUrl}/messages/bulk-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      await Promise.all([
        loadConversationMessages(selectedOwner, selectedConversation),
        loadConversations(selectedOwner, { silent: true })
      ]);
      setMessageMenuId("");
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  useEffect(() => {
    loadMessages();
    loadNumbers();
    loadEvents();
  }, [baseUrl]);

  useEffect(() => {
    if (activeView === "database") {
      loadDbTables();
    }
  }, [activeView]);

  useEffect(() => {
    if (!selectedOwner && fromNumbers.length > 0) {
      setSelectedOwner(fromNumbers[0].number);
    }
  }, [fromNumbers, selectedOwner]);

  useEffect(() => {
    if (!selectedOwner) {
      setConversations([]);
      return;
    }
    loadConversations(selectedOwner);
  }, [selectedOwner]);

  useEffect(() => {
    if (!selectedOwner || !selectedConversation) {
      setConversationMessages([]);
      return;
    }
    loadConversationMessages(selectedOwner, selectedConversation);
  }, [selectedOwner, selectedConversation]);

  useEffect(() => {
    const handleClick = (event) => {
      if (!event.target.closest(".conversation-menu")) {
        setConversationMenuId("");
      }
      if (!event.target.closest(".message-menu")) {
        setMessageMenuId("");
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  useEffect(() => {
    setSelectionMode(false);
    setSelectedMessageIds([]);
    setMessageMenuId("");
  }, [selectedOwner, selectedConversation]);

  useEffect(() => {
    if (!selectionMode) {
      setSelectedMessageIds([]);
    }
  }, [selectionMode]);

  useEffect(() => {
    setSelectedMessageIds([]);
  }, [messageFilter]);

  useEffect(() => {
    let disposed = false;
    let timerId;

    const pollRealtime = async () => {
      if (disposed) {
        return;
      }

      if (document.hidden) {
        timerId = setTimeout(pollRealtime, realtimePollMs);
        return;
      }

      try {
        if (activeView === "app") {
          await Promise.all([
            loadNumbers(),
            selectedOwner
              ? loadConversations(selectedOwner, { silent: true })
              : Promise.resolve(),
            selectedOwner && selectedConversation
              ? loadConversationMessages(selectedOwner, selectedConversation)
              : Promise.resolve()
          ]);
        } else if (activeView === "dev") {
          await Promise.all([
            loadMessages(),
            loadNumbers(),
            loadEvents(),
            selectedOwner
              ? loadConversations(selectedOwner, { silent: true })
              : Promise.resolve(),
            selectedOwner && selectedConversation
              ? loadConversationMessages(selectedOwner, selectedConversation)
              : Promise.resolve()
          ]);
        } else if (activeView === "database") {
          await loadDbTables();
          const openTables = Object.entries(dbState)
            .filter(([, value]) => value?.open)
            .map(([name]) => name);
          await Promise.all(openTables.map((name) => fetchTableRows(name)));
        }
      } catch {
      } finally {
        if (!disposed) {
          timerId = setTimeout(pollRealtime, realtimePollMs);
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        return;
      }
      if (timerId) {
        clearTimeout(timerId);
      }
      pollRealtime();
    };

    timerId = setTimeout(pollRealtime, realtimePollMs);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      if (timerId) {
        clearTimeout(timerId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeView,
    baseUrl,
    dbState,
    realtimePollMs,
    selectedConversation,
    selectedOwner
  ]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    if (name === "from" || name === "to") {
      setForm((prev) => {
        const sanitized = sanitizeE164(value);
        if (sanitized.startsWith("+")) {
          const code = findCallingCode(sanitized);
          if (code) {
            try {
              const status = validatePhoneNumberLength(sanitized);
              if (status === "TOO_LONG" && sanitized.length > prev[name].length) {
                return prev;
              }
            } catch (error) {
              return { ...prev, [name]: sanitized };
            }
          }
        }
        return { ...prev, [name]: sanitized };
      });
      return;
    }
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSwap = () => {
    setForm((prev) => ({
      ...prev,
      from: prev.to,
      to: prev.from
    }));
  };

  const fromMeta = useMemo(() => analyzeNumber(form.from), [form.from]);
  const toMeta = useMemo(() => analyzeNumber(form.to), [form.to]);
  const inboundGroups = useMemo(() => {
    const grouped = new Map();
    messages
      .filter((message) => message.direction === "inbound")
      .forEach((message) => {
        const destination = message.to || "Unknown";
        const sender = message.from || "Unknown";
        if (!grouped.has(destination)) {
          grouped.set(destination, new Map());
        }
        const senderMap = grouped.get(destination);
        if (!senderMap.has(sender)) {
          senderMap.set(sender, []);
        }
        senderMap.get(sender).push(message);
      });

    return Array.from(grouped.entries()).map(([destination, senderMap]) => ({
      destination,
      senders: Array.from(senderMap.entries()).map(([sender, items]) => ({
        sender,
        items
      }))
    }));
  }, [messages]);

  const sortedConversationMessages = useMemo(() => {
    const toTime = (message) =>
      new Date(message?.occurredAt || message?.createdAt || 0).getTime();
    const mergeWindowMs = 120000;

    const sorted = [...conversationMessages].sort((a, b) => toTime(a) - toTime(b));
    const byTelnyxId = new Map();
    const fallbackBuckets = new Map();

    for (const message of sorted) {
      const messageTime = toTime(message);

      if (message.telnyxMessageId) {
        const key = `telnyx:${message.telnyxMessageId}`;
        const existing = byTelnyxId.get(key);
        if (!existing || messageTime >= toTime(existing)) {
          byTelnyxId.set(key, message);
        }
        continue;
      }

      const signature = `fallback:${message.direction}|${message.from}|${message.to}|${
        message.text || ""
      }`;
      const bucket = fallbackBuckets.get(signature) || [];
      let merged = false;

      for (let index = 0; index < bucket.length; index += 1) {
        const candidate = bucket[index];
        if (Math.abs(toTime(candidate) - messageTime) <= mergeWindowMs) {
          if (messageTime >= toTime(candidate)) {
            bucket[index] = message;
          }
          merged = true;
          break;
        }
      }

      if (!merged) {
        bucket.push(message);
      }
      fallbackBuckets.set(signature, bucket);
    }

    const mergedFallback = Array.from(fallbackBuckets.values()).flat();
    const combined = [...byTelnyxId.values(), ...mergedFallback];

    const seenRow = new Set();
    const deduped = [];
    for (const message of combined) {
      const rowKey = message.id || `${message.telnyxMessageId || ""}|${toTime(message)}`;
      if (seenRow.has(rowKey)) {
        continue;
      }
      seenRow.add(rowKey);
      deduped.push(message);
    }

    return deduped.sort((a, b) => {
      const firstTime = new Date(a.occurredAt || a.createdAt || 0).getTime();
      const secondTime = new Date(b.occurredAt || b.createdAt || 0).getTime();
      return firstTime - secondTime;
    });
  }, [conversationMessages]);

  const visibleConversationMessages = useMemo(() => {
    if (messageFilter === "all") {
      return sortedConversationMessages;
    }

    return sortedConversationMessages.filter((message) => {
      const state = message.state || (message.readAt ? "READ" : "UNREAD");
      const tags = Array.isArray(message.tags) ? message.tags : [];
      if (messageFilter === "active") {
        return state !== "ARCHIVED" && state !== "DELETED";
      }
      if (messageFilter === "bookmarked") {
        return tags.includes("Favorite");
      }
      if (messageFilter === "archived") {
        return state === "ARCHIVED";
      }
      if (messageFilter === "deleted") {
        return state === "DELETED";
      }
      return true;
    });
  }, [sortedConversationMessages, messageFilter]);

  useEffect(() => {
    setSelectedMessageIds((prev) =>
      prev.filter((id) => visibleConversationMessages.some((msg) => msg.id === id))
    );
  }, [visibleConversationMessages]);

  useEffect(() => {
    if (!threadBodyRef.current || !selectedOwner || !selectedConversation) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }
          const messageId = entry.target.getAttribute("data-message-id");
          const readable = entry.target.getAttribute("data-readable") === "true";
          if (!messageId || !readable) {
            return;
          }
          pendingReadIdsRef.current.add(messageId);
          if (readFlushRef.current) {
            clearTimeout(readFlushRef.current);
          }
          readFlushRef.current = setTimeout(() => {
            flushReadMessages();
          }, 300);
        });
      },
      {
        root: threadBodyRef.current,
        threshold: 0.6
      }
    );

    const items = threadBodyRef.current.querySelectorAll("[data-message-id]");
    items.forEach((item) => observer.observe(item));

    return () => {
      if (readFlushRef.current) {
        clearTimeout(readFlushRef.current);
      }
      observer.disconnect();
    };
  }, [visibleConversationMessages, selectedOwner, selectedConversation]);

  useEffect(() => {
    if (!threadBodyRef.current) {
      return;
    }
    threadBodyRef.current.scrollTop = threadBodyRef.current.scrollHeight;
  }, [sortedConversationMessages, selectedConversation]);

  const activityRows = useMemo(() => {
    if (events.length === 0) {
      return [];
    }

    const chronological = [...events].sort((a, b) => {
      const firstTime = new Date(a.occurredAt || a.createdAt || 0).getTime();
      const secondTime = new Date(b.occurredAt || b.createdAt || 0).getTime();
      return firstTime - secondTime;
    });

    const lastStatusByMessage = new Map();
    const statusChangeByEvent = new Map();

    for (const event of chronological) {
      const key = event.telnyxMessageId || event.message?.id || event.id;
      const previousStatus = lastStatusByMessage.get(key);
      const currentStatus = event.status || null;

      if (currentStatus && previousStatus && currentStatus !== previousStatus) {
        statusChangeByEvent.set(event.id, true);
      }

      if (currentStatus) {
        lastStatusByMessage.set(key, currentStatus);
      }
    }

    return events.map((event) => ({
      ...event,
      statusChanged: statusChangeByEvent.get(event.id) || false
    }));
  }, [events]);

  const visibleConversations = useMemo(() => {
    return conversations.filter((item) => {
      const state = item.state || "ACTIVE";
      return state !== "ARCHIVED" && state !== "DELETED";
    });
  }, [conversations]);

  const archivedConversations = useMemo(() => {
    return conversations.filter((item) => (item.state || "ACTIVE") === "ARCHIVED");
  }, [conversations]);

  const sortedConversations = useMemo(() => {
    return [...visibleConversations].sort((a, b) => {
      const aBookmarked = Boolean(a.bookmarked);
      const bBookmarked = Boolean(b.bookmarked);
      if (aBookmarked && !bBookmarked) {
        return -1;
      }
      if (!aBookmarked && bBookmarked) {
        return 1;
      }
      const aTime = new Date(a.lastMessageAt || 0).getTime();
      const bTime = new Date(b.lastMessageAt || 0).getTime();
      return bTime - aTime;
    });
  }, [visibleConversations]);

  const sortedArchivedConversations = useMemo(() => {
    return [...archivedConversations].sort((a, b) => {
      const aTime = new Date(a.lastMessageAt || 0).getTime();
      const bTime = new Date(b.lastMessageAt || 0).getTime();
      return bTime - aTime;
    });
  }, [archivedConversations]);

  const sortedBookmarkedConversations = useMemo(() => {
    return sortedConversations.filter((item) => Boolean(item.bookmarked));
  }, [sortedConversations]);

  const isArchiveView = conversationView === "archived";
  const isBookmarkedView = conversationView === "bookmarked";
  const canShowArchiveButton =
    sortedConversations.length > 0 || sortedArchivedConversations.length > 0;
  const canShowBookmarkedButton =
    sortedConversations.length > 0 ||
    sortedBookmarkedConversations.length > 0 ||
    isBookmarkedView;
  const displayedConversations = isArchiveView
    ? sortedArchivedConversations
    : isBookmarkedView
      ? sortedBookmarkedConversations
      : sortedConversations;

  useEffect(() => {
    if (conversationView !== "archived") {
      return;
    }
    if (sortedArchivedConversations.length === 0 && sortedConversations.length > 0) {
      setConversationView("recent");
      setSelectedConversation("");
    }
  }, [conversationView, sortedArchivedConversations, sortedConversations]);

  useEffect(() => {
    if (conversationView !== "bookmarked") {
      return;
    }
    if (sortedBookmarkedConversations.length === 0 && sortedConversations.length > 0) {
      setSelectedConversation("");
    }
  }, [conversationView, sortedBookmarkedConversations, sortedConversations]);

  useEffect(() => {
    if (conversationView === "bookmarked") {
      if (messageFilter !== "bookmarked") {
        setMessageFilter("bookmarked");
      }
      return;
    }
    if (messageFilter === "bookmarked") {
      setMessageFilter("active");
    }
  }, [conversationView, messageFilter]);

  const selectedCount = selectedMessageIds.length;
  const isAllSelected =
    selectionMode &&
    visibleConversationMessages.length > 0 &&
    selectedCount === visibleConversationMessages.length;

  const formatTimestamp = (value) => {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  const formatCellValue = (value, fieldType) => {
    if (value === null || value === undefined || value === "") {
      return "—";
    }
    if (fieldType === "datetime") {
      return formatTimestamp(value);
    }
    if (fieldType === "json") {
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    }
    return String(value);
  };

  const getTableMeta = (name) => dbTables.find((table) => table.name === name);

  const getTableState = (name) => {
    const meta = getTableMeta(name);
    const fallback = {
      open: false,
      rows: [],
      count: 0,
      loading: false,
      error: "",
      search: "",
      sortBy: meta?.defaultSort || "createdAt",
      sortDir: "desc",
      filters: {},
      selected: {}
    };
    return dbState[name] || fallback;
  };

  const toggleTableOpen = (name) => {
    const tableState = getTableState(name);
    const shouldOpen = !tableState.open;
    setDbState((prev) => ({
      ...prev,
      [name]: { ...tableState, open: shouldOpen }
    }));
    if (shouldOpen && tableState.rows.length === 0) {
      fetchTableRows(name, { open: true });
    }
  };

  const updateTableSearch = (name, value) => {
    fetchTableRows(name, { search: value });
  };

  const updateTableFilter = (name, field, value) => {
    const tableState = getTableState(name);
    const filters = { ...tableState.filters, [field]: value };
    fetchTableRows(name, { filters });
  };

  const updateTableSort = (name, field) => {
    const tableState = getTableState(name);
    const isSameField = tableState.sortBy === field;
    const sortDir = isSameField && tableState.sortDir === "asc" ? "desc" : "asc";
    fetchTableRows(name, { sortBy: field, sortDir });
  };

  const toggleRowSelection = (name, rowId) => {
    const tableState = getTableState(name);
    const nextSelected = { ...tableState.selected };
    if (nextSelected[rowId]) {
      delete nextSelected[rowId];
    } else {
      nextSelected[rowId] = true;
    }
    setDbState((prev) => ({
      ...prev,
      [name]: { ...tableState, selected: nextSelected }
    }));
  };

  const toggleSelectAllRows = (name, rows) => {
    const tableState = getTableState(name);
    const allSelected = rows.length > 0 && rows.every((row) => tableState.selected[row.id]);
    const nextSelected = {};
    if (!allSelected) {
      rows.forEach((row) => {
        nextSelected[row.id] = true;
      });
    }
    setDbState((prev) => ({
      ...prev,
      [name]: { ...tableState, selected: nextSelected }
    }));
  };

  const deleteSelectedRows = async (name) => {
    const tableState = getTableState(name);
    const selectedIds = Object.keys(tableState.selected || {});
    if (selectedIds.length === 0) {
      return;
    }
    const confirmed = window.confirm(
      `Delete ${selectedIds.length} record(s) from ${name}?`
    );
    if (!confirmed) {
      return;
    }
    try {
      await fetch(`${baseUrl}/db/table/${encodeURIComponent(name)}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds })
      });
      await fetchTableRows(name);
    } catch (error) {
      setDbState((prev) => ({
        ...prev,
        [name]: { ...tableState, error: error.message }
      }));
    }
  };

  const clearTableRows = async (name) => {
    const tableState = getTableState(name);
    const confirmed = window.confirm(`Clear all records from ${name}?`);
    if (!confirmed) {
      return;
    }
    try {
      await fetch(`${baseUrl}/db/table/${encodeURIComponent(name)}/clear`, {
        method: "POST"
      });
      await fetchTableRows(name);
    } catch (error) {
      setDbState((prev) => ({
        ...prev,
        [name]: { ...tableState, error: error.message }
      }));
    }
  };

  const handleSend = async (event) => {
    event.preventDefault();
    setStatus({ loading: true, error: "", success: "" });

    try {
      const response = await fetch(`${baseUrl}/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });

      if (!response.ok) {
        const errorBody = await response.json();
        throw new Error(errorBody?.message || errorBody?.error || "Failed to send");
      }

      setForm({ from: form.from, to: form.to, text: "" });
      setStatus({ loading: false, error: "", success: "Message sent" });
      await loadMessages();
      await loadNumbers();
    } catch (error) {
      setStatus({ loading: false, error: error.message, success: "" });
    }
  };

  const handleRefresh = async () => {
    await Promise.all([
      loadMessages(),
      loadNumbers(),
      loadEvents(),
      selectedOwner ? loadConversations(selectedOwner) : Promise.resolve()
    ]);
  };

  const handleConversationSend = async (event) => {
    event.preventDefault();
    if (!conversationDraft.trim() || !selectedOwner || !selectedConversation) {
      return;
    }

    try {
      const response = await fetch(`${baseUrl}/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: selectedOwner,
          to: selectedConversation,
          text: conversationDraft.trim()
        })
      });

      if (!response.ok) {
        const errorBody = await response.json();
        throw new Error(errorBody?.message || errorBody?.error || "Failed to send");
      }

      setConversationDraft("");
      await Promise.all([
        loadConversationMessages(selectedOwner, selectedConversation),
        loadConversations(selectedOwner),
        loadMessages(),
        loadEvents(),
        loadNumbers()
      ]);
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  const refreshDatabase = async () => {
    await loadDbTables();
    const openTables = Object.entries(dbState)
      .filter(([, value]) => value?.open)
      .map(([name]) => name);
    await Promise.all(openTables.map((name) => fetchTableRows(name)));
  };

  const handleHome = () => {
    setActiveView("app");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="app">
      <nav className="top-nav">
        <div className="nav-brand">
          <span className="eyebrow">SIP Texting</span>
          <h2>Messaging Suite</h2>
        </div>
        <div className="nav-actions">
          <button type="button" className="nav-button" onClick={handleHome}>
            Home
          </button>
          <button
            type="button"
            className={`nav-button ${activeView === "app" ? "active" : ""}`}
            onClick={() => setActiveView("app")}
          >
            App
          </button>
          <div className="nav-dropdown">
            <button type="button" className="nav-button">
              Admin
            </button>
            <div className="nav-menu">
              <button
                type="button"
                className="nav-menu-item"
                onClick={() => setActiveView("database")}
              >
                Database Tables
              </button>
              <button
                type="button"
                className="nav-menu-item"
                onClick={() => setActiveView("dev")}
              >
                Dev Consoles
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="top-area">
        {activeView === "app" ? (
          <section className="conversation-board">
            <div className="conversation-head">
              <div className="conversation-head-main">
                <p className="eyebrow">Production console</p>
                <div className="conversation-title-row">
                  <h2>Conversation Overview</h2>
                  <div className="owner-row owner-row-inline">
                    {fromNumbers.length === 0 ? (
                      <p className="muted owner-row-empty">No owned numbers yet.</p>
                    ) : (
                      fromNumbers.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`owner-chip ${
                            selectedOwner === item.number ? "active" : ""
                          }`}
                          onClick={() => {
                            setSelectedOwner(item.number);
                            setSelectedConversation("");
                          }}
                        >
                          {item.number}
                        </button>
                      ))
                    )}
                  </div>
                  {selectedConversation ? (
                    <div className="message-view conversation-message-view">
                      <p className="message-view-label">Message View</p>
                      <div className="message-view-options">
                        <button
                          type="button"
                          className={`owner-chip action-chip filter-chip ${
                            messageFilter === "all" ? "active" : ""
                          }`}
                          onClick={() => setMessageFilter("all")}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          className={`owner-chip action-chip filter-chip ${
                            messageFilter === "active" ? "active" : ""
                          }`}
                          onClick={() => setMessageFilter("active")}
                        >
                          <span className="filter-icon active" aria-hidden="true">
                            <svg viewBox="0 0 24 24" role="img" focusable="false">
                              <path
                                d="M12 4a8 8 0 108 8 8 8 0 00-8-8zm0 4a4 4 0 11-4 4 4 4 0 014-4z"
                                fill="currentColor"
                              />
                            </svg>
                          </span>
                          Active
                        </button>
                        <button
                          type="button"
                          className={`owner-chip action-chip filter-chip ${
                            messageFilter === "archived" ? "active" : ""
                          }`}
                          onClick={() => setMessageFilter("archived")}
                        >
                          <span className="filter-icon archive" aria-hidden="true">
                            <svg viewBox="0 0 24 24" role="img" focusable="false">
                              <path
                                d="M4 3h16a1 1 0 011 1v4a1 1 0 01-1 1h-1v11a1 1 0 01-1 1H6a1 1 0 01-1-1V9H4a1 1 0 01-1-1V4a1 1 0 011-1zm2 6v10h12V9H6zm1-4v2h10V5H7zm2 5h6v2H9v-2z"
                                fill="currentColor"
                              />
                            </svg>
                          </span>
                          Archived
                        </button>
                        <button
                          type="button"
                          className={`owner-chip action-chip filter-chip ${
                            messageFilter === "deleted" ? "active" : ""
                          }`}
                          onClick={() => setMessageFilter("deleted")}
                        >
                          <span className="filter-icon delete" aria-hidden="true">
                            <svg
                              viewBox="0 0 24 24"
                              role="img"
                              focusable="false"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M3 6h18" />
                              <path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" />
                              <path d="M6 6l1 14a1 1 0 001 1h8a1 1 0 001-1l1-14" />
                              <path d="M10 11v6" />
                              <path d="M14 11v6" />
                            </svg>
                          </span>
                          Deleted
                        </button>
                        <button
                          type="button"
                          className={`owner-chip action-chip filter-chip ${
                            messageFilter === "bookmarked" ? "active" : ""
                          }`}
                          onClick={() => setMessageFilter("bookmarked")}
                        >
                          <span className="filter-icon bookmark" aria-hidden="true">
                            <svg viewBox="0 0 24 24" role="img" focusable="false">
                              <path
                                d="M7 3h10a1 1 0 011 1v17l-6-3-6 3V4a1 1 0 011-1z"
                                fill="currentColor"
                              />
                            </svg>
                          </span>
                          Bookmarked
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="conversation-panel">
              <div className="conversation-list">
                <div className="list-header">
                  <div className="list-title-wrap">
                    <h3>
                      {isArchiveView
                        ? "Archived conversations"
                        : isBookmarkedView
                          ? "Bookmarked items"
                        : "Recent conversations"}
                    </h3>
                    {canShowBookmarkedButton ? (
                      <button
                        type="button"
                        className={`bookmark-toggle ${isBookmarkedView ? "active" : ""}`}
                        title="Open Bookmarked Items"
                        aria-label="Open Bookmarked Items"
                        onClick={() => {
                          setConversationView((prev) => {
                            const nextView =
                              prev === "bookmarked" ? "recent" : "bookmarked";
                            setMessageFilter(
                              nextView === "bookmarked" ? "bookmarked" : "active"
                            );
                            return nextView;
                          });
                          setSelectedConversation("");
                          setConversationMenuId("");
                        }}
                      >
                        <svg
                          className="bookmark-toggle-icon"
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          width="26"
                          height="26"
                          aria-hidden="true"
                        >
                          <path
                            d="M7 3h10a1 1 0 011 1v17l-6-3-6 3V4a1 1 0 011-1z"
                            fill="currentColor"
                          />
                        </svg>
                      </button>
                    ) : null}
                    {canShowArchiveButton ? (
                      <button
                        type="button"
                        className={`archive-toggle ${isArchiveView ? "active" : ""}`}
                        title="Open Archive"
                        aria-label="Open Archive"
                        onClick={() => {
                          setConversationView((prev) =>
                            prev === "archived" ? "recent" : "archived"
                          );
                          setSelectedConversation("");
                          setConversationMenuId("");
                        }}
                      >
                        <svg
                          className="archive-toggle-icon"
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          width="26"
                          height="26"
                          fill="none"
                          stroke="#cbd5f5"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M4 7h16" />
                          <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
                          <path d="M9 11h6" />
                          <path d="M12 11v6" />
                          <path d="M10 15l2 2 2-2" />
                        </svg>
                        {sortedArchivedConversations.length > 0 ? (
                          <span className="archive-count-badge">
                            {sortedArchivedConversations.length}
                          </span>
                        ) : null}
                      </button>
                    ) : null}
                  </div>
                  <span className="badge">{displayedConversations.length} threads</span>
                </div>
                {conversationStatus.loading ? (
                  <p className="muted">Loading conversations...</p>
                ) : displayedConversations.length === 0 ? (
                  <p className="muted">
                    {isArchiveView
                      ? "No archived conversations yet."
                      : isBookmarkedView
                        ? "No bookmarked items yet."
                        : "No conversations yet."}
                  </p>
                ) : (
                  displayedConversations.map((item) => {
                    const isActive = selectedConversation === item.counterparty;
                    const isUnread = item.unreadCount > 0;
                    const isBookmarked = Boolean(item.bookmarked);
                    const menuOpen =
                      conversationMenuId === `${item.ownerNumber}::${item.counterparty}`;
                    return (
                      <div
                        key={`${item.ownerNumber}-${item.counterparty}`}
                        role="button"
                        tabIndex={0}
                        className={`conversation-item ${
                          isActive ? "active" : ""
                        } ${isUnread ? "unread" : ""}`}
                        onClick={() => {
                          setSelectedConversation(item.counterparty);
                          setConversationMenuId("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedConversation(item.counterparty);
                            setConversationMenuId("");
                          }
                        }}
                      >
                        <div className="conversation-title">
                          <div className="conversation-title-main">
                            {isBookmarked ? (
                              <span
                                className="bookmark-indicator"
                                aria-label="Favorite conversation"
                              >
                                <svg viewBox="0 0 24 24" role="img" focusable="false">
                                  <path
                                    d="M12 3.4l2.6 5.4 6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.7l6-.9L12 3.4z"
                                    fill="currentColor"
                                  />
                                </svg>
                              </span>
                            ) : null}
                            <span>{item.counterparty}</span>
                          </div>
                          <div className="conversation-title-actions">
                            <span className="conversation-time">
                              {formatTimestamp(item.lastMessageAt)}
                            </span>
                            <div className="conversation-menu">
                              <button
                                type="button"
                                className="menu-trigger"
                                aria-label="Conversation actions"
                                aria-expanded={menuOpen}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const nextId = `${item.ownerNumber}::${item.counterparty}`;
                                  setConversationMenuId((prev) =>
                                    prev === nextId ? "" : nextId
                                  );
                                }}
                              >
                                ...
                              </button>
                              {menuOpen ? (
                                <div
                                  className="menu-panel"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {!isArchiveView ? (
                                    <button
                                      type="button"
                                      className="menu-item"
                                      onClick={() =>
                                        updateConversation({
                                          counterparty: item.counterparty,
                                          bookmarked: !isBookmarked
                                        })
                                      }
                                    >
                                      <span className="menu-icon bookmark">
                                        <svg
                                          viewBox="0 0 24 24"
                                          role="img"
                                          focusable="false"
                                        >
                                          <path
                                            d="M12 3.4l2.6 5.4 6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.7l6-.9L12 3.4z"
                                            fill="currentColor"
                                          />
                                        </svg>
                                      </span>
                                      {isBookmarked
                                        ? "Remove from Favorites"
                                        : "Add to Favorites"}
                                    </button>
                                  ) : null}
                                  {isArchiveView ? (
                                    <button
                                      type="button"
                                      className="menu-item"
                                      onClick={() =>
                                        updateConversation({
                                          counterparty: item.counterparty,
                                          state: "ACTIVE"
                                        })
                                      }
                                    >
                                      <span className="menu-icon restore">
                                        <svg
                                          viewBox="0 0 24 24"
                                          role="img"
                                          focusable="false"
                                        >
                                          <path
                                            d="M12 4a8 8 0 016.9 4h-2.4l3.2 3.2L23 8h-2a10 10 0 00-17.2-2.6l1.4 1.4A8 8 0 0112 4zm8.2 11.6l-1.4-1.4A8 8 0 015 16h2.4L4.2 12.8 1 16h2a10 10 0 0017.2 2.6z"
                                            fill="currentColor"
                                          />
                                        </svg>
                                      </span>
                                      Restore to Active Messages
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="menu-item"
                                      onClick={() =>
                                        updateConversation({
                                          counterparty: item.counterparty,
                                          state: "ARCHIVED"
                                        })
                                      }
                                    >
                                      <span className="menu-icon archive">
                                        <svg
                                          viewBox="0 0 24 24"
                                          role="img"
                                          focusable="false"
                                        >
                                          <path
                                            d="M4 3h16a1 1 0 011 1v4a1 1 0 01-1 1h-1v11a1 1 0 01-1 1H6a1 1 0 01-1-1V9H4a1 1 0 01-1-1V4a1 1 0 011-1zm2 6v10h12V9H6zm1-4v2h10V5H7zm2 5h6v2H9v-2z"
                                            fill="currentColor"
                                          />
                                        </svg>
                                      </span>
                                      Archive
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="menu-item danger"
                                    onClick={() =>
                                      updateConversation({
                                        counterparty: item.counterparty,
                                        state: "DELETED"
                                      })
                                    }
                                  >
                                    <span className="menu-icon delete">
                                      <svg
                                        viewBox="0 0 24 24"
                                        role="img"
                                        focusable="false"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      >
                                        <path d="M3 6h18" />
                                        <path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" />
                                        <path d="M6 6l1 14a1 1 0 001 1h8a1 1 0 001-1l1-14" />
                                        <path d="M10 11v6" />
                                        <path d="M14 11v6" />
                                      </svg>
                                    </span>
                                    Delete Conversation
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <div className="conversation-preview">
                          <span>{item.lastMessageText || "(no text)"}</span>
                          {isUnread ? <span className="unread-dot" /> : null}
                        </div>
                      </div>
                    );
                  })
                )}
                {conversationStatus.error ? (
                  <p className="error">{conversationStatus.error}</p>
                ) : null}
              </div>

              <div className="conversation-thread">
                {selectedConversation ? (
                  <>
                    <div className="thread-header">
                      <div>
                        <p className="eyebrow">Conversation</p>
                        <h3>{selectedConversation}</h3>
                      </div>
                      <div className="thread-header-right">
                        <span className="badge">
                          {visibleConversationMessages.length} messages
                        </span>
                      </div>
                    </div>
                    <div className="thread-toolbar">
                      <div className="thread-toolbar-left">
                        <button
                          type="button"
                          className={`owner-chip action-chip ${
                            selectionMode ? "active" : ""
                          }`}
                          onClick={toggleSelectionMode}
                        >
                          Select Messages
                        </button>
                        {selectionMode ? (
                          <label className="select-all">
                            <input
                              type="checkbox"
                              checked={isAllSelected}
                              onChange={(event) =>
                                handleSelectAll(event.target.checked)
                              }
                            />
                            Select all
                          </label>
                        ) : null}
                      </div>
                      {selectionMode && selectedCount > 0 ? (
                        <div className="selection-actions">
                          {messageFilter === "deleted" ? (
                            <button
                              type="button"
                              className="owner-chip action-chip"
                              onClick={() => bulkUpdateMessages({ state: "UNREAD" })}
                            >
                              Undelete
                            </button>
                          ) : null}
                          <div className="selection-actions-row">
                            <button
                              type="button"
                              className="owner-chip action-chip"
                              onClick={() => bulkUpdateMessages({ state: "ARCHIVED" })}
                            >
                              Archive
                            </button>
                            <button
                              type="button"
                              className="owner-chip action-chip"
                              onClick={() => bulkUpdateMessages({ state: "DELETED" })}
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              className="owner-chip action-chip"
                              onClick={() =>
                                bulkUpdateMessages({ toggleTag: "Favorite" })
                              }
                            >
                              Tag Favorite
                            </button>
                            <span className="toolbar-count">
                              {selectedCount} selected
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="thread-body" ref={threadBodyRef}>
                      {visibleConversationMessages.length === 0 ? (
                        <p className="muted">
                          No messages in this conversation yet.
                        </p>
                      ) : (
                        visibleConversationMessages.map((message) => {
                          const directionClass =
                            message.direction === "inbound" ? "inbound" : "outbound";
                          const messageState =
                            message.state || (message.readAt ? "READ" : "UNREAD");
                          const tags = Array.isArray(message.tags) ? message.tags : [];
                          const isFavorite = tags.includes("Favorite");
                          const isSelected = selectedMessageIds.includes(message.id);
                          const messageMenuOpen = messageMenuId === message.id;
                          const isReadable =
                            message.direction === "inbound" &&
                            message.to === selectedOwner &&
                            messageState === "UNREAD";
                          return (
                            <div
                              key={message.id}
                              className={`chat-row ${directionClass} state-${messageState.toLowerCase()} ${
                                selectionMode ? "selectable" : ""
                              } ${isSelected ? "selected" : ""}`}
                              data-message-id={message.id}
                              data-readable={isReadable}
                              onClick={() => {
                                if (selectionMode) {
                                  toggleMessageSelection(message.id);
                                }
                              }}
                            >
                              {selectionMode ? (
                                <label
                                  className="message-select"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleMessageSelection(message.id)}
                                  />
                                </label>
                              ) : null}
                              <div className={`chat-bubble ${directionClass}`}>
                                <div className="message-menu">
                                  <button
                                    type="button"
                                    className="message-menu-trigger"
                                    aria-label="Message actions"
                                    aria-expanded={messageMenuOpen}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setMessageMenuId((prev) =>
                                        prev === message.id ? "" : message.id
                                      );
                                    }}
                                  >
                                    ...
                                  </button>
                                  {messageMenuOpen ? (
                                    <div
                                      className="message-menu-panel"
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      <button
                                        type="button"
                                        className="message-menu-action select"
                                        data-label="Select"
                                        aria-label="Select"
                                        onClick={() =>
                                          runMessageMenuAction(message.id, "select")
                                        }
                                      >
                                        <svg viewBox="0 0 24 24" role="img" focusable="false">
                                          <path
                                            d="M9 12l2 2 4-4"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                          />
                                          <circle
                                            cx="12"
                                            cy="12"
                                            r="9"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.8"
                                          />
                                        </svg>
                                      </button>
                                      <button
                                        type="button"
                                        className="message-menu-action delete"
                                        data-label="Delete"
                                        aria-label="Delete"
                                        onClick={() =>
                                          runMessageMenuAction(message.id, "delete")
                                        }
                                      >
                                        <svg
                                          viewBox="0 0 24 24"
                                          role="img"
                                          focusable="false"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                        >
                                          <path d="M3 6h18" />
                                          <path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" />
                                          <path d="M6 6l1 14a1 1 0 001 1h8a1 1 0 001-1l1-14" />
                                          <path d="M10 11v6" />
                                          <path d="M14 11v6" />
                                        </svg>
                                      </button>
                                      <button
                                        type="button"
                                        className="message-menu-action bookmark"
                                        data-label="Bookmark"
                                        aria-label="Bookmark"
                                        onClick={() =>
                                          runMessageMenuAction(message.id, "bookmark")
                                        }
                                      >
                                        <svg viewBox="0 0 24 24" role="img" focusable="false">
                                          <path
                                            d="M7 3h10a1 1 0 011 1v17l-6-3-6 3V4a1 1 0 011-1z"
                                            fill="currentColor"
                                          />
                                        </svg>
                                      </button>
                                      <button
                                        type="button"
                                        className="message-menu-action archive"
                                        data-label="Archive"
                                        aria-label="Archive"
                                        onClick={() =>
                                          runMessageMenuAction(message.id, "archive")
                                        }
                                      >
                                        <svg viewBox="0 0 24 24" role="img" focusable="false">
                                          <path
                                            d="M4 3h16a1 1 0 011 1v4a1 1 0 01-1 1h-1v11a1 1 0 01-1 1H6a1 1 0 01-1-1V9H4a1 1 0 01-1-1V4a1 1 0 011-1zm2 6v10h12V9H6zm1-4v2h10V5H7zm2 5h6v2H9v-2z"
                                            fill="currentColor"
                                          />
                                        </svg>
                                      </button>
                                      <button
                                        type="button"
                                        className="message-menu-action tag"
                                        data-label="Tag"
                                        aria-label="Tag"
                                        onClick={() => runMessageMenuAction(message.id, "tag")}
                                      >
                                        <svg viewBox="0 0 24 24" role="img" focusable="false">
                                          <path
                                            d="M3 12l9-9h7a2 2 0 012 2v7l-9 9-9-9zM16 8a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"
                                            fill="currentColor"
                                          />
                                        </svg>
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                                <p className="chat-text">
                                  {message.text || "(no text)"}
                                </p>
                                <div className="chat-meta-row">
                                  <p className="chat-meta">
                                    {formatTimestamp(
                                      message.occurredAt || message.createdAt
                                    )}
                                  </p>
                                  {isFavorite ? (
                                    <button
                                      type="button"
                                      className="tag-bookmark active"
                                      aria-label="Remove Favorite tag"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        toggleFavoriteTag(message.id);
                                      }}
                                    >
                                      <svg
                                        viewBox="0 0 24 24"
                                        role="img"
                                        focusable="false"
                                      >
                                        <path
                                          d="M7 3h10a1 1 0 011 1v17l-6-3-6 3V4a1 1 0 011-1z"
                                          fill="currentColor"
                                        />
                                      </svg>
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    <form className="thread-composer" onSubmit={handleConversationSend}>
                      <input
                        type="text"
                        placeholder="Type your message"
                        value={conversationDraft}
                        onChange={(event) => setConversationDraft(event.target.value)}
                      />
                      <button
                        type="submit"
                        className="thread-send"
                        aria-label="Send message"
                        disabled={!conversationDraft.trim()}
                      >
                        <svg viewBox="0 0 24 24" role="img" focusable="false">
                          <path
                            d="M3.4 20.6l17-8.1c.8-.4.8-1.6 0-2L3.4 2.5c-.9-.4-1.9.4-1.6 1.4L3.9 10l7.6 2-7.6 2-2.1 6.1c-.3 1 .7 1.8 1.6 1.5z"
                            fill="currentColor"
                          />
                        </svg>
                      </button>
                    </form>
                  </>
                ) : (
                  <div className="thread-empty">
                    <p className="muted">
                      Select a conversation to view the full message history.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}
      </div>

      {activeView === "dev" ? <div className="section-divider" /> : null}

      {activeView === "dev" ? (
        <section className="dev-container">
          <div className="dev-header">
            <p className="eyebrow">Development console</p>
            <h2>Testing workspace</h2>
          </div>
          <section className="grid">
        <div className="stack">
          <form className="card send-card" onSubmit={handleSend}>
            <h2>Send a message</h2>
            <label>
              From
              <select
                className="phone-select"
                value={form.from}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    from: sanitizeE164(event.target.value)
                  }))
                }
              >
                <option value="">Select recent number</option>
                {fromNumbers.map((item) => (
                  <option key={item.id} value={item.number}>
                    {item.number}
                  </option>
                ))}
              </select>
              <div className="phone-input">
                <span
                  className={`code-pill ${
                    form.from
                      ? fromMeta.isCodeValid
                        ? "valid"
                        : "invalid"
                      : ""
                  }`}
                >
                  {fromMeta.code ? `+${fromMeta.code}` : "+"}
                </span>
                <input
                  className="phone-field"
                  name="from"
                  value={form.from}
                  onChange={handleChange}
                  placeholder="+13125551212"
                />
              </div>
              <p
                className={`helper ${
                  fromMeta.isPossible ? "valid" : "invalid"
                }`}
              >
                {getLengthMessage(fromMeta)}
              </p>
            </label>
            <div className="swap-row">
              <button type="button" className="swap-button" onClick={handleSwap}>
                <span className="swap-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <path
                      d="M12 3l4 4h-3v6h-2V7H8l4-4zm0 18l-4-4h3V11h2v6h3l-4 4z"
                      fill="currentColor"
                    />
                  </svg>
                </span>
                Swap
              </button>
            </div>
            <label>
              To
              <select
                className="phone-select"
                value={form.to}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    to: sanitizeE164(event.target.value)
                  }))
                }
              >
                <option value="">Select recent number</option>
                {toNumbers.map((item) => (
                  <option key={item.id} value={item.number}>
                    {item.number}
                  </option>
                ))}
              </select>
              <div className="phone-input">
                <span
                  className={`code-pill ${
                    form.to
                      ? toMeta.isCodeValid
                        ? "valid"
                        : "invalid"
                      : ""
                  }`}
                >
                  {toMeta.code ? `+${toMeta.code}` : "+"}
                </span>
                <input
                  className="phone-field"
                  name="to"
                  value={form.to}
                  onChange={handleChange}
                  placeholder="+14155551212"
                />
              </div>
              <p className={`helper ${toMeta.isPossible ? "valid" : "invalid"}`}>
                {getLengthMessage(toMeta)}
              </p>
            </label>
            <label>
              Message
              <textarea
                name="text"
                rows="3"
                value={form.text}
                onChange={handleChange}
                placeholder="Type your SMS content..."
              />
            </label>
            <button type="submit" disabled={status.loading}>
              {status.loading ? "Sending..." : "Send SMS"}
            </button>
            {status.error ? <p className="error">{status.error}</p> : null}
            {status.success ? <p className="success">{status.success}</p> : null}
          </form>

          <div className="card inbound-card">
            <div className="card-header">
              <h2>Inbound messages</h2>
              <span className="badge">
                {inboundGroups.reduce(
                  (total, group) => total + group.senders.length,
                  0
                )} senders
              </span>
            </div>
            {inboundGroups.length === 0 ? (
              <p className="muted">No inbound messages yet.</p>
            ) : (
              inboundGroups.map((group) => (
                <div key={group.destination} className="inbound-destination">
                  <p className="bubble-title">To {group.destination}</p>
                  <div className="inbound-senders">
                    {group.senders.map((senderGroup) => (
                      <div key={senderGroup.sender} className="inbound-sender">
                        <div className="sender-header">
                          <span className="sender-pill">
                            {senderGroup.sender}
                          </span>
                        </div>
                        <div className="bubble-list">
                          {senderGroup.items.map((item) => (
                            <span key={item.id} className="bubble bubble-message">
                              {item.text || "(no text)"}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-header">
              <h2>Recent activity</h2>
              <span className="badge">{events.length} entries</span>
            </div>
            <div className="message-list">
              {eventStatus.loading ? (
                <p className="muted">Loading activity...</p>
              ) : events.length === 0 ? (
                <p className="muted">No activity yet.</p>
                  ) : (
                    activityRows.map((event) => (
                      <div key={event.id} className="message">
                        <div>
                          <p className="message-text">
                            {event.message?.text || "(no text)"}
                          </p>
                          <p className="message-meta">
                            {event.eventType}
                            {event.message
                              ? ` • ${event.message.from} → ${event.message.to}`
                              : ""}
                          </p>
                          <p className="message-meta">
                            {formatTimestamp(event.occurredAt || event.createdAt)}
                          </p>
                        </div>
                        <span
                          className={`status ${
                            event.statusChanged ? "status-changed" : ""
                          }`}
                        >
                          {event.status || "received"}
                        </span>
                      </div>
                    ))
                  )}
            </div>
              {eventStatus.error ? <p className="error">{eventStatus.error}</p> : null}
          </div>
          <div className="card">
            <div className="card-header">
              <h2>Saved numbers</h2>
              <span className="badge">
                {fromNumbers.length + toNumbers.length} total
              </span>
            </div>
            <div className="bubble-group">
              <div>
                <p className="bubble-title">From</p>
                <div className="bubble-list">
                  {fromNumbers.length === 0 ? (
                    <span className="muted">No numbers yet.</span>
                  ) : (
                    fromNumbers.map((item) => (
                      <span key={item.id} className="bubble">
                        {item.number}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div>
                <p className="bubble-title">To</p>
                <div className="bubble-list">
                  {toNumbers.length === 0 ? (
                    <span className="muted">No numbers yet.</span>
                  ) : (
                    toNumbers.map((item) => (
                      <span key={item.id} className="bubble">
                        {item.number}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
          </section>
        </section>
      ) : activeView === "database" ? (
        <section className="db-view">
          <div className="db-head">
              <div>
                <p className="eyebrow">Database</p>
                <h2>Table explorer</h2>
                <p className="subtitle">
                  Browse, sort, search, and filter every record in your data store.
                </p>
              </div>
            </div>

            <div className="db-accordions">
              {dbState.metaError ? (
                <p className="error">{dbState.metaError}</p>
              ) : null}
              {dbTables.length === 0 ? (
                <p className="muted">No tables available.</p>
              ) : (
                dbTables.map((table) => {
                  const tableState = getTableState(table.name);
                  return (
                    <div key={table.name} className="db-accordion">
                      <button
                        type="button"
                        className="db-accordion-toggle"
                        onClick={() => toggleTableOpen(table.name)}
                      >
                        <div>
                          <h3>{table.name}</h3>
                          <p className="muted">
                            {table.fields.length} fields
                          </p>
                        </div>
                        <span className="badge">
                          {tableState.count || 0} rows
                        </span>
                      </button>

                      {tableState.open ? (
                        <div className="db-accordion-body">
                          <div className="db-table-controls">
                            <input
                              type="text"
                              placeholder="Search all fields"
                              value={tableState.search}
                              onChange={(event) =>
                                updateTableSearch(table.name, event.target.value)
                              }
                            />
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => fetchTableRows(table.name)}
                            >
                              Refresh table
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => deleteSelectedRows(table.name)}
                              disabled={
                                Object.keys(tableState.selected || {}).length === 0
                              }
                            >
                              Delete selected ({
                                Object.keys(tableState.selected || {}).length
                              })
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => clearTableRows(table.name)}
                            >
                              Clear table
                            </button>
                          </div>

                          {tableState.loading ? (
                            <p className="muted">Loading rows...</p>
                          ) : (
                            <div className="db-table-wrapper">
                              <table className="db-table">
                                <thead>
                                  <tr>
                                    <th className="db-check">
                                      <input
                                        type="checkbox"
                                        checked={
                                          tableState.rows.length > 0 &&
                                          tableState.rows.every(
                                            (row) => tableState.selected[row.id]
                                          )
                                        }
                                        onChange={() =>
                                          toggleSelectAllRows(
                                            table.name,
                                            tableState.rows
                                          )
                                        }
                                      />
                                    </th>
                                    {table.fields.map((field) => (
                                      <th key={field}>
                                        <button
                                          type="button"
                                          className="db-sort"
                                          onClick={() => updateTableSort(table.name, field)}
                                        >
                                          {field}
                                          {tableState.sortBy === field ? (
                                            <span className="db-sort-indicator">
                                              {tableState.sortDir === "asc" ? "▲" : "▼"}
                                            </span>
                                          ) : null}
                                        </button>
                                      </th>
                                    ))}
                                  </tr>
                                  <tr className="db-filter-row">
                                    <th className="db-check" />
                                    {table.fields.map((field) => (
                                      <th key={`${table.name}-${field}-filter`}>
                                        <input
                                          type="text"
                                          placeholder={`Filter ${field}`}
                                          value={tableState.filters?.[field] || ""}
                                          onChange={(event) =>
                                            updateTableFilter(
                                              table.name,
                                              field,
                                              event.target.value
                                            )
                                          }
                                        />
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {tableState.rows.length === 0 ? (
                                    <tr>
                                      <td colSpan={table.fields.length + 1}>
                                        <span className="muted">No rows found.</span>
                                      </td>
                                    </tr>
                                  ) : (
                                    tableState.rows.map((row) => (
                                      <tr key={row.id || JSON.stringify(row)}>
                                        <td className="db-check">
                                          <input
                                            type="checkbox"
                                            checked={Boolean(tableState.selected[row.id])}
                                            onChange={() =>
                                              toggleRowSelection(table.name, row.id)
                                            }
                                          />
                                        </td>
                                        {table.fields.map((field) => (
                                          <td key={`${row.id || field}-${field}`}>
                                            {formatCellValue(
                                              row[field],
                                              table.fieldTypes?.[field]
                                            )}
                                          </td>
                                        ))}
                                      </tr>
                                    ))
                                  )}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {tableState.error ? (
                            <p className="error">{tableState.error}</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
        </section>
      ) : null}
    </div>
  );
}

export default App;
