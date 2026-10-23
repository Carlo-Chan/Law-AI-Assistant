"""合同上传限制：在解析文档或调用模型前校验实际文件大小。"""

from fastapi import HTTPException, UploadFile

MAX_CONTRACT_FILE_BYTES = 10 * 1024 * 1024
CONTRACT_FILE_TOO_LARGE_MESSAGE = "合同文件不能超过 10 MiB，请压缩或拆分后重试。"


async def read_contract_upload(file: UploadFile) -> bytes:
    """优先检查已知大小；读取最多上限加一字节，防止元数据缺失或不准确。"""
    if file.size is not None and file.size > MAX_CONTRACT_FILE_BYTES:
        raise HTTPException(status_code=413, detail=CONTRACT_FILE_TOO_LARGE_MESSAGE)
    content = await file.read(MAX_CONTRACT_FILE_BYTES + 1)
    if len(content) > MAX_CONTRACT_FILE_BYTES:
        raise HTTPException(status_code=413, detail=CONTRACT_FILE_TOO_LARGE_MESSAGE)
    return content
