import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PPQN, TimeBase } from "@opendaw/lib-dsp";
import { AnimationFrame } from "@opendaw/lib-dom";
import type { Project } from "@opendaw/studio-core";
import { AudioRegionBox } from "@opendaw/studio-boxes";
import {
  ArrowRightIcon,
  PlayIcon,
  PauseIcon,
  StopIcon,
  UpdateIcon,
  ScissorsIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";
import { createTrackFromAudioBuffer } from "@/lib/trackLoading";
import { initializeOpenDAW } from "@/lib/projectSetup";
import { loadAudioFile } from "@/lib/audioUtils";
import {
  clamp,
  getClipSecondsFromAudioTime,
  getPreviewStartTime,
  getSafeTrimRange,
  shouldRestartPreview
} from "@/lib/samplePreview";
import type { TrackData } from "@/lib/types";

const BPM = 120;
// If VITE_SAMPLE_SERVER_ORIGIN is set to "" at build time (e.g. when bundling
// into the standalone exe where API + UI share an origin), fetches resolve
// relative to the page. Unset → dev default of the local API server on :3847.
const SERVER_ORIGIN_ENV = import.meta.env.VITE_SAMPLE_SERVER_ORIGIN as string | undefined;
const SERVER_ORIGIN = SERVER_ORIGIN_ENV !== undefined ? SERVER_ORIGIN_ENV : "http://127.0.0.1:3847";
const WAVE_HEIGHT = 130;

type VideoInfo = {
  id: string;
  title: string;
  author: string;
  duration: number | null;
  thumbnail: string | null;
};

type DownloadedAudio = {
  fileUrl: string;
  durationSeconds: number;
};

function makeBitCrushCurve(amount: number): Float32Array {
  // amount ∈ [0, 1]. 0 → transparent (16 bits). 1 → heavy (≈1 bit).
  const n = 8192;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const bits = 16 - clamp(amount, 0, 1) * 15;
  const levels = Math.pow(2, bits);
  const stepSize = 2 / levels;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x / stepSize) * stepSize;
  }
  return curve;
}

function formatLcd(value: number): string {
  if (!Number.isFinite(value) || value < 0) value = 0;
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60);
  const cs = Math.floor((value % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function sanitizeFileStem(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "clip";
}

async function requestJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${SERVER_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function ensureAudioCanSeek(audio: HTMLAudioElement): Promise<void> {
  if (audio.readyState >= 1 && Number.isFinite(audio.duration)) return;
  await new Promise<void>((resolve, reject) => {
    const onLoadedMetadata = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not load preview audio"));
    };
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("error", onError);
    audio.load();
  });
}

async function seekAudioElement(audio: HTMLAudioElement, timeSeconds: number): Promise<void> {
  await ensureAudioCanSeek(audio);
  const target = Math.max(0, timeSeconds);
  if (Math.abs(audio.currentTime - target) < 0.02) {
    audio.currentTime = target;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not seek preview audio"));
    };
    const cleanup = () => {
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("error", onError);
    audio.currentTime = target;
  });
}

const HANDLE_HIT_PX = 10;
const CLIP_WAVE_HEIGHT = 70;

const ClipWaveformCanvas: React.FC<{
  audioBuffer: AudioBuffer | null;
  durationSeconds: number;
  selectionStart: number;
  selectionEnd: number;
  playheadSourceSeconds: number;
}> = ({ audioBuffer, durationSeconds, selectionStart, selectionEnd, playheadSourceSeconds }) => {
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef(playheadSourceSeconds);
  playheadRef.current = playheadSourceSeconds;

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    if (!audioBuffer || durationSeconds <= 0) {
      drawAudioBufferWaveform(canvas, null, CLIP_WAVE_HEIGHT, "#E6E6E6", "#0F1113");
      return;
    }
    const sampleRate = audioBuffer.sampleRate;
    const start = clamp(selectionStart, 0, durationSeconds);
    const end = clamp(selectionEnd, start, durationSeconds);
    const sStart = Math.floor(start * sampleRate);
    const sEnd = Math.max(sStart + 1, Math.floor(end * sampleRate));
    drawAudioBufferWaveform(canvas, audioBuffer, CLIP_WAVE_HEIGHT, "#C6FF2E", "#0F1113", sStart, sEnd);
  }, [audioBuffer, durationSeconds, selectionStart, selectionEnd]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || durationSeconds <= 0) return undefined;
    const render = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = CLIP_WAVE_HEIGHT;
      if (width === 0) return;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const start = clamp(selectionStart, 0, durationSeconds);
      const end = clamp(selectionEnd, start, durationSeconds);
      const clipSpan = Math.max(0.0001, end - start);
      // Progress bar background (fills as playback advances through clip)
      const rel = clamp(playheadRef.current - start, 0, clipSpan);
      const progressX = (rel / clipSpan) * width;
      ctx.fillStyle = "rgba(198, 255, 46, 0.08)";
      ctx.fillRect(0, 0, progressX, height);
      // Playhead line in clip-local coordinates
      ctx.strokeStyle = "#FF5A4F";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(progressX, 0);
      ctx.lineTo(progressX, height);
      ctx.stroke();
      // Time ticks at 0%, 25%, 50%, 75%, 100%
      ctx.strokeStyle = "rgba(198, 255, 46, 0.22)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const x = (i / 4) * width;
        ctx.beginPath();
        ctx.moveTo(x, height - 4);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    };
    render();
    const af = AnimationFrame.add(render);
    return () => af.terminate();
  }, [durationSeconds, selectionStart, selectionEnd]);

  return (
    <div style={{ position: "relative", width: "100%", height: CLIP_WAVE_HEIGHT }}>
      <canvas
        ref={waveformCanvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: CLIP_WAVE_HEIGHT, borderRadius: 3 }}
      />
      <canvas
        ref={overlayCanvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: CLIP_WAVE_HEIGHT, pointerEvents: "none" }}
      />
    </div>
  );
};

