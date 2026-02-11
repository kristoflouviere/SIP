import { useEffect, useMemo, useState } from "react";
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
  const [activeView, setActiveView] = useState("console");
  const [dbTables, setDbTables] = useState([]);
  const [dbState, setDbState] = useState({});
  const [selectedOwner, setSelectedOwner] = useState("");
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState("");
  const [conversationMessages, setConversationMessages] = useState([]);
  const [conversationStatus, setConversationStatus] = useState({
    loading: false,
    error: ""
  });
  const [toast, setToast] = useState({ message: "", tone: "" });

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

  const loadConversations = async (ownerNumber) => {
    if (!ownerNumber) {
      setConversations([]);
      return;
    }
    setConversationStatus((prev) => ({ ...prev, loading: true, error: "" }));
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

  const rebuildConversations = async (ownerNumber) => {
    if (!ownerNumber) {
      return;
    }
    setConversationStatus((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const response = await fetch(`${baseUrl}/conversations/rebuild`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: ownerNumber })
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body?.error || "Rebuild failed");
      }
      await loadConversations(ownerNumber);
      setToast({ message: "Conversations rebuilt.", tone: "success" });
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
      setToast({ message: error.message || "Rebuild failed.", tone: "error" });
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
    markConversationRead(selectedOwner, selectedConversation);
  }, [selectedOwner, selectedConversation]);

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
    const seen = new Set();
    const deduped = [];

    for (const message of conversationMessages) {
      const timestamp = new Date(
        message.occurredAt || message.createdAt || 0
      ).getTime();
      const key = message.telnyxMessageId
        ? `telnyx:${message.telnyxMessageId}`
        : `fallback:${message.direction}|${message.from}|${message.to}|${
            message.text || ""
          }|${timestamp}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(message);
    }

    return deduped.sort((a, b) => {
      const firstTime = new Date(a.occurredAt || a.createdAt || 0).getTime();
      const secondTime = new Date(b.occurredAt || b.createdAt || 0).getTime();
      return firstTime - secondTime;
    });
  }, [conversationMessages]);

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
      filters: {}
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

  useEffect(() => {
    if (!toast.message) {
      return;
    }
    const timeout = setTimeout(() => {
      setToast({ message: "", tone: "" });
    }, 2800);
    return () => clearTimeout(timeout);
  }, [toast]);

  const refreshDatabase = async () => {
    await loadDbTables();
    const openTables = Object.entries(dbState)
      .filter(([, value]) => value?.open)
      .map(([name]) => name);
    await Promise.all(openTables.map((name) => fetchTableRows(name)));
  };

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">SIP Texting</p>
          <h1>Telnyx Messaging Console</h1>
          <p className="subtitle">
            Manage inbound and outbound SMS across your SIP-enabled numbers.
          </p>
        </div>
        <button
          className="ghost"
          onClick={activeView === "console" ? handleRefresh : refreshDatabase}
        >
          {activeView === "console" ? "Refresh" : "Refresh database"}
        </button>
      </header>

      <div className="top-area">
        {toast.message ? (
          <div className={`toast ${toast.tone}`}>{toast.message}</div>
        ) : null}
        <div className="top-nav">
          <span className="eyebrow">Secondary nav</span>
          <div className="nav-links">
            <button
              type="button"
              className={`nav-link ${activeView === "console" ? "active" : ""}`}
              onClick={() => setActiveView("console")}
            >
              Console
            </button>
            <button
              type="button"
              className={`nav-link ${activeView === "database" ? "active" : ""}`}
              onClick={() => setActiveView("database")}
            >
              Database
            </button>
          </div>
        </div>

        {activeView === "console" ? (
          <section className="conversation-board">
            <div className="conversation-head">
              <div>
                <p className="eyebrow">Production console</p>
                <h2>Conversation overview</h2>
              </div>
              <div className="conversation-actions">
                <span className="badge">
                  {selectedOwner ? selectedOwner : "No owned number"}
                </span>
                <button
                  className="ghost"
                  onClick={() => loadConversations(selectedOwner)}
                >
                  Refresh conversations
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => rebuildConversations(selectedOwner)}
                >
                  Rebuild conversations
                </button>
              </div>
            </div>

            <div className="owner-row">
              {fromNumbers.length === 0 ? (
                <p className="muted">No owned numbers yet.</p>
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

            <div className="conversation-panel">
              <div className="conversation-list">
                <div className="list-header">
                  <h3>Recent conversations</h3>
                  <span className="badge">{conversations.length} threads</span>
                </div>
                {conversationStatus.loading ? (
                  <p className="muted">Loading conversations...</p>
                ) : conversations.length === 0 ? (
                  <p className="muted">No conversations yet.</p>
                ) : (
                  conversations.map((item) => {
                    const isActive = selectedConversation === item.counterparty;
                    const isUnread = item.unreadCount > 0;
                    return (
                      <button
                        key={`${item.ownerNumber}-${item.counterparty}`}
                        type="button"
                        className={`conversation-item ${
                          isActive ? "active" : ""
                        } ${isUnread ? "unread" : ""}`}
                        onClick={() => setSelectedConversation(item.counterparty)}
                      >
                        <div className="conversation-title">
                          <span>{item.counterparty}</span>
                          <span className="conversation-time">
                            {formatTimestamp(item.lastMessageAt)}
                          </span>
                        </div>
                        <div className="conversation-preview">
                          <span>{item.lastMessageText || "(no text)"}</span>
                          {isUnread ? <span className="unread-dot" /> : null}
                        </div>
                      </button>
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
                      <span className="badge">
                        {sortedConversationMessages.length} messages
                      </span>
                    </div>
                    <div className="thread-body">
                      {sortedConversationMessages.length === 0 ? (
                        <p className="muted">
                          No messages in this conversation yet.
                        </p>
                      ) : (
                        sortedConversationMessages.map((message) => {
                          const directionClass =
                            message.direction === "inbound" ? "inbound" : "outbound";
                          return (
                            <div
                              key={message.id}
                              className={`chat-row ${directionClass}`}
                            >
                              <div className={`chat-bubble ${directionClass}`}>
                                <p className="chat-text">
                                  {message.text || "(no text)"}
                                </p>
                                <p className="chat-meta">
                                  {formatTimestamp(
                                    message.occurredAt || message.createdAt
                                  )}
                                </p>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
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

      <div className="section-divider" />

      {activeView === "console" ? (
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
      ) : (
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
      )}
    </div>
  );
}

export default App;
