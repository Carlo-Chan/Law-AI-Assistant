"""生成模型创建边界；当前只保留已验证的 DeepSeek 非思考模式。"""

from dataclasses import dataclass, field

from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from app.core.config import Settings


@dataclass(frozen=True, slots=True)
class DeepSeekModelConfig:
    """启动时固定生成参数；密钥和服务地址不进入默认对象表示。"""

    model: str
    api_key: SecretStr = field(repr=False)
    base_url: str = field(repr=False)
    temperature: float
    timeout_seconds: float
    max_tokens: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "DeepSeekModelConfig":
        """从已经校验的设置复制参数，不保留可变 Settings 引用。"""
        return cls(
            model=settings.deepseek_model,
            api_key=SecretStr(settings.deepseek_api_key),
            base_url=settings.deepseek_base_url,
            temperature=settings.deepseek_temperature,
            timeout_seconds=settings.deepseek_timeout_seconds,
            max_tokens=settings.deepseek_max_tokens,
        )


def create_deepseek_model(config: DeepSeekModelConfig) -> ChatOpenAI:
    """保留既有调用参数，不将 DeepSeek 专用字段当作通用厂商能力。"""
    api_key = config.api_key.get_secret_value()
    if not api_key.strip():
        raise ValueError("未配置 DeepSeek API Key，请设置 DEEPSEEK_API_KEY。")
    return ChatOpenAI(
        model=config.model,
        api_key=api_key,
        base_url=config.base_url,
        temperature=config.temperature,
        timeout=config.timeout_seconds,
        max_tokens=config.max_tokens,
        extra_body={"thinking": {"type": "disabled"}},
    )
