/** Single byte ranges used by native video controls, including open and suffix ranges. */
export function mediaRange(header: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return;
  return { start, end };
}
