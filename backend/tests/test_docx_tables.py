"""使用内存 Word 文档验证正文表格及两类审查入口，不连接模型或转换程序。"""

import io
import json
from pathlib import Path

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.api import routes
from app.main import app
from app.services.parser import DocumentParser


def document_bytes(document):
    """生成真实 DOCX 字节，不读取或修改用户文件。"""
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def extract(document):
    return DocumentParser.parse(document_bytes(document), "合同.docx")


def test_paragraphs_and_tables_keep_body_order():
    """不把表格集中追加到正文末尾，也不把页眉页脚混入条款。"""
    document = Document()
    document.sections[0].header.paragraphs[0].text = "重复页眉"
    document.sections[0].footer.paragraphs[0].text = "页码"
    document.add_paragraph("第一条：合同主体")
    first = document.add_table(rows=1, cols=2)
    first.cell(0, 0).text = "甲方"
    first.cell(0, 1).text = "张三"
    document.add_paragraph("第二条：付款方式")
    second = document.add_table(rows=1, cols=2)
    second.cell(0, 0).text = "押金"
    second.cell(0, 1).text = "2000元"
    document.add_paragraph("第三条：签字生效")

    assert extract(document) == (
        "第一条：合同主体\n甲方\t张三\n第二条：付款方式\n押金\t2000元\n第三条：签字生效"
    )


def test_table_only_document_preserves_rows_and_columns():
    """仅有表格的合同不能被当作空文档，同行标签和值用制表符分隔。"""
    document = Document()
    table = document.add_table(rows=3, cols=2)
    for row, values in zip(
        table.rows, [("项目", "约定"), ("租金", "3000元/月"), ("期限", "一年")], strict=True
    ):
        for cell, value in zip(row.cells, values, strict=True):
            cell.text = value

    assert extract(document) == "项目\t约定\n租金\t3000元/月\n期限\t一年"


def test_cell_paragraphs_and_line_breaks_are_preserved():
    document = Document()
    table = document.add_table(rows=1, cols=2)
    cell = table.cell(0, 0)
    cell.text = "维修责任"
    cell.add_paragraph("甲方负责自然损耗\n乙方负责人为损坏")
    table.cell(0, 1).text = "不得转嫁"

    assert extract(document) == "维修责任\n甲方负责自然损耗\n乙方负责人为损坏\t不得转嫁"


def test_nested_table_keeps_its_place_inside_cell():
    """递归处理单元格内的表格，保留前后说明，嵌套内容只出现一次。"""
    document = Document()
    cell = document.add_table(rows=1, cols=1).cell(0, 0)
    cell.text = "费用明细"
    nested = cell.add_table(rows=1, cols=2)
    nested.cell(0, 0).text = "物业费"
    nested.cell(0, 1).text = "100元/月"
    cell.add_paragraph("其他费用不得另行收取")

    assert extract(document) == "费用明细\n物业费\t100元/月\n其他费用不得另行收取"


def test_horizontal_merge_does_not_duplicate_text():
    document = Document()
    table = document.add_table(rows=1, cols=3)
    table.cell(0, 0).merge(table.cell(0, 1)).text = "违约责任"
    table.cell(0, 2).text = "按实际损失赔偿"

    assert extract(document) == "违约责任\t按实际损失赔偿"


def test_vertical_merge_does_not_repeat_anchor_in_later_rows():
    document = Document()
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).merge(table.cell(1, 0)).text = "付款安排"
    table.cell(0, 1).text = "首期1000元"
    table.cell(1, 1).text = "次期2000元"

    assert extract(document) == "付款安排\t首期1000元\n次期2000元"


def test_rectangular_merge_and_nested_content_are_not_repeated():
    document = Document()
    table = document.add_table(rows=2, cols=2)
    cell = table.cell(0, 0).merge(table.cell(1, 1))
    cell.text = "争议解决"
    cell.add_table(rows=1, cols=1).cell(0, 0).text = "向有管辖权的法院起诉"

    assert extract(document) == "争议解决\n向有管辖权的法院起诉"


