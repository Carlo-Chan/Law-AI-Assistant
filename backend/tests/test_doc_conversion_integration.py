"""显式指定测试专用 LibreOffice 时运行；真实转换合成 DOC，不连接模型或真实历史。"""

import json
import os

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.api import routes
from app.main import app
from app.services import document_conversion as conversion
from app.services.parser import DocumentParser

pytestmark = pytest.mark.skipif(
    not os.environ.get("LAW_AI_TEST_LIBREOFFICE"),
    reason="真实 DOC 转换需显式设置 LAW_AI_TEST_LIBREOFFICE，默认离线 CI 不启动外部程序",
)


@pytest.fixture
def synthetic_doc(tmp_path, monkeypatch):
    """从合成 DOCX 导出真正的二进制 DOC，包含中文、横纵合并及嵌套表格。"""
    executable = conversion._find_executable(os.environ["LAW_AI_TEST_LIBREOFFICE"])
    document = Document()
    document.add_paragraph("合成租赁合同，仅用于转换回归")
    table = document.add_table(rows=4, cols=3)
    table.cell(0, 0).merge(table.cell(0, 2)).text = "费用与责任"
    table.cell(1, 0).merge(table.cell(2, 0)).text = "每月费用"
    table.cell(1, 1).text = "租金2000元"
    table.cell(1, 2).text = "每月5日前支付"
    table.cell(2, 1).text = "物业费100元"
    table.cell(2, 2).text = "不得重复收费"
    table.cell(3, 0).text = "押金"
    table.cell(3, 1).text = "3000元"
    cell = table.cell(3, 2)
    cell.text = "退还条件"
    nested = cell.add_table(rows=1, cols=2)
    nested.cell(0, 0).text = "结清费用"
    nested.cell(0, 1).text = "7日内退还"
    document.add_paragraph("双方签字后生效。")
    source = tmp_path / "input.docx"
    document.save(source)
    expected = DocumentParser.parse_document(source.read_bytes(), "input.docx")
    profile = tmp_path / "export-profile"
    (profile / "user").mkdir(parents=True)
    (profile / "user" / "registrymodifications.xcu").write_text(
        conversion._PROFILE, encoding="utf-8"
    )
    output = tmp_path / "export"
    output.mkdir()
    process = conversion.subprocess.Popen(
        [
            str(executable),
            f"-env:UserInstallation={profile.as_uri()}",
            "--headless",
            "--nologo",
            "--nodefault",
            "--norestore",
            "--convert-to",
            "doc:MS Word 97",
            "--outdir",
            str(output),
            str(source),
        ],
        **conversion._process_options(tmp_path),
    )
    try:
        assert process.wait(timeout=90) == 0
    finally:
        if process.poll() is None:
            conversion._terminate_process_tree(process)
    doc = (output / "input.doc").read_bytes()
    assert doc.startswith(conversion.OLE_SIGNATURE)
    settings = conversion.get_settings().model_copy(
        update={
            "libreoffice_path": str(executable),
            "doc_conversion_timeout_seconds": 45,
            "doc_conversion_temp_dir": str(tmp_path),
        }
    )
    monkeypatch.setattr(conversion, "get_settings", lambda: settings)
    return doc, expected


@pytest.mark.parametrize("streaming", [False, True])
def test_real_doc_upload_tables_history_and_regeneration(
    synthetic_doc, history_store, monkeypatch, streaming
):
    """真实 DOC 上传后解析结构不漂移；保存、重新读取及重审不依赖原附件。"""
    doc, expected = synthetic_doc

    async def analyze(raw_text, instruction):
        assert raw_text == expected["raw_text"]
        return {"raw_text": raw_text, "chat_reply": "合成报告", "risk_points": []}

    async def generate(raw_text, instruction):
        yield {"type": "done", **await analyze(raw_text, instruction)}

    monkeypatch.setattr(routes, "run_contract_analysis", analyze)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    with TestClient(app) as client:
        response = client.post(
            "/api/analyze_contract" + ("/stream" if streaming else ""),
            files={"file": ("中文合同.DOC", doc)},
        )
        assert response.status_code == 200, response.text
        report = (
            json.loads(
                next(line[6:] for line in response.text.splitlines() if line.startswith("data: "))
            )
            if streaming
            else response.json()["data"]
        )
        assert report["raw_text"] == expected["raw_text"]
        assert report["document_blocks"] == expected["document_blocks"]
        report.pop("type", None)
        cid = client.post("/api/conversations").json()["data"]["id"]
        saved = client.post(
            f"/api/conversations/{cid}/messages",
            json={
                "user_content": "审查合成 DOC",
                "assistant_content": "合成报告",
                "file_name": "中文合同.DOC",
                "contract_data": report,
            },
        )
        assert saved.status_code == 200
        target = client.get(f"/api/conversations/{cid}").json()["data"]["messages"][1]
        assert json.loads(target["contract_data"])["document_blocks"] == expected["document_blocks"]
        monkeypatch.setattr(
            conversion, "convert_doc_to_docx", lambda content: pytest.fail("重审不应转换附件")
        )
        response = client.post(
            f"/api/conversations/{cid}/messages/{target['id']}/regenerate_contract/stream",
            json={"expected_revision": target["revision"]},
        )
        event = json.loads(
            next(line[6:] for line in response.text.splitlines() if line.startswith("data: "))
        )
        assert event["saved"] is True
        assert event["document_blocks"] == expected["document_blocks"]
        after = client.get(f"/api/conversations/{cid}").json()["data"]["messages"]
        assert len(after) == 2
        assert (
            json.loads(after[1]["contract_data"])["document_blocks"] == expected["document_blocks"]
        )
