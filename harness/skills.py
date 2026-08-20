"""
Shared skill and persona loading logic.
Used by both the CLI (cli.py) and the REST API (api/rest.py).

Skill discovery priority (high → low):
  1. .myharness/skills/         — project-installed
  2. ~/.myharness/skills/       — user-global installed
  3. .claude/skills/            — Claude Code ecosystem compat
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml


# ── Paths ─────────────────────────────────────────────────────────────

SKILLS_DIR         = Path(".myharness/skills")   # where skill CRUD writes to
PERSONAS_DIR       = Path(".myharness/personas")
PROJECT_SKILL_SOURCES = {"project", "project-agents", "project-claude"}

def _get_skill_scan_dirs() -> list[tuple[Path, str]]:
    """Return [(directory, source_label), ...] in priority order."""
    home = Path(os.environ.get("HOME", os.environ.get("USERPROFILE", "~")))

    return [
        (Path(".myharness/skills"), "project"),
        (home / ".myharness" / "skills", "global"),
        (Path(".agents/skills"), "project-agents"),
        (home / ".agents" / "skills", "global-agents"),
        (Path(".claude/skills"), "project-claude"),
        (home / ".claude" / "skills", "global-claude"),
    ]


# ── Persona helpers ────────────────────────────────────────────────────

def parse_persona_md(path: Path) -> dict[str, Any]:
    """Parse YAML frontmatter + Markdown body from a persona file.

    Returns dict with persona/agent profile fields:
    name, description, system_prompt, allowed_tools, provider, mode, hidden,
    color, default_approval_mode, can_spawn, spawn_allowlist.
    Legacy files (no frontmatter) are treated as pure system-prompt text.
    """
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", text, re.DOTALL)
    if m:
        meta: dict[str, Any] = yaml.safe_load(m.group(1)) or {}
        meta["system_prompt"] = m.group(2).strip()
    else:
        meta = {"system_prompt": text.strip()}
    meta.setdefault("name", path.stem)
    meta.setdefault("display_name", meta.get("name", path.stem))
    meta.setdefault("description", "")
    meta.setdefault("allowed_tools", None)
    meta.setdefault("provider", "")
    meta.setdefault("mode", "all")
    meta.setdefault("hidden", False)
    meta.setdefault("color", "")
    meta.setdefault("default_approval_mode", "")
    meta.setdefault("can_spawn", True)
    meta.setdefault("spawn_allowlist", None)
    if meta["mode"] not in ("primary", "subagent", "all"):
        meta["mode"] = "all"
    if meta["default_approval_mode"] not in ("", "ask", "auto", "full"):
        meta["default_approval_mode"] = ""
    meta["hidden"] = bool(meta["hidden"])
    meta["can_spawn"] = bool(meta["can_spawn"])
    if meta["spawn_allowlist"] is not None:
        meta["spawn_allowlist"] = [str(item) for item in meta["spawn_allowlist"]]
    return meta


def load_persona(name: str) -> dict[str, Any]:
    """Load personas/{name}.md -> dict with system_prompt, allowed_tools, etc."""
    md = PERSONAS_DIR / f"{name}.md"
    if not md.exists():
        available = [p["name"] for p in list_personas()]
        raise ValueError(
            f"Persona '{name}' not found. "
            f"Available: {available}. "
            f"Create: personas/{name}.md"
        )
    return parse_persona_md(md)


def list_personas() -> list[dict[str, Any]]:
    """Return sorted persona/agent profile summaries (excludes README)."""
    if not PERSONAS_DIR.exists():
        return []
    results = []
    for p in sorted(PERSONAS_DIR.glob("*.md")):
        if p.stem.upper() == "README":
            continue
        try:
            meta = parse_persona_md(p)
            results.append({
                "name": str(meta.get("name") or p.stem),
                "display_name": str(meta.get("display_name") or meta.get("name") or p.stem),
                "description": str(meta.get("description", "")),
                "mode": str(meta.get("mode", "all")),
                "hidden": bool(meta.get("hidden", False)),
                "color": str(meta.get("color", "")),
                "provider": str(meta.get("provider", "")),
                "default_approval_mode": str(meta.get("default_approval_mode", "")),
                "can_spawn": bool(meta.get("can_spawn", True)),
                "spawn_allowlist": meta.get("spawn_allowlist"),
            })
        except Exception:
            results.append({
                "name": p.stem,
                "display_name": p.stem,
                "description": "",
                "mode": "all",
                "hidden": False,
                "color": "",
                "provider": "",
                "default_approval_mode": "",
                "can_spawn": True,
                "spawn_allowlist": None,
            })
    return results


# ── Skill helpers (folder-based) ───────────────────────────────────────

def parse_skill_md(path: Path) -> dict[str, Any]:
    """Parse a YAML-frontmatter + Markdown-body skill file (SKILL.md)."""
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", text, re.DOTALL)
    if not m:
        raise ValueError(
            f"{path.name}: missing frontmatter. "
            "File must start with --- markers. See skills/template/SKILL.md."
        )
    meta: dict[str, Any] = yaml.safe_load(m.group(1)) or {}
    body = m.group(2).strip()
    meta["system_prompt"] = body
    meta.setdefault("_source_file", str(path))
    return meta


def _iter_skill_dirs(project_only: bool = False) -> list[tuple[Path, str]]:
    """Return skill scan dirs, optionally limited to project-local sources."""
    dirs = _get_skill_scan_dirs()
    if not project_only:
        return dirs
    return [(scan_dir, source) for scan_dir, source in dirs if source in PROJECT_SKILL_SOURCES]


def _resolve_skill_file(
    name: str,
    *,
    project_only: bool = False,
) -> tuple[Path, str] | None:
    """Resolve a skill name to the first matching file and its source label."""
    for scan_dir, source in _iter_skill_dirs(project_only=project_only):
        if not scan_dir.exists():
            continue

        folder_md = scan_dir / name / "SKILL.md"
        if folder_md.exists():
            return folder_md, source

        legacy_md = scan_dir / f"{name}.md"
        if legacy_md.exists():
            return legacy_md, source

    return None


def _display_skill_path(path: Path) -> str:
    """Return a stable display path for config UIs and API responses."""
    try:
        return path.relative_to(Path.cwd()).as_posix()
    except ValueError:
        return path.as_posix()


def resolve_project_skill_path(name: str) -> tuple[Path, str] | None:
    """Resolve a project-local skill from supported project Skill directories."""
    return _resolve_skill_file(name, project_only=True)


def load_skill(name: str, project_only: bool = False) -> dict[str, Any]:
    """Load a skill by name, searching all directories in priority order.

    Priority follows :func:`_get_skill_scan_dirs`.

    For each directory, looks for ``{name}/SKILL.md`` first, then ``{name}.md`` (legacy).
    """
    resolved = _resolve_skill_file(name, project_only=project_only)
    if resolved is not None:
        skill_path, source = resolved
        meta = parse_skill_md(skill_path)
        meta.setdefault("_source", source)
        meta.setdefault("_source_file", str(skill_path))
        meta.setdefault("_display_path", _display_skill_path(skill_path))
        return meta

    available = [s["name"] for s in list_skills()]
    raise ValueError(
        f"Skill '{name}' not found. "
        f"Available: {available}. "
        f"Create: .myharness/skills/{name}/SKILL.md"
    )


def load_skill_content(name: str) -> str:
    """Return the instruction body (markdown) of a skill."""
    return load_skill(name).get("system_prompt", "")


def _scan_skill_dir(
    scan_dir: Path,
    source: str,
    *,
    include_paths: bool = False,
) -> list[dict[str, Any]]:
    """Scan a single directory for skills, returning [{name, description, source}, ...]."""
    results: list[dict[str, Any]] = []
    if not scan_dir.exists():
        return results

    # Folder-based skills (each subfolder with SKILL.md)
    for item in sorted(scan_dir.iterdir()):
        if not item.is_dir() or item.name.startswith(".") or item.name == "template":
            continue
        skill_md = item / "SKILL.md"
        if skill_md.exists():
            try:
                meta = parse_skill_md(skill_md)
                entry = {
                    "name":        str(meta.get("name") or item.name),
                    "description": str(meta.get("description", "")),
                    "source":      source,
                }
                if include_paths:
                    entry["path"] = _display_skill_path(skill_md)
                results.append(entry)
            except Exception:
                pass

    # Legacy flat .md files
    for md_file in sorted(scan_dir.glob("*.md")):
        if md_file.stem == "template":
            continue
        try:
            meta = parse_skill_md(md_file)
            entry = {
                "name":        str(meta.get("name") or md_file.stem),
                "description": str(meta.get("description", "")),
                "source":      source,
            }
            if include_paths:
                entry["path"] = _display_skill_path(md_file)
            results.append(entry)
        except Exception:
            pass

    return results


def list_skills(
    *,
    project_only: bool = False,
    include_paths: bool = False,
) -> list[dict[str, str]]:
    """Return [{name, description, source}] for all skills across all directories.

    Sources cover Dreamatic, Agents, and Claude-compatible project/global directories.

    Higher-priority directories override lower-priority skills with the same name.
    """
    seen: set[str] = set()
    results: list[dict[str, str]] = []

    # Scan in priority order, skip seen names (first match = highest priority)
    for scan_dir, source in _iter_skill_dirs(project_only=project_only):
        for entry in _scan_skill_dir(scan_dir, source, include_paths=include_paths):
            if entry["name"] in seen:
                continue
            seen.add(entry["name"])
            results.append(entry)

    return results


def build_skill_system_addendum(skills: list[dict[str, str]]) -> str:
    """Build text appended to system prompt listing available skills.

    Names and descriptions let the agent decide when to call use_skill().
    Skills are intentionally unclassified; full content is loaded on demand.
    """
    if not skills:
        return ""
    lines = [
        "",
        "## Available Skills",
        "Skills are on-demand instruction packages, NOT executable tools.",
        "A Skill may provide professional knowledge, a method, a rubric, a",
        "protocol, a complete workflow, or several of these at once.",
        "Skills do not need a category. Use each name and description to decide",
        "whether its full instructions are relevant to the current task.",
        "When the user explicitly names an installed Skill, load it unless the",
        "request clearly says not to use it.",
        "Otherwise call `use_skill` only when the description clearly matches",
        "the task and the instructions will materially change your approach.",
        "Do NOT call `use_skill` for simple questions, small edits, ordinary",
        "debugging, or tasks you can already complete with the base tools.",
        "Do NOT repeatedly load the same skill in one session unless the user",
        "changes the task enough that the skill instructions need to be refreshed.",
        "Do not treat every Skill as a workflow. A Skill controls orchestration",
        "only when the user selects it for that purpose or its loaded",
        "instructions explicitly define the workflow being followed.",
        "Your actual executable tools (read_file, shell, web_search, etc.) are",
        "listed separately in your function-calling interface.",
        "After loading a Skill, resolve bundled references, assets, and scripts",
        "relative to the authoritative Base directory returned by `use_skill`.",
        "Do not search for or switch to duplicate Skill copies. Use",
        "`read_skill_file` to load only the resource needed for the next",
        "immediate action. Do not batch-read resources for future stages; load",
        "each one when that stage begins. Run bundled scripts with an",
        "available shell tool when the Skill requests it. If the loaded Skill",
        "defines an ordered workflow, replace any generic plan created before",
        "loading it with the Skill's ordered mandatory stages before execution.",
        "",
    ]
    for s in skills:
        lines.append(f"- **{s['name']}**: {s.get('description', '')}")
    return "\n".join(lines)


# ── Config file read/write ─────────────────────────────────────────────

def read_file_safe(path: Path) -> str:
    """Read a text file; return empty string if not found."""
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def write_file_safe(path: Path, content: str) -> None:
    """Write content to path, creating parent dirs as needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
