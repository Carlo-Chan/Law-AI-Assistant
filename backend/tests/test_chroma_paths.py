"""Chroma 路径回归：固定数据库位置，规避 Windows 中文路径导致的索引加载失败。"""

from unittest.mock import MagicMock, Mock

import pytest

from app import init_db
from app.agent import retriever
from app.core import chroma_paths


@pytest.mark.parametrize("windows", [False, True])
def test_ascii_absolute_database_path_is_independent_of_working_directory(
    tmp_path, monkeypatch, windows
):
    """没有非 ASCII 字符时直接使用固定绝对路径，不要求改变启动目录。"""
    monkeypatch.setattr(chroma_paths, "_IS_WINDOWS", windows)
    database = Mock()
    database.resolve.return_value = "C:/law-ai/backend/chroma_db"
    monkeypatch.chdir(tmp_path)
    assert chroma_paths.chroma_persist_path(database) == str(database.resolve())
    database.mkdir.assert_not_called()


@pytest.mark.parametrize("working_directory", ["project", "backend", "frontend", "parent"])
def test_windows_chinese_parent_uses_the_same_database_from_supported_start_locations(
    tmp_path, monkeypatch, working_directory
):
    """从常用启动目录计算相对路径，不能仅写死 chroma_db 或把库建到别处。"""
    monkeypatch.setattr(chroma_paths, "_IS_WINDOWS", True)
    parent = tmp_path / "中文工作区"
    project = parent / "law-ai"
    backend = project / "backend"
    frontend = project / "frontend"
    backend.mkdir(parents=True)
    frontend.mkdir()
    database = backend / "chroma_db"
    locations = {"project": project, "backend": backend, "frontend": frontend, "parent": parent}
    monkeypatch.chdir(locations[working_directory])
    before = chroma_paths.Path.cwd()

    provided = chroma_paths.chroma_persist_path(database)

    assert provided.isascii()
    assert not chroma_paths.Path(provided).is_absolute()
    assert chroma_paths.Path(provided).resolve() == database.resolve()
    assert chroma_paths.Path.cwd() == before
    assert not database.exists()


def test_non_windows_keeps_unicode_absolute_paths(tmp_path, monkeypatch):
    """不把 Windows 的绕行规则强加给其他平台。"""
    monkeypatch.setattr(chroma_paths, "_IS_WINDOWS", False)
    database = tmp_path / "中文目录" / "chroma_db"
    assert chroma_paths.chroma_persist_path(database) == str(database.resolve())
    assert not database.exists()


@pytest.mark.parametrize("reason", ["cross_drive", "unicode_relative"])
def test_unsafe_windows_paths_fail_without_creating_or_changing_directories(
    tmp_path, monkeypatch, reason
):
    """跨盘或相对路径仍含中文时给出启动指引，不创建别名或静默换一个库。"""
    monkeypatch.setattr(chroma_paths, "_IS_WINDOWS", True)
    database = tmp_path / "中文目录" / "chroma_db"
    monkeypatch.chdir(tmp_path)
    if reason == "cross_drive":
        monkeypatch.setattr(
            chroma_paths, "relpath", Mock(side_effect=ValueError("different drives"))
        )
    with pytest.raises(RuntimeError, match="backend.*启动"):
        chroma_paths.chroma_persist_path(database)
    assert chroma_paths.Path.cwd() == tmp_path
    assert not database.exists()


def test_path_is_computed_when_called_not_cached_at_import(tmp_path, monkeypatch):
    """启动准备阶段切换目录后，也必须定位到同一数据库。"""
    monkeypatch.setattr(chroma_paths, "_IS_WINDOWS", True)
    parent = tmp_path / "中文工作区"
    backend = parent / "project" / "backend"
    backend.mkdir(parents=True)
    database = backend / "chroma_db"
    monkeypatch.chdir(parent)
    first = chroma_paths.chroma_persist_path(database)
    monkeypatch.chdir(backend)
    second = chroma_paths.chroma_persist_path(database)
    assert first != second
    assert (parent / first).resolve() == (backend / second).resolve() == database.resolve()


def test_retriever_passes_safe_path_to_chroma(tmp_path, monkeypatch):
    """真实初始化入口采用共用路径处理，而不是继续传入含中文绝对路径。"""
    monkeypatch.setattr(chroma_paths, "_IS_WINDOWS", True)
    backend = tmp_path / "中文项目" / "backend"
    backend.mkdir(parents=True)
    monkeypatch.chdir(backend)
    monkeypatch.setattr(retriever, "_db", backend / "chroma_db")
    monkeypatch.setattr(retriever, "_client", None)
    monkeypatch.setattr(retriever, "_collection", None)
    monkeypatch.setattr(retriever, "_ef", None)
    monkeypatch.setattr(retriever, "_bm25", None)
    monkeypatch.setattr(retriever, "_bm25_docs", None)
    factory = Mock()
    monkeypatch.setattr(retriever.chromadb, "PersistentClient", factory)
    monkeypatch.setattr(retriever, "_build_bm25", Mock())
    retriever._init()
    factory.assert_called_once_with(path="chroma_db")
    assert retriever._collection is factory.return_value.get_or_create_collection.return_value


def test_invalid_retriever_path_does_not_open_another_database(tmp_path, monkeypatch):
    """无法生成安全路径时，在创建客户端之前失败。"""
    monkeypatch.setattr(chroma_paths, "_IS_WINDOWS", True)
    monkeypatch.setattr(retriever, "_db", tmp_path / "中文项目" / "chroma_db")
    monkeypatch.setattr(retriever, "_client", None)
    monkeypatch.setattr(retriever, "_ef", None)
    monkeypatch.chdir(tmp_path)
    factory = Mock()
    monkeypatch.setattr(retriever.chromadb, "PersistentClient", factory)
    with pytest.raises(RuntimeError, match="backend.*启动"):
        retriever._init()
    factory.assert_not_called()
    assert retriever._client is None


def test_builder_reuses_existing_database_with_the_same_safe_path(tmp_path, monkeypatch):
    """建库脚本读取已有库时也应绕过中文路径问题，而不是只有在线检索修复。"""
    monkeypatch.setattr(chroma_paths, "_IS_WINDOWS", True)
    backend = tmp_path / "中文项目" / "backend"
    database = backend / "chroma_db"
    database.mkdir(parents=True)
    data = backend / "data"
    data.mkdir()
    (data / "示例法.md").write_text("示例法律条文。" * 40, encoding="utf-8")
    monkeypatch.chdir(backend)
    monkeypatch.setattr(init_db, "DATA_DIR", data)
    monkeypatch.setattr(init_db, "CHROMA_DIR", database)
    monkeypatch.setattr(init_db.httpx, "Client", MagicMock())
    factory = Mock()
    monkeypatch.setattr(init_db.chromadb, "PersistentClient", factory)
    monkeypatch.setattr(init_db, "verify_query", Mock())
    init_db.main()
    factory.assert_called_once_with(path="chroma_db")
    factory.return_value.get_collection.assert_called_once()
    factory.return_value.create_collection.assert_not_called()
