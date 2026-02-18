import { useEffect, useRef, useState } from "react";

const STOP_PULSE_MS = 2000;

export default function useAudioTranscriptionRecorder({ onTranscribe, onError }) {
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const chunksRef = useRef([]);
  const pulseTimerRef = useRef(null);

  const [phase, setPhase] = useState("idle");
  const [isProcessing, setIsProcessing] = useState(false);

  const isSupported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder !== "undefined";

  const cleanupStream = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  };

  const startPulseReset = () => {
    if (pulseTimerRef.current) {
      clearTimeout(pulseTimerRef.current);
    }
    pulseTimerRef.current = setTimeout(() => {
      setPhase((prev) => (prev === "stop-pulse" ? "idle" : prev));
      pulseTimerRef.current = null;
    }, STOP_PULSE_MS);
  };

  const startRecording = async () => {
    if (!isSupported || isProcessing) {
      return;
    }

    try {
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";

      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        cleanupStream();

        setPhase("stop-pulse");
        startPulseReset();

        if (!audioBlob.size) {
          onError?.("No audio was captured.");
          return;
        }

        setIsProcessing(true);
        try {
          await onTranscribe(audioBlob, mimeType);
        } catch (error) {
          onError?.(error.message || "Transcription failed.");
        } finally {
          setIsProcessing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setPhase("recording");
    } catch (error) {
      cleanupStream();
      setPhase("idle");
      onError?.(error.message || "Unable to start recording.");
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return;
    }

    recorder.stop();
    mediaRecorderRef.current = null;
  };

  const toggleRecording = async () => {
    if (phase === "recording") {
      stopRecording();
      return;
    }

    if (isProcessing) {
      return;
    }

    await startRecording();
  };

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
      }
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        recorder.stop();
      }
      cleanupStream();
    };
  }, []);

  return {
    phase,
    isProcessing,
    isSupported,
    toggleRecording
  };
}
