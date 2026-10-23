"""建库脚本回归测试：已有向量库应直接复用，避免重复创建。"""

from unittest.mock import MagicMock, Mock

import pytest

from app import init_db


@pytest.mark.parametrize("database_exists", [True, False], ids=["reuse-existing", "create-new"])
def test_main_initializes_client_for_existing_and_new_database(
    tmp_path, monkeypatch, database_exists
):
    """已有库可直接复用，客户端创建目录后也不能误将新库当成已有库。"""
    data_directory = tmp_path / "data"
    data_directory.mkdir()
    (data_directory / "示例法.md").write_text("示例法条正文。" * 40, encoding="utf-8")
    database_directory = tmp_path / "chroma_db"
    if database_exists:
        database_directory.mkdir()
    monkeypatch.setattr(init_db, "DATA_DIR", data_directory)
    monkeypatch.setattr(init_db, "CHROMA_DIR", database_directory)
    monkeypatch.setattr(init_db.httpx, "Client", MagicMock())
    client = Mock()
    client.get_collection.return_value.count.return_value = 3
    client.create_collection.return_value.count.return_value = 1

    def create_client(*args, **kwargs):
        database_directory.mkdir(exist_ok=True)
        return client

    client_factory = Mock(side_effect=create_client)
    monkeypatch.setattr(init_db.chromadb, "PersistentClient", client_factory)
    embed_batch = Mock(return_value=[[0.1, 0.2]])
    monkeypatch.setattr(init_db, "ollama_embed_batch", embed_batch)
    monkeypatch.setattr("time.sleep", Mock())
    verify_query = Mock()
    monkeypatch.setattr(init_db, "verify_query", verify_query)

    init_db.main()

    client_factory.assert_called_once()
    if database_exists:
        client.get_collection.assert_called_once()
        client.create_collection.assert_not_called()
        client.get_collection.return_value.add.assert_not_called()
        embed_batch.assert_not_called()
        verify_query.assert_called_once_with(client.get_collection.return_value)
    else:
        client.get_collection.assert_not_called()
        client.create_collection.assert_called_once()
        client.create_collection.return_value.add.assert_called_once()
        embed_batch.assert_called_once()
        verify_query.assert_called_once_with(client.create_collection.return_value)