function drawAudioBufferWaveform(
  canvas: HTMLCanvasElement,
  audioBuffer: AudioBuffer | null,
  height: number,
  color: string,
  bg: string,
  sampleStart?: number,
  sampleEnd?: number
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  if (width <= 0) return;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  if (!audioBuffer) return;
  const data = audioBuffer.getChannelData(0);
  const total = data.length;
  const s0 = Math.max(0, Math.min(total, sampleStart ?? 0));
  const s1 = Math.max(s0 + 1, Math.min(total, sampleEnd ?? total));
  const span = s1 - s0;
  if (span <= 0) return;
  const centerY = height / 2;
  const halfH = height / 2 - 1;
  ctx.fillStyle = color;
  for (let x = 0; x < width; x++) {
    const start = s0 + Math.floor((x / width) * span);
    const end = s0 + Math.floor(((x + 1) / width) * span);
    let min = 1.0;
    let max = -1.0;
    for (let i = start; i < end; i++) {
      const s = data[i];
      if (s < min) min = s;
      if (s > max) max = s;
    }
    if (min > max) { min = 0; max = 0; }
    const top = centerY + min * halfH;
    const bot = centerY + max * halfH;
    ctx.fillRect(x, top, 1, Math.max(1, bot - top));
  }
}

const WaveformSelectionCanvas: React.FC<{
  audioBuffer: AudioBuffer | null;
  durationSeconds: number;
  selectionStart: number;
  selectionEnd: number;
  playheadSourceSeconds: number;
  onSeek: (sourceSeconds: number) => void;
  onTrimStart: (sourceSeconds: number) => void;
  onTrimEnd: (sourceSeconds: number) => void;
}> = ({ audioBuffer, durationSeconds, selectionStart, selectionEnd, playheadSourceSeconds, onSeek, onTrimStart, onTrimEnd }) => {
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef(playheadSourceSeconds);
  playheadRef.current = playheadSourceSeconds;
  const [dragMode, setDragMode] = useState<"seek" | "start" | "end" | null>(null);
  const [hoverMode, setHoverMode] = useState<"seek" | "start" | "end">("seek");

  const secondsFromClientX = useCallback((clientX: number) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || durationSeconds <= 0) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * durationSeconds;
  }, [durationSeconds]);

  const pickMode = useCallback((clientX: number): "seek" | "start" | "end" => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || durationSeconds <= 0) return "seek";
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const startX = (selectionStart / durationSeconds) * rect.width;
    const endX = (selectionEnd / durationSeconds) * rect.width;
    const dStart = Math.abs(x - startX);
    const dEnd = Math.abs(x - endX);
    if (dStart <= HANDLE_HIT_PX && dStart <= dEnd) return "start";
    if (dEnd <= HANDLE_HIT_PX) return "end";
    return "seek";
  }, [durationSeconds, selectionStart, selectionEnd]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    drawAudioBufferWaveform(canvas, audioBuffer, WAVE_HEIGHT, "#E6E6E6", "#0F1113");
  }, [audioBuffer]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || durationSeconds <= 0) return undefined;

    const render = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = WAVE_HEIGHT;
      if (width === 0) return;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const startX = (selectionStart / durationSeconds) * width;
      const endX = (selectionEnd / durationSeconds) * width;

      // Dim non-selection area slightly
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(0, 0, startX, height);
      ctx.fillRect(endX, 0, width - endX, height);

      // Red selection tint
      ctx.fillStyle = "rgba(198, 255, 46, 0.15)";
      ctx.fillRect(startX, 0, Math.max(0, endX - startX), height);

      // Selection outline
      ctx.strokeStyle = "#C6FF2E";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(startX, 0); ctx.lineTo(startX, height);
      ctx.moveTo(endX, 0); ctx.lineTo(endX, height);
      ctx.stroke();

      // Triangle markers at top
      const drawMarker = (x: number) => {
        ctx.fillStyle = "#E6E6E6";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x - 5, 6);
        ctx.lineTo(x + 5, 6);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#C6FF2E";
        ctx.beginPath();
        ctx.moveTo(x, height);
        ctx.lineTo(x - 5, height - 6);
        ctx.lineTo(x + 5, height - 6);
        ctx.closePath();
        ctx.fill();
      };
      drawMarker(startX);
      drawMarker(endX);

      const playheadX = (clamp(playheadRef.current, 0, durationSeconds) / durationSeconds) * width;
      ctx.strokeStyle = "#FF5A4F";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    };

    render();
    const af = AnimationFrame.add(render);
    return () => af.terminate();
  }, [durationSeconds, selectionStart, selectionEnd]);

  const cursor = dragMode
    ? dragMode === "seek" ? "pointer" : "ew-resize"
    : hoverMode === "seek" ? "pointer" : "ew-resize";

  return (
    <div
      style={{ position: "relative", width: "100%", height: WAVE_HEIGHT, cursor, touchAction: "none" }}
      onPointerDown={event => {
        const mode = pickMode(event.clientX);
        setDragMode(mode);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        const seconds = secondsFromClientX(event.clientX);
        if (mode === "start") onTrimStart(seconds);
        else if (mode === "end") onTrimEnd(seconds);
        else onSeek(seconds);
      }}
      onPointerMove={event => {
        if (dragMode) {
          const seconds = secondsFromClientX(event.clientX);
          if (dragMode === "start") onTrimStart(seconds);
          else if (dragMode === "end") onTrimEnd(seconds);
          else onSeek(seconds);
        } else {
          setHoverMode(pickMode(event.clientX));
        }
      }}
      onPointerUp={event => {
        setDragMode(null);
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => setDragMode(null)}
      onPointerLeave={() => { if (!dragMode) setHoverMode("seek"); }}
    >
      <canvas
        ref={waveformCanvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: WAVE_HEIGHT, borderRadius: 4 }}
      />
      <canvas
        ref={overlayCanvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: WAVE_HEIGHT, pointerEvents: "none" }}
      />
    </div>
  );
};