def test_distinct_cells_with_identical_text_are_not_deduplicated():
    """按物理单元格身份去重合并映射，不能按文字去重不同条款。"""
    document = Document()
    table = document.add_table(rows=2, cols=2)
    for row in table.rows:
        for cell in row.cells:
            cell.text = "双方确认"

    assert extract(document) == "双方确认\t双方确认\n双方确认\t双方确认"


def test_empty_rows_are_skipped_but_empty_columns_remain_separated():
    document = Document()
    table = document.add_table(rows=3, cols=3)
    table.cell(0, 1).text = "   "
    table.cell(1, 0).text = "甲方"
    table.cell(1, 2).text = "乙方"
    table.cell(2, 1).text = "签署日期"

    assert extract(document) == "甲方\t\t乙方\n\t签署日期\t"


def test_empty_tables_do_not_inject_blank_lines_into_paragraphs():
    document = Document()
    document.add_paragraph("开始")
    document.add_table(rows=0, cols=2)
    document.add_table(rows=2, cols=2)
    document.add_paragraph("结束")

    assert extract(document) == "开始\n结束"


def test_table_text_is_plain_text_and_keeps_original_spacing():
    document = Document()
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "  中文、English、¥2000 😀  "
    table.cell(0, 1).text = '<script>原文字面量</script> & "备注"'

    assert extract(document) == '  中文、English、¥2000 😀  \t<script>原文字面量</script> & "备注"'


@pytest.mark.parametrize("streaming", [False, True])
def test_review_endpoints_pass_table_text_to_agent_and_report(
    history_store, monkeypatch, streaming
):
    """上传经真实解析后进入审查，表格中的金额和责任不在模型调用前丢失。"""
    document = Document()
    document.add_paragraph("第一条")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "违约金"
    table.cell(0, 1).text = "每日5%"
    document.add_paragraph("第二条")
    expected = "第一条\n违约金\t每日5%\n第二条"
    calls = []

    async def analyze(raw_text, instruction):
        calls.append((raw_text, instruction))
        return {"raw_text": raw_text, "chat_reply": "报告", "risk_points": []}

    async def generate(raw_text, instruction):
        yield {"type": "done", **await analyze(raw_text, instruction)}

    monkeypatch.setattr(routes, "run_contract_analysis", analyze)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    with TestClient(app) as client:
        response = client.post(
            "/api/analyze_contract" + ("/stream" if streaming else ""),
            files={"file": ("合同.DOCX", document_bytes(document))},
            data={"instruction": "重点关注表格金额"},
        )

    assert response.status_code == 200
    structure = DocumentParser.parse_document(document_bytes(document), "合同.docx")[
        "document_blocks"
    ]
    if streaming:
        events = [
            json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
        ]
        assert events == [
            {
                "type": "done",
                "raw_text": expected,
                "chat_reply": "报告",
                "risk_points": [],
                "instruction": "重点关注表格金额",
                "document_blocks": structure,
            }
        ]
    else:
        assert response.json()["data"] == {
            "raw_text": expected,
            "chat_reply": "报告",
            "risk_points": [],
            "instruction": "重点关注表格金额",
            "document_blocks": structure,
        }
    assert calls == [(expected, "重点关注表格金额")]


def test_structure_matches_shared_browser_fixture_including_utf16():
    """跨语言使用同一份样本，emoji 后面的金额范围仍按浏览器坐标计算。"""
    document = Document()
    document.add_paragraph("合同😀")
    table = document.add_table(rows=2, cols=2)
    for row, values in zip(table.rows, [("押金", "2000元"), ("租金", "3000元")], strict=True):
        for cell, value in zip(row.cells, values, strict=True):
            cell.text = value
    document.add_paragraph("尾")
    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "tests/fixtures/word-contract.json").read_text(
            encoding="utf-8"
        )
    )
    assert DocumentParser.parse_document(document_bytes(document), "合同.docx") == fixture


