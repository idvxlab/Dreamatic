from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from harness.types.tools import ToolParam, ToolSchema


RUN_INIT_SCHEMA = ToolSchema(
    name="run_init",
    description=(
        "Initialize a Dreamatic workflow run. mode=default creates the complete "
        "Dreamatic workspace, brief.json, output folder, and empty bus.jsonl. "
        "mode=minimal creates only the run directory so a custom workflow Skill "
        "can define its own files and directory layout."
    ),
    params=[
        ToolParam(name="brief", type="string", description="Raw user design brief."),
        ToolParam(
            name="mode",
            type="string",
            description="Initialization mode: default or minimal. Defaults to default.",
            required=False,
            enum=["default", "minimal"],
        ),
        ToolParam(
            name="workflowSkill",
            type="string",
            description="Selected workflow Skill name.",
            required=False,
        ),
        ToolParam(
            name="context",
            type="string",
            description="Optional JSON-stringified workflow-defined context.",
            required=False,
        ),
        ToolParam(
            name="resolvedScope",
            type="string",
            description="Legacy/default-workflow JSON string with clarified scope.",
            required=False,
        ),
        ToolParam(
            name="domainContext",
            type="string",
            description="Legacy/default-workflow JSON string with domain context.",
            required=False,
        ),
        ToolParam(name="runIdOverride", type="string", description="Optional explicit run id.", required=False),
    ],
)


DESIGN_BUS_POST_SCHEMA = ToolSchema(
    name="design_bus_post",
    description="Append a structured message to <runDir>/bus.jsonl for design-agent coordination.",
    params=[
        ToolParam(name="runId", type="string", description="Design run id."),
        ToolParam(name="runDir", type="string", description="Design run directory."),
        ToolParam(name="from_agent", type="string", description="Sender agent name."),
        ToolParam(name="to", type="string", description="Recipient agent name or all."),
        ToolParam(name="type", type="string", description="Message type, e.g. status, research_done, design_done."),
        ToolParam(name="summary", type="string", description="One-line summary."),
        ToolParam(name="phase", type="string", description="Workflow phase.", required=False),
        ToolParam(name="severity", type="string", description="low | medium | high | critical.", required=False),
        ToolParam(name="round", type="integer", description="Iteration round, default 1.", required=False),
        ToolParam(
            name="artifactRefs",
            type="array",
            description="Artifact paths referenced by the message.",
            required=False,
            items={"type": "string"},
        ),
        ToolParam(name="requestedAction", type="string", description="Expected next action.", required=False),
        ToolParam(name="payload", type="string", description="Optional JSON-stringified payload.", required=False),
        ToolParam(name="replyTo", type="string", description="Optional parent message id.", required=False),
    ],
)


DESIGN_BUS_READ_SCHEMA = ToolSchema(
    name="design_bus_read",
    description="Read messages from <runDir>/bus.jsonl, optionally filtered by recipient, type, and round.",
    params=[
        ToolParam(name="runId", type="string", description="Design run id."),
        ToolParam(name="runDir", type="string", description="Design run directory."),
        ToolParam(name="agent", type="string", description="Recipient agent to read as."),
        ToolParam(name="type", type="string", description="Optional message type filter.", required=False),
        ToolParam(name="minRound", type="integer", description="Optional minimum round.", required=False),
        ToolParam(name="sinceMessageId", type="string", description="Return messages after this id.", required=False),
        ToolParam(name="includeAll", type="boolean", description="Include all recipients, not only agent/all.", required=False),
        ToolParam(name="limit", type="integer", description="Maximum messages, default 200.", required=False),
    ],
)