const App: React.FC = () => {
  const [status, setStatus] = useState("Starting up…");
  const [error, setError] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [regionBox, setRegionBox] = useState<AudioRegionBox | null>(null);
  const [activeTrack, setActiveTrack] = useState<TrackData | null>(null);
  const [sourceAudioBuffer, setSourceAudioBuffer] = useState<AudioBuffer | null>(null);
  const [downloadedAudio, setDownloadedAudio] = useState<DownloadedAudio | null>(null);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [loopSelection, setLoopSelection] = useState(true);
  const [pitchSemitones, setPitchSemitones] = useState(0);
  const [crushAmount, setCrushAmount] = useState(0);
  const bitCrushNodeRef = useRef<WaveShaperNode | null>(null);
  const previewSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isDownloadingSource, setIsDownloadingSource] = useState(false);
  const [isExportingClip, setIsExportingClip] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [clipBlobCache, setClipBlobCache] = useState<{
    blob: Blob;
    url: string;
    start: number;
    end: number;
    pitch: number;
    crush: number;
    fileName: string;
    videoId: string;
  } | null>(null);
  const clipBlobCacheRef = useRef<typeof clipBlobCache>(null);
  useEffect(() => { clipBlobCacheRef.current = clipBlobCache; }, [clipBlobCache]);
  const localAudioBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const previewOffsetRef = useRef(0);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAnimationRef = useRef<{ terminate(): void } | null>(null);

  useEffect(() => {
    let mounted = true;
    let localProject: Project | null = null;
    let localAudioContext: AudioContext | null = null;

    (async () => {
      try {
        const localAudioBuffers = new Map<string, AudioBuffer>();
        localAudioBuffersRef.current = localAudioBuffers;
        const { project: nextProject, audioContext: nextAudioContext } = await initializeOpenDAW({
          localAudioBuffers,
          bpm: BPM,
          onStatusUpdate: nextStatus => mounted && setStatus(nextStatus),
        });

        localProject = nextProject;
        localAudioContext = nextAudioContext;

        if (!mounted) return;
        setProject(nextProject);
        setAudioContext(nextAudioContext);
        setStatus("Paste a YouTube URL to get started");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) {
          setError(message);
          setStatus("Couldn't start up — try reloading");
        }
      }
    })();

    return () => {
      mounted = false;
      localProject?.terminate();
      localAudioContext?.close().catch(() => {});
    };
  }, []);

  const clipDuration = Math.max(0, selectionEnd - selectionStart);
  const playheadSeconds = PPQN.pulsesToSeconds(currentPosition, BPM);
  const playheadSourceSeconds = clamp(selectionStart + playheadSeconds, selectionStart, Math.max(selectionStart, selectionEnd));
  const canDownloadSource = !!video && !isDownloadingSource;
  const shouldHighlightDownload =
    !!video && !downloadedAudio && !isDownloadingSource && !isResolving && !error;
  const canExportClip = !!video && !!downloadedAudio && clipDuration > 0.05 && !isExportingClip;

  useEffect(() => {
    setDownloadProgress(0);
    let timer: number | null = null;
    if (isDownloadingSource) {
      timer = window.setInterval(() => {
        setDownloadProgress(prev => (prev >= 100 ? 0 : Math.min(100, prev + 4)));
      }, 120);
    }
    return () => {
      if (timer !== null) window.clearInterval(timer);
    };
  }, [isDownloadingSource]);

  const getCurrentClipSeconds = useCallback(() => {
    const previewAudio = previewAudioRef.current;
    if (!previewAudio || clipDuration <= 0) {
      return clamp(PPQN.pulsesToSeconds(currentPosition, BPM), 0, clipDuration);
    }
    return getClipSecondsFromAudioTime(previewAudio.currentTime, selectionStart, selectionEnd);
  }, [clipDuration, currentPosition, selectionStart, selectionEnd]);

  const syncPlayhead = useCallback((clipSeconds: number) => {
    setCurrentPosition(PPQN.secondsToPulses(clamp(clipSeconds, 0, clipDuration), BPM));
  }, [clipDuration]);

  const syncPreviewPosition = useCallback(() => {
    const previewAudio = previewAudioRef.current;
    if (!previewAudio) return;

    if (loopSelection && previewAudio.currentTime >= selectionEnd) {
      previewAudio.currentTime = selectionStart;
    } else if (!loopSelection && previewAudio.currentTime >= selectionEnd) {
      previewAudio.pause();
      previewAudio.currentTime = selectionEnd;
      previewOffsetRef.current = clipDuration;
      syncPlayhead(clipDuration);
      setIsPlaying(false);
      setStatus("Stopped");
      return;
    }

    const clipSeconds = clamp(previewAudio.currentTime - selectionStart, 0, clipDuration);
    previewOffsetRef.current = clipSeconds;
    syncPlayhead(clipSeconds);
  }, [clipDuration, loopSelection, selectionEnd, selectionStart, syncPlayhead]);

  const stopPreviewLoop = useCallback(() => {
    previewAnimationRef.current?.terminate();
    previewAnimationRef.current = null;
  }, []);

  const startPreviewLoop = useCallback(() => {
    stopPreviewLoop();
    previewAnimationRef.current = AnimationFrame.add(syncPreviewPosition);
  }, [stopPreviewLoop, syncPreviewPosition]);

  const startPreview = useCallback(async (clipSeconds: number) => {
    const previewAudio = previewAudioRef.current;
    if (!previewAudio || clipDuration <= 0) return;
    const safeClipSeconds = clamp(clipSeconds, 0, clipDuration);
    await seekAudioElement(previewAudio, getPreviewStartTime(selectionStart, safeClipSeconds));
    previewOffsetRef.current = safeClipSeconds;
    syncPlayhead(safeClipSeconds);
    if (audioContext && audioContext.state !== "running") {
      await audioContext.resume().catch(() => {});
    }
    await previewAudio.play();
    setIsPlaying(true);
    startPreviewLoop();
  }, [clipDuration, selectionStart, syncPlayhead, startPreviewLoop, audioContext]);

  const handlePlay = useCallback(async () => {
    if (!previewAudioRef.current || clipDuration <= 0) {
      setStatus("Download the audio first");
      return;
    }
    const currentClipSeconds = getCurrentClipSeconds();
    const restart = shouldRestartPreview(currentClipSeconds, clipDuration, 0.01);
    await startPreview(restart ? 0 : currentClipSeconds);
    setStatus(loopSelection ? "Looping selection" : "Playing selection");
  }, [clipDuration, getCurrentClipSeconds, startPreview, loopSelection]);

  const handlePause = useCallback(() => {
    const previewAudio = previewAudioRef.current;
    const currentClipSeconds = getCurrentClipSeconds();
    previewAudio?.pause();
    stopPreviewLoop();
    syncPlayhead(currentClipSeconds);
    previewOffsetRef.current = currentClipSeconds;
    setIsPlaying(false);
    setStatus("Paused");
  }, [getCurrentClipSeconds, stopPreviewLoop, syncPlayhead]);

  const handleStop = useCallback(() => {
    const previewAudio = previewAudioRef.current;
    previewAudio?.pause();
    stopPreviewLoop();
    previewOffsetRef.current = 0;
    syncPlayhead(0);
    setIsPlaying(false);
    setStatus("Stopped");
  }, [stopPreviewLoop, syncPlayhead]);

  const seekToClipSeconds = useCallback(async (clipSeconds: number) => {
    const safeClipSeconds = clamp(clipSeconds, 0, clipDuration);
    if (isPlaying) {
      await startPreview(safeClipSeconds);
      return;
    }
    previewOffsetRef.current = safeClipSeconds;
    syncPlayhead(safeClipSeconds);
  }, [clipDuration, isPlaying, startPreview, syncPlayhead]);

  const applyTrimToRegion = useCallback((startSeconds: number, endSeconds: number) => {
    if (!project || !regionBox) return;

    const { start: safeStart, duration: clipLength } = getSafeTrimRange(
      startSeconds,
      endSeconds,
      downloadedAudio?.durationSeconds ?? Number.MAX_SAFE_INTEGER,
      0.05
    );
    const clipLengthPpqn = PPQN.secondsToPulses(clipLength, BPM);

    project.editing.modify(() => {
      regionBox.timeBase.setValue(TimeBase.Seconds);
      regionBox.position.setValue(0);
      regionBox.duration.setValue(clipLength);
      regionBox.loopDuration.setValue(clipLength);
      regionBox.loopOffset.setValue(0);
      regionBox.waveformOffset.setValue(safeStart);
      project.timelineBox.durationInPulses.setValue(clipLengthPpqn);
      project.timelineBox.loopArea.from.setValue(0);
      project.timelineBox.loopArea.to.setValue(clipLengthPpqn);
      project.timelineBox.loopArea.enabled.setValue(loopSelection);
    });
  }, [project, regionBox, loopSelection, downloadedAudio]);

  useEffect(() => {
    applyTrimToRegion(selectionStart, selectionEnd);
  }, [selectionStart, selectionEnd, applyTrimToRegion]);

  useEffect(() => {
    if (!project) return;
    project.editing.modify(() => {
      project.timelineBox.loopArea.enabled.setValue(loopSelection);
    });
  }, [project, loopSelection]);

  useEffect(() => {
    if (clipDuration <= 0) {
      handleStop();
      return;
    }
    const previewAudio = previewAudioRef.current;
    if (isPlaying && previewAudio) {
      // Keep playing across trim edits like a real sampler: if the playhead
      // fell behind the new start (user dragged start forward), snap it up.
      // The end boundary is handled naturally by syncPreviewPosition on the
      // next animation frame (wraps when looping, pauses otherwise).
      if (previewAudio.currentTime < selectionStart) {
        previewAudio.currentTime = selectionStart;
      }
      // Refresh the animation frame loop so syncPreviewPosition picks up the
      // latest selection bounds via its new closure.
      startPreviewLoop();
      return;
    }
    // Not playing: clamp the paused offset into the new window.
    const nextClipSeconds = clamp(previewOffsetRef.current, 0, clipDuration);
    previewOffsetRef.current = nextClipSeconds;
    syncPlayhead(nextClipSeconds);
  }, [selectionStart, selectionEnd, loopSelection, clipDuration, isPlaying, syncPlayhead, handleStop, startPreviewLoop]);

  useEffect(() => {
    return () => {
      stopPreviewLoop();
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
    };
  }, [stopPreviewLoop]);

  useEffect(() => {
    const audio = previewAudioRef.current;
    if (!audio) return;
    audio.playbackRate = Math.pow(2, pitchSemitones / 12);
    audio.preservesPitch = false;
  }, [pitchSemitones]);

  useEffect(() => {
    const shaper = bitCrushNodeRef.current;
    if (!shaper) return;
    shaper.curve = makeBitCrushCurve(crushAmount) as any;
  }, [crushAmount]);


  const loadVideoInfo = useCallback(async (urlOverride?: string) => {
    const urlToLoad = (urlOverride ?? youtubeUrl).trim();
    if (!urlToLoad || !project || !audioContext || isResolving) return;
    setIsResolving(true);
    setError(null);
    setDownloadedAudio(null);
    setSourceAudioBuffer(null);
    setRegionBox(null);

    try {
      const payload = await requestJson<{ ok: true; video: VideoInfo }>("/url", { url: urlToLoad });
      setVideo(payload.video);
      setStatus("Video found. Download the audio to start trimming.");
    } catch (e) {
      setVideo(null);
      setError(e instanceof Error ? e.message : String(e));
      setStatus("Couldn't find that video — check the URL");
    } finally {
      setIsResolving(false);
    }
  }, [youtubeUrl, project, audioContext, isResolving]);

  const downloadSourceAudio = useCallback(async () => {
    if (!project || !audioContext || !video) return;
    setIsDownloadingSource(true);
    setError(null);
    setStatus("Downloading audio from YouTube…");

    try {
      const download = await requestJson<{ ok: true; path: string }>("/download-audio", { videoId: video.id });
      const fileUrl = `${SERVER_ORIGIN}/${download.path}`;
      handleStop();
      project.editing.modify(() => {
        if (activeTrack) {
          activeTrack.audioUnitBox.mute.setValue(true);
        }
      });

      const audioBuffer = await loadAudioFile(audioContext, fileUrl);
      setSourceAudioBuffer(audioBuffer);
      const loadedTrack = createTrackFromAudioBuffer(
        project,
        video.title || "Imported track",
        audioBuffer,
        localAudioBuffersRef.current
      );
      await project.engine.queryLoadingComplete();
      const previewAudio = new Audio();
      previewAudio.crossOrigin = "anonymous";
      previewAudio.preload = "auto";
      previewAudio.src = fileUrl;
      const fullPpqn = PPQN.secondsToPulses(audioBuffer.duration, BPM);
      let createdRegion: AudioRegionBox | null = null;
      project.editing.modify(() => {
        loadedTrack.audioUnitBox.mute.setValue(false);
        project.timelineBox.loopArea.from.setValue(0);
        project.timelineBox.loopArea.enabled.setValue(loopSelection);
        project.timelineBox.durationInPulses.setValue(fullPpqn);
        project.timelineBox.loopArea.to.setValue(fullPpqn);
      });

      const audioUnits = project.rootBoxAdapter.audioUnits.adapters();
      const lastUnit = audioUnits[audioUnits.length - 1];
      const regionAdapter = lastUnit?.tracks.values()[0]?.regions.adapters.values().find(r => r.isAudioRegion());
      createdRegion = regionAdapter?.box ?? null;

      setRegionBox(createdRegion);
      setActiveTrack(loadedTrack);
      previewAudioRef.current?.pause();
      if (previewAudioRef.current) {
        previewAudioRef.current.src = "";
      }
      previewAudioRef.current = previewAudio;
      previewAudio.playbackRate = Math.pow(2, pitchSemitones / 12);
      previewAudio.preservesPitch = false;

      // Wire the preview audio through a bit-crush waveshaper on the existing AudioContext.
      try {
        if (previewSourceNodeRef.current) {
          try { previewSourceNodeRef.current.disconnect(); } catch {}
        }
        const source = audioContext.createMediaElementSource(previewAudio);
        if (!bitCrushNodeRef.current) {
          const shaper = audioContext.createWaveShaper();
          shaper.curve = makeBitCrushCurve(crushAmount) as any;
          shaper.connect(audioContext.destination);
          bitCrushNodeRef.current = shaper;
        }
        source.connect(bitCrushNodeRef.current);
        previewSourceNodeRef.current = source;
      } catch (graphErr) {
        console.warn("[sampler] bit-crush graph failed", graphErr);
      }

      setDownloadedAudio({ fileUrl, durationSeconds: audioBuffer.duration });
      setSelectionStart(0);
      setSelectionEnd(audioBuffer.duration);
      previewOffsetRef.current = 0;
      syncPlayhead(0);
      setStatus("Audio ready — drag the markers to trim, then press Play.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("Couldn't download the audio — try again");
    } finally {
      setIsDownloadingSource(false);
    }
  }, [project, audioContext, video, loopSelection, activeTrack, handleStop, syncPlayhead]);

  const updateSelectionStart = useCallback((value: number) => {
    if (!downloadedAudio) return;
    const nextStart = clamp(value, 0, Math.max(0, selectionEnd - 0.05));
    setSelectionStart(nextStart);
  }, [downloadedAudio, selectionEnd]);

  const updateSelectionEnd = useCallback((value: number) => {
    if (!downloadedAudio) return;
    const nextEnd = clamp(value, selectionStart + 0.05, downloadedAudio.durationSeconds);
    setSelectionEnd(nextEnd);
  }, [downloadedAudio, selectionStart]);

  const prepareClipBlob = useCallback(async () => {
    if (!video) throw new Error("No video loaded");
    const cached = clipBlobCacheRef.current;
    if (
      cached &&
      cached.videoId === video.id &&
      cached.start === selectionStart &&
      cached.end === selectionEnd &&
      cached.pitch === pitchSemitones &&
      cached.crush === crushAmount
    ) {
      return cached;
    }

    const response = await fetch(`${SERVER_ORIGIN}/clip-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: video.id,
        startSeconds: selectionStart,
        endSeconds: selectionEnd,
        pitchSemitones,
        crushAmount,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Clip export failed (${response.status})`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const pitchTag = pitchSemitones === 0 ? "" : `-p${pitchSemitones > 0 ? "+" : ""}${pitchSemitones}st`;
    const crushBits = 16 - clamp(crushAmount, 0, 1) * 15;
    const crushTag = crushAmount < 0.02 ? "" : `-c${Math.round(crushBits * 10) / 10}b`;
    const fileName = `${sanitizeFileStem(video.title)}-${selectionStart.toFixed(2)}-${selectionEnd.toFixed(2)}${pitchTag}${crushTag}.mp3`;
    const next = { blob, url, start: selectionStart, end: selectionEnd, pitch: pitchSemitones, crush: crushAmount, fileName, videoId: video.id };
    if (cached) URL.revokeObjectURL(cached.url);
    setClipBlobCache(next);
    return next;
  }, [video, selectionStart, selectionEnd, pitchSemitones, crushAmount]);

  const exportClip = useCallback(async () => {
    if (!video || !canExportClip) return;
    setIsExportingClip(true);
    setError(null);
    setStatus("Exporting MP3…");

    try {
      const ready = await prepareClipBlob();
      triggerBlobDownload(ready.blob, ready.fileName);
      setStatus("MP3 saved to your downloads");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("Export failed — try again");
    } finally {
      setIsExportingClip(false);
    }
  }, [video, canExportClip, prepareClipBlob]);

  // Invalidate the cached clip blob when the selection, pitch, or crush changes
  useEffect(() => {
    const cached = clipBlobCacheRef.current;
    if (!cached) return;
    if (
      cached.start !== selectionStart ||
      cached.end !== selectionEnd ||
      cached.pitch !== pitchSemitones ||
      cached.crush !== crushAmount ||
      cached.videoId !== video?.id
    ) {
      URL.revokeObjectURL(cached.url);
      setClipBlobCache(null);
    }
  }, [selectionStart, selectionEnd, pitchSemitones, crushAmount, video?.id]);

  // Free blob URL on unmount
  useEffect(() => () => {
    const cached = clipBlobCacheRef.current;
    if (cached) URL.revokeObjectURL(cached.url);
  }, []);

  const lcdStatus = useMemo(() => {
    if (error) return "ERROR";
    if (isResolving) return "LOADING";
    if (isDownloadingSource) return "DOWNLOADING";
    if (isExportingClip) return "EXPORTING";
    if (isPlaying) return "PLAYING";
    if (downloadedAudio) return "READY";
    if (video) return "LOADED";
    return "IDLE";
  }, [error, isResolving, isDownloadingSource, isExportingClip, isPlaying, downloadedAudio, video]);

  const lcdClock = useMemo(() => {
    if (isPlaying || downloadedAudio) return formatLcd(playheadSeconds);
    return "00:00.00";
  }, [isPlaying, downloadedAudio, playheadSeconds]);

  return (
    <div className="tc-app">
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <filter
          id="tc-tint-green"
          colorInterpolationFilters="sRGB"
          x="-40%"
          y="-60%"
          width="180%"
          height="220%"
        >
          <feFlood floodColor="#C6FF2E" result="logoTint" />
          <feComposite in="logoTint" in2="SourceAlpha" operator="in" result="logoFill" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="2.8" result="logoGlowAlpha" />
          <feFlood floodColor="#C6FF2E" floodOpacity="0.75" result="logoGlowColor" />
          <feComposite in="logoGlowColor" in2="logoGlowAlpha" operator="in" result="logoGlow" />
          <feMerge>
            <feMergeNode in="logoGlow" />
            <feMergeNode in="logoFill" />
          </feMerge>
        </filter>
      </svg>
      {/* Main panel */}
      <div className="tc-panel">
        <div className="tc-vents" aria-hidden />

        <div className="tc-panel-grid">
          {/* LEFT COLUMN */}
          <div className="tc-left-col">
            <div className="tc-title-block">
              <div className="tc-title-row">
                <img className="tc-title-logo" src="/logo2.svg" alt="O-Sample" />
              </div>
              <p className="tc-subtitle">YOUTUBE DOWNLOADER / CLIPPER</p>
            </div>

            <div className="tc-lcd tc-lcd-left">
              <div className="tc-lcd-row">
                <span className="label">{lcdStatus}</span>
                <span className="value">{lcdClock}</span>
              </div>
              <div className="tc-lcd-caption" title={status}>{status}</div>

              <div className="tc-lcd-divider" />

              <div className={`tc-lcd-label-sm ${!youtubeUrl ? "empty" : ""}`}>PASTE YOUTUBE URL</div>
              <input
                className={`tc-lcd-input ${!youtubeUrl ? "empty" : ""}`}
                value={youtubeUrl}
                onChange={e => setYoutubeUrl(e.target.value)}
                onPaste={e => {
                  const pasted = e.clipboardData.getData("text").trim();
                  if (!pasted) return;
                  e.preventDefault();
                  setYoutubeUrl(pasted);
                  void loadVideoInfo(pasted);
                }}
                placeholder="https://youtu.be/..."
                spellCheck={false}
              />

              <div className="tc-lcd-row" style={{ marginTop: 2 }}>
                <span className="label">OUTPUT</span>
                <span className="value">MP3 · 320 KBPS</span>
              </div>

              <div style={{ marginTop: 2, display: "flex", gap: 8 }}>
                <button
                  className={`tc-download-btn primary ${shouldHighlightDownload ? "next-step" : ""} ${isDownloadingSource ? "loading" : ""}`}
                  style={{ width: "100%" }}
                  onClick={downloadSourceAudio}
                  disabled={!canDownloadSource}
                  aria-label={isDownloadingSource ? "Downloading audio" : "Download audio from YouTube"}
                >
                  {isDownloadingSource ? (
                    <>
                      <span className="tc-download-loading-track" aria-hidden>
                        <span
                          className="tc-download-loading-fill"
                          style={{ width: `${downloadProgress}%` }}
                        />
                      </span>
                      <span className="tc-download-loading-label">{downloadProgress}%</span>
                    </>
                  ) : (
                    <>
                      <span>DOWNLOAD AUDIO</span>
                      <ArrowRightIcon />
                    </>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="tc-error" style={{ marginTop: 12 }}>
                <ExclamationTriangleIcon style={{ verticalAlign: "middle", marginRight: 6 }} />
                {error}
              </div>
            )}
          </div>

          {/* RIGHT COLUMN — WAVEFORM LCD */}
          <div className="tc-lcd tc-lcd-wave">
            <div className="tc-lcd-wave-header">
              <div className="tc-header-clip">
                <span className={`tc-led ${isPlaying ? "blink" : ""}`} />
              </div>
              {video ? (
                <div className="tc-header-video">
                  {video.thumbnail ? (
                    <img src={video.thumbnail} alt={video.title} />
                  ) : (
                    <div className="tc-header-video-placeholder"><PlayIcon /></div>
                  )}
                  <div className="tc-header-video-meta">
                    <div className="tc-header-video-title">{video.title}</div>
                    <div className="tc-header-video-sub">
                      {video.author}
                      {video.duration !== null && ` · ${formatLcd(video.duration)}`}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="tc-header-video empty">
                  <div className="tc-header-video-placeholder"><PlayIcon /></div>
                  <span>PASTE A URL TO BEGIN</span>
                </div>
              )}
              <div className="tc-lcd-timers">
                <div className="tc-lcd-timer">
                  <div className="lbl">START</div>
                  <div className="val">{formatLcd(selectionStart)}</div>
                </div>
                <div className="tc-lcd-timer">
                  <div className="lbl">END</div>
                  <div className="val">{formatLcd(selectionEnd)}</div>
                </div>
              </div>
            </div>

            <div className="tc-wave-main-section">
              <div className="tc-wave-section-label">FULL TRACK · DRAG MARKERS TO TRIM · CLICK TO SEEK</div>
              <div className="tc-wave-main">
                {sourceAudioBuffer && downloadedAudio ? (
                  <WaveformSelectionCanvas
                    audioBuffer={sourceAudioBuffer}
                    durationSeconds={downloadedAudio.durationSeconds}
                    selectionStart={selectionStart}
                    selectionEnd={selectionEnd || downloadedAudio.durationSeconds}
                    playheadSourceSeconds={playheadSourceSeconds}
                    onSeek={sourceSeconds => {
                      const clampedSource = clamp(sourceSeconds, selectionStart, selectionEnd);
                      void seekToClipSeconds(clampedSource - selectionStart);
                    }}
                    onTrimStart={updateSelectionStart}
                    onTrimEnd={updateSelectionEnd}
                  />
                ) : (
                  <div className="tc-wave-empty">DOWNLOAD TO SEE WAVEFORM</div>
                )}
              </div>
            </div>

            <div>
              <div className="tc-wave-section-label">YOUR CLIP · PREVIEW OF THE EXPORT</div>
              <div className="tc-wave-mini-wrap">
                <div className="tc-wave-mini">
                  {sourceAudioBuffer && downloadedAudio && clipDuration > 0 ? (
                    <ClipWaveformCanvas
                      audioBuffer={sourceAudioBuffer}
                      durationSeconds={downloadedAudio.durationSeconds}
                      selectionStart={selectionStart}
                      selectionEnd={selectionEnd || downloadedAudio.durationSeconds}
                      playheadSourceSeconds={playheadSourceSeconds}
                    />
                  ) : (
                    <div className="tc-wave-empty clip">TRIM THE TRACK ABOVE TO SEE YOUR CLIP</div>
                  )}
                </div>
                <div className="tc-length-badge">
                  <div className="lbl">LENGTH</div>
                  <div className="val">{formatLcd(clipDuration)}</div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* Bottom controls */}
      <div className="tc-controls">
        <div className="tc-subpanel">
          <div className="tc-knob-row">
            <Knob
              label="START"
              value={selectionStart}
              min={0}
              max={Math.max(0, (downloadedAudio?.durationSeconds ?? 0) - clipDuration)}
              defaultValue={0}
              disabled={!downloadedAudio || clipDuration <= 0}
              onChange={v => {
                const span = clipDuration;
                const maxStart = Math.max(0, (downloadedAudio?.durationSeconds ?? 0) - span);
                const nextStart = clamp(v, 0, maxStart);
                setSelectionStart(nextStart);
                setSelectionEnd(nextStart + span);
              }}
              format={v => formatLcd(v)}
              rangeLeft="0:00"
              rangeRight={downloadedAudio ? formatLcd(downloadedAudio.durationSeconds).slice(0, 5) : "—"}
            />
            <Knob
              label="LENGTH"
              value={clipDuration}
              min={0.05}
              max={Math.max(0.05, (downloadedAudio?.durationSeconds ?? 0) - selectionStart)}
              defaultValue={downloadedAudio ? downloadedAudio.durationSeconds - selectionStart : 0.05}
              disabled={!downloadedAudio}
              onChange={v => {
                const sourceDur = downloadedAudio?.durationSeconds ?? 0;
                const maxLen = Math.max(0.05, sourceDur - selectionStart);
                const nextLen = clamp(v, 0.05, maxLen);
                setSelectionEnd(selectionStart + nextLen);
              }}
              format={v => formatLcd(v)}
              rangeLeft="0:00"
              rangeRight={downloadedAudio ? formatLcd(downloadedAudio.durationSeconds - selectionStart).slice(0, 5) : "—"}
            />
            <Knob
              label="PITCH"
              value={pitchSemitones}
              min={-12}
              max={12}
              step={1}
              defaultValue={0}
              onChange={setPitchSemitones}
              format={v => `${v > 0 ? "+" : ""}${v} st`}
              rangeLeft="-12"
              rangeRight="+12"
            />
            <Knob
              label="CRUSH"
              value={crushAmount}
              min={0}
              max={1}
              defaultValue={0}
              onChange={setCrushAmount}
              format={v => `${Math.round((16 - v * 15) * 10) / 10} BIT`}
              rangeLeft="16b"
              rangeRight="1b"
            />
          </div>
        </div>

        <div className="tc-subpanel tc-about">
          <div className="tc-about-eyebrow">ABOUT</div>
          <h3 className="tc-about-heading">YouTube to MP3, for samplers.</h3>
          <div className="tc-about-copy-wrap">
            <div
              className="tc-about-copy"
              onScroll={e => {
                const el = e.currentTarget;
                const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 2;
                el.closest(".tc-about-copy-wrap")?.classList.toggle("scrolled-to-end", atBottom);
              }}
            >
              <p className="tc-about-body">
                O-Sample is a free YouTube to MP3 clipper built for producers. Paste
                a YouTube URL, trim the part you want, and export a clean MP3 ready
                to drop straight into your DAW — no accounts, no ads, no installs.
              </p>
              <p className="tc-about-body dim">
                Works in your browser on desktop and mobile. Use it to chop vocal
                hooks, grab drum breaks, sample interviews, or rip any audio snippet
                from a YouTube video.
              </p>
            </div>
          </div>
          <a
            className="tc-about-repo"
            href="https://github.com/chronoshivt/o-sample"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg className="tc-about-repo-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path fill="currentColor" fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
            </svg>
            <span>View source on GitHub</span>
          </a>
        </div>

        <div className="tc-subpanel tc-side">
          <div className="tc-action-group">
            <div className="tc-side-label">TRANSPORT</div>
            <div className="tc-transport">
              <button
                className={`tc-xport-btn${isPlaying ? " active" : ""}`}
                data-kind="play"
                onClick={() => void handlePlay()}
                disabled={isPlaying || !downloadedAudio}
                aria-label="Play"
              ><PlayIcon /></button>
              <button
                className="tc-xport-btn"
                onClick={handlePause}
                disabled={!isPlaying}
                aria-label="Pause"
              ><PauseIcon /></button>
              <button
                className="tc-xport-btn"
                onClick={handleStop}
                disabled={!isPlaying}
                aria-label="Stop"
              ><StopIcon /></button>
            </div>
          </div>

          <div className="tc-action-row">
            <span className="tc-side-label">LOOP</span>
            <button
              className={`tc-switch${loopSelection ? " on" : ""}`}
              type="button"
              aria-pressed={loopSelection}
              onClick={() => setLoopSelection(v => !v)}
            />
          </div>

          <div className="tc-action-group">
            <button
              className="tc-export-btn big"
              onClick={exportClip}
              disabled={!canExportClip}
            >
              {isExportingClip ? <UpdateIcon className="spin" /> : <ScissorsIcon />}
              <span>{isExportingClip ? "EXPORTING…" : "EXPORT MP3"}</span>
              <ArrowRightIcon />
            </button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="tc-footer">
        <span className="tc-led" />
        <img className="tc-footer-logo" src="/logo2.svg" alt="O-Sample" />
        <span className="spacer" />
        <a
          className="tc-footer-link"
          href="https://x.com/neetsdotfun"
          target="_blank"
          rel="noreferrer"
          aria-label="X profile @neetsdotfun"
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M18.9 2H22l-6.8 7.8L23 22h-6.7l-5.2-6.8L5.1 22H2l7.3-8.3L1 2h6.9l4.7 6.2L18.9 2zm-1.2 18h1.9L6.8 3.9H4.8L17.7 20z" />
          </svg>
          <span>@NEETSDOTFUN</span>
        </a>
      </div>
    </div>
  );
};

