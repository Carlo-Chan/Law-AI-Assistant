"""用 PDF 基础指令构造合成样本，不依赖字体文件、Office 或额外制图包。"""

import zlib


class PDFPage:
    """位置采用左上角坐标，便于直接对照解析器的表格边界。"""

    width = 600
    height = 800

    def __init__(self):
        self.commands = []
        self.has_image = False

    def text(self, left, top, text, size=10):
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        self.commands.append(
            f"BT /F1 {size} Tf {left} {self.height - top - size} Td ({escaped}) Tj ET"
        )
        return self

    def rectangle(self, left, top, width, height):
        self.commands.append(f"{left} {self.height - top - height} {width} {height} re S")
        return self

    def image(self):
        self.has_image = True
        self.commands.append("q 500 0 0 600 40 100 cm /Im1 Do Q")
        return self

    def table(self, values, top=100, widths=(150, 150), spans=None, left=40, row_height=40):
        spans = spans or {}
        covered = set()
        for row_index, row in enumerate(values):
            for column, text in enumerate(row):
                if (row_index, column) in covered:
                    continue
                rowspan, colspan = spans.get((row_index, column), (1, 1))
                covered.update(
                    (row, col)
                    for row in range(row_index, row_index + rowspan)
                    for col in range(column, column + colspan)
                    if (row, col) != (row_index, column)
                )
                cell_left = left + sum(widths[:column])
                cell_top = top + row_index * row_height
                self.rectangle(
                    cell_left,
                    cell_top,
                    sum(widths[column : column + colspan]),
                    row_height * rowspan,
                )
                for line_index, line in enumerate(text.split("\n")):
                    self.text(cell_left + 7, cell_top + 7 + line_index * 13, line)
        return self


def build_pdf(*pages):
    """生成带真实交叉引用表、可选图片对象和内置 Helvetica 字体的 PDF。"""
    page_ids = [4 + index * 3 for index in range(len(pages))]
    children = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{children}] /Count {len(pages)} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for page, page_id in zip(pages, page_ids, strict=True):
        image_resource = f"/XObject << /Im1 {page_id + 2} 0 R >>" if page.has_image else ""
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page.width} {page.height}] "
                f"/Resources << /Font << /F1 3 0 R >> {image_resource} >> "
                f"/Contents {page_id + 1} 0 R >>"
            ).encode()
        )
        content = "\n".join(page.commands).encode("ascii")
        objects.append(
            f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream"
        )
        image = zlib.compress(b"\xff\xff\xff")
        objects.append(
            (
                "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 "
                "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
                f"/Length {len(image)} >>\nstream\n"
            ).encode()
            + image
            + b"\nendstream"
        )
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for identifier, content in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{identifier} 0 obj\n".encode() + content + b"\nendobj\n")
    startxref = len(result)
    result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{startxref}\n%%EOF".encode()
    )
    return bytes(result)


def nested_contract_pdf():
    """同一单元格的子表前后均有正文，且金额不能被重复追加。"""
    page = PDFPage().text(40, 35, "Contract")
    page.table([["Item", "Terms"], ["Deposit", "Before"]], row_height=120)
    page.table(
        [["Due", "7 days"], ["Amount", "3000"]], top=255, widths=(60, 60), left=205, row_height=25
    )
    page.text(197, 320, "After").text(40, 385, "End")
    return build_pdf(page)
