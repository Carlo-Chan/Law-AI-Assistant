"""验证真实 PDF 的表格结构、原文完整性及两类上传入口。"""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.core.errors import PublicError
from app.main import app
from app.services.parser import DocumentParser
from tests.pdf_samples import PDFPage, build_pdf, nested_contract_pdf


def parse(content):
    return DocumentParser.parse_document(content, "合同.PDF")


def text_at(document, block):
    return (
        document["raw_text"]
        .encode("utf-16-le")[block["start"] * 2 : block["end"] * 2]
        .decode("utf-16-le")
    )


def test_pdf_tables_keep_body_order_and_multiline_cells():
    page = PDFPage().text(40, 35, "Begin")
    page.table([["Deposit", "2000\nReturn in 7 days"], ["Rent", "20000"]])
    page.text(40, 230, "Middle")
    page.table([["Penalty", "0.05%"]], top=290)
    page.text(40, 375, "End")
    document = parse(build_pdf(page))
    assert document["raw_text"] == (
        "Begin\nDeposit\t2000\nReturn in 7 days\nRent\t20000\nMiddle\nPenalty\t0.05%\nEnd"
    )
    assert [block["type"] for block in document["document_blocks"]] == [
        "paragraph",
        "table",
        "paragraph",
        "table",
        "paragraph",
    ]


def test_pdf_merge_uses_cell_boundaries_not_empty_text():
    page = PDFPage().table(
        [["Shared", "", "Owner"], ["", "", "Tenant"], ["Deposit", "3000", ""]],
        widths=(100, 100, 100),
        spans={(0, 0): (2, 2)},
    )
    document = parse(build_pdf(page))
    table = document["document_blocks"][0]
    assert table["columns"] == 3
    assert (table["rows"][0][0]["colspan"], table["rows"][0][0]["rowspan"]) == (2, 2)
    assert table["rows"][1][0]["column"] == 2
    assert len(table["rows"][2]) == 3
    assert document["raw_text"] == "Shared\tOwner\nTenant\nDeposit\t3000\t"


def test_nested_pdf_table_stays_inside_cell_without_duplicate_text():
    document = parse(nested_contract_pdf())
    assert (
        document["raw_text"]
        == "Contract\nItem\tTerms\nDeposit\tBefore\nDue\t7 days\nAmount\t3000\nAfter\nEnd"
    )
    outer = document["document_blocks"][1]
    content = outer["rows"][1][1]["blocks"]
    assert [block["type"] for block in content] == ["paragraph", "table", "paragraph"]
    assert content[1]["columns"] == 2
    assert text_at(document, content[1]["rows"][1][1]) == "3000"
    assert document["raw_text"].count("3000") == 1


def test_pdf_distinct_cells_with_same_text_are_not_deduplicated():
    document = parse(
        build_pdf(PDFPage().table([["Confirmed", "Confirmed"], ["Confirmed", "Confirmed"]]))
    )
    assert document["raw_text"] == "Confirmed\tConfirmed\nConfirmed\tConfirmed"


def test_pdf_pages_keep_separator_and_independent_tables():
    document = parse(
        build_pdf(
            PDFPage().table([["Item", "Value"], ["A", "100"]]),
            PDFPage(),
            PDFPage().table([["Item", "Value"], ["B", "200"]]),
        )
    )
    assert document["raw_text"] == "Item\tValue\nA\t100\n\nItem\tValue\nB\t200"
    assert [block["type"] for block in document["document_blocks"]] == ["table", "table"]


def test_pdf_borderless_text_is_preserved_without_guessing_structure():
    page = PDFPage().text(40, 30, "Body")
    page.text(40, 100, "Deposit").text(220, 100, "2000")
    page.text(40, 150, "Rent").text(220, 150, "20000")
    document = parse(build_pdf(page))
    assert document["raw_text"] == "Body\nDeposit 2000\nRent 20000"
    assert all(block["type"] == "paragraph" for block in document["document_blocks"])


@pytest.mark.parametrize("mixed", [False, True])
def test_pdf_image_only_page_rejects_instead_of_reviewing_partial_text(mixed):
    pages = ([PDFPage().text(40, 30, "Readable first page")] if mixed else []) + [PDFPage().image()]
    with pytest.raises(PublicError, match="OCR") as raised:
        parse(build_pdf(*pages))
    assert raised.value.info.code == "pdf_ocr_required"


def test_pdf_image_with_readable_text_does_not_trigger_page_only_guard():
    document = parse(build_pdf(PDFPage().text(40, 30, "Readable page").image()))
    assert document["raw_text"] == "Readable page"


