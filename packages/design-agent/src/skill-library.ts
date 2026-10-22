import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDesignCategory } from "./design-categories.js";

export interface SkillLibraryIssue { code: string; path: string; message: string }

/** Build-time checks for Dreamatic's bundled library, not restrictions on installed Pi Skills. */
export async function validateSkillLibrary(root: string): Promise<SkillLibraryIssue[]> {
  const issues: SkillLibraryIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
  if (!directories.length) add("empty_library", root, "The bundled library needs at least one Skill directory");
  // Delegate Agent Skills syntax and discovery checks to Pi.
  for (const issue of loadSkillsFromDir({ dir: root, source: "project" }).diagnostics) add("pi_diagnostic", issue.path ?? root, issue.message);
  const seenNames = new Set<string>();
  for (const directory of directories) {
    const path = join(root, directory.name, "SKILL.md");
    let source: string;
    try { source = await readFile(path, "utf8"); }
    catch (error) {
      add("missing_skill_entry", path, error instanceof Error ? error.message : String(error));
      continue;
    }
    let frontmatter: Record<string, unknown>, body: string;
    try { ({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(source)); }
    catch (error) {
      add("invalid_frontmatter", path, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (frontmatter.name !== directory.name) add("name_directory_mismatch", path, "name must exactly match its directory");
    if (typeof frontmatter.name === "string") {
      if (seenNames.has(frontmatter.name)) add("duplicate_name", path, `Duplicate Skill name: ${frontmatter.name}`);
      seenNames.add(frontmatter.name);
    }
    if (body.split("\n").filter(line => /^#\s+\S/u.test(line)).length !== 1) add("invalid_title", path, "Provide exactly one non-empty level-one title");
    const metadata = frontmatter.metadata && typeof frontmatter.metadata === "object" && !Array.isArray(frontmatter.metadata)
      ? frontmatter.metadata as Record<string, unknown> : {};
    if (metadata.audience !== "designer") add("invalid_audience", path, "Bundled design knowledge must declare audience: designer");
    if (typeof metadata.domain_type !== "string" || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(metadata.domain_type)) add("invalid_domain_type", path, "domain_type must be a non-empty lowercase underscore identifier");
    if (!["discipline", "cross_domain", "execution"].includes(String(metadata.module_type))) add("invalid_module_type", path, "Declare discipline, cross_domain or execution");
    const list = (field: string, valid: (value: string) => boolean, allowEmpty = false) => {
      const value = metadata[field];
      if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.some(item => typeof item !== "string" || !valid(item)) || new Set(value).size !== value.length) {
        add(`invalid_${field}`, path, `${field} must contain unique, valid strings${allowEmpty ? " (an empty array is allowed)" : " and cannot be empty"}`);
      }
      return Array.isArray(value) ? value : [];
    };
    const categories = list("design_categories", isDesignCategory, metadata.module_type !== "discipline");
    if (["cross_domain", "execution"].includes(String(metadata.module_type)) && categories.length) add("supporting_primary_categories", path, "Supporting modules declare [] for primary professional categories");
    list("supported_outputs", value => ["image", "html"].includes(value));
    // Capability identifiers stay open-ended; adding a tag requires no registry edit.
    list("capabilities", value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value));
    if (metadata.version !== undefined && (typeof metadata.version !== "string" || !metadata.version.trim())) add("invalid_version", path, "Optional knowledge version must be a non-empty string");
    for (const match of body.matchAll(/\]\(([^)]+)\)/gu)) {
      const link = match[1]!.split(/[#?]/u)[0]!;
      if (!link || /^[a-z][a-z0-9+.-]*:/iu.test(link) || link.startsWith("//")) continue;
      try { await access(resolve(root, directory.name, decodeURIComponent(link))); }
      catch { add("missing_reference", path, `Local reference does not exist: ${link}`); }
    }
  }
  return issues;
}
