from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.agents import load_agent_profile
from harness.config import HarnessConfig
from harness.factory import build_engine
from harness.skills import build_skill_system_addendum, list_skills, load_skill
from harness.storage.backends.memory import (
    InMemoryMemoryStore,
    InMemoryPlanStore,
    MemorySessionStore,
)
from harness.tools.builtin.design_run import (
    design_bus_post_tool,
    design_bus_read_tool,
    run_init_tool,
)
from harness.tools.builtin.skill import (
    list_skills_tool,
    read_skill_file_tool,
    use_skill_tool,
)


def _write_skill(root: Path, name: str, description: str, body: str) -> Path:
    path = root / ".myharness" / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        f"name: {name}\n"
        f'description: "{description}"\n'
        "---\n"
        f"{body}\n",
        encoding="utf-8",
    )
    return path


def _write_persona(root: Path, name: str) -> Path:
    path = root / ".myharness" / "personas" / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        f"name: {name}\n"
        "description: Custom workflow reviewer.\n"
        "mode: subagent\n"
        "hidden: true\n"
        "can_spawn: false\n"
        "---\n"
        "# Role\n\nReview the custom stage.\n",
        encoding="utf-8",
    )
    return path


def _write_agents_skill(root: Path, name: str) -> Path:
    path = root / ".agents" / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        f"name: {name}\n"
        'description: "A specialized scripted workflow."\n'
        "---\n"
        "# Scripted workflow\n",
        encoding="utf-8",
    )
    return path


