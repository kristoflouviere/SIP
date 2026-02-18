import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const safeId = (prefix) => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const formatBytes = (value) => {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
};

const normalizeContactName = (contact) => {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
  return name || contact.email || contact.phoneNumbers?.[0] || "Unnamed contact";
};

const cleanString = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isMediaFile = (file) => {
  if (!file) {
    return false;
  }
  return file.type.startsWith("image/") || file.type.startsWith("video/");
};

const mediaPickerTypes = [
  {
    description: "Images and videos",
    accept: {
      "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic"],
      "video/*": [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"]
    }
  }
];

function ComposeAttachmentsControl({
  baseUrl,
  ownerNumber,
  counterparty,
  disabled = false,
  resetToken = 0,
  onAttachmentIdsChange,
  onInsertText,
  onLocationSelected,
  onSendContactNow
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeModal, setActiveModal] = useState("");
  const [locationMenuOpen, setLocationMenuOpen] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const rootRef = useRef(null);

  const [selectedAttachments, setSelectedAttachments] = useState([]);

  const [fileUploads, setFileUploads] = useState([]);
  const [fileModalError, setFileModalError] = useState("");

  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState("");
  const [contactsPane, setContactsPane] = useState("all");
  const [contactsSearch, setContactsSearch] = useState("");
  const [contactsTagFilter, setContactsTagFilter] = useState("all");
  const [contactsTagMenuOpen, setContactsTagMenuOpen] = useState(false);
  const [contactsSort, setContactsSort] = useState("recent");
  const [attachedContactIds, setAttachedContactIds] = useState([]);
  const [contactAttachmentMap, setContactAttachmentMap] = useState({});

  const [mediaItems, setMediaItems] = useState([]);
  const [mediaSearch, setMediaSearch] = useState("");
  const [mediaView, setMediaView] = useState("grid");
  const [mediaError, setMediaError] = useState("");

  const [cameraDevices, setCameraDevices] = useState([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [recordingVideo, setRecordingVideo] = useState(false);
  const [cameraPreviewUrl, setCameraPreviewUrl] = useState("");
  const [cameraPhotoUrl, setCameraPhotoUrl] = useState("");

  const streamRef = useRef(null);
  const previewVideoRef = useRef(null);
  const recorderRef = useRef(null);
  const recorderChunksRef = useRef([]);

  const [locationState, setLocationState] = useState({ loading: false, error: "" });

  useEffect(() => {
    if (typeof onAttachmentIdsChange === "function") {
      onAttachmentIdsChange(selectedAttachments.map((item) => item.id));
    }
  }, [onAttachmentIdsChange, selectedAttachments]);

  useEffect(() => {
    setSelectedAttachments([]);
    setFileUploads([]);
    setAttachedContactIds([]);
    setContactAttachmentMap({});
    setMediaItems((prev) => {
      prev.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      });
      return [];
    });
    setLocationState({ loading: false, error: "" });
    setLocationMenuOpen(false);
  }, [resetToken]);

  const closeModal = () => setActiveModal("");

  const openModal = (name) => {
    setMenuOpen(false);
    setLocationMenuOpen(false);
    setGlobalError("");
    setActiveModal(name);
  };

  useEffect(() => {
    const handleClick = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setLocationMenuOpen(false);
        setActiveModal("");
      }
    };

    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (cameraPreviewUrl) {
        URL.revokeObjectURL(cameraPreviewUrl);
      }
      if (cameraPhotoUrl) {
        URL.revokeObjectURL(cameraPhotoUrl);
      }
      mediaItems.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      });
    };
  }, [cameraPhotoUrl, cameraPreviewUrl, mediaItems]);

  const addSelectedAttachments = useCallback((attachments) => {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return;
    }
    setSelectedAttachments((prev) => {
      const existingIds = new Set(prev.map((item) => item.id));
      const next = [...prev];
      attachments.forEach((attachment) => {
        if (!existingIds.has(attachment.id)) {
          next.push({
            id: attachment.id,
            kind: attachment.kind,
            label: attachment.fileName || attachment.metadata?.label || attachment.id
          });
        }
      });
      return next;
    });
  }, []);

  const removeSelectedAttachment = useCallback((attachmentId) => {
    setSelectedAttachments((prev) => prev.filter((item) => item.id !== attachmentId));
  }, []);

  const uploadFiles = useCallback(
    async ({ files, kind, onStatusPatch }) => {
      if (!ownerNumber || !counterparty) {
        throw new Error("Select a conversation before attaching files.");
      }
      if (!Array.isArray(files) || files.length === 0) {
        return [];
      }

      const formData = new FormData();
      formData.append("owner", ownerNumber);
      formData.append("counterparty", counterparty);
      formData.append("kind", kind);
      files.forEach((file) => formData.append("files", file));

      if (typeof onStatusPatch === "function") {
        onStatusPatch({ status: "Uploading", progress: 25 });
      }

      const response = await fetch(`${baseUrl}/attachments/upload`, {
        method: "POST",
        body: formData
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Attachment upload failed");
      }

      const created = data.attachments || [];
      addSelectedAttachments(created);

      if (typeof onStatusPatch === "function") {
        onStatusPatch({ status: "Uploaded", progress: 100, attachments: created });
      }

      return created;
    },
    [addSelectedAttachments, baseUrl, counterparty, ownerNumber]
  );

  const queueFiles = useCallback(
    async (files) => {
      if (!files?.length) {
        return;
      }
      setFileModalError("");
      setGlobalError("");

      const pending = files.map((file) => ({
        localId: safeId("file"),
        name: file.name,
        size: file.size,
        status: "Queued",
        progress: 0,
        attachmentId: ""
      }));

      setFileUploads((prev) => [...pending, ...prev]);

      for (const item of pending) {
        const originalFile = files.find((file) => file.name === item.name && file.size === item.size);
        if (!originalFile) {
          continue;
        }

        try {
          const created = await uploadFiles({
            files: [originalFile],
            kind: "FILE",
            onStatusPatch: ({ status, progress, attachments }) => {
              setFileUploads((prev) =>
                prev.map((row) =>
                  row.localId === item.localId
                    ? {
                        ...row,
                        status: status || row.status,
                        progress: Number.isFinite(progress) ? progress : row.progress,
                        attachmentId: attachments?.[0]?.id || row.attachmentId
                      }
                    : row
                )
              );
            }
          });

          if (created[0]?.id) {
            setFileUploads((prev) =>
              prev.map((row) =>
                row.localId === item.localId
                  ? {
                      ...row,
                      attachmentId: created[0].id
                    }
                  : row
              )
            );
          }
        } catch (error) {
          setFileUploads((prev) =>
            prev.map((row) =>
              row.localId === item.localId
                ? {
                    ...row,
                    status: "Failed",
                    progress: 0
                  }
                : row
            )
          );
          setFileModalError(error.message || "Unable to upload file");
        }
      }
    },
    [uploadFiles]
  );

  const chooseFiles = async () => {
    setFileModalError("");
    if (!window.showOpenFilePicker) {
      setFileModalError("Choose files is not supported in this browser. Use drag and drop.");
      return;
    }
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      const pickedFiles = await Promise.all(handles.map((handle) => handle.getFile()));
      await queueFiles(pickedFiles);
    } catch (error) {
      if (error?.name !== "AbortError") {
        setFileModalError("Unable to choose files from location.");
      }
    }
  };

  const handleFileDrop = async (event) => {
    event.preventDefault();
    const dropped = Array.from(event.dataTransfer?.files || []);
    await queueFiles(dropped);
  };

  const loadContacts = useCallback(async () => {
    setContactsLoading(true);
    setContactsError("");
    try {
      const response = await fetch(`${baseUrl}/contacts?limit=10000`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Unable to load contacts");
      }
      setContacts(data.contacts || []);
    } catch (error) {
      setContactsError(error.message || "Unable to load contacts");
    } finally {
      setContactsLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    if (activeModal === "contact" && contacts.length === 0 && !contactsLoading) {
      loadContacts();
    }
  }, [activeModal, contacts.length, contactsLoading, loadContacts]);

  const favoritesContactIds = useMemo(
    () =>
      contacts
        .filter((contact) => {
          const tags = contact?.sourceDetails?.tags;
          return (
            Array.isArray(tags) && tags.some((tag) => String(tag).toLowerCase() === "favorite")
          );
        })
        .map((contact) => contact.id),
    [contacts]
  );

  const taggedContactIds = useMemo(
    () =>
      contacts
        .filter((contact) => {
          const tags = contact?.sourceDetails?.tags;
          return Array.isArray(tags) && tags.some((tag) => String(tag).toLowerCase() === "tagged");
        })
        .map((contact) => contact.id),
    [contacts]
  );

  const availableContactTags = useMemo(() => {
    const tags = new Set();
    contacts.forEach((contact) => {
      const sourceTags = Array.isArray(contact?.sourceDetails?.tags)
        ? contact.sourceDetails.tags
        : [];
      sourceTags.forEach((tag) => {
        const cleaned = cleanString(tag)?.toLowerCase();
        if (cleaned) {
          tags.add(cleaned);
        }
      });
    });

    return ["all", "untagged", ...Array.from(tags).sort((a, b) => a.localeCompare(b))];
  }, [contacts]);

  const filteredContacts = useMemo(() => {
    const term = contactsSearch.trim().toLowerCase();
    let list = contacts;

    if (contactsPane === "favorites") {
      list = contacts.filter((contact) => favoritesContactIds.includes(contact.id));
    } else if (contactsPane === "tagged") {
      list = contacts.filter((contact) => taggedContactIds.includes(contact.id));
    }

    if (contactsTagFilter !== "all") {
      list = list.filter((contact) => {
        const tags = Array.isArray(contact?.sourceDetails?.tags)
          ? contact.sourceDetails.tags
              .map((tag) => cleanString(tag)?.toLowerCase())
              .filter(Boolean)
          : [];

        if (contactsTagFilter === "untagged") {
          return tags.length === 0;
        }

        return tags.includes(contactsTagFilter);
      });
    }

    if (term) {
      list = list.filter((contact) => {
        const values = [
          normalizeContactName(contact),
          contact.email,
          contact.company,
          contact.address,
          ...(Array.isArray(contact.phoneNumbers) ? contact.phoneNumbers : [])
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return values.includes(term);
      });
    }

    const sorted = [...list].sort((left, right) => {
      if (contactsSort === "alpha") {
        return normalizeContactName(left).localeCompare(normalizeContactName(right));
      }

      const leftTime = new Date(left?.createdAt || left?.updatedAt || 0).getTime() || 0;
      const rightTime = new Date(right?.createdAt || right?.updatedAt || 0).getTime() || 0;
      return rightTime - leftTime;
    });

    return sorted;
  }, [
    contacts,
    contactsPane,
    contactsSearch,
    contactsSort,
    contactsTagFilter,
    favoritesContactIds,
    taggedContactIds
  ]);

  const attachedContacts = useMemo(
    () => contacts.filter((item) => attachedContactIds.includes(item.id)),
    [attachedContactIds, contacts]
  );

  const attachContact = async (contactId) => {
    if (!ownerNumber || !counterparty) {
      setContactsError("Select a conversation before attaching contacts.");
      return;
    }

    try {
      let createdAttachmentId = contactAttachmentMap[contactId] || "";
      let createdAttachment = null;

      if (!createdAttachmentId) {
        const response = await fetch(`${baseUrl}/attachments/contact`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner: ownerNumber, counterparty, contactIds: [contactId] })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Unable to attach contact");
        }

        const created = data.attachments || [];
        createdAttachment = created[0] || null;
        createdAttachmentId = createdAttachment?.id || "";
        if (!createdAttachmentId) {
          throw new Error("Unable to create contact attachment");
        }

        setContactAttachmentMap((prev) => ({ ...prev, [contactId]: createdAttachmentId }));
      }

      if (typeof onSendContactNow === "function") {
        await onSendContactNow({ attachmentIds: [createdAttachmentId] });
        setContactsError("");
        setActiveModal("");
        setMenuOpen(false);
        return;
      }

      setAttachedContactIds((prev) => (prev.includes(contactId) ? prev : [...prev, contactId]));
      addSelectedAttachments(
        createdAttachment
          ? [createdAttachment]
          : [
              {
                id: createdAttachmentId,
                kind: "CONTACT",
                fileName: normalizeContactName(contacts.find((item) => item.id === contactId) || {})
              }
            ]
      );
      setContactsError("");
    } catch (error) {
      setContactsError(error.message || "Unable to send contact");
    }
  };

  const detachContact = (contactId) => {
    setAttachedContactIds((prev) => prev.filter((id) => id !== contactId));
    const attachmentId = contactAttachmentMap[contactId];
    if (attachmentId) {
      removeSelectedAttachment(attachmentId);
    }
  };

  const addMediaFiles = (files, kind = "MEDIA") => {
    if (!files?.length) {
      return;
    }
    const mapped = files
      .filter((file) => isMediaFile(file))
      .map((file) => ({
        id: safeId("media"),
        name: file.name,
        size: file.size,
        type: file.type,
        file,
        kind,
        previewUrl: URL.createObjectURL(file),
        attachmentId: ""
      }));

    if (mapped.length === 0) {
      setMediaError("No image/video files detected.");
      return;
    }

    setMediaError("");
    setMediaItems((prev) => [...mapped, ...prev]);
  };

  const chooseMediaFolder = async () => {
    setMediaError("");
    if (!window.showDirectoryPicker) {
      setMediaError("Folder selection is not supported in this browser. Use drag and drop.");
      return;
    }
    try {
      const directoryHandle = await window.showDirectoryPicker();
      const files = [];
      for await (const entry of directoryHandle.values()) {
        if (entry.kind === "file") {
          const file = await entry.getFile();
          if (isMediaFile(file)) {
            files.push(file);
          }
        }
      }
      addMediaFiles(files, "MEDIA");
    } catch (error) {
      if (error?.name !== "AbortError") {
        setMediaError("Unable to read selected folder.");
      }
    }
  };

  const chooseMediaFiles = async () => {
    setMediaError("");
    if (!window.showOpenFilePicker) {
      setMediaError("Media picker is not supported in this browser. Use drag and drop.");
      return;
    }
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: mediaPickerTypes,
        excludeAcceptAllOption: false
      });
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      addMediaFiles(files, "MEDIA");
    } catch (error) {
      if (error?.name !== "AbortError") {
        setMediaError("Unable to choose media files.");
      }
    }
  };

  const handleMediaDrop = (event) => {
    event.preventDefault();
    const dropped = Array.from(event.dataTransfer?.files || []);
    addMediaFiles(dropped, "MEDIA");
  };

  const filteredMedia = useMemo(() => {
    const term = mediaSearch.trim().toLowerCase();
    if (!term) {
      return mediaItems;
    }
    return mediaItems.filter((item) => item.name.toLowerCase().includes(term));
  }, [mediaItems, mediaSearch]);

  const attachMedia = async (mediaId) => {
    const media = mediaItems.find((item) => item.id === mediaId);
    if (!media) {
      return;
    }

    if (media.attachmentId) {
      addSelectedAttachments([
        {
          id: media.attachmentId,
          kind: media.kind,
          fileName: media.name
        }
      ]);
      return;
    }

    try {
      const created = await uploadFiles({ files: [media.file], kind: media.kind || "MEDIA" });
      const attachmentId = created[0]?.id || "";
      if (attachmentId) {
        setMediaItems((prev) =>
          prev.map((item) =>
            item.id === mediaId
              ? {
                  ...item,
                  attachmentId
                }
              : item
          )
        );
      }
    } catch (error) {
      setMediaError(error.message || "Unable to attach media.");
    }
  };

  const detachMedia = (mediaId) => {
    const media = mediaItems.find((item) => item.id === mediaId);
    if (media?.attachmentId) {
      removeSelectedAttachment(media.attachmentId);
    }
  };

  const attachedMedia = useMemo(
    () => mediaItems.filter((item) => selectedAttachments.some((att) => att.id === item.attachmentId)),
    [mediaItems, selectedAttachments]
  );

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const loadCameraDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      setCameraDevices(cameras);
      if (!selectedCameraId && cameras[0]?.deviceId) {
        setSelectedCameraId(cameras[0].deviceId);
      }
    } catch {
      setCameraError("Unable to enumerate cameras.");
    }
  }, [selectedCameraId]);

  const startCamera = useCallback(
    async (deviceId) => {
      setCameraError("");
      stopCameraStream();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? {
                deviceId: { exact: deviceId }
              }
            : true,
          audio: true
        });
        streamRef.current = stream;
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
        }
        setCameraReady(true);
        await loadCameraDevices();
      } catch (error) {
        setCameraReady(false);
        setCameraError(error?.message || "Camera permission denied or unavailable.");
      }
    },
    [loadCameraDevices]
  );

  useEffect(() => {
    if (activeModal === "camera") {
      startCamera(selectedCameraId);
    } else {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      setRecordingVideo(false);
      stopCameraStream();
    }

    return () => {
      if (activeModal !== "camera") {
        stopCameraStream();
      }
    };
  }, [activeModal, selectedCameraId, startCamera]);

  const takePhoto = async () => {
    if (!previewVideoRef.current || !cameraReady) {
      return;
    }

    const video = previewVideoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      return;
    }

    if (cameraPhotoUrl) {
      URL.revokeObjectURL(cameraPhotoUrl);
    }

    const nextPhotoUrl = URL.createObjectURL(blob);
    setCameraPhotoUrl(nextPhotoUrl);

    const photoFile = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
    addMediaFiles([photoFile], "CAMERA");
  };

  const startVideoRecording = () => {
    if (!streamRef.current || recordingVideo) {
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setCameraError("Video recording is not supported in this browser.");
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";

    const recorder = new MediaRecorder(streamRef.current, { mimeType });
    recorderChunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recorderChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(recorderChunksRef.current, { type: mimeType });
      if (blob.size === 0) {
        return;
      }

      if (cameraPreviewUrl) {
        URL.revokeObjectURL(cameraPreviewUrl);
      }
      const nextPreviewUrl = URL.createObjectURL(blob);
      setCameraPreviewUrl(nextPreviewUrl);
      const clipFile = new File([blob], `clip-${Date.now()}.webm`, { type: mimeType });
      addMediaFiles([clipFile], "CAMERA");
      setRecordingVideo(false);
    };

    recorderRef.current = recorder;
    recorder.start();
    setRecordingVideo(true);
  };

  const stopVideoRecording = () => {
    if (recorderRef.current && recordingVideo) {
      recorderRef.current.stop();
    }
  };

  const requestCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      return Promise.reject(new Error("Geolocation is not supported in this browser."));
    }

    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy
          });
        },
        (error) => reject(new Error(error.message || "Unable to retrieve current location.")),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }, []);

  const buildLocationLink = useCallback((mapApp, latitude, longitude) => {
    if (mapApp === "waze") {
      return `https://www.waze.com/ul?ll=${latitude},${longitude}&navigate=yes`;
    }
    if (mapApp === "microsoft") {
      return `https://www.bing.com/maps?cp=${latitude}~${longitude}&lvl=16`;
    }
    return `https://www.google.com/maps?q=${latitude},${longitude}`;
  }, []);

  const handleLocationInsert = useCallback(
    async (mapApp) => {
      setLocationMenuOpen(false);
      setMenuOpen(false);

      if (!ownerNumber || !counterparty) {
        setGlobalError("Select a conversation before sharing location.");
        return;
      }

      setLocationState({ loading: true, error: "" });
      setGlobalError("");

      try {
        const coords = await requestCurrentLocation();
        const locationLink = buildLocationLink(mapApp, coords.latitude, coords.longitude);

        if (typeof onInsertText === "function") {
          onInsertText(locationLink);
        }

        if (typeof onLocationSelected === "function") {
          onLocationSelected({
            mapApp,
            url: locationLink,
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: coords.accuracy
          });
        }

        setLocationState({ loading: false, error: "" });
      } catch (error) {
        const message = error?.message || "Unable to retrieve current location.";
        setLocationState({ loading: false, error: message });
        setGlobalError(message);
      }
    },
    [
      buildLocationLink,
      counterparty,
      onInsertText,
      onLocationSelected,
      ownerNumber,
      requestCurrentLocation
    ]
  );

  const selectedCount = selectedAttachments.length;

  const renderFileModal = () => (
    <>
      <div className="attachment-modal-actions">
        <button type="button" className="button secondary" onClick={chooseFiles}>
          Choose File Location
        </button>
      </div>
      <div
        className="attachment-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleFileDrop}
      >
        Drag & drop files here
      </div>
      {fileModalError ? <p className="status-text error">{fileModalError}</p> : null}
      <div className="attachment-upload-list">
        {fileUploads.length === 0 ? (
          <p className="muted">No files selected yet.</p>
        ) : (
          fileUploads.map((item) => (
            <div key={item.localId} className="attachment-upload-row">
              <div className="attachment-upload-head">
                <strong>{item.name}</strong>
                <span>
                  {formatBytes(item.size)} · {item.status}
                </span>
              </div>
              <div className="attachment-progress-track">
                <div className="attachment-progress-fill" style={{ width: `${item.progress}%` }} />
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );

  const renderContactModal = () => (
    <div className="attachment-split">
      <aside className="attachment-left-nav">
        <button
          type="button"
          className={`attachment-pane-button ${contactsPane === "all" ? "active" : ""}`}
          onClick={() => setContactsPane("all")}
        >
          <svg viewBox="0 0 24 24" role="img" focusable="false">
            <path
              d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"
              fill="currentColor"
            />
          </svg>
          All
        </button>
        <button
          type="button"
          className={`attachment-pane-button ${contactsPane === "favorites" ? "active" : ""}`}
          onClick={() => setContactsPane("favorites")}
        >
          <svg viewBox="0 0 24 24" role="img" focusable="false">
            <path
              d="M12 3l2.9 5.9L21 9.8l-4.5 4.4 1.1 6.3L12 17.8 6.4 20.5l1.1-6.3L3 9.8l6.1-.9L12 3z"
              fill="currentColor"
            />
          </svg>
          Favorites
        </button>
        <button
          type="button"
          className={`attachment-pane-button ${contactsPane === "tagged" ? "active" : ""}`}
          onClick={() => setContactsPane("tagged")}
        >
          <svg viewBox="0 0 24 24" role="img" focusable="false">
            <path
              d="M3 12l9-9h7a2 2 0 012 2v7l-9 9-9-9zM16 8a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"
              fill="currentColor"
            />
          </svg>
          Tagged
        </button>
      </aside>
      <section className="attachment-main-pane">
        <div className="attachment-bubbles">
          {attachedContacts.length > 0 ? (
            attachedContacts.map((contact) => (
              <button
                key={contact.id}
                type="button"
                className="attachment-bubble"
                onClick={() => detachContact(contact.id)}
                title="Remove attached contact"
              >
                {normalizeContactName(contact)}
                <span aria-hidden="true">×</span>
              </button>
            ))
          ) : (
            <span className="muted">Attached contacts appear here.</span>
          )}
        </div>
        <div className="attachment-modal-toolbar contact-toolbar">
          <input
            className="attachment-search"
            type="search"
            placeholder="Search contacts"
            value={contactsSearch}
            onChange={(event) => setContactsSearch(event.target.value)}
          />
          <div className="contact-toolbar-controls">
            <div className="contact-tag-filter">
              <button
                type="button"
                className="button secondary"
                onClick={() => setContactsTagMenuOpen((prev) => !prev)}
              >
                Filter Tags
              </button>
              {contactsTagMenuOpen ? (
                <div className="contact-tag-filter-menu">
                  {availableContactTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`contact-tag-filter-option ${
                        contactsTagFilter === tag ? "active" : ""
                      }`}
                      onClick={() => {
                        setContactsTagFilter(tag);
                        setContactsTagMenuOpen(false);
                      }}
                    >
                      {tag === "all"
                        ? "All tags"
                        : tag === "untagged"
                          ? "Untagged"
                          : tag}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <label className="contact-sort-label">
              Sort
              <select
                className="input"
                value={contactsSort}
                onChange={(event) => setContactsSort(event.target.value)}
              >
                <option value="recent">Most recently added</option>
                <option value="alpha">Alphabetical (A-Z)</option>
              </select>
            </label>
          </div>
        </div>
        <div className="attachment-scroll-window">
          {contactsLoading ? <p className="muted">Loading contacts…</p> : null}
          {contactsError ? <p className="status-text error">{contactsError}</p> : null}
          {!contactsLoading && !contactsError ? (
            filteredContacts.length > 0 ? (
              filteredContacts.map((contact) => (
                <div key={contact.id} className="attachment-contact-row">
                  <button
                    type="button"
                    className="message-menu-action select"
                    data-label="Attach contact"
                    aria-label="Attach contact"
                    onClick={() => attachContact(contact.id)}
                  >
                    <svg viewBox="0 0 24 24" role="img" focusable="false">
                      <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" fill="currentColor" />
                    </svg>
                  </button>
                  <div>
                    <p>{normalizeContactName(contact)}</p>
                    <small>{contact.email || contact.phoneNumbers?.[0] || "No email/phone"}</small>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">No contacts found for this view/filter.</p>
            )
          ) : null}
        </div>
      </section>
    </div>
  );

  const renderMediaModal = () => (
    <>
      <div className="attachment-bubbles">
        {attachedMedia.length > 0 ? (
          attachedMedia.map((item) => (
            <button
              key={item.id}
              type="button"
              className="attachment-bubble"
              onClick={() => detachMedia(item.id)}
              title="Remove attached media"
            >
              {item.name}
              <span aria-hidden="true">×</span>
            </button>
          ))
        ) : (
          <span className="muted">Attached images/videos appear here.</span>
        )}
      </div>
      <div className="attachment-modal-toolbar">
        <input
          className="attachment-search"
          type="search"
          placeholder="Search images/videos"
          value={mediaSearch}
          onChange={(event) => setMediaSearch(event.target.value)}
        />
        <button
          type="button"
          className="button secondary"
          onClick={() => setMediaView((prev) => (prev === "grid" ? "list" : "grid"))}
        >
          View: {mediaView === "grid" ? "Grid" : "List"}
        </button>
      </div>
      <div className="attachment-modal-actions">
        <button type="button" className="button secondary" onClick={chooseMediaFolder}>
          Choose Folder
        </button>
        <button type="button" className="button secondary" onClick={chooseMediaFiles}>
          Add Media Files
        </button>
      </div>
      <div
        className="attachment-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleMediaDrop}
      >
        Drag & drop images/videos here
      </div>
      {mediaError ? <p className="status-text error">{mediaError}</p> : null}
      <div className={`attachment-media-library ${mediaView}`}>
        {filteredMedia.length > 0 ? (
          filteredMedia.map((item) => (
            <div key={item.id} className="attachment-media-card">
              {item.type.startsWith("video/") ? (
                <video src={item.previewUrl} muted playsInline controls={mediaView === "list"} />
              ) : (
                <img src={item.previewUrl} alt={item.name} />
              )}
              <div className="attachment-media-meta">
                <button
                  type="button"
                  className="message-menu-action select"
                  data-label="Attach media"
                  aria-label="Attach media"
                  onClick={() => attachMedia(item.id)}
                >
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" fill="currentColor" />
                  </svg>
                </button>
                <div>
                  <p>{item.name}</p>
                  <small>{formatBytes(item.size)}</small>
                </div>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">No media loaded.</p>
        )}
      </div>
    </>
  );

  const renderCameraModal = () => (
    <>
      <div className="attachment-modal-toolbar">
        <label>
          Camera
          <select
            value={selectedCameraId}
            onChange={(event) => setSelectedCameraId(event.target.value)}
            className="input"
          >
            {cameraDevices.length === 0 ? <option value="">Default camera</option> : null}
            {cameraDevices.map((device, index) => (
              <option key={device.deviceId || `${index}`} value={device.deviceId}>
                {device.label || `Camera ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="camera-preview-wrap">
        <video ref={previewVideoRef} autoPlay muted playsInline className="camera-live-preview" />
      </div>
      <div className="attachment-modal-actions">
        <button type="button" className="button secondary" onClick={takePhoto} disabled={!cameraReady}>
          Take Photo
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={startVideoRecording}
          disabled={!cameraReady || recordingVideo}
        >
          Record Video
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={stopVideoRecording}
          disabled={!recordingVideo}
        >
          Stop
        </button>
      </div>
      {cameraError ? <p className="status-text error">{cameraError}</p> : null}
      <div className="camera-captures">
        {cameraPhotoUrl ? (
          <div className="camera-capture-card">
            <p>Photo Preview</p>
            <img src={cameraPhotoUrl} alt="Captured" />
          </div>
        ) : null}
        {cameraPreviewUrl ? (
          <div className="camera-capture-card">
            <p>Video Preview</p>
            <video src={cameraPreviewUrl} controls playsInline />
          </div>
        ) : null}
      </div>
    </>
  );

  return (
    <div className="composer-attachment-root" ref={rootRef}>
      {locationState.loading ? (
        <button
          type="button"
          className="thread-location-loading"
          aria-label="Determining location"
          disabled
        >
          <span className="thread-location-spinner" aria-hidden="true" />
          Determining Location
        </button>
      ) : (
        <button
          type="button"
          className="thread-mic thread-plus"
          aria-label="Open attachment actions"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((prev) => !prev)}
          disabled={disabled}
        >
          <svg viewBox="0 0 24 24" role="img" focusable="false">
            <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" fill="currentColor" />
          </svg>
          {selectedCount > 0 ? <span className="thread-plus-count">{selectedCount}</span> : null}
        </button>
      )}

      {menuOpen ? (
        <div className="message-menu-panel composer-plus-menu">
          <button
            type="button"
            className="message-menu-action archive"
            data-label="Send a file"
            aria-label="Send a file"
            onClick={() => openModal("file")}
          >
            <svg viewBox="0 0 24 24" role="img" focusable="false">
              <path
                d="M6 2h8l4 4v16H6V2zm8 1.5V7h3.5L14 3.5zM8 11h8v1.8H8V11zm0 4h8v1.8H8V15z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            className="message-menu-action select"
            data-label="Send a contact"
            aria-label="Send a contact"
            onClick={() => openModal("contact")}
          >
            <svg viewBox="0 0 24 24" role="img" focusable="false">
              <path
                d="M12 3a5 5 0 100 10 5 5 0 000-10zm0 12c-4.1 0-7.8 2.2-9 5.5-.2.6.2 1.3.9 1.3h16.2c.7 0 1.1-.7.9-1.3C19.8 17.2 16.1 15 12 15z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            className="message-menu-action tag"
            data-label="Send photo / video"
            aria-label="Send photo / video"
            onClick={() => openModal("media")}
          >
            <svg viewBox="0 0 24 24" role="img" focusable="false">
              <path
                d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm2 3a2.1 2.1 0 100 4.2A2.1 2.1 0 006 7zm14 11V8l-4.2 4.2-2.6-2.6L4 18h16z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            className="message-menu-action delete"
            data-label="Take photo / video"
            aria-label="Take photo / video"
            onClick={() => openModal("camera")}
          >
            <svg viewBox="0 0 24 24" role="img" focusable="false">
              <path
                d="M4 7h4l1.6-2h4.8L16 7h4a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2zm8 3.2a4.8 4.8 0 100 9.6 4.8 4.8 0 000-9.6zm0 2a2.8 2.8 0 110 5.6 2.8 2.8 0 010-5.6z"
                fill="currentColor"
              />
            </svg>
          </button>
          <div className="composer-location-trigger">
            <button
              type="button"
              className="message-menu-action bookmark"
              data-label="Insert location link"
              aria-label="Insert location link"
              onClick={() => {
                setActiveModal("");
                setGlobalError("");
                setLocationMenuOpen((prev) => !prev);
              }}
            >
              <svg viewBox="0 0 24 24" role="img" focusable="false">
                <path
                  d="M12 2a7 7 0 00-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6a2.5 2.5 0 010 5.5z"
                  fill="currentColor"
                />
              </svg>
            </button>

            {locationMenuOpen ? (
              <div className="message-menu-panel composer-location-menu" role="menu" aria-label="Choose maps app">
                <button
                  type="button"
                  className="message-menu-action archive"
                  data-label="Google Maps"
                  aria-label="Google Maps"
                  onClick={() => handleLocationInsert("google")}
                  disabled={locationState.loading}
                >
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <path
                      d="M6 4l4-1.5L14 4l4-1.5 2 1v16l-4 1.5L10 19l-4 1.5-2-1V4.5L6 4zm4 1.2v13.6l4 1.2V6.4L10 5.2z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="message-menu-action tag"
                  data-label="Waze"
                  aria-label="Waze"
                  onClick={() => handleLocationInsert("waze")}
                  disabled={locationState.loading}
                >
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <path
                      d="M12 4c-4.4 0-8 3.1-8 7 0 2.7 1.7 5.1 4.2 6.3.4 1 1.4 1.7 2.6 1.7 1 0 1.9-.5 2.4-1.3h1.6c.5.8 1.4 1.3 2.4 1.3 1.6 0 2.9-1.3 2.9-2.9 0-.5-.1-.9-.3-1.3 1.5-1.2 2.4-3 2.4-4.8 0-3.9-3.6-7-8-7zm-2.1 7.5a1.4 1.4 0 110-2.8 1.4 1.4 0 010 2.8zm4.2 0a1.4 1.4 0 110-2.8 1.4 1.4 0 010 2.8z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="message-menu-action select"
                  data-label="Microsoft Maps"
                  aria-label="Microsoft Maps"
                  onClick={() => handleLocationInsert("microsoft")}
                  disabled={locationState.loading}
                >
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <path
                      d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {globalError ? <p className="status-text error composer-attachment-error">{globalError}</p> : null}

      {activeModal ? (
        <div className="attachment-modal-backdrop" onClick={closeModal}>
          <div className="attachment-modal" onClick={(event) => event.stopPropagation()}>
            <div className="attachment-modal-header">
              <h3>
                {activeModal === "file" && "Send File"}
                {activeModal === "contact" && "Send Contact"}
                {activeModal === "media" && "Photo / Video Library"}
                {activeModal === "camera" && "Take Photo / Video"}
              </h3>
              <button type="button" className="icon-button" onClick={closeModal} aria-label="Close">
                ×
              </button>
            </div>
            <div className="attachment-modal-content">
              {activeModal === "file" ? renderFileModal() : null}
              {activeModal === "contact" ? renderContactModal() : null}
              {activeModal === "media" ? renderMediaModal() : null}
              {activeModal === "camera" ? renderCameraModal() : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default ComposeAttachmentsControl;
