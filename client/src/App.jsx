import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getCountries,
  getCountryCallingCode,
  validatePhoneNumberLength
} from "libphonenumber-js/max";
import ContactsManager from "./contacts/ContactsManager";
import useAudioTranscriptionRecorder from "./features/transcription/useAudioTranscriptionRecorder";
import MicRecordButton from "./features/transcription/MicRecordButton";
import ComposeAttachmentsControl from "./features/attachments/ComposeAttachmentsControl";
import "./App.css";

const defaultBaseUrl = "http://localhost:3206";
const SYNC_ON_LOAD_STORAGE_KEY = "salestools2026.syncOwnedOnLoad";
const OWNER_VISIBILITY_STORAGE_KEY = "salestools2026.ownerVisibility";
const loadedConversationOwnersCache = new Set();
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

const normalizeConversationTarget = (value) => {
  const cleaned = sanitizeE164(String(value || ""));
  if (!cleaned) {
    return "";
  }
  if (cleaned.startsWith("+")) {
    return cleaned;
  }

  const digits = cleaned.replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return `+${digits}`;
};

const normalizeOwnedNumberTag = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

const parseCustomTags = (value) =>
  String(value || "")
    .split(",")
    .map((item) => normalizeOwnedNumberTag(item))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);

const parseStoredJson = (value, fallback) => {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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

function App({ routeView = "app" }) {
  const navigate = useNavigate();
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
  const [numberSyncStatus, setNumberSyncStatus] = useState({
    loading: false,
    error: "",
    success: ""
  });
  const [syncOwnedOnLoad, setSyncOwnedOnLoad] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(SYNC_ON_LOAD_STORAGE_KEY) === "true";
  });
  const [ownerVisibility, setOwnerVisibility] = useState(() => {
    if (typeof window === "undefined") {
      return {};
    }
    return parseStoredJson(
      window.localStorage.getItem(OWNER_VISIBILITY_STORAGE_KEY),
      {}
    );
  });
  const [ownedNumberTagOptions, setOwnedNumberTagOptions] = useState([]);
  const [ownedNumberEditorOpen, setOwnedNumberEditorOpen] = useState(false);
  const [ownedNumberEditorTarget, setOwnedNumberEditorTarget] = useState("");
  const [ownedNumberDraft, setOwnedNumberDraft] = useState({
    description: "",
    purpose: "",
    selectedTags: [],
    customTagsInput: ""
  });
  const [floatingToast, setFloatingToast] = useState(null);
  const [eventStatus, setEventStatus] = useState({ loading: false, error: "" });
  const activeView = routeView;
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
  const [newConversationModalOpen, setNewConversationModalOpen] = useState(false);
  const [newConversationValue, setNewConversationValue] = useState("");
  const [newConversationError, setNewConversationError] = useState("");
  const [pendingLocationShare, setPendingLocationShare] = useState(null);
  const [composerAttachmentIds, setComposerAttachmentIds] = useState([]);
  const [composerAttachmentResetToken, setComposerAttachmentResetToken] = useState(0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const [messageFilter, setMessageFilter] = useState("active");
  const [conversationView, setConversationView] = useState("recent");
  const realtimePollMs = Number(import.meta.env.VITE_REALTIME_POLL_MS || 3000);
  const threadBodyRef = useRef(null);
  const pendingReadIdsRef = useRef(new Set());
  const readFlushRef = useRef(null);
  const persistedSelectionRef = useRef("");
  const pinnedManualConversationRef = useRef({ owner: "", counterparty: "" });
  const toastTimeoutRef = useRef(null);
  const toastDismissRef = useRef(null);

  const visibleFromNumbers = useMemo(
    () =>
      fromNumbers.filter(
        (item) => ownerVisibility[item.number] !== false
      ),
    [fromNumbers, ownerVisibility]
  );

  const selectedOwnedNumber = useMemo(
    () =>
      fromNumbers.find(
        (item) => item.number === (ownedNumberEditorTarget || selectedOwner)
      ) || null,
    [fromNumbers, ownedNumberEditorTarget, selectedOwner]
  );

  const appendToConversationDraft = useCallback((value) => {
    const nextValue = String(value || "").trim();
    if (!nextValue) {
      return;
    }

    setConversationDraft((prev) => {
      if (!prev) {
        return nextValue;
      }
      return /\s$/.test(prev) ? `${prev}${nextValue}` : `${prev} ${nextValue}`;
    });
  }, []);

  const handleTranscribeAudio = async (audioBlob, mimeType) => {
    const extension = mimeType?.includes("ogg")
      ? "ogg"
      : mimeType?.includes("mp4")
        ? "m4a"
        : "webm";

    const formData = new FormData();
    formData.append("audio", audioBlob, `dictation.${extension}`);

    const response = await fetch(`${baseUrl}/transcriptions/whisper`, {
      method: "POST",
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Transcription failed");
    }

    const transcript = (data?.text || "").trim();
    if (!transcript) {
      throw new Error("Transcription returned empty text.");
    }

    setConversationStatus((prev) => ({ ...prev, error: "" }));
    setConversationDraft((prev) =>
      prev?.trim() ? `${prev.trim()} ${transcript}` : transcript
    );
  };

  const {
    phase: recordingPhase,
    isProcessing: isTranscribing,
    isSupported: isRecordingSupported,
    toggleRecording
  } = useAudioTranscriptionRecorder({
    onTranscribe: handleTranscribeAudio,
    onError: (message) =>
      setConversationStatus((prev) => ({
        ...prev,
        error: message || "Unable to transcribe audio."
      }))
  });

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

  const loadOwnedNumberTags = async () => {
    try {
      const response = await fetch(`${baseUrl}/numbers/from/tags`);
      if (!response.ok) {
        return;
      }
      const data = await response.json().catch(() => ({}));
      const tags = Array.isArray(data?.tags)
        ? data.tags.map((item) => normalizeOwnedNumberTag(item)).filter(Boolean)
        : [];
      setOwnedNumberTagOptions(tags);
    } catch {
      setOwnedNumberTagOptions([]);
    }
  };

  const showFloatingToast = (message, kind = "success") => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    if (toastDismissRef.current) {
      clearTimeout(toastDismissRef.current);
      toastDismissRef.current = null;
    }

    const id = Date.now();
    setFloatingToast({ id, message, kind, visible: true });

    toastTimeoutRef.current = setTimeout(() => {
      setFloatingToast((prev) => (prev?.id === id ? { ...prev, visible: false } : prev));
      toastDismissRef.current = setTimeout(() => {
        setFloatingToast((prev) => (prev?.id === id ? null : prev));
      }, 300);
    }, 3000);
  };

  const openOwnedNumberEditor = (ownerNumber = selectedOwner) => {
    const target = fromNumbers.find((item) => item.number === ownerNumber);
    if (!target) {
      return;
    }

    const selectedTags = Array.isArray(target.tags)
      ? target.tags.map((item) => normalizeOwnedNumberTag(item)).filter(Boolean)
      : [];

    setOwnedNumberEditorTarget(target.number);
    setOwnedNumberDraft({
      description: target.description || "",
      purpose: target.purpose || "",
      selectedTags,
      customTagsInput: ""
    });
    setOwnedNumberEditorOpen(true);
  };

  const closeOwnedNumberEditor = () => {
    setOwnedNumberEditorOpen(false);
    setOwnedNumberEditorTarget("");
  };

  const toggleOwnedNumberTag = (tag) => {
    const normalized = normalizeOwnedNumberTag(tag);
    if (!normalized) {
      return;
    }

    setOwnedNumberDraft((prev) => {
      const hasTag = prev.selectedTags.includes(normalized);
      return {
        ...prev,
        selectedTags: hasTag
          ? prev.selectedTags.filter((item) => item !== normalized)
          : [...prev.selectedTags, normalized]
      };
    });
  };

  const saveOwnedNumberMetadata = async () => {
    if (!selectedOwnedNumber?.number) {
      return;
    }

    const ownerNumber = selectedOwnedNumber.number;
    const name = String(ownedNumberDraft.description || "").trim();
    const purpose = String(ownedNumberDraft.purpose || "").trim();
    const customTags = parseCustomTags(ownedNumberDraft.customTagsInput);
    const tags = [...ownedNumberDraft.selectedTags, ...customTags]
      .map((item) => normalizeOwnedNumberTag(item))
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index);

    closeOwnedNumberEditor();

    try {
      const response = await fetch(
        `${baseUrl}/numbers/from/${encodeURIComponent(ownerNumber)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: name,
            purpose,
            tags
          })
        }
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Failed to save owned number details");
      }

      const updated = data?.number;
      if (updated?.number) {
        setFromNumbers((prev) =>
          prev.map((item) =>
            item.number === updated.number
              ? { ...item, ...updated }
              : item
          )
        );
      }

      const nameLabel = name || "Unnamed";
      showFloatingToast(`${nameLabel} - ${ownerNumber} was updated successfully`, "success");
    } catch (error) {
      showFloatingToast(error.message || "Failed to save number details", "error");
    }
  };

  const toggleOwnerVisibility = (ownerNumber, checked) => {
    if (!ownerNumber) {
      return;
    }
    setOwnerVisibility((prev) => ({
      ...prev,
      [ownerNumber]: Boolean(checked)
    }));
  };

  const syncOwnedNumbers = async () => {
    setNumberSyncStatus({ loading: true, error: "", success: "" });

    try {
      const response = await fetch(`${baseUrl}/numbers/sync-owned`, {
        method: "POST"
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error || "Failed to sync owned numbers");
      }

      await loadNumbers();

      const syncedCount = Number(data?.synced || 0);
      setNumberSyncStatus({
        loading: false,
        error: "",
        success: `Synced ${syncedCount} owned number${syncedCount === 1 ? "" : "s"} from Telnyx`
      });
    } catch (error) {
      setNumberSyncStatus({ loading: false, error: error.message, success: "" });
    }
  };

  const loadConversations = async (ownerNumber, options = {}) => {
    const { silent = false, restoreSelection = false } = options;
    if (!ownerNumber) {
      setConversations([]);
      return;
    }
    const hasLoadedOwner = loadedConversationOwnersCache.has(ownerNumber);
    if (!silent && !hasLoadedOwner) {
      setConversationStatus((prev) => ({ ...prev, loading: true, error: "" }));
    }
    try {
      const response = await fetch(
        `${baseUrl}/conversations?owner=${encodeURIComponent(ownerNumber)}`
      );
      const data = await response.json();
      const nextConversations = data.conversations || [];
      const selectedCounterparty = data.selectedCounterparty || "";
      setConversations(nextConversations);
      setSelectedConversation((prev) => {
        const pinned = pinnedManualConversationRef.current;
        if (
          pinned?.owner === ownerNumber &&
          pinned?.counterparty &&
          (!restoreSelection || prev === pinned.counterparty)
        ) {
          return pinned.counterparty;
        }

        const prevExists = nextConversations.some(
          (item) => item.counterparty === prev
        );

        if (!restoreSelection && prevExists) {
          return prev;
        }

        if (!restoreSelection && prev) {
          return prev;
        }

        if (
          selectedCounterparty &&
          nextConversations.some((item) => item.counterparty === selectedCounterparty)
        ) {
          return selectedCounterparty;
        }

        if (prevExists) {
          return prev;
        }

        if (!nextConversations.length && prev) {
          return prev;
        }

        return nextConversations[0]?.counterparty || "";
      });
      loadedConversationOwnersCache.add(ownerNumber);
      setConversationStatus((prev) => ({ ...prev, loading: false }));
    } catch (error) {
      setConversationStatus({ loading: false, error: error.message });
    }
  };

  const persistSelectedConversation = async (ownerNumber, counterparty) => {
    if (!ownerNumber || !counterparty) {
      return;
    }

    const key = `${ownerNumber}::${counterparty}`;
    if (persistedSelectionRef.current === key) {
      return;
    }

    persistedSelectionRef.current = key;
    try {
      await fetch(`${baseUrl}/conversations/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: ownerNumber, counterparty })
      });
    } catch {
      persistedSelectionRef.current = "";
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
    const hydrate = async () => {
      await Promise.all([loadMessages(), loadNumbers(), loadEvents(), loadOwnedNumberTags()]);
      if (syncOwnedOnLoad) {
        await syncOwnedNumbers();
      }
    };
    hydrate();
  }, [baseUrl]);

  useEffect(() => {
    if (activeView === "database") {
      loadDbTables();
    }
  }, [activeView]);

  useEffect(() => {
    if (visibleFromNumbers.length === 0) {
      if (selectedOwner) {
        setSelectedOwner("");
      }
      return;
    }

    const selectedStillVisible = visibleFromNumbers.some(
      (item) => item.number === selectedOwner
    );

    if (!selectedOwner || !selectedStillVisible) {
      setSelectedOwner(visibleFromNumbers[0].number);
    }
  }, [visibleFromNumbers, selectedOwner]);

  useEffect(() => {
    if (!selectedOwner) {
      setConversations([]);
      return;
    }
    loadConversations(selectedOwner, { restoreSelection: true });
  }, [selectedOwner]);

  useEffect(() => {
    if (!selectedOwner || !selectedConversation) {
      return;
    }
    persistSelectedConversation(selectedOwner, selectedConversation);
  }, [selectedOwner, selectedConversation]);

  useEffect(() => {
    if (!selectedOwner || !selectedConversation) {
      setConversationMessages([]);
      return;
    }
    loadConversationMessages(selectedOwner, selectedConversation);
  }, [selectedOwner, selectedConversation]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      SYNC_ON_LOAD_STORAGE_KEY,
      syncOwnedOnLoad ? "true" : "false"
    );
  }, [syncOwnedOnLoad]);

  useEffect(() => {
    if (!Array.isArray(fromNumbers) || fromNumbers.length === 0) {
      return;
    }

    setOwnerVisibility((prev) => {
      const next = { ...prev };
      let changed = false;

      for (const item of fromNumbers) {
        if (!(item.number in next)) {
          next[item.number] = true;
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [fromNumbers]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      OWNER_VISIBILITY_STORAGE_KEY,
      JSON.stringify(ownerVisibility)
    );
  }, [ownerVisibility]);

  useEffect(() => {
    if (!ownedNumberEditorOpen) {
      return;
    }

    const handleEsc = (event) => {
      if (event.key === "Escape") {
        closeOwnedNumberEditor();
      }
    };

    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [ownedNumberEditorOpen]);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
      if (toastDismissRef.current) {
        clearTimeout(toastDismissRef.current);
      }
    };
  }, []);

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

  const openNewConversationModal = () => {
    setNewConversationValue("");
    setNewConversationError("");
    setNewConversationModalOpen(true);
  };

  const closeNewConversationModal = () => {
    setNewConversationModalOpen(false);
    setNewConversationError("");
  };

  const submitNewConversation = () => {
    const counterparty = normalizeConversationTarget(newConversationValue);
    if (!counterparty) {
      setNewConversationError("Enter a valid phone number.");
      return;
    }

    const ownerNumber = selectedOwner || fromNumbers[0]?.number || "";
    if (!ownerNumber) {
      setNewConversationError("No owned number is available yet.");
      return;
    }

    if (!selectedOwner) {
      setSelectedOwner(ownerNumber);
    }

    pinnedManualConversationRef.current = {
      owner: ownerNumber,
      counterparty
    };

    setConversationView("recent");
    setMessageFilter("active");
    setSelectedConversation(counterparty);
    setConversationDraft("");
    setConversationMenuId("");
    setNewConversationModalOpen(false);
    setNewConversationError("");
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

  const requestConversationSend = useCallback(
    async ({ text = "", attachmentIds = [], locationShare = null } = {}) => {
      if (!selectedOwner || !selectedConversation) {
        throw new Error("Select a conversation before sending");
      }

      const response = await fetch(`${baseUrl}/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: selectedOwner,
          to: selectedConversation,
          text,
          attachmentIds,
          locationShare
        })
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody?.message || errorBody?.error || "Failed to send");
      }

      return response.json();
    },
    [baseUrl, selectedConversation, selectedOwner]
  );

  const handleImmediateContactSend = useCallback(
    async ({ attachmentIds }) => {
      await requestConversationSend({ text: "", attachmentIds, locationShare: null });

      await Promise.all([
        loadConversationMessages(selectedOwner, selectedConversation),
        loadConversations(selectedOwner),
        loadMessages(),
        loadEvents(),
        loadNumbers()
      ]);
    },
    [
      loadConversationMessages,
      loadConversations,
      loadEvents,
      loadMessages,
      loadNumbers,
      requestConversationSend,
      selectedConversation,
      selectedOwner
    ]
  );

  const handleConversationSend = async (event) => {
    event.preventDefault();
    if (!conversationDraft.trim() || !selectedOwner || !selectedConversation) {
      return;
    }

    try {
      await requestConversationSend({
        text: conversationDraft.trim(),
        attachmentIds: composerAttachmentIds,
        locationShare:
          pendingLocationShare &&
          conversationDraft.includes(pendingLocationShare.url || "")
            ? pendingLocationShare
            : null
      });

      setConversationDraft("");
      setPendingLocationShare(null);
      setComposerAttachmentIds([]);
      setComposerAttachmentResetToken((prev) => prev + 1);
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

  const handleAttachmentDownload = async (attachment) => {
    if (!attachment?.id) {
      return;
    }

    try {
      const response = await fetch(`${baseUrl}/attachments/${attachment.id}/download`);
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody?.error || "Failed to download attachment");
      }

      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = attachment.fileName || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
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
    navigate("/");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="app">
      <nav className="top-nav">
        <div className="nav-brand">
          <span className="eyebrow">Sales Tools 2026</span>
          <h2>Messaging Suite</h2>
        </div>
        <div className="nav-actions">
          <button type="button" className="nav-button" onClick={handleHome}>
            Home
          </button>
          <button
            type="button"
            className={`nav-button ${activeView === "app" ? "active" : ""}`}
            onClick={() => navigate("/")}
          >
            App
          </button>
          <button
            type="button"
            className={`nav-button ${activeView === "contacts" ? "active" : ""}`}
            onClick={() => navigate("/contacts")}
          >
            Contacts
          </button>
          <div className="nav-dropdown">
            <button type="button" className="nav-button">
              Admin
            </button>
            <div className="nav-menu">
              <button
                type="button"
                className="nav-menu-item"
                onClick={() => navigate("/admin/database")}
              >
                Database Tables
              </button>
              <button
                type="button"
                className="nav-menu-item"
                onClick={() => navigate("/admin/dev-consoles")}
              >
                Dev Consoles
              </button>
              <button
                type="button"
                className="nav-menu-item"
                onClick={() => navigate("/admin/my-numbers")}
              >
                My Numbers
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
                    {visibleFromNumbers.length === 0 ? (
                      <p className="muted owner-row-empty">No owned numbers yet.</p>
                    ) : (
                      visibleFromNumbers.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`owner-chip owner-chip-with-badge ${
                            selectedOwner === item.number ? "active" : ""
                          }`}
                          onClick={() => {
                            setSelectedOwner(item.number);
                            setSelectedConversation("");
                            persistedSelectionRef.current = "";
                            pinnedManualConversationRef.current = {
                              owner: "",
                              counterparty: ""
                            };
                          }}
                        >
                          <span className="owner-chip-name">
                            {item.description || item.number}
                          </span>
                          {item.description ? (
                            <span className="owner-chip-number-hover">{item.number}</span>
                          ) : null}
                          {Number(item.unreadCount || 0) > 0 ? (
                            <span className="owner-unread-badge">
                              {Number(item.unreadCount) > 99 ? "99+" : Number(item.unreadCount)}
                            </span>
                          ) : null}
                        </button>
                      ))
                    )}
                    <button
                      type="button"
                      className={`owner-chip action-chip ${ownedNumberEditorOpen ? "active" : ""}`}
                      onClick={() =>
                        ownedNumberEditorOpen
                          ? closeOwnedNumberEditor()
                          : openOwnedNumberEditor(selectedOwner)
                      }
                      disabled={!selectedOwnedNumber}
                    >
                      {ownedNumberEditorOpen ? "Close Number Editor" : "Edit Number"}
                    </button>
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
                          pinnedManualConversationRef.current = {
                            owner: "",
                            counterparty: ""
                          };
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedConversation(item.counterparty);
                            setConversationMenuId("");
                            pinnedManualConversationRef.current = {
                              owner: "",
                              counterparty: ""
                            };
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
                {!isArchiveView && !isBookmarkedView ? (
                  <button
                    type="button"
                    className="conversation-add-button"
                      onClick={openNewConversationModal}
                    disabled={!selectedOwner && fromNumbers.length === 0}
                    title="Start a new conversation"
                    aria-label="Start a new conversation"
                  >
                    +
                  </button>
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
                                {message.text ? (
                                  <p className="chat-text">{message.text}</p>
                                ) : !Array.isArray(message.attachments) ||
                                  message.attachments.length === 0 ? (
                                  <p className="chat-text">(no text)</p>
                                ) : null}
                                {Array.isArray(message.attachments) &&
                                message.attachments.length > 0 ? (
                                  <div className="chat-attachments">
                                    {message.attachments.map((attachment) => (
                                      <button
                                        key={attachment.id}
                                        type="button"
                                        className="chat-attachment-chip"
                                        onClick={() => handleAttachmentDownload(attachment)}
                                        title={`Download ${attachment.fileName || "attachment"}`}
                                      >
                                        {attachment.kind === "CONTACT" ||
                                        /\.vcf$/i.test(attachment.fileName || "") ? (
                                          <svg viewBox="0 0 24 24" role="img" focusable="false">
                                            <path
                                              d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm8 2.8a3.2 3.2 0 100 6.4 3.2 3.2 0 000-6.4zm0 8c-2.3 0-4.4 1.2-5.1 3h10.2c-.7-1.8-2.8-3-5.1-3z"
                                              fill="currentColor"
                                            />
                                          </svg>
                                        ) : (
                                          <svg viewBox="0 0 24 24" role="img" focusable="false">
                                            <path
                                              d="M5 20h14v-2H5v2zm7-18v10.2l3.6-3.6L17 10l-5 5-5-5 1.4-1.4 3.6 3.6V2h2z"
                                              fill="currentColor"
                                            />
                                          </svg>
                                        )}
                                        <span>{attachment.fileName || "Attachment"}</span>
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
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
                      <ComposeAttachmentsControl
                        baseUrl={baseUrl}
                        ownerNumber={selectedOwner}
                        counterparty={selectedConversation}
                        disabled={isTranscribing}
                        resetToken={composerAttachmentResetToken}
                        onAttachmentIdsChange={setComposerAttachmentIds}
                        onInsertText={appendToConversationDraft}
                        onLocationSelected={setPendingLocationShare}
                        onSendContactNow={handleImmediateContactSend}
                      />
                      <input
                        type="text"
                        placeholder="Type your message"
                        value={conversationDraft}
                        onChange={(event) => setConversationDraft(event.target.value)}
                      />
                      <MicRecordButton
                        phase={recordingPhase}
                        isProcessing={isTranscribing}
                        isSupported={isRecordingSupported}
                        onToggle={toggleRecording}
                      />
                      <button
                        type="submit"
                        className="thread-send"
                        aria-label="Send message"
                        disabled={!conversationDraft.trim() || isTranscribing}
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

      {newConversationModalOpen ? (
        <div
          className="new-conversation-modal-backdrop"
          role="presentation"
          onClick={closeNewConversationModal}
        >
          <div
            className="new-conversation-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Start new conversation"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="new-conversation-modal-header">
              <h3>Start New Conversation</h3>
              <button
                type="button"
                className="icon-button"
                onClick={closeNewConversationModal}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="new-conversation-modal-body">
              <label htmlFor="new-conversation-number">To number</label>
              <input
                id="new-conversation-number"
                type="tel"
                placeholder="e.g. 3372580880 or +13372580880"
                value={newConversationValue}
                onChange={(event) => {
                  setNewConversationValue(event.target.value);
                  if (newConversationError) {
                    setNewConversationError("");
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitNewConversation();
                  }
                }}
                autoFocus
              />
              {newConversationError ? <p className="error">{newConversationError}</p> : null}
              <p className="muted">If no country code is entered, this defaults to US (+1).</p>
            </div>
            <div className="new-conversation-modal-actions">
              <button type="button" className="button secondary" onClick={closeNewConversationModal}>
                Cancel
              </button>
              <button type="button" onClick={submitNewConversation}>
                Start Conversation
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {ownedNumberEditorOpen && selectedOwnedNumber ? (
        <div
          className="owned-number-modal-backdrop"
          role="presentation"
          onClick={closeOwnedNumberEditor}
        >
          <div
            className="owned-number-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Edit owned number"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="owned-number-modal-header">
              <h3>Edit Owned Number</h3>
              <button
                type="button"
                className="icon-button"
                onClick={closeOwnedNumberEditor}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="owned-number-modal-body">
              <p className="muted">{selectedOwnedNumber.number}</p>
              <label>
                Name
                <input
                  type="text"
                  value={ownedNumberDraft.description}
                  onChange={(event) =>
                    setOwnedNumberDraft((prev) => ({
                      ...prev,
                      description: event.target.value
                    }))
                  }
                  placeholder="e.g. Main sales line"
                  autoFocus
                />
              </label>
              <label>
                Purpose
                <input
                  type="text"
                  value={ownedNumberDraft.purpose}
                  onChange={(event) =>
                    setOwnedNumberDraft((prev) => ({
                      ...prev,
                      purpose: event.target.value
                    }))
                  }
                  placeholder="e.g. inbound support"
                />
              </label>
              <div className="owned-number-tag-wrap">
                <p className="message-view-label">Tags</p>
                <div className="owned-number-tags">
                  {ownedNumberTagOptions.length > 0
                    ? ownedNumberTagOptions.map((tag) => {
                        const active = ownedNumberDraft.selectedTags.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            className={`owner-chip action-chip ${active ? "active" : ""}`}
                            onClick={() => toggleOwnedNumberTag(tag)}
                          >
                            {tag}
                          </button>
                        );
                      })
                    : null}
                </div>
                <label>
                  Custom tags (comma-separated)
                  <input
                    type="text"
                    value={ownedNumberDraft.customTagsInput}
                    onChange={(event) =>
                      setOwnedNumberDraft((prev) => ({
                        ...prev,
                        customTagsInput: event.target.value
                      }))
                    }
                    placeholder="vip, after-hours"
                  />
                </label>
              </div>
            </div>
            <div className="owned-number-modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={closeOwnedNumberEditor}
              >
                Cancel
              </button>
              <button type="button" onClick={saveOwnedNumberMetadata}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {floatingToast ? (
        <div
          className={`floating-toast ${floatingToast.visible ? "visible" : ""} ${
            floatingToast.kind === "error" ? "error" : "success"
          }`}
        >
          {floatingToast.message}
        </div>
      ) : null}

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
      ) : activeView === "contacts" ? (
        <ContactsManager baseUrl={baseUrl} />
      ) : activeView === "myNumbers" ? (
        <section className="my-numbers-view">
          <div className="db-head">
            <div>
              <p className="eyebrow">Admin</p>
              <h2>My Numbers</h2>
              <p className="subtitle">
                Manage number names, sync behavior, and which owned numbers appear in Conversation Overview.
              </p>
            </div>
          </div>

          <div className="my-numbers-panel">
            <div className="my-numbers-toolbar">
              <label className="my-numbers-checkbox">
                <input
                  type="checkbox"
                  checked={syncOwnedOnLoad}
                  onChange={(event) => setSyncOwnedOnLoad(event.target.checked)}
                />
                Sync owned numbers on load
              </label>
              <button
                type="button"
                className="ghost"
                onClick={syncOwnedNumbers}
                disabled={numberSyncStatus.loading}
              >
                {numberSyncStatus.loading ? "Syncing..." : "Sync Now"}
              </button>
            </div>
            {numberSyncStatus.error ? <p className="error">{numberSyncStatus.error}</p> : null}
            {numberSyncStatus.success ? <p className="success">{numberSyncStatus.success}</p> : null}

            <div className="my-numbers-list">
              {fromNumbers.length === 0 ? (
                <p className="muted">No owned numbers found.</p>
              ) : (
                fromNumbers.map((item) => (
                  <div key={item.id} className="my-number-row">
                    <label className="my-numbers-checkbox">
                      <input
                        type="checkbox"
                        checked={ownerVisibility[item.number] !== false}
                        onChange={(event) =>
                          toggleOwnerVisibility(item.number, event.target.checked)
                        }
                      />
                      Show in conversations
                    </label>
                    <div className="my-number-details">
                      <strong>{item.description || "(unnamed)"}</strong>
                      <span>{item.number}</span>
                    </div>
                    <button
                      type="button"
                      className="owner-chip action-chip"
                      onClick={() => openOwnedNumberEditor(item.number)}
                    >
                      Edit
                    </button>
                  </div>
                ))
              )}
            </div>
            <p className="muted">
              {visibleFromNumbers.length} of {fromNumbers.length} numbers visible in conversation view.
            </p>
          </div>
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
