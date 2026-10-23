export interface CitationValidation { unusedReferences: number[] }

/** Separate a References section from every other Markdown section, wherever it occurs. */
export function validateCitations(design: string, research: string): CitationValidation {
  const body: string[] = [], bibliography: string[] = [];
  let referenceLevel: number | undefined;
  let fence: string | undefined;
  for (const line of design.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue; }
    if (fence) continue;
    const heading = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (referenceLevel !== undefined && level <= referenceLevel) referenceLevel = undefined;
      if (/^References$/i.test(heading[2]!)) { referenceLevel = level; continue; }
    }
    (referenceLevel === undefined ? body : bibliography).push(line);
  }
  const references = new Map<number, string>();
  let current: number | undefined;
  const number = (value: string) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid IEEE reference number [${value}]`);
    return parsed;
  };
  for (const line of bibliography) {
    const entry = /^\s*\[(\d+)\]\s+(.+)$/.exec(line);
    if (entry) {
      current = number(entry[1]!);
      if (references.has(current)) throw new Error(`Duplicate IEEE reference [${current}]`);
      references.set(current, entry[2]!);
    } else if (current !== undefined) references.set(current, `${references.get(current)}\n${line}`);
  }
  const citations = new Set<number>();
  const cite = (id: number) => {
    if (!references.has(id)) throw new Error(`Missing IEEE reference [${id}]`);
    citations.add(id);
  };
  const range = (start: number, end: number) => {
    if (end < start) throw new Error(`Invalid IEEE citation range [${start}]–[${end}]`);
    // Missing entries fail immediately, so even oversized ranges cannot cause unbounded work.
    for (let id = start; id <= end; id++) cite(id);
  };
  const prose = body.join('\n').replace(/`[^`\n]*`/g, '');
  for (const match of prose.matchAll(/\[(\d+(?:\s*(?:,|[-–—])\s*\d+)*)\](?:\s*[-–—]\s*\[(\d+)\])?/g)) {
    if (match[2]) {
      if (!/^\d+$/.test(match[1]!)) throw new Error('Invalid IEEE citation range');
      range(number(match[1]!), number(match[2]));
    } else for (const group of match[1]!.split(',')) {
      const ends = group.trim().split(/\s*[-–—]\s*/);
      if (ends.length === 1) cite(number(ends[0]!));
      else if (ends.length === 2) range(number(ends[0]!), number(ends[1]!));
      else throw new Error('Invalid IEEE citation range');
    }
  }
  for (const [id, reference] of references) {
    const urls = reference.match(/https?:\/\/[^\s<>\])]+/g) || [];
    if (!urls.length || urls.some(url => !research.includes(url))) throw new Error(`Reference [${id}] must cite a traceable researched URL`);
  }
  // Extra bibliography entries are an editorial warning, not a failed design.
  // Preserve the original text/numbering and validate source traceability even
  // for uncited entries; do not silently invent citations or rewrite the plan.
  return { unusedReferences: [...references.keys()].filter(id => !citations.has(id)) };
}
