import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadToolDefinition, loadSkills, parseFrontmatter, type ReadToolInput, type Skill, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { PROJECT_CATEGORIES } from '@dreamatic/project-data';
import { AGENT_ROLES, parseSkillSources, type AgentRole } from './skill-sources.js';

export const APPLICATION_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BUILTIN_SKILL_DIRECTORY = join(APPLICATION_ROOT, '.pi/skills');
export interface SkillDiagnostic { severity: 'warning' | 'error'; code: string; path: string; message: string }
export interface CatalogSkill { skill: Skill; source: 'builtin' | 'approved'; digest: string; version?: string; compatibility?: string; allowedTools?: string; invocationPolicy?: { location: string; path: string; digest: string } }
export interface SkillCatalog { id: string; role: AgentRole; entries: CatalogSkill[]; diagnostics: SkillDiagnostic[] }
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const inside = (root: string, target: string) => { const path = relative(root, target); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)); };
const words = (value: unknown) => typeof value === 'string' ? value.split(/\s+/u).filter(Boolean) : [];
const pathFrom = (root: string, path: string) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(root, path);
const toolName = (name: string) => ({ Read: 'read', Bash: 'bash', Write: 'write', Edit: 'edit', WebSearch: 'web_search' }[name] ?? name);

/** Only leading directives in the original human request select Skills. */
export function requestedSkillNames(request = ''): string[] {
  const names: string[] = [];
  let rest = request.trimStart();
  for (;;) {
    const match = /^(?:\$|\/skill:)([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/u.exec(rest);
    if (!match || match[1]!.length > 64) break;
    names.push(match[1]!);
    rest = rest.slice(match[0].length).trimStart();
  }
  return [...new Set(names)];
}

export function validateSkillDocument(source: string, directoryName: string, builtin = false): string[] {
  const errors: string[] = [];
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return ['SKILL.md requires YAML frontmatter'];
  let data: Record<string, unknown>;
  try { data = parseFrontmatter<Record<string, unknown>>(source).frontmatter; } catch { return ['SKILL.md contains invalid YAML frontmatter']; }
  if (data.license !== undefined && (typeof data.license !== 'string' || !data.license.trim())) errors.push('license must be a non-empty string');
  const name = data.name, description = data.description;
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64 || name !== directoryName) errors.push('name must match the directory and use lowercase letters, digits and single hyphens (1–64 characters)');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) errors.push('description must contain 1–1024 characters');
  if (data.compatibility !== undefined && (typeof data.compatibility !== 'string' || !data.compatibility.trim() || data.compatibility.length > 500)) errors.push('compatibility must contain 1–500 characters');
  if (data['allowed-tools'] !== undefined && typeof data['allowed-tools'] !== 'string') errors.push('allowed-tools must be a string');
  const metadata = data.metadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.values(metadata).some(value => typeof value !== 'string'))) errors.push('metadata must map string keys to string values');
  if (builtin) {
    const fields = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
    const roles = words(fields['dreamatic-roles']);
    if (!roles.length || roles.some(role => !(AGENT_ROLES as readonly string[]).includes(role))) errors.push('built-in dreamatic-roles must identify supported application roles');
    const categoryIds = new Set<string>(PROJECT_CATEGORIES.map(category => category.id));
    if (words(fields['dreamatic-categories']).some(category => !categoryIds.has(category))) errors.push('built-in categories must use the current project taxonomy');
    if (typeof fields.version !== 'string' || !fields.version) errors.push('built-in skills require a version');
  }
  return errors;
}

