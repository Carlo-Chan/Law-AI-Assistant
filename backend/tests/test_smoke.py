"""冒烟测试：验证核心模块在隔离环境下可正常导入。"""
import os
from pathlib import Path


def test_import_main():
    """FastAPI 应用可正常创建"""
    from app.main import app

    assert app.title == "Law-AI-Assistant"


def test_import_agent_modules():
    """agent 模块导入不触发 ChromaDB 预初始化（由 conftest 环境变量控制）"""
    from app.agent import chain, retriever, tools

    assert chain.settings.deepseek_api_key == "test-deepseek-key"
    assert tools.settings.tavily_api_key == "test-tavily-key"
    assert retriever._client is None
    assert retriever._collection is None


def test_import_services():
    """服务层导入时只初始化临时数据库。"""
    from app.services import history
    from app.services.parser import DocumentParser

    assert history.DB_PATH == Path(os.environ["LAW_AI_HISTORY_DB_PATH"])
    assert history.DB_PATH.is_file()
    assert history.DB_PATH.parent != Path(history.__file__).resolve().parents[2] / "data"
    assert callable(DocumentParser.parse)
