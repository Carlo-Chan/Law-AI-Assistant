"""生成模型配置及创建边界回归；不连接模型、读取真实 Key 或修改环境文件。"""

from dataclasses import FrozenInstanceError
from unittest.mock import Mock

import pytest
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from pydantic import ValidationError

from app.agent import chain, model_factory
from app.agent.model_factory import DeepSeekModelConfig, create_deepseek_model
from app.core.config import Settings


def configured(**overrides):
    """使用固定占位配置，覆盖值只在当前测试内生效。"""
    values = {
        "deepseek_api_key": "synthetic-model-key",
        "deepseek_base_url": "http://127.0.0.1:9/v1",
    }
    return Settings(_env_file=None, **(values | overrides))


def test_model_defaults_preserve_existing_deepseek_parameters():
    config = DeepSeekModelConfig.from_settings(configured())
    assert config.model == "deepseek-v4-flash"
    assert config.temperature == 0.3
    assert config.timeout_seconds == 120
    assert config.max_tokens == 16384
    assert config.api_key.get_secret_value() == "synthetic-model-key"
    assert config.base_url == "http://127.0.0.1:9/v1"


@pytest.mark.parametrize(
    ("name", "value", "field", "expected"),
    [
        ("DEEPSEEK_MODEL", "custom-model", "model", "custom-model"),
        ("DEEPSEEK_TEMPERATURE", "0.7", "temperature", 0.7),
        ("DEEPSEEK_TIMEOUT_SECONDS", "45.5", "timeout_seconds", 45.5),
        ("DEEPSEEK_MAX_TOKENS", "4096", "max_tokens", 4096),
    ],
)
def test_generation_parameters_are_read_from_validated_environment(
    monkeypatch, name, value, field, expected
):
    monkeypatch.setenv(name, value)
    config = DeepSeekModelConfig.from_settings(configured())
    assert getattr(config, field) == expected


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("deepseek_model", ""),
        ("deepseek_model", "  "),
        ("deepseek_model", "\n\t"),
        ("deepseek_temperature", -0.1),
        ("deepseek_temperature", 2.1),
        ("deepseek_temperature", "nan"),
        ("deepseek_temperature", "inf"),
        ("deepseek_timeout_seconds", 0),
        ("deepseek_timeout_seconds", -1),
        ("deepseek_timeout_seconds", "nan"),
        ("deepseek_timeout_seconds", "inf"),
        ("deepseek_max_tokens", 0),
        ("deepseek_max_tokens", -1),
        ("deepseek_max_tokens", 1.5),
        ("deepseek_max_tokens", "unknown"),
    ],
)
def test_invalid_generation_parameters_fail_before_model_creation(field, value):
    """配置错误在本地明确拒绝，不等到真实调用才失败。"""
    with pytest.raises(ValidationError) as error:
        configured(**{field: value})
    assert "synthetic-model-key" not in str(error.value)


@pytest.mark.parametrize("temperature", [0, 2])
def test_temperature_boundaries_and_positive_limits_remain_available(temperature):
    config = DeepSeekModelConfig.from_settings(
        configured(
            deepseek_temperature=temperature,
            deepseek_timeout_seconds=0.1,
            deepseek_max_tokens=1,
        )
    )
    assert config.temperature == temperature
    assert config.timeout_seconds == 0.1
    assert config.max_tokens == 1


def test_model_name_only_trims_surrounding_whitespace():
    config = DeepSeekModelConfig.from_settings(configured(deepseek_model="  vendor/model-name  "))
    assert config.model == "vendor/model-name"


@pytest.mark.parametrize(
    "field", ["model", "api_key", "base_url", "temperature", "timeout_seconds", "max_tokens"]
)
def test_config_snapshot_fields_cannot_be_reassigned(field):
    config = DeepSeekModelConfig.from_settings(configured())
    with pytest.raises(FrozenInstanceError):
        setattr(config, field, "changed")


def test_snapshot_does_not_retain_mutable_settings_reference():
    settings = configured()
    config = DeepSeekModelConfig.from_settings(settings)
    settings.deepseek_api_key = "replacement-key"
    settings.deepseek_base_url = "https://replacement.example.invalid"
    settings.deepseek_model = "replacement-model"
    settings.deepseek_temperature = 1.2
    settings.deepseek_timeout_seconds = 30
    settings.deepseek_max_tokens = 2048
    assert config == DeepSeekModelConfig.from_settings(configured())


def test_snapshot_representation_hides_key_and_endpoint():
    config = DeepSeekModelConfig.from_settings(configured())
    assert config.api_key.get_secret_value() not in repr(config)
    assert config.api_key.get_secret_value() not in str(config.api_key)
    assert config.base_url not in repr(config)
    assert "deepseek-v4-flash" in repr(config)


