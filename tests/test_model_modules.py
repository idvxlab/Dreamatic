import pytest

import api.rest as rest_mod
from harness.config import HarnessConfig


def test_model_modules_from_env_are_independent() -> None:
    modules = rest_mod._modules_from_env(
        {
            "DREAMATIC_PROVIDER_TYPE": "openai-compatible",
            "DREAMATIC_API_KEY": "agent-key",
            "DREAMATIC_BASE_URL": "https://agent.example/v1",
            "DREAMATIC_MODEL": "agent-model",
            "DREAMATIC_SUMMARY_PROVIDER_TYPE": "anthropic",
            "DREAMATIC_SUMMARY_API_KEY": "summary-key",
            "DREAMATIC_SUMMARY_BASE_URL": "https://summary.example/v1",
            "DREAMATIC_SUMMARY_MODEL": "summary-model",
            "DREAMATIC_IMAGE_API_KEY": "image-key",
            "DREAMATIC_IMAGE_BASE_URL": "https://image.example/v1",
            "DREAMATIC_IMAGE_MODEL": "image-model",
            "DREAMATIC_SEARCH_PROVIDER": "brave",
            "DREAMATIC_SEARCH_API_KEY": "search-key",
            "DREAMATIC_VIDEO_MODEL": "video-model",
            "DREAMATIC_HUNYUAN3D_MODEL": "3d-model",
        }
    )

    assert set(modules) == set(rest_mod.MODEL_MODULE_IDS)
    assert modules["agent"]["provider_type"] == "openai-compatible"
    assert modules["compression"]["provider_type"] == "anthropic"
    assert modules["agent"]["api_key"] == "agent-key"
    assert modules["compression"]["api_key"] == "summary-key"
    assert modules["image"]["generation_endpoint"] == "https://image.example/v1/images/generations"
    assert modules["image"]["edit_endpoint"] == "https://image.example/v1/images/edits"
    assert modules["search"] == {"provider": "brave", "api_key": "search-key"}
    assert modules["video"]["model"] == "video-model"
    assert modules["model3d"]["model"] == "3d-model"


def test_model_modules_round_trip_to_runtime_env() -> None:
    modules = rest_mod._normalize_modules(
        {
            "agent": {"provider_type": "openai", "model": "agent-model"},
            "compression": {"provider_type": "anthropic", "model": "summary-model"},
            "search": {"provider": "serper", "api_key": "search-key"},
        }
    )

    values = rest_mod._modules_to_env_values(modules)

    assert values["DREAMATIC_PROVIDER_TYPE"] == "openai"
    assert values["DREAMATIC_SUMMARY_PROVIDER_TYPE"] == "anthropic"
    assert values["SERPER_API_KEY"] == "search-key"
    assert values["BRAVE_SEARCH_API_KEY"] == ""


def test_public_module_masks_api_key() -> None:
    public = rest_mod._public_module({"model": "test-model", "api_key": "secret-1234"})

    assert "api_key" not in public
    assert public["has_api_key"] is True
    assert public["api_key_hint"] == "••••1234"


def test_apply_model_modules_registers_agent_and_compression(monkeypatch) -> None:
    modules = rest_mod._normalize_modules(
        {
            "agent": {
                "provider_type": "openai-compatible",
                "api_key": "agent-key",
                "base_url": "https://agent.example/v1",
                "model": "agent-model",
            },
            "compression": {
                "provider_type": "anthropic",
                "api_key": "summary-key",
                "base_url": "https://summary.example/v1",
                "model": "summary-model",
            },
        }
    )
    monkeypatch.setattr(
        rest_mod,
        "_load_dreamatic_settings",
        lambda: {"version": 2, "modules": modules},
    )
    monkeypatch.setattr(rest_mod, "_apply_runtime_env", lambda values: None)
    monkeypatch.setattr(rest_mod, "_read_managed_env_values", lambda: {})
    cfg = HarnessConfig()

    rest_mod._apply_model_modules_to_config(cfg)

    assert cfg.default_provider == rest_mod.AGENT_PROVIDER_ID
    assert cfg.providers[rest_mod.AGENT_PROVIDER_ID].model == "agent-model"
    assert cfg.providers[rest_mod.COMPRESSION_PROVIDER_ID].name == "anthropic"
    assert cfg.compression.summary_provider == rest_mod.COMPRESSION_PROVIDER_ID


@pytest.mark.asyncio
async def test_save_model_module_persists_singleton_settings(tmp_path, monkeypatch) -> None:
    settings_file = tmp_path / "settings.json"

    async def _noop_refresh() -> None:
        return None

    monkeypatch.setattr(rest_mod, "DREAMATIC_SETTINGS_FILE", settings_file)
    monkeypatch.setattr(rest_mod, "_reload_runtime_config", lambda: None)
    monkeypatch.setattr(rest_mod, "_refresh_idle_session_engines", _noop_refresh)

    result = await rest_mod.api_save_model_module(
        "agent",
        rest_mod.ModelModuleRequest(
            module={
                "provider_type": "openai-compatible",
                "api_key": "saved-key",
                "base_url": "https://agent.example/v1",
                "model": "saved-model",
            }
        ),
    )

    saved = rest_mod.json.loads(settings_file.read_text(encoding="utf-8"))
    assert saved["version"] == 2
    assert saved["modules"]["agent"]["model"] == "saved-model"
    assert "profiles" not in saved
    assert result["module"]["has_api_key"] is True
    assert "api_key" not in result["module"]
