"""pytest 公共配置：隔离测试数据库、API 配置与外部网络。"""

import socket
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

_SOCKET_CONNECT = socket.socket.connect

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def pytest_configure(config):
    """在收集测试前配置隔离环境，结束后恢复环境并清理临时数据库。"""
    environment = pytest.MonkeyPatch()
    database_directory = TemporaryDirectory(prefix="law-ai-tests-")
    config.add_cleanup(database_directory.cleanup)
    config.add_cleanup(environment.undo)

    environment.setenv("LAW_AI_SKIP_RETRIEVER_INIT", "1")
    environment.setenv(
        "LAW_AI_HISTORY_DB_PATH",
        str(Path(database_directory.name) / "history.db"),
    )
    environment.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")
    environment.setenv("DEEPSEEK_BASE_URL", "http://127.0.0.1:9/v1")
    environment.setenv("TAVILY_API_KEY", "test-tavily-key")
    environment.setenv("YUANDIAN_API_KEY", "test-yuandian-key")
    environment.setenv("LANGSMITH_TRACING", "false")
    environment.setenv("LANGCHAIN_TRACING_V2", "false")

    from app.core.config import Settings

    environment.setitem(Settings.model_config, "env_file", None)
    environment.setattr(socket.socket, "connect", _block_network)
    environment.setattr(socket.socket, "connect_ex", _block_network)
    if sys.platform == "win32":
        environment.setattr(socket, "socketpair", _windows_socketpair)


def _block_network(*args, **kwargs):
    """禁止测试连接本地或远程服务，外部调用应使用 mock。"""
    raise AssertionError("测试禁止真实网络连接，请 mock 外部服务")


def _windows_socketpair(family=socket.AF_INET, type=socket.SOCK_STREAM, proto=0):
    """为 Windows 事件循环创建内部套接字对，仅连接函数自身创建的临时监听器。"""
    with socket.socket(family, type, proto) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        client = socket.socket(family, type, proto)
        try:
            _SOCKET_CONNECT(client, listener.getsockname())
            server, _ = listener.accept()
        except BaseException:
            client.close()
            raise
    return server, client


@pytest.fixture
def history_store(tmp_path, monkeypatch):
    """每个存储或接口用例使用独立数据库，结束后恢复模块原有路径。"""
    from app.services import history

    monkeypatch.setattr(history, "DB_PATH", tmp_path / "history.db")
    history._init_db()
    return history
