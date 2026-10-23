/** Public progress/log data must never carry model image payloads. The Pi session
 * and image artifacts retain the original content for execution and export. */
export function publicWorkflowData<T>(value: T): T {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 32) return '[Nested workflow data omitted]';
    if (typeof item === 'string') {
      const start = item.trimStart();
      // Tool results in historical bus records were JSON serialized a second time.
      if (start.startsWith('{') || start.startsWith('[')) {
        try {
          const parsed: unknown = JSON.parse(item);
          if (parsed && typeof parsed === 'object') return JSON.stringify(visit(parsed, depth + 1));
        } catch { /* Ordinary text, including incomplete model output. */ }
      }
      if (item.length > 4096 && /^[A-Za-z0-9+/=\r\n]+$/.test(item)) return '[Image/binary payload omitted]';
      return item.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g, '[Image payload omitted]');
    }
    if (Array.isArray(item)) return item.map(part => visit(part, depth + 1));
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (record.type === 'image' && typeof record.data === 'string') return { type: 'text', text: '[Image payload omitted]' };
      return Object.fromEntries(Object.entries(record).map(([key, part]) => [key,
        ['b64_json', 'imageData', 'base64'].includes(key) && typeof part === 'string' ? '[Image payload omitted]' : visit(part, depth + 1)
      ]));
    }
    return item;
  };
  return visit(value, 0) as T;
}
