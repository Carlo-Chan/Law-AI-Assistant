"""按 PDF 真实边界提取有框线表格，无法可靠分配文字时整页回退，绝不截断原文。"""

import io
import math
from bisect import bisect_right
from collections import Counter

import pdfplumber

from app.core.errors import PDF_OCR_REQUIRED, PublicError
from app.services.document_structure import serialize_document

_MAX_TABLES = 128
_MAX_CELLS = 10000
_MAX_GRID_SLOTS = 100000
_MAX_DEPTH = 16
_MAX_ASSIGNMENTS = 5000000
_TOLERANCE = 0.01


class _UnsupportedLayout(ValueError):
    """几何关系不明确或超出结构预算，仅取消该页表格展示，不丢弃正文。"""


def _contains(outer, inner, tolerance=_TOLERANCE):
    return (
        outer[0] - tolerance <= inner[0]
        and outer[1] - tolerance <= inner[1]
        and outer[2] + tolerance >= inner[2]
        and outer[3] + tolerance >= inner[3]
    )


def _area(bounds):
    return (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])


def _overlaps(first, second):
    return (
        min(first[2], second[2]) - max(first[0], second[0]) > _TOLERANCE
        and min(first[3], second[3]) - max(first[1], second[1]) > _TOLERANCE
    )


def _bounds(values):
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        raise _UnsupportedLayout
    bounds = tuple(round(value, 3) for value in values)
    if bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
        raise _UnsupportedLayout
    return bounds


def _build_tables(page):
    """先校验真实网格及包含关系，再将子表挂到唯一的父单元格。"""
    found = page.find_tables()
    if len(found) > _MAX_TABLES:
        raise _UnsupportedLayout
    tables = []
    seen = set()
    cell_budget = _MAX_CELLS
    grid_budget = _MAX_GRID_SLOTS
    for source in found:
        bounds = _bounds(source.bbox)
        cells = sorted({_bounds(cell) for cell in source.cells})
        if not cells or not _contains(page.bbox, bounds):
            raise _UnsupportedLayout
        identity = (bounds, tuple(cells))
        if identity in seen:
            continue
        seen.add(identity)
        xs = sorted({value for cell in cells for value in (cell[0], cell[2])})
        ys = sorted({value for cell in cells for value in (cell[1], cell[3])})
        columns, row_count = len(xs) - 1, len(ys) - 1
        cell_budget -= len(cells)
        grid_budget -= columns * row_count
        if columns > 256 or row_count > 1000 or cell_budget < 0 or grid_budget < 0:
            raise _UnsupportedLayout
        table = {
            "bbox": bounds,
            "xs": xs,
            "ys": ys,
            "rows": [[] for _ in range(row_count)],
            "owners": {},
        }
        for cell_bounds in cells:
            if not _contains(bounds, cell_bounds):
                raise _UnsupportedLayout
            column, row = xs.index(cell_bounds[0]), ys.index(cell_bounds[1])
            colspan = xs.index(cell_bounds[2]) - column
            rowspan = ys.index(cell_bounds[3]) - row
            cell = {
                "bbox": cell_bounds,
                "column": column,
                "colspan": colspan,
                "rowspan": rowspan,
                "children": [],
            }
            table["rows"][row].append(cell)
            for row_index in range(row, row + rowspan):
                for column_index in range(column, column + colspan):
                    if (row_index, column_index) in table["owners"]:
                        raise _UnsupportedLayout
                    table["owners"][row_index, column_index] = cell
        for row in table["rows"]:
            row.sort(key=lambda cell: cell["column"])
        tables.append(table)
    roots = []
    for child in tables:
        candidates = []
        for parent in tables:
            if parent is child or not _overlaps(parent["bbox"], child["bbox"]):
                continue
            if _contains(parent["bbox"], child["bbox"]):
                if _area(parent["bbox"]) <= _area(child["bbox"]):
                    raise _UnsupportedLayout
                containers = [
                    cell
                    for row in parent["rows"]
                    for cell in row
                    if _contains(cell["bbox"], child["bbox"])
                ]
                if len(containers) != 1:
                    raise _UnsupportedLayout
                candidates.append(containers[0])
            elif not _contains(child["bbox"], parent["bbox"]):
                raise _UnsupportedLayout
        if candidates:
            min(candidates, key=lambda cell: _area(cell["bbox"]))["children"].append(child)
        else:
            roots.append(child)
    return roots


