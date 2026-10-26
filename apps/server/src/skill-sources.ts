import { isAbsolute } from 'node:path';

export const AGENT_ROLES = ['orchestrator', 'researcher', 'designer', 'builder', 'editor'] as const;
export type AgentRole = typeof AGENT_ROLES[number];
export type SkillSources = Partial<Record<AgentRole, string[]>>;

/** Application settings only; approving a Skill path does not approve execution. */
export function parseSkillSources(source: string | undefined): SkillSources {
  if (!source?.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('Skill paths must be a JSON object of role names and absolute Skill paths'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill paths must be a JSON object');
  for (const [role, paths] of Object.entries(value)) {
    if (!(AGENT_ROLES as readonly string[]).includes(role)) throw new Error(`Unknown Skill role: ${role}`);
    if (!Array.isArray(paths) || paths.length > 32 || paths.some(path => typeof path !== 'string' || path.length > 4096 || /[\r\n\0]/u.test(path) || (!isAbsolute(path) && !path.startsWith('~/')))) throw new Error(`Skill paths for ${role} must contain at most 32 absolute paths or ~/ paths`);
  }
  return value as SkillSources;
}
