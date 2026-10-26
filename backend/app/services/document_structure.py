"""提取 Word 结构并统一序列化文档，保证浏览器使用同一份 UTF-16 原文坐标。"""

import io
from itertools import groupby


def extract_docx(file_bytes: bytes) -> dict:
    import docx
    from docx.text.paragraph import Paragraph

    def read_blocks(container):
        blocks = []
        for block in container.iter_inner_content():
            if isinstance(block, Paragraph):
                if block.text.strip():
                    blocks.append({"type": "paragraph", "text": block.text})
                continue
            rows = []
            anchors = {}
            for row_index, row in enumerate(block.rows):
                cells = []
                column = row.grid_cols_before
                for element, group in groupby(row.cells, key=lambda cell: cell._tc):
                    mapped = list(group)
                    if element in anchors:
                        anchor, first_row = anchors[element]
                        anchor["rowspan"] = row_index - first_row + 1
                    else:
                        cell = {
                            "column": column,
                            "colspan": len(mapped),
                            "rowspan": 1,
                            "blocks": read_blocks(mapped[0]),
                        }
                        anchors[element] = (cell, row_index)
                        cells.append(cell)
                    column += len(mapped)
                rows.append(cells)
            if any(cell["blocks"] for row in rows for cell in row):
                blocks.append({"type": "table", "columns": len(block.columns), "rows": rows})
        return blocks

    return serialize_document(read_blocks(docx.Document(io.BytesIO(file_bytes))))


def serialize_document(blocks: list[dict], *, page_starts=()) -> dict:
    """结构只引用最终原文；PDF 保留页间空行，单元格与段落仍使用同一分隔规则。"""
    parts = []
    offset = 0
    page_starts = set(page_starts)

    def append(text):
        nonlocal offset
        parts.append(text)
        # Python 按 Unicode 字符计数，浏览器字符串按 UTF-16 计数，不能直接混用 len。
        offset += len(text.encode("utf-16-le")) // 2

    def write_blocks(items, *, root=False):
        for index, block in enumerate(items):
            if index:
                append("\n\n" if root and index in page_starts else "\n")
            block["start"] = offset
            if block["type"] == "paragraph":
                append(block.pop("text"))
            else:
                written_row = False
                for row in block["rows"]:
                    nonempty = any(cell["blocks"] for cell in row)
                    if nonempty and written_row:
                        append("\n")
                    for cell_index, cell in enumerate(row):
                        if nonempty and cell_index:
                            append("\t")
                        cell["start"] = offset
                        write_blocks(cell["blocks"])
                        cell["end"] = offset
                    written_row = written_row or nonempty
            block["end"] = offset

    write_blocks(blocks, root=True)
    return {"raw_text": "".join(parts), "document_blocks": blocks}