LEGACY_COORDINATION_AGENTS = {
    "design-primary",
    "design-research",
    "design-planner",
    "design-designer",
    "design-critic",
    "design-evaluator",
}
async def run_init_tool(
    brief: str,
    workflowSkill: str | None = None,
    context: str | None = None,
    resolvedScope: str | None = None,
    domainContext: str | None = None,
    runIdOverride: str | None = None,
    mode: str | None = None,
) -> str:
    if not brief or not brief.strip():
        return _json({"ok": False, "error": "brief is required"})

    init_mode = (mode or "default").strip().lower()
    if init_mode not in {"default", "minimal"}:
        return _json(
            {
                "ok": False,
                "error": f"invalid initialization mode: {mode}",
                "allowed": ["default", "minimal"],
            }
        )

    harness_root = Path(os.getenv("DESIGN_HARNESS_ROOT", ".design-harness"))
    outputs_root = Path(os.getenv("DESIGN_OUTPUTS_ROOT", "outputs"))
    run_id = _sanitize_run_id(runIdOverride) if runIdOverride else _timestamp_id()
    run_id = _unique_run_id(run_id, harness_root, outputs_root)
    run_dir = harness_root / "runs" / run_id
    output_dir = outputs_root / "runs" / run_id

    if init_mode == "minimal":
        run_dir.mkdir(parents=True, exist_ok=True)
        return _json(
            {
                "ok": True,
                "mode": init_mode,
                "runId": run_id,
                "runDir": str(run_dir),
                "workflowSkill": (workflowSkill or "").strip(),
                "paths": {"runDir": str(run_dir)},
            }
        )

    subdirs = [
        "",
        "research",
        "research/assets",
        "plan",
        "artifacts",
        "artifacts/generated-images",
        "artifacts/edits",
        "artifacts/models",
        "artifacts/model-renders",
        "review",
    ]
    for subdir in subdirs:
        (run_dir / subdir).mkdir(parents=True, exist_ok=True)
    final_dir = output_dir / "final"
    final_dir.mkdir(parents=True, exist_ok=True)

    workflow_context: Any = None
    if context and context.strip():
        try:
            workflow_context = json.loads(context)
        except json.JSONDecodeError as exc:
            return _json({"ok": False, "error": f"context is not valid JSON: {exc}"})

    scope: Any = None
    if resolvedScope and resolvedScope.strip():
        try:
            scope = json.loads(resolvedScope)
        except json.JSONDecodeError as exc:
            return _json({"ok": False, "error": f"resolvedScope is not valid JSON: {exc}"})

    domain_context: Any = None
    if domainContext and domainContext.strip():
        try:
            domain_context = json.loads(domainContext)
        except json.JSONDecodeError as exc:
            return _json({"ok": False, "error": f"domainContext is not valid JSON: {exc}"})

    paths = {
        "runDir": str(run_dir),
        "outputDir": str(output_dir),
        "researchDir": str(run_dir / "research"),
        "researchAssetsDir": str(run_dir / "research" / "assets"),
        "planDir": str(run_dir / "plan"),
        "artifactsDir": str(run_dir / "artifacts"),
        "generatedImagesDir": str(run_dir / "artifacts" / "generated-images"),
        "editsDir": str(run_dir / "artifacts" / "edits"),
        "modelsDir": str(run_dir / "artifacts" / "models"),
        "modelRendersDir": str(run_dir / "artifacts" / "model-renders"),
        "reviewDir": str(run_dir / "review"),
        "finalDir": str(final_dir),
        "bus": str(run_dir / "bus.jsonl"),
    }
    payload = {
        "runId": run_id,
        "mode": init_mode,
        "createdAt": _now_iso(),
        "brief": brief,
        "workflowSkill": (workflowSkill or "").strip(),
        "context": workflow_context,
        "resolvedScope": scope,
        "domainContext": domain_context,
        "paths": paths,
    }
    (run_dir / "brief.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "bus.jsonl").touch()

    return _json(
        {
            "ok": True,
            "mode": init_mode,
            "runId": run_id,
            "runDir": str(run_dir),
            "outputDir": str(output_dir),
            "workflowSkill": (workflowSkill or "").strip(),
            "paths": paths,
        }
    )


async def design_bus_post_tool(
    runId: str,
    runDir: str,
    from_agent: str,
    to: str,
    type: str,
    summary: str,
    phase: str | None = None,
    severity: str | None = None,
    round: int | None = None,
    artifactRefs: list[str] | None = None,
    requestedAction: str | None = None,
    payload: str | None = None,
    replyTo: str | None = None,
) -> str:
    warnings: list[str] = []
    coordination_agents = _coordination_agents()
    if from_agent not in coordination_agents:
        return _json(
            {
                "ok": False,
                "error": f"invalid from_agent: {from_agent}",
                "allowed": sorted(coordination_agents),
            }
        )
    recipients = coordination_agents | {"all"}
    if to not in recipients:
        return _json(
            {
                "ok": False,
                "error": f"invalid to: {to}",
                "allowed": sorted(recipients),
            }
        )
    sev = severity or "low"
    if sev not in {"low", "medium", "high", "critical"}:
        return _json({"ok": False, "error": f"invalid severity: {sev}"})

    parsed_payload: Any = None
    if payload and payload.strip():
        try:
            parsed_payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            return _json({"ok": False, "error": f"payload is not valid JSON: {exc}"})

    path = _bus_path(runDir)
    record = {
        "messageId": str(uuid.uuid4()),
        "runId": runId,
        "ts": _now_iso(),
        "from": from_agent,
        "to": to,
        "type": type,
        "phase": phase,
        "severity": sev,
        "round": round or 1,
        "summary": summary,
        "artifactRefs": artifactRefs or [],
        "requestedAction": requestedAction or "",
        "replyTo": replyTo,
        "payload": parsed_payload,
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return _json({"ok": True, "messageId": record["messageId"], "file": str(path), "warnings": warnings})


async def design_bus_read_tool(
    runId: str,
    runDir: str,
    agent: str,
    type: str | None = None,
    minRound: int | None = None,
    sinceMessageId: str | None = None,
    includeAll: bool | None = None,
    limit: int | None = None,
) -> str:
    recipients = _coordination_agents() | {"all"}
    if agent not in recipients:
        return _json(
            {
                "ok": False,
                "error": f"invalid agent: {agent}",
                "allowed": sorted(recipients),
            }
        )
    path = _bus_path(runDir)
    if not path.exists():
        return _json({"ok": True, "runId": runId, "count": 0, "messages": []})

    rows: list[dict[str, Any]] = []
    cutoff_passed = sinceMessageId is None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not cutoff_passed:
            if row.get("messageId") == sinceMessageId:
                cutoff_passed = True
            continue
        if not includeAll and row.get("to") not in {agent, "all"}:
            continue
        if type and row.get("type") != type:
            continue
        if minRound is not None and int(row.get("round") or 0) < minRound:
            continue
        rows.append(row)

    cap = max(1, min(int(limit or 200), 1000))
    rows = rows[-cap:]
    return _json({"ok": True, "runId": runId, "count": len(rows), "messages": rows})


def _timestamp_id() -> str:
    return _sanitize_run_id(time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime()))


def _sanitize_run_id(value: str | None) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", (value or "").strip()).strip("-._")
    return value or _timestamp_id()


def _unique_run_id(base_id: str, harness_root: Path, outputs_root: Path) -> str:
    base = _sanitize_run_id(base_id)
    candidate = base
    suffix = 2
    while (
        (harness_root / "runs" / candidate).exists()
        or (outputs_root / "runs" / candidate).exists()
    ):
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _bus_path(run_dir: str) -> Path:
    path = Path(run_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path / "bus.jsonl"


def _coordination_agents() -> set[str]:
    """Return registered agent ids while preserving legacy bus compatibility."""
    agents = set(LEGACY_COORDINATION_AGENTS)
    try:
        from harness.agents import list_agent_profiles  # noqa: PLC0415

        for profile in list_agent_profiles(include_hidden=True):
            agent_id = str(profile.get("agent_id") or profile.get("name") or "").strip()
            if agent_id:
                agents.add(agent_id)
    except Exception:
        pass
    return agents


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)
