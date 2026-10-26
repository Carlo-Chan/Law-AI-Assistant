"""文档解析测试：使用内存样本验证文本提取和格式校验。"""

import io

import pytest
from docx import Document

from app.services.parser import DocumentParser


@pytest.mark.parametrize(
    ("filename", "text"),
    [
        ("租赁合同.txt", "租赁合同\n第一条：租金为每月 2000 元。\n第二条：按月支付。"),
        ("合同.TXT", "甲方：出租人\nTenant: Alice\nRent: 2000 CNY"),
        ("空文件.txt", ""),
    ],
    ids=["chinese", "uppercase-and-mixed-text", "empty"],
)
def test_parse_txt_preserves_text(filename, text):
    """UTF-8 文本保留中文、英文、数字与换行，空文件返回空字符串。"""
    assert DocumentParser.parse(text.encode("utf-8"), filename) == text


@pytest.mark.parametrize("filename", ["租赁合同.docx", "租赁合同.DOCX"])
def test_parse_docx_extracts_paragraphs_in_order(filename):
    """Word 段落按原顺序提取，跳过空段落与纯空白段落。"""
    document = Document()
    document.add_paragraph("租赁合同")
    document.add_paragraph("")
    document.add_paragraph("第一条：甲方向乙方出租房屋。")
    document.add_paragraph("   ")
    document.add_paragraph("第二条：月租金为 2000 元。")
    buffer = io.BytesIO()
    document.save(buffer)

    result = DocumentParser.parse(buffer.getvalue(), filename)

    assert result == "租赁合同\n第一条：甲方向乙方出租房屋。\n第二条：月租金为 2000 元。"


def test_parse_empty_docx_returns_empty_text():
    """无正文的 Word 文档返回空字符串。"""
    buffer = io.BytesIO()
    Document().save(buffer)

    assert DocumentParser.parse(buffer.getvalue(), "空文档.docx") == ""


@pytest.mark.parametrize("filename", ["合同.doc", "合同.DOC"])
def test_parse_doc_uses_shared_docx_structure(filename, monkeypatch):
    """DOC 转换后复用 DOCX 解析器，不另写一套表格和坐标逻辑。"""
    from app.services import parser

    document = Document()
    document.add_paragraph("转换后的合同")
    document.add_table(rows=1, cols=1).cell(0, 0).text = "押金2000元"
    buffer = io.BytesIO()
    document.save(buffer)
    received = []

    def convert(content):
        received.append(content)
        return buffer.getvalue()

    monkeypatch.setattr(parser, "convert_doc_to_docx", convert)
    assert DocumentParser.parse_document(
        b"synthetic DOC", filename
    ) == DocumentParser.parse_document(buffer.getvalue(), "合同.docx")
    assert received == [b"synthetic DOC"]


@pytest.mark.parametrize("filename", ["程序.exe", "说明.md", "无扩展名"])
def test_parse_unsupported_format_explains_supported_types(filename):
    """不支持的扩展名或无扩展名时给出可操作的格式提示。"""
    with pytest.raises(ValueError, match="不支持的文件格式.*仅支持 PDF / DOC / DOCX / TXT"):
        DocumentParser.parse(b"example", filename)


def _build_pdf(page_texts):
    """生成带交叉引用表的最小 PDF；使用内置字体和英文以避免字体依赖。"""
    page_ids = [4 + page_index * 2 for page_index in range(len(page_texts))]
    children = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{children}] /Count {len(page_texts)} >>".encode("ascii"),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for page_id, text in zip(page_ids, page_texts, strict=True):
        objects.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                "/Resources << /Font << /F1 3 0 R >> >> "
                f"/Contents {page_id + 1} 0 R >>"
            ).encode("ascii")
        )
        content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii") if text else b""
        objects.append(
            f"<< /Length {len(content)} >>\nstream\n".encode("ascii") + content + b"\nendstream"
        )

    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for object_id, content in enumerate(objects, start=1):
        offsets.append(len(result))
        result.extend(f"{object_id} 0 obj\n".encode("ascii") + content + b"\nendobj\n")
    xref_offset = len(result)
    result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode("ascii"))
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    result.extend(
        (
            f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(result)


@pytest.mark.parametrize(
    ("filename", "page_texts", "expected"),
    [
        (
            "租赁合同.PDF",
            ["Rental agreement", "", "Payment is due monthly"],
            "Rental agreement\n\nPayment is due monthly",
        ),
        ("空白.pdf", [""], ""),
    ],
    ids=["multiple-pages-with-blank-page", "blank-document"],
)
def test_parse_pdf_extracts_pages_in_order(filename, page_texts, expected):
    """真实 PDF 按页提取文本，跳过空白页并保留页间分隔。"""
    assert DocumentParser.parse(_build_pdf(page_texts), filename) == expected
