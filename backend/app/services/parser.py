"""
文档解析服务：从 PDF 和 Word 文件中提取纯文本
"""
import io
from pathlib import Path


class DocumentParser:
    """支持 PDF 和 DOCX 的文本提取"""

    @staticmethod
    def parse(file_bytes: bytes, filename: str) -> str:
        ext = Path(filename).suffix.lower()

        if ext == ".pdf":
            return DocumentParser._parse_pdf(file_bytes)
        elif ext in (".docx", ".doc"):
            return DocumentParser._parse_docx(file_bytes)
        elif ext == ".txt":
            return file_bytes.decode("utf-8", errors="replace")
        else:
            raise ValueError(f"不支持的文件格式: {ext}（仅支持 PDF / DOCX / TXT）")

    @staticmethod
    def _parse_pdf(file_bytes: bytes) -> str:
        import pdfplumber
        text_parts = []
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
        return "\n\n".join(text_parts)

    @staticmethod
    def _parse_docx(file_bytes: bytes) -> str:
        import docx
        doc = docx.Document(io.BytesIO(file_bytes))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        return "\n".join(paragraphs)