def _character_center(char):
    return (char["x0"] + char["x1"]) / 2, (char["top"] + char["bottom"]) / 2


def _inside(bounds, center):
    return bounds[0] <= center[0] < bounds[2] and bounds[1] <= center[1] < bounds[3]


def _read_region(chars, tables, depth=0):
    """每个字符仅分配给所在区域一次，子表文字不再留在父单元格的段落中。"""
    if depth > _MAX_DEPTH or len(chars) * len(tables) > _MAX_ASSIGNMENTS:
        raise _UnsupportedLayout
    assigned = [[] for _ in tables]
    outside = []
    for char in chars:
        center = _character_center(char)
        for index, table in enumerate(tables):
            if _inside(table["bbox"], center):
                assigned[index].append(char)
                break
        else:
            outside.append(char)
    if any(
        char["text"].strip() and table["bbox"][1] < _character_center(char)[1] < table["bbox"][3]
        for table in tables
        for char in outside
    ):
        raise _UnsupportedLayout
    events = []
    words = pdfplumber.utils.extract_words(outside)
    for line in pdfplumber.utils.cluster_objects(words, "top", 3):
        events.append(
            (
                min(word["top"] for word in line),
                min(word["x0"] for word in line),
                "text",
                " ".join(word["text"] for word in line),
            )
        )
    for table, content in zip(tables, assigned, strict=True):
        block = _read_table(table, content, depth + 1)
        if any(cell["blocks"] for row in block["rows"] for cell in row):
            events.append((table["bbox"][1], table["bbox"][0], "table", block))
    blocks = []
    lines = []

    def flush_lines():
        if lines:
            blocks.append({"type": "paragraph", "text": "\n".join(lines)})
            lines.clear()

    for _, _, kind, content in sorted(events, key=lambda event: event[:2]):
        if kind == "text":
            lines.append(content)
        else:
            flush_lines()
            blocks.append(content)
    flush_lines()
    return blocks


def _read_table(table, chars, depth):
    """按字符中心定位网格，跨格字形拒绝结构化，空格子不用于猜测合并。"""
    assigned = {id(cell): [] for row in table["rows"] for cell in row}
    for char in chars:
        center = _character_center(char)
        row = bisect_right(table["ys"], center[1]) - 1
        column = bisect_right(table["xs"], center[0]) - 1
        owner = table["owners"].get((row, column))
        if owner is None:
            if char["text"].strip():
                raise _UnsupportedLayout
            continue
        char_bounds = (char["x0"], char["top"], char["x1"], char["bottom"])
        if char["text"].strip() and not _contains(owner["bbox"], char_bounds, tolerance=1):
            raise _UnsupportedLayout
        assigned[id(owner)].append(char)
    rows = []
    for row in table["rows"]:
        rows.append(
            [
                {
                    "column": cell["column"],
                    "colspan": cell["colspan"],
                    "rowspan": cell["rowspan"],
                    "blocks": _read_region(assigned[id(cell)], cell["children"], depth),
                }
                for cell in row
            ]
        )
    return {"type": "table", "columns": len(table["xs"]) - 1, "rows": rows}


def _text_characters(blocks):
    for block in blocks:
        if block["type"] == "paragraph":
            yield from (char for char in block["text"] if not char.isspace())
        else:
            for row in block["rows"]:
                for cell in row:
                    yield from _text_characters(cell["blocks"])


def _page_blocks(page):
    """结构转换前后核对非空白字符数量，异常时保留该页的完整文本提取结果。"""
    text = page.extract_text() or ""
    if not text.strip() and page.images:
        raise PublicError(PDF_OCR_REQUIRED)
    if not text.strip():
        return []
    fallback = [{"type": "paragraph", "text": text}]
    try:
        tables = _build_tables(page)
        if not tables:
            return fallback
        blocks = _read_region(page.chars, tables)
        expected = Counter(
            char for item in page.chars for char in item["text"] if not char.isspace()
        )
        if Counter(_text_characters(blocks)) != expected:
            raise _UnsupportedLayout
        return blocks
    except _UnsupportedLayout:
        return fallback


def extract_pdf(file_bytes: bytes) -> dict:
    """各页分别解析并保留页间空行；扫描页在启动模型之前明确拒绝。"""
    blocks = []
    page_starts = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as document:
        for page in document.pages:
            try:
                page_starts.append(len(blocks))
                blocks.extend(_page_blocks(page))
            finally:
                page.close()
    return serialize_document(blocks, page_starts=page_starts)
