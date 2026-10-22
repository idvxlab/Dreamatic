import { DefaultResourceLoader, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { skillMetadata } from "./skill-metadata.js";

export const SKILL_LOADING_INSTRUCTION = "Discover professional knowledge with list_skills using task descriptions, capabilities or output types. Choose exact names from the returned catalog; never assume a particular installed name. Load Skill entry files only through use_skill. Read referenced resources relative to the returned base directory as needed. Discovery and saved selections do not load knowledge; reload retained selections after compaction or in a fresh invocation. Skills never grant tools or change role permissions.";

/** One invocation-local snapshot: Pi owns discovery, precedence and diagnostics. */
export class SkillCatalog {
  #catalogs = new Map<string, Promise<Awaited<ReturnType<SkillCatalog["discover"]>>>>();
  invalidate(cwd: string) { this.#catalogs.delete(cwd); }
  load(cwd: string, refresh = false) {
    if (refresh) this.invalidate(cwd);
    let result = this.#catalogs.get(cwd);
    if (!result) {
      result = this.discover(cwd);
      this.#catalogs.set(cwd, result);
      void result.catch(() => { if (this.#catalogs.get(cwd) === result) this.invalidate(cwd); });
    }
    return result;
  }
  private async discover(cwd: string) {
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    const entries = await Promise.all(skills.map(async skill => {
      try {
        const content = await readFile(skill.filePath, "utf8");
        const metadata = skillMetadata(parseFrontmatter<{ metadata?: unknown }>(content).frontmatter.metadata);
        return { skill, physicalPath: await realpath(skill.filePath), descriptor: { name: skill.name, description: skill.description, path: skill.filePath,
          sha256: createHash("sha256").update(content).digest("hex"), ...metadata } };
      } catch (error) {
        return { error: { type: "warning" as const, path: skill.filePath, message: error instanceof Error ? error.message : String(error) } };
      }
    }));
    return { skills: entries.flatMap(entry => entry.skill ? [entry.skill] : []),
      entryPaths: new Set(entries.flatMap(entry => entry.physicalPath ? [entry.physicalPath] : [])),
      descriptors: entries.flatMap(entry => entry.descriptor ? [entry.descriptor] : []),
      diagnostics: [...diagnostics, ...entries.flatMap(entry => entry.error ? [entry.error] : [])] };
  }
}
