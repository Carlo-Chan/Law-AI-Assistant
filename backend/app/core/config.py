"""
应用配置：从 .env 读取所有环境变量
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # --- API Keys ---
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    tavily_api_key: str = ""
    yuandian_api_key: str = ""

    # --- DeepSeek 生成参数；启动时读取，修改后需重启后端 ---
    deepseek_model: str = Field(default="deepseek-v4-flash", min_length=1)
    deepseek_temperature: float = Field(default=0.3, ge=0, le=2, allow_inf_nan=False)
    deepseek_timeout_seconds: float = Field(default=120, gt=0, allow_inf_nan=False)
    deepseek_max_tokens: int = Field(default=16384, gt=0)

    # --- 应用配置 ---
    app_env: str = "development"
    app_log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    app_port: int = 8000
    app_cors_origins: str = "http://localhost:5173"
    database_url: str = "sqlite:///./data/app.db"

    # --- DOC 本地转换；空路径时查找 PATH 和标准安装目录 ---
    libreoffice_path: str = ""
    doc_conversion_timeout_seconds: int = Field(default=45, ge=1, le=120)
    doc_conversion_temp_dir: str = ""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @field_validator("deepseek_model")
    @classmethod
    def validate_deepseek_model(cls, value: str) -> str:
        """去掉模型名两端空白，拒绝只有空格的配置。"""
        value = value.strip()
        if not value:
            raise ValueError("生成模型名称不能为空。")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
