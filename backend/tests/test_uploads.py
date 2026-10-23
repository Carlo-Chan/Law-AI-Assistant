"""上传限制测试：覆盖大小边界、有限读取及两类审查端点的提前拒绝。"""

from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import routes
from app.main import app
from app.services.uploads import (
    CONTRACT_FILE_TOO_LARGE_MESSAGE,
    MAX_CONTRACT_FILE_BYTES,
    read_contract_upload,
)


def test_upload_limit_is_ten_mebibytes():
    """上限按二进制字节数计算，避免 MB 与 MiB 的边界含义混淆。"""
    assert MAX_CONTRACT_FILE_BYTES == 10 * 1024 * 1024


@pytest.mark.asyncio
async def test_known_oversize_file_is_rejected_without_reading():
    """已知大小超限时直接拒绝，避免分配文件读取缓冲区。"""
    file = Mock(size=MAX_CONTRACT_FILE_BYTES + 1, read=AsyncMock())

    with pytest.raises(HTTPException) as captured:
        await read_contract_upload(file)

    assert captured.value.status_code == 413
    assert captured.value.detail == CONTRACT_FILE_TOO_LARGE_MESSAGE
    file.read.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("declared_size", [None, 1])
async def test_missing_or_understated_size_still_checks_actual_bytes(declared_size):
    """不依赖元数据单独放行，未知或低报的大小仍通过实际字节数检查。"""
    file = Mock(
        size=declared_size,
        read=AsyncMock(return_value=b"a" * (MAX_CONTRACT_FILE_BYTES + 1)),
    )

    with pytest.raises(HTTPException) as captured:
        await read_contract_upload(file)

    assert captured.value.status_code == 413
    file.read.assert_awaited_once_with(MAX_CONTRACT_FILE_BYTES + 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [0, MAX_CONTRACT_FILE_BYTES - 1, MAX_CONTRACT_FILE_BYTES])
async def test_file_at_or_below_limit_is_returned_without_changes(size):
    """允许恰好达到上限的文件，空文件继续沿用原有解析行为。"""
    content = b"a" * size
    file = Mock(size=size, read=AsyncMock(return_value=content))

    assert await read_contract_upload(file) == content
    file.read.assert_awaited_once_with(MAX_CONTRACT_FILE_BYTES + 1)


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("offset", [-1, 0, 1])
def test_contract_endpoints_enforce_limit_before_parser_and_agent(
    monkeypatch, history_store, streaming, offset
):
    """真实 multipart 请求验证两端点边界，超限不进入解析器或模型，也不开始 SSE。"""
    raw_text = "测试合同原文"
    result = {"raw_text": raw_text, "chat_reply": "测试报告", "risk_points": []}
    parser = Mock(return_value=raw_text)
    agent = AsyncMock(return_value=result)

    async def generate(text):
        yield {"type": "done", **result}

    stream_agent = Mock(side_effect=generate)
    monkeypatch.setattr(routes.DocumentParser, "parse", parser)
    monkeypatch.setattr(routes, "run_contract_analysis", agent)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", stream_agent)
    endpoint = "/api/analyze_contract" + ("/stream" if streaming else "")
    content = b"a" * (MAX_CONTRACT_FILE_BYTES + offset)

    with TestClient(app) as client:
        response = client.post(endpoint, files={"file": ("合同.txt", content)})

    if offset > 0:
        assert response.status_code == 413
        assert response.json() == {"detail": CONTRACT_FILE_TOO_LARGE_MESSAGE}
        assert "text/event-stream" not in response.headers["content-type"]
        parser.assert_not_called()
        agent.assert_not_called()
        stream_agent.assert_not_called()
    else:
        assert response.status_code == 200
        parser.assert_called_once_with(content, "合同.txt")
        if streaming:
            stream_agent.assert_called_once_with(raw_text)
            agent.assert_not_called()
            assert "text/event-stream" in response.headers["content-type"]
            assert '"type": "done"' in response.text
        else:
            agent.assert_awaited_once_with(raw_text)
            stream_agent.assert_not_called()
            assert response.json() == {"code": 200, "data": result}
    assert history_store.list_conversations() == []
