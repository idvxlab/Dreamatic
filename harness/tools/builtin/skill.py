"""
use_skill built-in tool.

Allows the agent to load any Skill's instructions on demand.
The agent discovers available Skills from names and descriptions, without
requiring a category, then fetches full instructions when relevant.
"""
from __future__ import annotations

import json
import re

from harness.skills import load_skill, list_skills as discover_skills
from harness.types.tools import ToolSchema, ToolParam
from pathlib import Path


_RESOURCE_PATTERN = re.compile(
    r"`((?:references|scripts|assets)[\\/][^`\r\n]+)`"
)
_DEFAULT_RESOURCE_LINES = 200
_MAX_RESOURCE_LINES = 400

USE_SKILL_SCHEMA = ToolSchema(
    name="use_skill",
    description=(
        "Load any installed Skill by name and return its full instructions. "
        "Skills are unclassified and may provide knowledge, methods, rubrics, "
        "protocols, or workflows. Use the description and user intent to decide "
        "when to load one."
    ),
    params=[
        ToolParam(
            name="name",
            type="string",
            description="The skill name to load (e.g. 'code-review', 'python-dev')",
        ),
        ToolParam(
            name="arguments",
            type="string",
            required=False,
            description="Optional arguments to pass to the skill (e.g. file path, search query)",
        ),
    ],
)

LIST_SKILLS_SCHEMA = ToolSchema(
    name="list_skills",
    description=(
        "Refresh and list installed Skills by name, description, and source. "
        "Skills are unclassified. Use this when the user mentions a newly "
        "installed Skill or when you need to discover relevant instructions "
        "before calling use_skill."
    ),
    params=[
        ToolParam(
            name="query",
            type="string",
            required=False,
            description="Optional text filter matched against Skill names and descriptions.",
        ),
    ],
)

READ_SKILL_FILE_SCHEMA = ToolSchema(
    name="read_skill_file",
    description=(
        "Read one supporting text file from an installed Skill, using a path "
        "relative to that Skill's base directory. Use this progressively for "
        "the resource required by the current immediate action. Do not batch "
        "preload resources for future stages."
    ),
    params=[
        ToolParam(name="name", type="string", description="Installed Skill name."),
        ToolParam(
            name="path",
            type="string",
            description=(
                "Relative resource path such as references/method.md or "
                "scripts/example.py."
            ),
        ),
        ToolParam(
            name="offset",
            type="integer",
            required=False,
            description="Zero-based line offset. Defaults to 0.",
        ),
        ToolParam(
            name="limit",
            type="integer",
            required=False,
            description="Number of lines to return. Defaults to 200; maximum 400.",
        ),
    ],
)


def _referenced_resources(content: str, base_dir: Path) -> list[str]:
    resources: list[str] = []
    seen: set[str] = set()
    root = base_dir.resolve()
    for match in _RESOURCE_PATTERN.finditer(content):
        relative = match.group(1).replace("\\", "/").strip()
        try:
            target = (root / relative).resolve()
            target.relative_to(root)
        except (OSError, ValueError):
            continue
        if target.is_file() and relative not in seen:
            seen.add(relative)
            resources.append(relative)
    return resources


async def use_skill_tool(name: str, arguments: str = "") -> str:
    try:
        meta = load_skill(name)
        content = meta.get("system_prompt", "")
        if not content:
            return f"Skill '{name}' exists but has no instructions."

        source = meta.get("_source_file", "")
        base_dir = (
            str(Path(source).parent.resolve())
            if source
            else str(Path(f"skills/{name}").resolve())
        )

        result = (
            f"<skill_content name=\"{name}\">\n"
            f"Base directory: {base_dir}\n\n"
            f"# Skill: {name}\n\n"
            f"{content}"
        )

        if arguments:
            result += f"\n\n---\nArguments: {arguments}"

        resources = _referenced_resources(content, Path(base_dir))
        result += "\n</skill_content>"
        if resources:
            result += (
                "\n\n<skill_resources>\n"
                + "\n".join(f"- {path}" for path in resources)
                + "\n</skill_resources>"
            )
        result += (
            "\n\n<skill_resource_instructions>\n"
            "Supporting files listed above were not loaded. Read only the one "
            "needed for the next immediate action with read_skill_file. "
            "Load later-stage resources when that stage begins rather than "
            "preloading the whole Skill package. The resource index is not an "
            "execution order; follow any ordered workflow in the main Skill "
            "instructions. The Base directory above is "
            "the authoritative copy for this activation. Resolve bundled "
            "scripts and assets from it; do not search the workspace for "
            "duplicate copies of the Skill.\n"
            "</skill_resource_instructions>\n\n"
            "<skill_execution_contract>\n"
            "The Skill instructions are active for the current task. If they "
            "define an ordered workflow, replace any generic pre-load plan "
            "with that ordered workflow before domain execution. Keep the "
            "first unfinished stage as the next action, load its supporting "
            "file when that stage begins, and do not mark the stage complete "
            "until its required State Effect or artifact exists.\n"
            "</skill_execution_contract>\n\n"
            "Follow the above instructions for the current task."
        )
        return result
    except ValueError:
        available = [s["name"] for s in discover_skills()]
        return (
            f"Skill '{name}' not found. "
            f"Available: {', '.join(available) or 'none'}"
        )


async def read_skill_file_tool(
    name: str,
    path: str,
    offset: int = 0,
    limit: int = _DEFAULT_RESOURCE_LINES,
) -> str:
    try:
        meta = load_skill(name)
    except ValueError as exc:
        return f"Error: {exc}"

    source_value = str(meta.get("_source_file") or "").strip()
    if not source_value:
        return f"Error: Skill '{name}' has no readable base directory."
    source = Path(source_value)

    relative = Path(path.replace("\\", "/"))
    if relative.is_absolute():
        return "Error: Skill resource path must be relative to the Skill directory."

    root = source.parent.resolve()
    try:
        target = (root / relative).resolve()
        target.relative_to(root)
    except (OSError, ValueError):
        return "Error: Skill resource path escapes the Skill directory."

    if not target.is_file():
        return f"Error: Skill resource not found: {path}"

    start = max(0, int(offset or 0))
    page_size = max(1, min(int(limit or _DEFAULT_RESOURCE_LINES), _MAX_RESOURCE_LINES))
    try:
        lines = target.read_text(encoding="utf-8", errors="replace").splitlines(
            keepends=True
        )
    except (OSError, UnicodeError) as exc:
        return f"Error reading Skill resource '{path}': {exc}"

    end = min(len(lines), start + page_size)
    content = "".join(lines[start:end])
    normalized = relative.as_posix()
    header = (
        f"Skill resource: {name}/{normalized}\n"
        f"Lines: {start}-{end} of {len(lines)}\n"
    )
    if end < len(lines):
        header += f"Continue with offset={end}.\n"
    else:
        header += "End of resource.\n"
    return f"{header}\n{content}"


async def list_skills_tool(query: str = "") -> str:
    skills = discover_skills()
    needle = query.strip().casefold()
    if needle:
        skills = [
            skill
            for skill in skills
            if needle in str(skill.get("name", "")).casefold()
            or needle in str(skill.get("description", "")).casefold()
        ]
    return json.dumps(
        {
            "ok": True,
            "query": query,
            "count": len(skills),
            "skills": skills,
        },
        ensure_ascii=False,
        indent=2,
    )
