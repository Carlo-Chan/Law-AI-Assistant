"""
应用配置：从 .env 读取所有环境变量
"""
import os
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    # --- API Keys ---
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    tavily_api_key: str = ""
    yuandian_api_key: str = ""

    # --- 应用配置 ---
    app_env: str = "development"
    app_port: int = 8000
    app_cors_origins: str = "http://localhost:5173"
    database_url: str = "sqlite:///./data/app.db"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache()
def get_settings() -> Settings:
    return Settings()