const Knob: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  onChange?: (v: number) => void;
  format?: (v: number) => string;
  rangeLeft?: string;
  rangeRight?: string;
  red?: boolean;
  withLed?: boolean;
  disabled?: boolean;
}> = ({ label, value, min, max, step, defaultValue, onChange, format, rangeLeft, rangeRight, red, withLed, disabled }) => {
  const startYRef = useRef(0);
  const startValueRef = useRef(value);
  const [dragging, setDragging] = useState(false);

  const quantize = (v: number): number => {
    const clamped = clamp(v, min, max);
    if (!step || step <= 0) return clamped;
    return clamp(Math.round((clamped - min) / step) * step + min, min, max);
  };

  const normalized = max > min ? (value - min) / (max - min) : 0;
  const angle = -135 + clamp(normalized, 0, 1) * 270;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || !onChange) return;
    setDragging(true);
    startYRef.current = e.clientY;
    startValueRef.current = value;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging || !onChange) return;
    const dy = startYRef.current - e.clientY;
    const multiplier = e.shiftKey ? 0.2 : 1;
    const dv = (dy / 180) * (max - min) * multiplier;
    const next = quantize(startValueRef.current + dv);
    if (next !== value) onChange(next);
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    setDragging(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };
  const handleDoubleClick = () => {
    if (disabled || !onChange) return;
    onChange(quantize(defaultValue ?? (min + max) / 2));
  };
  const handleWheel = (e: React.WheelEvent) => {
    if (disabled || !onChange) return;
    const dir = e.deltaY > 0 ? -1 : 1;
    const amount = step && step > 0
      ? step * (e.shiftKey ? 1 : 1)
      : (max - min) / 100 * (e.shiftKey ? 0.2 : 1);
    onChange(quantize(value + amount * dir));
  };

  const display = format ? format(value) : value.toFixed(2);
  const interactive = !!onChange && !disabled;

  const notchCount = step && step > 0 && max > min ? Math.round((max - min) / step) : 0;
  const activeIndex = notchCount > 0 ? Math.round(((value - min) / (max - min)) * notchCount) : -1;
  const isPitchSemitoneKnob = label === "PITCH" && step === 1 && min === -12 && max === 12;

  return (
    <div className="tc-knob-cell">
      <div className="tc-knob-label">{label}</div>
      <div className="tc-knob-wrap">
        {notchCount > 0 && (
          <svg className="tc-knob-notches" viewBox="0 0 80 80" aria-hidden>
            {Array.from({ length: notchCount + 1 }, (_, i) => {
              const t = i / notchCount;
              const a = ((-135 + t * 270) * Math.PI) / 180;
              const notchValue = min + (max - min) * t;
              const isPitchSixMark = isPitchSemitoneKnob && (notchValue === -6 || notchValue === 6);
              const isMajor = i === 0 || i === notchCount || i === notchCount / 2 || isPitchSixMark;
              const rIn = 36;
              const rOut = isMajor ? 41 : 38.5;
              const x1 = 40 + Math.sin(a) * rIn;
              const y1 = 40 - Math.cos(a) * rIn;
              const x2 = 40 + Math.sin(a) * rOut;
              const y2 = 40 - Math.cos(a) * rOut;
              const active = i <= activeIndex;
              return (
                <line
                  key={i}
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={active ? "#C6FF2E" : "rgba(214,220,232,0.38)"}
                  strokeWidth={isMajor ? 1.6 : 1}
                  strokeLinecap="round"
                />
              );
            })}
          </svg>
        )}
        <div
          className={`tc-knob${red ? " red" : ""}${interactive ? " interactive" : ""}${dragging ? " dragging" : ""}${disabled ? " disabled" : ""}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          onWheel={interactive ? handleWheel : undefined}
          role={interactive ? "slider" : undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-label={label}
          tabIndex={interactive ? 0 : -1}
        >
          <div 
            className="tc-knob-indicator-wrapper" 
            style={{ 
              position: "absolute", 
              inset: 0, 
              transform: `rotate(${angle}deg)`,
              pointerEvents: "none"
            }}
          >
            <div className="tc-knob-indicator" />
          </div>
          {withLed && <span className="tc-led tc-knob-led" />}
        </div>
      </div>
      <div className="tc-knob-value">{display}</div>
      {(rangeLeft || rangeRight) && (
        <div className="tc-knob-range"><span>{rangeLeft ?? ""}</span><span>{rangeRight ?? ""}</span></div>
      )}
    </div>
  );
};

createRoot(document.getElementById("root")!).render(<App />);