/** Pi parses approved sources. Application policy selects roles and rejects unsupported dependencies. */
export async function loadRoleSkillCatalog(options: { root: string; role: AgentRole; tools: string[]; env?: NodeJS.ProcessEnv; builtinDir?: string }): Promise<SkillCatalog> {
  const catalog: SkillCatalog = { id: randomUUID(), role: options.role, entries: [], diagnostics: [] };
  const addDiagnostic = (code: string, path: string, message: string, severity: SkillDiagnostic['severity'] = 'error') => catalog.diagnostics.push({ severity, code, path, message });
  const sources = parseSkillSources(options.env?.DREAMATIC_SKILL_PATHS);
  const builtinDir = await realpath(options.builtinDir ?? BUILTIN_SKILL_DIRECTORY);
  const builtins = loadSkills({ cwd: options.root, agentDir: join(options.root, '.pi'), skillPaths: [builtinDir], includeDefaults: false });
  for (const diagnostic of builtins.diagnostics) addDiagnostic('native-validation', diagnostic.path ?? builtinDir, diagnostic.message, 'warning');
  const candidates: Array<{ skill: Skill; source: CatalogSkill['source']; approvedRoot: string }> = builtins.skills.map(skill => ({ skill, source: 'builtin', approvedRoot: builtinDir }));
  for (const path of sources[options.role] ?? []) {
    const requested = pathFrom(options.root, path);
    try {
      const info = await stat(requested);
      const directory = info.isDirectory() ? requested : dirname(requested);
      if (!info.isDirectory() && basename(requested) !== 'SKILL.md') throw new Error('Approve a directory containing SKILL.md or a SKILL.md file');
      await stat(join(directory, 'SKILL.md'));
      const approvedRoot = await realpath(directory);
      const loaded = loadSkills({ cwd: options.root, agentDir: join(options.root, '.pi'), skillPaths: [join(directory, 'SKILL.md')], includeDefaults: false });
      for (const diagnostic of loaded.diagnostics) addDiagnostic('native-validation', diagnostic.path ?? requested, diagnostic.message, 'warning');
      if (!loaded.skills.length) addDiagnostic('invalid-skill', requested, 'Pi could not load this approved Skill');
      candidates.push(...loaded.skills.map(skill => ({ skill, source: 'approved' as const, approvedRoot })));
    } catch (error) { addDiagnostic('source-unavailable', requested, error instanceof Error ? error.message : 'Could not read Skill source'); }
  }
  const reservedNames = new Set(builtins.skills.map(skill => skill.name));
  const availableTools = new Set(options.tools);
  const seenNames = new Set<string>(), seenPaths = new Set<string>();
  for (const candidate of candidates) {
    const { source, approvedRoot } = candidate;
    let path = candidate.skill.filePath;
    try {
      path = await realpath(path);
      const baseDir = await realpath(candidate.skill.baseDir);
      if (!inside(approvedRoot, path) || !inside(approvedRoot, baseDir) || !inside(baseDir, path)) throw new Error('Skill path escapes its approved source directory');
      const text = await readFile(path, 'utf8');
      const errors = validateSkillDocument(text, basename(baseDir), source === 'builtin');
      if (errors.length) { addDiagnostic('invalid-skill', path, errors.join('; ')); continue; }
      const { frontmatter: data } = parseFrontmatter<Record<string, unknown>>(text);
      const metadata = (data.metadata ?? {}) as Record<string, string>;
      const roles = words(metadata['dreamatic-roles']);
      if (roles.length && !roles.includes(options.role)) {
        if (source === 'approved') addDiagnostic('role-mismatch', path, `Skill declares roles ${roles.join(', ')} and is not available to ${options.role}`, 'warning');
        continue;
      }
      const skill: Skill = { ...candidate.skill, filePath: path, baseDir };
      if (seenPaths.has(path)) continue;
      // Reserve reviewed built-in names even if an explicitly requested third party uses the same name.
      if (seenNames.has(skill.name) || (source === 'approved' && reservedNames.has(skill.name))) { addDiagnostic('name-collision', path, `Skill ${skill.name} is already supplied by an earlier approved source; the built-in or first configured source wins`, 'warning'); continue; }
      let invocationPolicy: CatalogSkill['invocationPolicy'];
      const policyPath = join(baseDir, 'agents/openai.yaml');
      let policyPresent = false;
      try {
        await lstat(policyPath); policyPresent = true;
        const canonical = await realpath(policyPath);
        if (!inside(baseDir, canonical)) throw new Error('Invocation policy escapes its approved Skill directory');
        const policyText = await readFile(canonical, 'utf8');
        const config = parseFrontmatter<Record<string, unknown>>(`---\n${policyText}\n---\n`).frontmatter;
        if (config.policy !== undefined && (!config.policy || typeof config.policy !== 'object' || Array.isArray(config.policy))) throw new Error('openai.yaml policy must be a mapping');
        const implicit = (config.policy as Record<string, unknown> | undefined)?.allow_implicit_invocation;
        if (implicit !== undefined && typeof implicit !== 'boolean') throw new Error('allow_implicit_invocation must be a boolean');
        skill.disableModelInvocation ||= implicit === false;
        invocationPolicy = { location: policyPath, path: canonical, digest: digest(policyText) };
        if (config.dependencies !== undefined) addDiagnostic('dependencies-unverified', canonical, 'Client dependency declarations are not installed or connected by Dreamatic. Only registered host tools are available.', 'warning');
      } catch (error) {
        if (policyPresent || (error as NodeJS.ErrnoException).code !== 'ENOENT') { addDiagnostic('invalid-invocation-policy', policyPath, error instanceof Error ? error.message : 'Invalid invocation policy'); continue; }
      }
      const requirements = words(metadata['dreamatic-requires-tools']).map(value => toolName(value.split('(')[0]!));
      const missing = [...new Set(requirements.filter(name => !availableTools.has(name)))];
      if (missing.length) { addDiagnostic('unavailable-tools', path, `Unavailable tool requirements: ${missing.join(', ')}. Skill instructions do not grant execution permissions.`); continue; }
      const allowedTools = typeof data['allowed-tools'] === 'string' ? data['allowed-tools'] : undefined;
      const unavailable = words(allowedTools).filter(value => !availableTools.has(toolName(value.split('(')[0]!)));
      if (unavailable.length) addDiagnostic('allowed-tools-unavailable', path, `Declared optional tools are unavailable: ${unavailable.join(', ')}. Knowledge remains available; this declaration grants no tools.`, 'warning');
      if (words(allowedTools).some(value => value.includes('('))) addDiagnostic('tool-patterns-advisory', path, 'Client-specific tool argument patterns are advisory and are not enforced as per-Skill permissions. Host tool policy remains authoritative.', 'warning');
      if (source === 'approved' && typeof data.compatibility === 'string') addDiagnostic('environment-unverified', path, 'Environment compatibility is declared by this Skill and has not been verified; only registered tools are available.', 'warning');
      catalog.entries.push({ skill, source, digest: digest(text), ...(metadata.version ? { version: metadata.version } : {}), ...(typeof data.compatibility === 'string' ? { compatibility: data.compatibility } : {}), ...(allowedTools !== undefined ? { allowedTools } : {}), ...(invocationPolicy ? { invocationPolicy } : {}) });
      seenNames.add(skill.name); seenPaths.add(path);
    } catch (error) { addDiagnostic('source-unavailable', path, error instanceof Error ? error.message : 'Could not load Skill'); }
  }
  return catalog;
}

