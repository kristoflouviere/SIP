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
  const [fromNumbers, setFromNumbers] = useState([]);
  const [toNumbers, setToNumbers] = useState([]);
  const [form, setForm] = useState({ from: "", to: "", text: "" });
  const [status, setStatus] = useState({ loading: false, error: "", success: "" });

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

  useEffect(() => {
    loadMessages();
    loadNumbers();
  }, [baseUrl]);

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
        <button className="ghost" onClick={loadMessages}>
          Refresh
        </button>
      </header>

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
              <span className="badge">{messages.length} messages</span>
            </div>
            <div className="message-list">
              {messages.length === 0 ? (
                <p className="muted">No messages yet.</p>
              ) : (
                messages.map((message) => (
                  <div key={message.id} className="message">
                    <div>
                      <p className="message-text">{message.text || "(no text)"}</p>
                      <p className="message-meta">
                        {message.direction} • {message.from} → {message.to}
                      </p>
                    </div>
                    <span className="status">{message.status || "received"}</span>
                  </div>
                ))
              )}
            </div>
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
    </div>
  );
}

export default App;