def test_factory_passes_only_the_existing_deepseek_parameters(monkeypatch):
    factory = Mock()
    monkeypatch.setattr(model_factory, "ChatOpenAI", factory)
    config = DeepSeekModelConfig.from_settings(
        configured(
            deepseek_model="configured-model",
            deepseek_temperature=0.6,
            deepseek_timeout_seconds=60,
            deepseek_max_tokens=2048,
        )
    )
    assert create_deepseek_model(config) is factory.return_value
    factory.assert_called_once_with(
        model="configured-model",
        api_key="synthetic-model-key",
        base_url="http://127.0.0.1:9/v1",
        temperature=0.6,
        timeout=60,
        max_tokens=2048,
        extra_body={"thinking": {"type": "disabled"}},
    )


@pytest.mark.parametrize("key", ["", "  ", "\n\t"])
def test_missing_deepseek_key_cannot_fall_back_to_another_provider(monkeypatch, key):
    """未配置该服务的 Key 时，不借用 OPENAI_API_KEY 或触发 SDK 自动回退。"""
    monkeypatch.setenv("OPENAI_API_KEY", "unrelated-openai-key")
    factory = Mock()
    monkeypatch.setattr(model_factory, "ChatOpenAI", factory)
    config = DeepSeekModelConfig.from_settings(configured(deepseek_api_key=key))
    with pytest.raises(ValueError, match="DEEPSEEK_API_KEY") as error:
        create_deepseek_model(config)
    assert "unrelated-openai-key" not in str(error.value)
    factory.assert_not_called()


def test_provider_specific_body_is_fresh_for_each_client(monkeypatch):
    factory = Mock()
    monkeypatch.setattr(model_factory, "ChatOpenAI", factory)
    config = DeepSeekModelConfig.from_settings(configured())
    create_deepseek_model(config)
    first = factory.call_args.kwargs["extra_body"]
    first["thinking"]["type"] = "enabled"
    create_deepseek_model(config)
    second = factory.call_args.kwargs["extra_body"]
    assert second == {"thinking": {"type": "disabled"}}
    assert first is not second


def test_separate_configurations_do_not_share_clients_or_credentials(monkeypatch):
    factory = Mock(side_effect=[object(), object()])
    monkeypatch.setattr(model_factory, "ChatOpenAI", factory)
    first = DeepSeekModelConfig.from_settings(configured(deepseek_api_key="synthetic-first-key"))
    second = DeepSeekModelConfig.from_settings(
        configured(deepseek_api_key="synthetic-second-key", deepseek_model="second-model")
    )
    assert create_deepseek_model(first) is not create_deepseek_model(second)
    assert factory.call_args_list[0].kwargs["api_key"] == "synthetic-first-key"
    assert factory.call_args_list[1].kwargs["api_key"] == "synthetic-second-key"
    assert factory.call_args_list[1].kwargs["model"] == "second-model"


def test_sdk_payload_matches_the_original_constructor_without_network():
    """用已安装 SDK 对照旧参数，包含厂商字段、工具绑定及流式请求。"""
    original = ChatOpenAI(
        model="deepseek-v4-flash",
        api_key="synthetic-model-key",
        base_url="http://127.0.0.1:9/v1",
        temperature=0.3,
        timeout=120,
        max_tokens=16384,
        extra_body={"thinking": {"type": "disabled"}},
    )
    current = create_deepseek_model(DeepSeekModelConfig.from_settings(configured()))
    messages = [HumanMessage(content="合成问题，不发送请求")]
    for streaming in [False, True]:
        assert current._get_request_payload(messages, stream=streaming) == (
            original._get_request_payload(messages, stream=streaming)
        )
    assert current.request_timeout == original.request_timeout
    assert current.max_retries == original.max_retries
    assert (
        current.bind_tools(chain.AGENT_TOOLS).kwargs
        == original.bind_tools(chain.AGENT_TOOLS).kwargs
    )


def test_chain_uses_the_startup_snapshot_and_ignores_later_environment_changes(monkeypatch):
    original = chain.generation_config
    monkeypatch.setenv("DEEPSEEK_MODEL", "changed-after-startup")
    assert chain.llm.model_name == original.model == "deepseek-v4-flash"
    assert chain.llm.extra_body == {"thinking": {"type": "disabled"}}
    assert chain.llm.openai_api_key.get_secret_value() == original.api_key.get_secret_value()
    assert chain.generation_config is original
    assert DeepSeekModelConfig.from_settings(configured()).model == "changed-after-startup"