export async function saveSkillCatalog(root: string, catalog: SkillCatalog, sessionId: string) {
  const directory = join(root, 'sessions', catalog.role, 'skills');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `skill-catalog-${catalog.id}.json`), temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, id: catalog.id, sessionId, role: catalog.role, createdAt: new Date().toISOString(), skills: catalog.entries.map(({ skill, ...entry }) => ({ ...entry, name: skill.name, path: skill.filePath, baseDir: skill.baseDir, implicit: !skill.disableModelInvocation })), diagnostics: catalog.diagnostics }, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function readCatalogSkill(entry: CatalogSkill): Promise<string> {
  const path = await realpath(entry.skill.filePath);
  if (path !== entry.skill.filePath || !inside(entry.skill.baseDir, path)) throw new Error('Skill source moved; start a new session to reload and validate it');
  const text = await readFile(path, 'utf8');
  if (digest(text) !== entry.digest) throw new Error('Skill changed after catalog creation; start a new session to reload and validate it');
  if (entry.invocationPolicy) {
    const policy = entry.invocationPolicy;
    if (await realpath(policy.location) !== policy.path || digest(await readFile(policy.path, 'utf8')) !== policy.digest) throw new Error('Skill invocation policy changed; start a new session to reload and validate it');
  }
  return text;
}

