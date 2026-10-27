"""本机 Ollama 不受环境代理干扰，远程服务仍保留原有代理行为。"""

from unittest.mock import MagicMock, Mock

import httpx
import pytest

from app import init_db

URL_CASES = [
    ("http://localhost:11434", False),
    ("http://LOCALHOST:11434", False),
    ("http://localhost.:11434", False),
    ("http://127.0.0.1:11434", False),
    ("http://127.0.0.2:11434", False),
    ("http://[::1]:11434", False),
    ("https://ollama.example.com", True),
    ("http://192.168.1.2:11434", True),
    ("http://localhost.example.com:11434", True),
    ("http://127.0.0.1.example.com:11434", True),
]


@pytest.mark.parametrize(("url", "trust_env"), URL_CASES)
@pytest.mark.parametrize("entry", ["batch", "embedding", "health"])
def test_ollama_entry_points_only_bypass_environment_for_loopback(
    monkeypatch, tmp_path, url, trust_env, entry
):
    """批量建库、在线嵌入和健康检查遵循同一规则，不修改进程环境变量。"""
    response = Mock()
    response.json.return_value = {"embeddings": [[0.1, 0.2]]}
    client_factory = MagicMock()
    client = client_factory.return_value.__enter__.return_value
    client.post.return_value = response
    post = Mock(return_value=response)
    monkeypatch.setattr(init_db.httpx, "Client", client_factory)
    monkeypatch.setattr(init_db.httpx, "post", post)
    monkeypatch.setattr(init_db, "OLLAMA_URL", url)
    text = "违约金 5%/日，付款币种 USD。"

    if entry == "health":
        monkeypatch.setattr(init_db, "DATA_DIR", tmp_path)
        with pytest.raises(SystemExit) as error:
            init_db.main()
        assert error.value.code == 1
        client_factory.assert_called_once()
        options = client_factory.call_args.kwargs
        assert options["timeout"] == 5
        client.get.assert_called_once_with(url + "/api/tags")
    elif entry == "batch":
        assert init_db.ollama_embed_batch([text], model="test-model") == [[0.1, 0.2]]
        client_factory.assert_called_once()
        options = client_factory.call_args.kwargs
        assert options["timeout"] == 300
        client.post.assert_called_once_with(
            url + "/api/embed", json={"model": "test-model", "input": [text]}
        )
    else:
        embedding = init_db.OllamaEmbeddingFunction(model="test-model", base_url=url)
        assert embedding([text])[0] == pytest.approx([0.1, 0.2])
        post.assert_called_once()
        assert post.call_args.args == (url + "/api/embed",)
        options = post.call_args.kwargs
        assert options["timeout"] == 120
        assert options["json"] == {"model": "test-model", "input": [text]}

    assert options.get("trust_env", True) is trust_env


@pytest.mark.parametrize("entry", ["batch", "embedding"])
def test_local_embedding_retries_keep_proxy_bypass(monkeypatch, entry):
    """暂时失败后的重试不能重新走环境代理，也不改变原有重试间隔。"""
    response = Mock()
    response.json.return_value = {"embeddings": [[0.1]]}
    sender = Mock(side_effect=[httpx.ReadTimeout("合成超时"), response])
    client_factory = MagicMock()
    client_factory.return_value.__enter__.return_value.post = sender
    monkeypatch.setattr(init_db.httpx, "Client", client_factory)
    monkeypatch.setattr(init_db.httpx, "post", sender)
    sleep = Mock()
    monkeypatch.setattr("time.sleep", sleep)

    if entry == "batch":
        assert init_db.ollama_embed_batch(["合成查询"]) == [[0.1]]
        assert client_factory.call_args.kwargs.get("trust_env", True) is False
    else:
        assert init_db.OllamaEmbeddingFunction().embed_query("合成查询") == pytest.approx([0.1])
        assert all(call.kwargs.get("trust_env", True) is False for call in sender.call_args_list)
    assert sender.call_count == 2
    sleep.assert_called_once_with(3)