def test_unclassified_skill_is_discovered_and_loaded(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    _write_skill(
        tmp_path,
        "museum-work",
        "Museum exhibition research and planning guidance.",
        "# Museum Work\n\nFollow the visitor narrative.",
    )

    summaries = list_skills(project_only=True)
    assert summaries == [
        {
            "name": "museum-work",
            "description": "Museum exhibition research and planning guidance.",
            "source": "project",
        }
    ]
    assert "Follow the visitor narrative." in load_skill("museum-work")["system_prompt"]


def test_agents_skill_is_discovered(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    _write_agents_skill(tmp_path, "travel-workflow")

    summaries = list_skills(project_only=True)
    assert summaries == [
        {
            "name": "travel-workflow",
            "description": "A specialized scripted workflow.",
            "source": "project-agents",
        }
    ]
    loaded = load_skill("travel-workflow", project_only=True)
    assert loaded["_source"] == "project-agents"
    assert loaded["_source_file"].endswith("SKILL.md")


@pytest.mark.asyncio
async def test_list_skills_refreshes_current_filesystem(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    _write_skill(tmp_path, "first-skill", "First method.", "# First")

    first = json.loads(await list_skills_tool())
    assert [item["name"] for item in first["skills"] if item["source"] == "project"] == [
        "first-skill"
    ]

    _write_skill(tmp_path, "late-skill", "Installed after the session started.", "# Late")
    refreshed = json.loads(await list_skills_tool(query="late"))
    assert refreshed["count"] == 1
    assert refreshed["skills"][0]["name"] == "late-skill"
    assert "# Skill: late-skill" in await use_skill_tool("late-skill")


@pytest.mark.asyncio
async def test_skill_resources_are_indexed_and_loaded_progressively(
    monkeypatch, tmp_path
):
    monkeypatch.chdir(tmp_path)
    _write_skill(
        tmp_path,
        "progressive-skill",
        "A progressive workflow.",
        "# Workflow\n\nRead `references/current-step.md` only when needed.",
    )
    resource = (
        tmp_path
        / ".myharness"
        / "skills"
        / "progressive-skill"
        / "references"
        / "current-step.md"
    )
    resource.parent.mkdir(parents=True, exist_ok=True)
    resource.write_text("line one\nline two\nline three\n", encoding="utf-8")

    loaded = await use_skill_tool("progressive-skill")
    assert "references/current-step.md" in loaded
    assert "line one" not in loaded
    assert "Supporting files listed above were not loaded" in loaded
    assert "resource index is not an execution order" in loaded
    assert f"Base directory: {resource.parent.parent.resolve()}" in loaded
    assert "authoritative copy for this activation" in loaded
    assert "replace any generic pre-load plan" in loaded

    first = await read_skill_file_tool(
        "progressive-skill", "references/current-step.md", limit=2
    )
    assert "line one" in first
    assert "line two" in first
    assert "line three" not in first
    assert "Continue with offset=2" in first

    second = await read_skill_file_tool(
        "progressive-skill", "references/current-step.md", offset=2, limit=2
    )
    assert "line three" in second
    assert "End of resource" in second


@pytest.mark.asyncio
async def test_read_skill_file_rejects_path_escape(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    _write_skill(tmp_path, "safe-skill", "Safe.", "# Safe")
    outside = tmp_path / "outside.md"
    outside.write_text("secret", encoding="utf-8")

    result = await read_skill_file_tool("safe-skill", "../../outside.md")

    assert "escapes the Skill directory" in result


def test_skill_tools_exist_when_session_starts_without_skills(monkeypatch, tmp_path):
    root = Path(__file__).resolve().parents[1]
    cfg = HarnessConfig.from_yaml(str(root / "config.yaml"))
    profile = load_agent_profile("design-research")
    provider = cfg.providers[cfg.default_provider]
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path / "empty-home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "empty-home"))

    engine = build_engine(
        session_id="test-late-skill-discovery",
        provider_cfg=provider,
        harness_cfg=cfg,
        session_store=MemorySessionStore(),
        system_prompt=profile.system_prompt,
        allowed_tools=[],
        provider_name="test-provider",
        agent_id="design-research",
        memory_store=InMemoryMemoryStore(),
        plan_store=InMemoryPlanStore(),
    )

    tool_names = {schema.name for schema in engine.tool_schemas}
    assert {"list_skills", "use_skill", "read_skill_file"}.issubset(tool_names)


def test_skill_addendum_does_not_classify_every_skill_as_workflow():
    addendum = build_skill_system_addendum(
        [{"name": "free-form", "description": "Any useful instructions.", "source": "project"}]
    )
    assert "## Available Skills" in addendum
    assert "Skills (Workflow Presets)" not in addendum
    assert "Skills do not need a category" in addendum
    assert "Do not batch-read resources for future stages" in addendum
    assert "Do not search for or switch to duplicate Skill copies" in addendum
    assert "replace any generic plan" in addendum
    assert "**free-form**" in addendum


@pytest.mark.asyncio
async def test_run_init_accepts_generic_workflow_context(monkeypatch, tmp_path):
    monkeypatch.setenv("DESIGN_HARNESS_ROOT", str(tmp_path / "harness"))
    monkeypatch.setenv("DESIGN_OUTPUTS_ROOT", str(tmp_path / "outputs"))

    result = json.loads(
        await run_init_tool(
            brief="Create a museum exhibition concept.",
            mode="minimal",
            workflowSkill="museum-exhibition-workflow",
            context='{"visitor_goal":"orientation","custom_stage":"narrative"}',
            runIdOverride="museum-run",
        )
    )

    assert result["ok"] is True
    assert result["mode"] == "minimal"
    assert result["workflowSkill"] == "museum-exhibition-workflow"
    run_dir = Path(result["runDir"])
    assert run_dir.is_dir()
    assert list(run_dir.iterdir()) == []


@pytest.mark.asyncio
async def test_bus_accepts_registered_custom_persona_and_messages(
    monkeypatch, tmp_path
):
    monkeypatch.chdir(tmp_path)
    _write_persona(tmp_path, "exhibition-reviewer")
    run_dir = tmp_path / "run"

    posted = json.loads(
        await design_bus_post_tool(
            runId="custom-run",
            runDir=str(run_dir),
            from_agent="design-primary",
            to="exhibition-reviewer",
            type="narrative_ready",
            phase="visitor-journey",
            summary="Narrative handoff is ready.",
        )
    )
    assert posted["ok"] is True
    assert posted["warnings"] == []

    read = json.loads(
        await design_bus_read_tool(
            runId="custom-run",
            runDir=str(run_dir),
            agent="exhibition-reviewer",
        )
    )
    assert read["count"] == 1
    assert read["messages"][0]["type"] == "narrative_ready"
    assert read["messages"][0]["phase"] == "visitor-journey"


def test_fixed_domains_live_in_default_stage_skills_not_base_personas():
    root = Path(__file__).resolve().parents[1]
    persona_dir = root / ".myharness" / "personas"
    skill_dir = root / ".myharness" / "skills"

    for name in (
        "design-research",
        "design-planner",
        "design-designer",
        "design-critic",
    ):
        text = (persona_dir / f"{name}.md").read_text(encoding="utf-8")
        assert "brand_cultural_design" not in text
        assert "product_design" not in text
        assert "domainContext.evaluation_focus" not in text

    default_workflow = (
        skill_dir / "default-design-workflow" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "brand_cultural_design" in default_workflow
    assert "product_design" in default_workflow
    assert "default-research-stage" in default_workflow
    assert "default-planning-stage" in default_workflow
    assert "default-production-stage" in default_workflow
    assert "default-critique-stage" in default_workflow


def test_default_workflow_preserves_stable_delivery_contract():
    root = Path(__file__).resolve().parents[1]
    skill_dir = root / ".myharness" / "skills"
    workflow = (skill_dir / "default-design-workflow" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert (
        "design-primary -> design-research -> design-planner -> "
        "design-designer -> design-critic -> export_package"
    ) in workflow
    assert "resolvedScope" in workflow
    assert "domainContext" in workflow
    assert "deliverable_manifest.json" in workflow
    assert "00-gallery.html" in workflow
    assert "exactly one designer repair pass" in workflow

    expected_stage_contracts = {
        "default-research-stage": ("evidence.json", "research_done"),
        "default-planning-stage": ("design_plan.json", "plan_done"),
        "default-production-stage": ("image_generate", "design_done"),
        "default-critique-stage": ("artifact_lint", "evaluator_pass"),
    }
    for skill_name, required_text in expected_stage_contracts.items():
        text = (skill_dir / skill_name / "SKILL.md").read_text(encoding="utf-8")
        assert all(item in text for item in required_text)


def test_default_workflow_allows_explicit_professional_skill_override():
    root = Path(__file__).resolve().parents[1]
    skill_dir = root / ".myharness" / "skills"
    workflow = (skill_dir / "default-design-workflow" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "professional_skills" in workflow
    assert "do not force the brief into the closest built-in domain" in workflow
    for skill_name in (
        "default-research-stage",
        "default-planning-stage",
        "default-production-stage",
        "default-critique-stage",
    ):
        text = (skill_dir / skill_name / "SKILL.md").read_text(encoding="utf-8")
        normalized = " ".join(text.split())
        assert "professional_skills" in text
        assert "takes precedence over built-in-domain instructions" in normalized


def test_design_primary_keeps_four_agent_spawn_boundary():
    profile = load_agent_profile("design-primary")

    assert profile.spawn_allowlist == [
        "design-research",
        "design-planner",
        "design-designer",
        "design-critic",
    ]
    assert "cannot grant that agent additional tools" in profile.system_prompt
    assert "do not silently substitute a different agent" in profile.system_prompt
    assert {
        "powershell", "list_skills", "image_generate", "image_edit", "inspect_image"
    }.issubset(
        profile.allowed_tools
    )
    assert "single-controller or single-agent" in profile.system_prompt
    assert "do not create another nested run root" in profile.system_prompt


def test_design_stage_agents_can_run_bundled_skill_scripts():
    for name in (
        "design-research",
        "design-planner",
        "design-designer",
        "design-critic",
    ):
        profile = load_agent_profile(name)
        assert "powershell" in profile.allowed_tools
        assert "list_skills" in profile.allowed_tools
        assert "inspect_image" in profile.allowed_tools


def test_design_command_uses_explicit_or_default_workflow():
    root = Path(__file__).resolve().parents[1]
    command = (root / ".myharness" / "commands" / "design.md").read_text(
        encoding="utf-8"
    )
    assert "explicitly asks to use a named Skill as the workflow" in command
    assert "lightweight design operation" in command
    assert "without `run_init`" in command
    assert "full design deliverable" in command
    assert "default-design-workflow" in command
    assert "brand_cultural_design" not in command
