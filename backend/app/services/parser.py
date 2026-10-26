"""
文档解析服务：提取合同正文及可安全展示的表格结构
"""

from pathlib import Path

from app.core.errors import UNSUPPORTED_DOCUMENT, PublicError
from app.services.document_conversion import convert_doc_to_docx
from app.services.document_structure import extract_docx
from app.services.pdf_structure import extract_pdf


class DocumentParser:
    """支持 PDF、DOC、DOCX 和 TXT；PDF 与 Word 共用结构预览和原文坐标。"""

    @staticmethod
    def parse(file_bytes: bytes, filename: str) -> str:
        return DocumentParser.parse_document(file_bytes, filename)["raw_text"]

    @staticmethod
    def parse_document(file_bytes: bytes, filename: str) -> dict:
        """模型仍读取统一纯文本；布局来自解析器，不由模型重建。"""
        ext = Path(filename).suffix.lower()

        if ext == ".pdf":
            return extract_pdf(file_bytes)
        elif ext == ".docx":
            return extract_docx(file_bytes)
        elif ext == ".doc":
            return extract_docx(convert_doc_to_docx(file_bytes))
        elif ext == ".txt":
            return {"raw_text": file_bytes.decode("utf-8", errors="replace")}
        else:
            raise PublicError(UNSUPPORTED_DOCUMENT)