@pytest.mark.parametrize("streaming", [False, True])
def test_pdf_ocr_guard_runs_before_agent_and_sse(history_store, monkeypatch, streaming):
    analyze = AsyncMock()
    generate = AsyncMock()
    monkeypatch.setattr(routes, "run_contract_analysis", analyze)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    content = build_pdf(PDFPage().text(40, 30, "Readable"), PDFPage().image())
    with TestClient(app) as client:
        response = client.post(
            "/api/analyze_contract" + ("/stream" if streaming else ""),
            files={"file": ("合同.pdf", content)},
        )
    assert response.status_code == 400
    assert response.json()["code"] == "pdf_ocr_required"
    analyze.assert_not_called()
    generate.assert_not_called()


@pytest.mark.parametrize("streaming", [False, True])
def test_pdf_structure_survives_upload_history_and_regeneration(
    history_store, monkeypatch, streaming
):
    content = nested_contract_pdf()
    expected = parse(content)

    async def analyze(raw_text, instruction):
        assert raw_text == expected["raw_text"]
        return {
            "raw_text": "spoofed",
            "document_blocks": [{"type": "spoofed"}],
            "chat_reply": "报告",
            "risk_points": [],
        }

    async def generate(raw_text, instruction):
        yield {"type": "done", **await analyze(raw_text, instruction)}

    monkeypatch.setattr(routes, "run_contract_analysis", analyze)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", generate)
    with TestClient(app) as client:
        response = client.post(
            "/api/analyze_contract" + ("/stream" if streaming else ""),
            files={"file": ("合同.pdf", content)},
        )
        assert response.status_code == 200
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
                "user_content": "审查 PDF",
                "assistant_content": "报告",
                "file_name": "合同.pdf",
                "contract_data": report,
            },
        )
        assert saved.status_code == 200
        target = client.get(f"/api/conversations/{cid}").json()["data"]["messages"][1]
        assert json.loads(target["contract_data"])["document_blocks"] == expected["document_blocks"]

        async def regenerate(raw_text, instruction):
            yield {
                "type": "done",
                "raw_text": raw_text,
                "chat_reply": "新报告",
                "risk_points": [],
                "document_blocks": [{"type": "spoofed"}],
            }

        monkeypatch.setattr(routes, "run_contract_analysis_stream", regenerate)
        monkeypatch.setattr(
            DocumentParser, "parse_document", lambda *args: pytest.fail("重审不应重新解析附件")
        )
        response = client.post(
            f"/api/conversations/{cid}/messages/{target['id']}/regenerate_contract/stream",
            json={"expected_revision": target["revision"]},
        )
        event = json.loads(
            next(line[6:] for line in response.text.splitlines() if line.startswith("data: "))
        )
        assert event["saved"] is True
        assert event["raw_text"] == expected["raw_text"]
        assert event["document_blocks"] == expected["document_blocks"]
        assert len(client.get(f"/api/conversations/{cid}").json()["data"]["messages"]) == 2


def test_pdf_shared_browser_fixture_matches_real_parser():
    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "tests/fixtures/pdf-contract.json").read_text(
            encoding="utf-8"
        )
    )
    assert parse(nested_contract_pdf()) == fixture


@pytest.mark.parametrize(
    "budget", ["_MAX_TABLES", "_MAX_CELLS", "_MAX_GRID_SLOTS", "_MAX_DEPTH", "_MAX_ASSIGNMENTS"]
)
def test_pdf_structure_budget_falls_back_to_full_page_not_truncation(monkeypatch, budget):
    from app.services import pdf_structure

    monkeypatch.setattr(pdf_structure, budget, 0)
    document = parse(nested_contract_pdf())
    assert (
        document["raw_text"]
        == "Contract\nItem Terms\nDeposit Before\nDue 7 days\nAmount 3000\nAfter\nEnd"
    )
    assert len(document["document_blocks"]) == 1
    assert document["document_blocks"][0]["type"] == "paragraph"


def test_pdf_character_coverage_failure_preserves_original_text(monkeypatch):
    from app.services import pdf_structure

    monkeypatch.setattr(pdf_structure, "_text_characters", lambda blocks: iter("incomplete"))
    document = parse(nested_contract_pdf())
    assert "Amount 3000" in document["raw_text"]
    assert all(block["type"] == "paragraph" for block in document["document_blocks"])


