export interface CitationValidation { unusedReferences: number[] }

/** Separate a References section from every other Markdown section, wherever it occurs. */
export function validateCitations(design: string, research: string, issues?: string[]): CitationValidation {
  const problem = (message: string) => { if (issues) issues.push(message); else throw new Error(message); };
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
    if (!Number.isSafeInteger(parsed) || parsed < 1) { problem(`Invalid IEEE reference number [${value}]`); return NaN; }
    return parsed;
  };
  for (const line of bibliography) {
    const entry = /^\s*\[(\d+)\]\s+(.+)$/.exec(line);
    if (entry) {
      current = number(entry[1]!);
      if (references.has(current)) problem(`Duplicate IEEE reference [${current}]`);
      references.set(current, entry[2]!);
    } else if (current !== undefined) references.set(current, `${references.get(current)}\n${line}`);
  }
  const citations = new Set<number>();
  const cite = (id: number) => {
    if (!references.has(id)) problem(`Missing IEEE reference [${id}]`);
    citations.add(id);
  };
  const range = (start: number, end: number) => {
    if (end < start) { problem(`Invalid IEEE citation range [${start}]–[${end}]`); return; }
    // Missing entries fail immediately, so even oversized ranges cannot cause unbounded work.
    for (let id = start; id <= end; id++) {
      cite(id);
      if (id - start >= references.size) { if (id < end) problem('Citation range exceeds the available bibliography'); break; }
    }
  };
  const prose = body.join('\n').replace(/`[^`\n]*`/g, '');
  for (const match of prose.matchAll(/\[(\d+(?:\s*(?:,|[-–—])\s*\d+)*)\](?:\s*[-–—]\s*\[(\d+)\])?/g)) {
    if (match[2]) {
      if (!/^\d+$/.test(match[1]!)) problem('Invalid IEEE citation range');
      range(number(match[1]!), number(match[2]));
    } else for (const group of match[1]!.split(',')) {
      const ends = group.trim().split(/\s*[-–—]\s*/);
      if (ends.length === 1) cite(number(ends[0]!));
      else if (ends.length === 2) range(number(ends[0]!), number(ends[1]!));
      else problem('Invalid IEEE citation range');
    }
  }
  for (const [id, reference] of references) {
    const urls = reference.match(/https?:\/\/[^\s<>\])]+/g) || [];
    if (!urls.length || urls.some(url => !research.includes(url))) problem(`Reference [${id}] must cite a traceable researched URL`);
  }
  // Extra bibliography entries are an editorial warning, not a failed design.
  // Preserve the original text/numbering and validate source traceability even
  // for uncited entries; do not silently invent citations or rewrite the plan.
  return { unusedReferences: [...references.keys()].filter(id => !citations.has(id)) };
}

interface ReferenceSection { start: number; end: number; content: string }

/** Locate actual Markdown References sections, without treating code examples as metadata. */
function referenceSections(markdown: string): ReferenceSection[] {
  const sections: ReferenceSection[] = [];
  let offset = 0, active: { start: number; contentStart: number; level: number } | undefined;
  let fence: string | undefined;
  for (const line of markdown.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (!fence) {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line.replace(/\r?\n$/, ''));
      if (heading) {
        if (active && (heading[1]!.length <= active.level || /^References$/i.test(heading[2]!))) {
          sections.push({ start: active.start, end: offset, content: markdown.slice(active.contentStart, offset) });
          active = undefined;
        }
        if (/^References$/i.test(heading[2]!)) active = { start: offset, contentStart: offset + line.length, level: heading[1]!.length };
      }
    }
    offset += line.length;
  }
  if (active) sections.push({ start: active.start, end: markdown.length, content: markdown.slice(active.contentStart) });
  return sections;
}

/** A present canonical directory is authoritative; malformed directories never fall back to legacy mode. */
function researchDirectory(research: string): Map<number, string> | undefined {
  const sections = referenceSections(research);
  if (!sections.length) return undefined;
  if (sections.length !== 1) throw new Error('Research must contain one References directory');
  const entries = new Map<number, string>();
  let current: number | undefined;
  for (const line of sections[0]!.content.trim().split(/\r?\n/)) {
    const entry = /^\[(\d+)\]\s+(.+)$/.exec(line);
    if (entry) {
      const id = Number(entry[1]);
      if (!Number.isSafeInteger(id) || id !== entries.size + 1) throw new Error('Research reference numbers must be unique and consecutive from [1]');
      current = id; entries.set(id, line);
    } else if (line.trim()) {
      if (!current || !/^[ \t]+\S/.test(line)) throw new Error('Research References must contain numbered entries only');
      entries.set(current, entries.get(current)! + '\n' + line);
    }
  }
  for (const [id, entry] of entries) {
    if (!/https?:\/\/[^\s<>\])]+/.test(entry)) throw new Error(`Research reference [${id}] must contain a source URL`);
  }
  return entries;
}

/** Enforce the new contract only on newly generated research; historic inputs remain readable. */
export function validateResearchReferences(research: string): void {
  const directory = researchDirectory(research);
  if (!directory || (!directory.size && /https?:\/\//.test(research))) {
    throw new Error('Research must end with ## References and numbered source entries (or an empty directory when no sources exist)');
  }
  const section = referenceSections(research)[0]!;
  if (!/^## References[ \t]*\r?$/m.test(research.slice(section.start).split('\n')[0]!)) throw new Error('Research directory must use ## References');
  if (research.slice(section.end).trim()) throw new Error('Research References must be the final section');
  // Numeric citations in the research itself must also resolve to its own directory.
  validateCitations(research, research);
}

/** Bind design citations to fixed research ids and copy the complete directory without model rewriting. */
export function prepareDesignCitations(design: string, research: string): string {
  const directory = researchDirectory(research);
  if (!directory) {
    validateCitations(design, research); // Legacy research has no authoritative numeric directory.
    return design;
  }
  let body = design;
  for (const section of referenceSections(design).reverse()) {
    body = body.slice(0, section.start) + body.slice(section.end);
  }
  const result = body.trimEnd() + '\n\n## References\n' + [...directory.values()].join('\n') + '\n';
  validateCitations(result, research); // Unknown ids still fail; no invented or renumbered citations.
  return result;
}

export interface CitationReview {
  text: string;
  repairs: string[];
  issues: string[];
  unusedReferences: number[];
}

function review(text: string, research: string, repairs: string[] = [], issues: string[] = []): CitationReview {
  const { unusedReferences } = validateCitations(text, research, issues);
  return { text, repairs, issues: [...new Set(issues)], unusedReferences };
}

/** Only deterministic document repairs. Ambiguous ids and missing facts are retained for review. */
export function reviewResearchCitations(output: string): CitationReview {
  let text = output;
  const repairs: string[] = [];
  const issues: string[] = [];
  const wrapped = /^\s*```(?:md|markdown)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(text);
  if (wrapped) { text = wrapped[1]!; repairs.push('Removed enclosing Markdown fence.'); }
  const sections = referenceSections(text);
  if (sections.length === 1) {
    const section = sections[0]!;
    const content = section.content.trim();
    // Exact duplicates carry no ambiguity; different entries sharing an id remain untouched.
    const blocks = content.split(/(?=^\[\d+\]\s+)/m), seen = new Set<string>();
    const unique = blocks.filter(block => {
      if (!/^\[\d+\]\s+/.test(block)) return true;
      const key = block.trimEnd();
      if (seen.has(key)) { repairs.push('Removed an identical duplicate bibliography entry.'); return false; }
      seen.add(key); return true;
    }).map(block => block.trimEnd()).join('\n');
    const body = text.slice(0, section.start) + text.slice(section.end);
    const canonical = body.trimEnd() + '\n\n## References\n' + unique + (unique ? '\n' : '');
    if (canonical !== text && !repairs.length) repairs.push('Normalized the bibliography heading and placement.');
    text = canonical;
  }
  try { validateResearchReferences(text); }
  catch (error) { issues.push(String(error instanceof Error ? error.message : error)); }
  // Never renumber a source by guessing how grouped/ranged in-text citations should map.
  return review(text, text, repairs, issues);
}