async function recordSkillRead(root: string, catalog: SkillCatalog, sessionId: string, entry: CatalogSkill, detail: Record<string, unknown>) {
  const directory = join(root, 'sessions', catalog.role, 'skills');
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, 'skill-activations.jsonl'), JSON.stringify({ version: 1, at: new Date().toISOString(), sessionId, catalogId: catalog.id, role: catalog.role, name: entry.skill.name, path: entry.skill.filePath, source: entry.source, digest: entry.digest, event: 'skill_read', ...detail }) + '\n', { mode: 0o600 });
}

export async function explicitSkillInstructions(options: { root: string; catalog: SkillCatalog; request?: string; sessionId: string }): Promise<string> {
  const blocks: string[] = [];
  for (const name of requestedSkillNames(options.request)) {
    const entry = options.catalog.entries.find(entry => entry.skill.name === name);
    // A multi-role request selects the method only in roles where it is approved.
    if (!entry) continue;
    const text = await readCatalogSkill(entry);
    const body = parseFrontmatter(text).body;
    blocks.push(`## Explicitly requested Skill: ${name}\n\nSkill directory: ${entry.skill.baseDir}\nResolve resource references against that directory. Host role, output and tool policy remain authoritative.\n\n${body}`);
    await recordSkillRead(options.root, options.catalog, options.sessionId, entry, { invocation: 'explicit', offset: 1, callId: `explicit:${name}` });
  }
  return blocks.length ? `# User-selected Skill knowledge\n\n${blocks.join('\n\n')}\n\n---\n\n` : '';
}

export function createScopedSkillReadTool(options: { root: string; catalog: SkillCatalog; promptRoots?: string[]; delegate?: ToolDefinition; sessionId: () => string; requestedSkills?: string[] }): ToolDefinition {
  const native = options.delegate ?? createReadToolDefinition(options.root);
  let writes = Promise.resolve();
  return { name: native.name, label: native.label, parameters: native.parameters, description: native.description + ' Read only the current run, approved Skill resources, or role prompts. Skill resources are knowledge; reading scripts does not execute them.',
    async execute(callId, params, signal, onUpdate, context) {
      const input = params as ReadToolInput;
      if (typeof input.path !== 'string') throw new Error('Read requires a file path');
      const path = await realpath(pathFrom(options.root, input.path));
      const selected = new Set(options.requestedSkills ?? []);
      const rootCandidates = [options.root, ...(options.promptRoots ?? [])].map(path => ({ path, frozen: false }));
      rootCandidates.push(...options.catalog.entries.filter(entry => !entry.skill.disableModelInvocation || selected.has(entry.skill.name)).map(entry => ({ path: entry.skill.baseDir, frozen: true })));
      const roots = (await Promise.all(rootCandidates.map(async root => {
        try { const canonical = await realpath(root.path); return !root.frozen || canonical === root.path ? canonical : undefined; }
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
      }))).filter((root): root is string => root !== undefined);
      if (!roots.some(root => inside(root, path))) throw new Error('Read path is outside the run, approved Skill resources and role prompts');
      const entry = options.catalog.entries.find(entry => entry.skill.filePath === path);
      if (basename(path) === 'SKILL.md' && !entry) throw new Error('This Skill is not in the approved role catalog');
      if (entry?.skill.disableModelInvocation && !selected.has(entry.skill.name)) throw new Error('This Skill requires explicit user invocation');
      if (entry) await readCatalogSkill(entry);
      const result = await native.execute(callId, { ...input, path }, signal, onUpdate, context);
      if (entry) {
        const operation = writes.catch(() => {}).then(() => recordSkillRead(options.root, options.catalog, options.sessionId(), entry, { invocation: 'model', offset: input.offset ?? 1, ...(input.limit ? { limit: input.limit } : {}), callId }));
        writes = operation; await operation;
      }
      return result;
    }
  };
}
