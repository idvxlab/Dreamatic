from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from harness.skills import list_personas, load_persona


@dataclass
class AgentProfile:
    agent_id: str
    name: str
    display_name: str = ""
    description: str = ""
    mode: str = "all"
    hidden: bool = False
    provider: str = ""
    system_prompt: str = ""
    allowed_tools: list[str] | None = None
    default_approval_mode: str = ""
    color: str = ""
    can_spawn: bool = True
    spawn_allowlist: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "name": self.name,
            "display_name": self.display_name or self.name,
            "description": self.description,
            "mode": self.mode,
            "hidden": self.hidden,
            "provider": self.provider,
            "allowed_tools": self.allowed_tools,
            "default_approval_mode": self.default_approval_mode,
            "color": self.color,
            "can_spawn": self.can_spawn,
            "spawn_allowlist": self.spawn_allowlist,
        }


def _profile_from_meta(agent_id: str, meta: dict[str, Any]) -> AgentProfile:
    allowed = meta.get("allowed_tools")
    if allowed is not None:
        allowed = list(allowed)
    spawn_allowlist = meta.get("spawn_allowlist")
    if spawn_allowlist is not None:
        spawn_allowlist = [str(item) for item in spawn_allowlist]
    return AgentProfile(
        agent_id=agent_id,
        name=str(meta.get("name") or agent_id),
        display_name=str(meta.get("display_name") or meta.get("name") or agent_id),
        description=str(meta.get("description", "")),
        mode=str(meta.get("mode", "all")),
        hidden=bool(meta.get("hidden", False)),
        provider=str(meta.get("provider", "")),
        system_prompt=str(meta.get("system_prompt", "")),
        allowed_tools=allowed,
        default_approval_mode=str(meta.get("default_approval_mode", "")),
        color=str(meta.get("color", "")),
        can_spawn=bool(meta.get("can_spawn", True)),
        spawn_allowlist=spawn_allowlist,
    )


def load_agent_profile(agent_id: str) -> AgentProfile:
    """Load one agent profile from .myharness/personas/{agent_id}.md."""
    return _profile_from_meta(agent_id, load_persona(agent_id))


def list_agent_profiles(include_hidden: bool = True) -> list[dict[str, Any]]:
    """Return agent registry summaries derived from persona frontmatter."""
    profiles: list[dict[str, Any]] = []
    for meta in list_personas():
        if not include_hidden and meta.get("hidden"):
            continue
        agent_id = str(meta.get("name") or "")
        profiles.append(_profile_from_meta(agent_id, meta).to_dict())
    return profiles
