export default function MicRecordButton({
  phase,
  isProcessing,
  isSupported,
  onToggle
}) {
  const phaseClass = phase === "recording" ? "recording" : phase === "stop-pulse" ? "stop-pulse" : "idle";
  const label = !isSupported
    ? "Microphone recording unsupported"
    : phase === "recording"
      ? "Stop recording"
      : isProcessing
        ? "Transcribing"
        : "Start recording";

  return (
    <button
      type="button"
      className={`thread-mic ${phaseClass}`}
      aria-label={label}
      title={label}
      onClick={onToggle}
      disabled={!isSupported || isProcessing}
    >
      <svg viewBox="0 0 24 24" role="img" focusable="false">
        <path
          d="M12 15a4 4 0 004-4V7a4 4 0 10-8 0v4a4 4 0 004 4zm-7-4a1 1 0 012 0 5 5 0 0010 0 1 1 0 112 0 7 7 0 01-6 6.93V21h3a1 1 0 110 2H8a1 1 0 110-2h3v-3.07A7 7 0 015 11a1 1 0 011-1z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}
