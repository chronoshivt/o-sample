export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getSafeTrimRange(
  startSeconds: number,
  endSeconds: number,
  totalDuration: number,
  minDuration: number = 0.05
): { start: number; end: number; duration: number } {
  const safeStart = clamp(startSeconds, 0, Math.max(0, totalDuration - minDuration));
  const safeEnd = clamp(endSeconds, safeStart + minDuration, totalDuration);
  return {
    start: safeStart,
    end: safeEnd,
    duration: safeEnd - safeStart
  };
}

export function getPreviewStartTime(selectionStart: number, clipOffset: number): number {
  return Math.max(0, selectionStart + Math.max(0, clipOffset));
}

export function getClipSecondsFromAudioTime(
  audioTimeSeconds: number,
  selectionStart: number,
  selectionEnd: number
): number {
  const clipDuration = Math.max(0, selectionEnd - selectionStart);
  return clamp(audioTimeSeconds - selectionStart, 0, clipDuration);
}

export function shouldRestartPreview(currentClipSeconds: number, clipDuration: number, epsilon: number = 0.01): boolean {
  return currentClipSeconds >= clipDuration - epsilon;
}