export function reviewDesignCitations(design: string, research: string): CitationReview {
  let text = design;
  const repairs: string[] = [], issues: string[] = [];
  const sections = referenceSections(research);
  if (sections.length === 1) {
    // Even an imperfect directory is copied faithfully; ambiguous entries are flagged, not guessed.
    try { validateResearchReferences(research); }
    catch (error) { issues.push('Research bibliography needs verification: ' + String(error instanceof Error ? error.message : error)); }
    for (const section of referenceSections(text).reverse()) text = text.slice(0, section.start) + text.slice(section.end);
    const bibliography = sections[0]!.content.trim();
    text = text.trimEnd() + '\n\n## References\n' + bibliography + (bibliography ? '\n' : '');
    if (text !== design) repairs.push('Restored the complete research bibliography with its original source numbers.');
  } else if (sections.length > 1) {
    issues.push('Multiple research bibliographies are ambiguous; original design references retained.');
  }
  return review(text, research, repairs, issues);
}

/** A visible status in the delivered document, outside image prompts and the bibliography. */
export function annotateCitationIssues(result: CitationReview): string {
  if (!result.issues.length) return result.text;
  const sections = referenceSections(result.text);
  const at = sections[0]?.start ?? result.text.length;
  const notice = '## Citation verification\nSome references need verification. Original citation numbers and source information have been retained; these references must not be presented as verified evidence.\n'
    + result.issues.map(issue => '- ' + issue).join('\n') + '\n\n';
  return result.text.slice(0, at).trimEnd() + '\n\n' + notice + result.text.slice(at);
}
