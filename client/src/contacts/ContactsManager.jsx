import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const splitLinesOrComma = (value) =>
  String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const pageSizeStops = [20, 50, 100, 150, 200];

const snapPageSize = (rawValue) => {
  const numeric = Number(rawValue);
  if (Number.isNaN(numeric)) {
    return pageSizeStops[0];
  }

  return pageSizeStops.reduce((closest, stop) =>
    Math.abs(stop - numeric) < Math.abs(closest - numeric) ? stop : closest
  );
};

export default function ContactsManager({ baseUrl }) {
  const navigate = useNavigate();
  const location = useLocation();
  const handledOAuthRef = useRef(false);

  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState({ error: "", success: "" });
  const [searchTerm, setSearchTerm] = useState("");
  const [pageSize, setPageSize] = useState(100);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState([]);
  const [contactMenuId, setContactMenuId] = useState("");
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    address: "",
    company: "",
    phoneNumbersText: "",
    linkedInText: ""
  });

  const sortedContacts = useMemo(
    () => [...contacts].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    [contacts]
  );

  const filteredContacts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) {
      return sortedContacts;
    }

    return sortedContacts.filter((contact) => {
      const searchable = JSON.stringify(contact || {}).toLowerCase();
      return searchable.includes(term);
    });
  }, [searchTerm, sortedContacts]);

  const totalPages = Math.max(1, Math.ceil(filteredContacts.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (safeCurrentPage - 1) * pageSize;
  const paginatedContacts = filteredContacts.slice(startIndex, startIndex + pageSize);
  const selectedCount = selectedContactIds.length;
  const allVisibleSelected =
    paginatedContacts.length > 0 &&
    paginatedContacts.every((contact) => selectedContactIds.includes(contact.id));

  const pageOptions = useMemo(
    () => Array.from({ length: totalPages }, (_, index) => index + 1),
    [totalPages]
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [pageSize, searchTerm]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    const handleClick = (event) => {
      if (!event.target.closest(".contact-menu")) {
        setContactMenuId("");
      }
    };

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setStatus((prev) => ({ ...prev, error: "" }));
    try {
      const response = await fetch(`${baseUrl}/contacts?limit=5000`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load contacts");
      }
      setContacts(data.contacts || []);
    } catch (error) {
      setStatus((prev) => ({ ...prev, error: error.message }));
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const state = params.get("state");
    const oauthError = params.get("error");

    if (oauthError && !handledOAuthRef.current) {
      handledOAuthRef.current = true;
      setStatus({ error: `OAuth import canceled or failed: ${oauthError}`, success: "" });
      navigate("/contacts", { replace: true });
      return;
    }

    if (!code || !state || handledOAuthRef.current) {
      return;
    }

    handledOAuthRef.current = true;

    if (!state.startsWith("google_")) {
      setStatus({ error: "Unsupported OAuth provider state.", success: "" });
      navigate("/contacts", { replace: true });
      return;
    }

    const endpoint = "google";
    const sourceLabel = "Gmail";

    const runImport = async () => {
      setStatus({ error: "", success: `Importing contacts from ${sourceLabel}...` });
      try {
        const response = await fetch(`${baseUrl}/contacts/import/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, state })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || `Failed to import from ${sourceLabel}`);
        }
        await loadContacts();
        setStatus({
          error: "",
          success: `Imported ${data.imported || 0} contacts from ${sourceLabel}.`
        });
      } catch (error) {
        setStatus({ error: error.message, success: "" });
      } finally {
        navigate("/contacts", { replace: true });
      }
    };

    runImport();
  }, [baseUrl, loadContacts, location.search, navigate]);

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleAddContact = async (event) => {
    event.preventDefault();
    setStatus({ error: "", success: "" });

    try {
      const response = await fetch(`${baseUrl}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          address: form.address,
          company: form.company,
          phoneNumbers: splitLinesOrComma(form.phoneNumbersText),
          linkedInProfiles: splitLinesOrComma(form.linkedInText)
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to add contact");
      }

      setForm({
        firstName: "",
        lastName: "",
        email: "",
        address: "",
        company: "",
        phoneNumbersText: "",
        linkedInText: ""
      });
      setStatus({ error: "", success: "Contact added." });
      await loadContacts();
    } catch (error) {
      setStatus({ error: error.message, success: "" });
    }
  };

  const handleOutlookCsvImport = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setStatus({ error: "", success: "Importing Outlook CSV..." });

    try {
      const csvText = await file.text();
      const response = await fetch(`${baseUrl}/contacts/import/outlook-csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Outlook CSV import failed");
      }
      await loadContacts();
      setStatus({ error: "", success: `Imported ${data.imported || 0} contacts from Outlook CSV.` });
    } catch (error) {
      setStatus({ error: error.message, success: "" });
    } finally {
      event.target.value = "";
    }
  };

  const handleOAuthStart = async () => {
    setStatus({ error: "", success: "" });
    const endpoint = "google";

    try {
      const response = await fetch(`${baseUrl}/contacts/oauth/${endpoint}/start`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to start OAuth import");
      }
      window.location.href = data.url;
    } catch (error) {
      setStatus({ error: error.message, success: "" });
    }
  };

  const toggleSelectionMode = () => {
    setSelectionMode((prev) => !prev);
    setSelectedContactIds([]);
  };

  const toggleContactSelection = (contactId) => {
    setSelectedContactIds((prev) =>
      prev.includes(contactId)
        ? prev.filter((id) => id !== contactId)
        : [...prev, contactId]
    );
  };

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      const visibleIds = new Set(paginatedContacts.map((contact) => contact.id));
      setSelectedContactIds((prev) => prev.filter((id) => !visibleIds.has(id)));
      return;
    }

    const next = new Set(selectedContactIds);
    paginatedContacts.forEach((contact) => next.add(contact.id));
    setSelectedContactIds(Array.from(next));
  };

  const deleteContacts = async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) {
      return;
    }

    try {
      const response = await fetch(`${baseUrl}/contacts/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to delete contacts");
      }

      setStatus({ error: "", success: `Deleted ${data.deletedCount || 0} contacts.` });
      setSelectedContactIds((prev) => prev.filter((id) => !ids.includes(id)));
      setContactMenuId("");
      await loadContacts();
    } catch (error) {
      setStatus({ error: error.message, success: "" });
    }
  };

  const runContactMenuAction = async (contactId, action) => {
    if (action === "select") {
      if (!selectionMode) {
        setSelectionMode(true);
      }
      toggleContactSelection(contactId);
      setContactMenuId("");
      return;
    }

    if (action === "delete") {
      await deleteContacts([contactId]);
      return;
    }

    setStatus({
      error: "",
      success: "This action is currently available on message records only."
    });
    setContactMenuId("");
  };

  return (
    <section className="contacts-view">
      <div className="contacts-header">
        <div>
          <p className="eyebrow">Contacts</p>
          <h2>Contact Manager</h2>
          <p className="subtitle">
            Add contacts manually or import from Outlook CSV and Gmail.
          </p>
        </div>
      </div>

      <div className="grid contacts-grid">
        <form className="card" onSubmit={handleAddContact}>
          <div className="card-header">
            <h2>Add contact</h2>
          </div>
          <div className="contacts-form-row">
            <label>
              First Name
              <input name="firstName" value={form.firstName} onChange={handleInputChange} />
            </label>
            <label>
              Last Name
              <input name="lastName" value={form.lastName} onChange={handleInputChange} />
            </label>
          </div>
          <label>
            Email
            <input name="email" type="email" value={form.email} onChange={handleInputChange} />
          </label>
          <label>
            Address
            <input name="address" value={form.address} onChange={handleInputChange} />
          </label>
          <label>
            Company
            <input name="company" value={form.company} onChange={handleInputChange} />
          </label>
          <label>
            Phone Numbers (comma or new line separated)
            <textarea
              name="phoneNumbersText"
              value={form.phoneNumbersText}
              onChange={handleInputChange}
            />
          </label>
          <label>
            LinkedIn Profiles (comma or new line separated)
            <textarea name="linkedInText" value={form.linkedInText} onChange={handleInputChange} />
          </label>
          <button type="submit">Add Contact</button>
        </form>

        <div className="card">
          <div className="card-header">
            <h2>Import contacts</h2>
          </div>
          <label>
            Outlook CSV Export
            <input type="file" accept=".csv,text/csv" onChange={handleOutlookCsvImport} />
          </label>
          <div className="contacts-import-actions">
            <button type="button" onClick={handleOAuthStart}>
              Import from Gmail
            </button>
          </div>
          <p className="helper">
            OAuth redirect URIs must be configured in your provider apps and server env vars.
          </p>
        </div>
      </div>

      {status.error ? <p className="error">{status.error}</p> : null}
      {status.success ? <p className="success">{status.success}</p> : null}

      <div className="card">
        <div className="card-header">
          <h2>Contacts ({sortedContacts.length})</h2>
          <div className="contacts-toolbar-actions">
            <button
              type="button"
              className={`owner-chip action-chip ${selectionMode ? "active" : ""}`}
              onClick={toggleSelectionMode}
            >
              {selectionMode ? "Cancel Selection" : "Select"}
            </button>
            <button type="button" className="ghost" onClick={loadContacts} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>
        <div className="contacts-toolbar">
          <label className="contacts-search">
            Search all properties
            <input
              type="text"
              placeholder="Search contacts"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>
          {selectionMode ? (
            <div className="selection-actions">
              <p className="toolbar-count">{selectedCount} selected</p>
              <div className="selection-actions-row">
                <label className="select-all">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                  />
                  Select page
                </label>
                <button
                  type="button"
                  className="owner-chip action-chip"
                  disabled={selectedCount === 0}
                  onClick={() => deleteContacts(selectedContactIds)}
                >
                  Delete Selected
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {loading ? (
          <p className="muted">Loading contacts...</p>
        ) : filteredContacts.length === 0 ? (
          <p className="muted">No contacts yet.</p>
        ) : (
          <>
            <div className="contacts-pagination">
              <label>
                Records per page
                <input
                  className="contacts-page-slider"
                  type="range"
                  min={pageSizeStops[0]}
                  max={pageSizeStops[pageSizeStops.length - 1]}
                  step="1"
                  value={pageSize}
                  list="contacts-page-size-stops"
                  onChange={(event) => setPageSize(snapPageSize(event.target.value))}
                />
                <datalist id="contacts-page-size-stops">
                  {pageSizeStops.map((stop) => (
                    <option key={stop} value={stop} />
                  ))}
                </datalist>
                <span className="toolbar-count">{pageSize} per page</span>
              </label>
              <div className="contacts-pagination-controls">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                  disabled={safeCurrentPage === 1}
                  aria-label="Previous page"
                >
                  ←
                </button>
                <label>
                  Page
                  <select
                    value={safeCurrentPage}
                    onChange={(event) => setCurrentPage(Number(event.target.value))}
                  >
                    {pageOptions.map((page) => (
                      <option key={page} value={page}>
                        {page}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="muted">of {totalPages}</span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                  disabled={safeCurrentPage === totalPages}
                  aria-label="Next page"
                >
                  →
                </button>
              </div>
            </div>

            <div className="db-table-wrapper">
              <table className="db-table contacts-table">
              <thead>
                <tr>
                  <th className="db-check">
                    {selectionMode ? (
                      <label className="message-select" aria-label="Select all visible contacts">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                        />
                      </label>
                    ) : null}
                  </th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Company</th>
                  <th>Phones</th>
                  <th>LinkedIn</th>
                  <th>Source</th>
                  <th>Imported At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginatedContacts.map((contact) => {
                  const isSelected = selectedContactIds.includes(contact.id);
                  const menuOpen = contactMenuId === contact.id;

                  return (
                    <tr
                      key={contact.id}
                      className={`contacts-row ${selectionMode ? "selectable" : ""} ${
                        isSelected ? "selected" : ""
                      }`}
                      onClick={() => {
                        if (selectionMode) {
                          toggleContactSelection(contact.id);
                          return;
                        }
                        setContactMenuId((prev) => (prev === contact.id ? "" : contact.id));
                      }}
                    >
                      <td className="db-check">
                        {selectionMode ? (
                          <label
                            className="message-select"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleContactSelection(contact.id)}
                            />
                          </label>
                        ) : null}
                      </td>
                    <td>{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "—"}</td>
                    <td>{contact.email || "—"}</td>
                    <td>{contact.company || "—"}</td>
                    <td>{Array.isArray(contact.phoneNumbers) ? contact.phoneNumbers.join(", ") : "—"}</td>
                    <td>
                      {Array.isArray(contact.linkedInProfiles) && contact.linkedInProfiles.length > 0
                        ? contact.linkedInProfiles.join(", ")
                        : "—"}
                    </td>
                    <td>
                      {contact.sourceDetails
                        ? JSON.stringify(contact.sourceDetails)
                        : contact.source || "manual"}
                    </td>
                    <td>
                      {contact.importedAt
                        ? new Date(contact.importedAt).toLocaleString()
                        : "—"}
                    </td>
                      <td>
                        <div className="message-menu contact-menu">
                          <button
                            type="button"
                            className="message-menu-trigger"
                            aria-label="Contact actions"
                            aria-expanded={menuOpen}
                            onClick={(event) => {
                              event.stopPropagation();
                              setContactMenuId((prev) => (prev === contact.id ? "" : contact.id));
                            }}
                          >
                            ...
                          </button>
                          {menuOpen ? (
                            <div
                              className="message-menu-panel"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="message-menu-action select"
                                data-label="Select"
                                aria-label="Select"
                                onClick={() => runContactMenuAction(contact.id, "select")}
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
                                onClick={() => runContactMenuAction(contact.id, "delete")}
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
                                onClick={() => runContactMenuAction(contact.id, "bookmark")}
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
                                onClick={() => runContactMenuAction(contact.id, "archive")}
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
                                onClick={() => runContactMenuAction(contact.id, "tag")}
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </section>
  );
}