def test_pdf_table_and_side_note_fall_back_instead_of_reordering_text():
    page = PDFPage().table([["Deposit", "2000"], ["Rent", "20000"]])
    page.text(410, 120, "Side note")
    document = parse(build_pdf(page))
    assert "Side note" in document["raw_text"]
    assert "2000" in document["raw_text"]
    assert all(block["type"] == "paragraph" for block in document["document_blocks"])


def test_pdf_two_side_by_side_tables_are_not_nested():
    page = PDFPage().table([["A", "100"], ["B", "200"]], widths=(80, 80))
    page.table([["C", "300"], ["D", "400"]], left=350, widths=(80, 80))
    document = parse(build_pdf(page))
    assert document["raw_text"] == "A\t100\nB\t200\nC\t300\nD\t400"
    assert [block["type"] for block in document["document_blocks"]] == ["table", "table"]


def test_pdf_glyph_crossing_cell_boundary_falls_back_without_losing_amount():
    page = PDFPage().table([["", "Value"], ["Item", "1000"]], widths=(100, 100))
    page.text(135, 125, "Crossing")
    document = parse(build_pdf(page))
    assert "Crossing" in document["raw_text"]
    assert "1000" in document["raw_text"]
    assert all(block["type"] == "paragraph" for block in document["document_blocks"])


def test_pdf_empty_table_does_not_hide_surrounding_text():
    page = PDFPage().text(40, 30, "Before")
    page.table([["", ""], ["", ""]])
    page.text(40, 230, "After")
    document = parse(build_pdf(page))
    assert document["raw_text"] == "Before\nAfter"
    assert all(block["type"] == "paragraph" for block in document["document_blocks"])


def test_shared_serializer_counts_utf16_and_page_gaps():
    from app.services.document_structure import serialize_document

    result = serialize_document(
        [
            {"type": "paragraph", "text": "合同😀"},
            {
                "type": "table",
                "columns": 1,
                "rows": [
                    [
                        {
                            "column": 0,
                            "colspan": 1,
                            "rowspan": 1,
                            "blocks": [{"type": "paragraph", "text": "2000元"}],
                        }
                    ]
                ],
            },
        ],
        page_starts=[1],
    )
    assert result["raw_text"] == "合同😀\n\n2000元"
    amount = result["document_blocks"][1]["rows"][0][0]
    assert amount["start"] == 6
    assert amount["end"] == 11
    assert text_at(result, amount) == "2000元"


@pytest.mark.parametrize(
    "layout",
    [
        "overlapping_cells",
        "crossing_tables",
        "child_crosses_columns",
        "invalid_bounds",
        "missing_cell",
    ],
)
def test_pdf_ambiguous_geometry_falls_back_to_complete_page(monkeypatch, layout):
    import pdfplumber

    outer = SimpleNamespace(
        bbox=(40, 100, 240, 180), cells=[(40, 100, 140, 180), (140, 100, 240, 180)]
    )
    if layout == "overlapping_cells":
        tables = [
            SimpleNamespace(bbox=outer.bbox, cells=[(40, 100, 160, 180), (140, 100, 240, 180)])
        ]
    elif layout == "crossing_tables":
        tables = [outer, SimpleNamespace(bbox=(180, 130, 300, 220), cells=[(180, 130, 300, 220)])]
    elif layout == "child_crosses_columns":
        tables = [outer, SimpleNamespace(bbox=(110, 120, 170, 160), cells=[(110, 120, 170, 160)])]
    elif layout == "invalid_bounds":
        tables = [SimpleNamespace(bbox=(40, 100, float("nan"), 180), cells=outer.cells)]
    else:
        tables = [SimpleNamespace(bbox=outer.bbox, cells=[(40, 100, 140, 180)])]
    monkeypatch.setattr(pdfplumber.page.Page, "find_tables", lambda page: tables)
    page = PDFPage().text(40, 35, "Begin").text(160, 115, "Deposit 2000")
    document = parse(build_pdf(page))
    assert document["raw_text"] == "Begin\nDeposit 2000"
    assert document["document_blocks"] == [{"type": "paragraph", "start": 0, "end": 18}]


def test_pdf_duplicate_detection_of_same_geometry_does_not_duplicate_text(monkeypatch):
    import pdfplumber

    original = pdfplumber.page.Page.find_tables
    monkeypatch.setattr(pdfplumber.page.Page, "find_tables", lambda page: original(page) * 2)
    document = parse(nested_contract_pdf())
    assert document["raw_text"].count("3000") == 1
    assert document["document_blocks"][1]["type"] == "table"