def test_merged_cells_keep_grid_spans_in_structure():
    document = Document()
    table = document.add_table(rows=2, cols=3)
    table.cell(0, 0).merge(table.cell(1, 1)).text = "双方责任"
    table.cell(0, 2).text = "甲方维修"
    table.cell(1, 2).text = "乙方付款"
    result = DocumentParser.parse_document(document_bytes(document), "合同.docx")
    block = result["document_blocks"][0]
    assert block["columns"] == 3
    assert len(block["rows"][0]) == 2
    assert len(block["rows"][1]) == 1
    anchor = block["rows"][0][0]
    assert (anchor["column"], anchor["colspan"], anchor["rowspan"]) == (0, 2, 2)
    assert block["rows"][1][0]["column"] == 2
    assert result["raw_text"] == "双方责任\t甲方维修\n乙方付款"


@pytest.mark.parametrize("streaming", [False, True])
def test_model_cannot_replace_parsed_structure(history_store, monkeypatch, streaming):
    document = Document()
    document.add_table(rows=1, cols=1).cell(0, 0).text = "合同正文"
    parsed = DocumentParser.parse_document(document_bytes(document), "合同.docx")

    async def analyze(raw_text, instruction):
        return {
            "raw_text": "模型伪造原文",
            "document_blocks": [{"type": "script"}],
            "risk_points": [],
            "chat_reply": "报告",
        }

    async def generate(raw_text, instruction):
        yield {"type": "done", **await analyze(raw_text, instruction)}

    monkeypatch.setattr(routes, "run_contract_analysis", analyze)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    with TestClient(app) as client:
        response = client.post(
            "/api/analyze_contract" + ("/stream" if streaming else ""),
            files={"file": ("合同.docx", document_bytes(document))},
        )
    assert response.status_code == 200
    data = (
        json.loads(
            next(line[6:] for line in response.text.splitlines() if line.startswith("data: "))
        )
        if streaming
        else response.json()["data"]
    )
    assert data["raw_text"] == parsed["raw_text"]
    assert data["document_blocks"] == parsed["document_blocks"]


def test_saved_structure_survives_history_and_repeated_regeneration(history_store, monkeypatch):
    """结构随现有 JSON 字段保存，重跑只采用已保存的解析结构，不用模型猜测。"""
    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "tests/fixtures/word-contract.json").read_text(
            encoding="utf-8"
        )
    )

    async def generate(raw_text, instruction):
        yield {
            "type": "done",
            "raw_text": raw_text,
            "chat_reply": "新报告",
            "risk_points": [],
            "document_blocks": [{"type": "伪造结构"}],
        }

    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    with TestClient(app) as client:
        cid = client.post("/api/conversations").json()["data"]["id"]
        client.post(
            f"/api/conversations/{cid}/messages",
            json={
                "user_content": "审查合同",
                "assistant_content": "旧报告",
                "file_name": "合同.docx",
                "contract_data": {**fixture, "chat_reply": "旧报告", "risk_points": []},
            },
        )
        for _ in range(2):
            saved = client.get(f"/api/conversations/{cid}").json()["data"]["messages"][1]
            assert (
                json.loads(saved["contract_data"])["document_blocks"] == fixture["document_blocks"]
            )
            response = client.post(
                f"/api/conversations/{cid}/messages/{saved['id']}/regenerate_contract/stream",
                json={"expected_revision": saved["revision"]},
            )
            event = json.loads(
                next(line[6:] for line in response.text.splitlines() if line.startswith("data: "))
            )
            assert event["saved"] is True
            assert event["document_blocks"] == fixture["document_blocks"]
        after = client.get(f"/api/conversations/{cid}").json()["data"]["messages"]
        assert len(after) == 2
        assert (
            json.loads(after[1]["contract_data"])["document_blocks"] == fixture["document_blocks"]
        )
