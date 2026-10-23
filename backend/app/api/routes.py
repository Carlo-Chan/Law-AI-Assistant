"""
API 路由：法律问答 + 合同审查
"""

import json
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent.chain import (
    run_chat,
    run_chat_stream,
    run_contract_analysis,
    run_contract_analysis_stream,
)
from app.services import history
from app.services.parser import DocumentParser

router = APIRouter()
logger = logging.getLogger(__name__)


# ============================================================
# 数据模型
# ============================================================


class ChatRequest(BaseModel):
    query: str
    history: list[dict] = []


class ChatResponse(BaseModel):
    code: int = 200
    data: dict


class RiskPoint(BaseModel):
    quote: str
    level: str
    bubble_text: str


class ContractAnalysisData(BaseModel):
    raw_text: str
    risk_points: list[RiskPoint]
    chat_reply: str


class ContractAnalysisResponse(BaseModel):
    code: int = 200
    data: ContractAnalysisData


# ============================================================
# 路由
# ============================================================


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """法律咨询对话"""
    try:
        result = await run_chat(request.query, request.history)
        return ChatResponse(code=200, data=result)
    except Exception as e:
        logger.exception("法律咨询请求处理失败")
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    async def generate():
        try:
            async for event in run_chat_stream(request.query, request.history):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.exception("流式法律咨询请求处理失败")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/analyze_contract", response_model=ContractAnalysisResponse)
async def analyze_contract(file: Annotated[UploadFile, File()]):
    """合同审查：上传文件 -> 解析文本 -> AI 分析"""
    # 1. 读取并解析文件
    raw_bytes = await file.read()
    try:
        raw_text = DocumentParser.parse(raw_bytes, file.filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    # 2. 调用 AI 审查
    try:
        result = await run_contract_analysis(raw_text)
    except Exception as e:
        logger.exception("合同审查请求处理失败")
        raise HTTPException(status_code=500, detail=str(e)) from e

    # 3. 构造响应
    return ContractAnalysisResponse(
        code=200,
        data=ContractAnalysisData(
            raw_text=result["raw_text"],
            risk_points=[RiskPoint(**rp) for rp in result["risk_points"]],
            chat_reply=result["chat_reply"],
        ),
    )


@router.post("/analyze_contract/stream")
async def analyze_contract_stream(file: Annotated[UploadFile, File()]):
    raw_bytes = await file.read()
    try:
        raw_text = DocumentParser.parse(raw_bytes, file.filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    async def generate():
        try:
            async for event in run_contract_analysis_stream(raw_text):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.exception("流式合同审查请求处理失败")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ============================================================
# 会话历史
# ============================================================


class ConvResponse(BaseModel):
    code: int = 200
    data: dict | list


@router.get("/conversations", response_model=ConvResponse)
async def list_conversations():
    convs = history.list_conversations()
    return ConvResponse(code=200, data=convs)


@router.post("/conversations", response_model=ConvResponse)
async def create_conversation():
    conv = history.create_conversation()
    return ConvResponse(code=200, data=conv)


@router.get("/conversations/{conv_id}", response_model=ConvResponse)
async def get_conversation(conv_id: str):
    conv = history.get_conversation(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="会话不存在")
    return ConvResponse(code=200, data=conv)


class UpdateTitleRequest(BaseModel):
    title: str


def _require_conversation(conv_id: str):
    """写入前检查目标会话，避免成功响应掩盖无效写入。"""
    if not history.conversation_exists(conv_id):
        raise HTTPException(status_code=404, detail="会话不存在")


@router.post("/conversations/{conv_id}/title", response_model=ConvResponse)
async def update_title(conv_id: str, req: UpdateTitleRequest):
    _require_conversation(conv_id)
    history.update_title(conv_id, req.title)
    return ConvResponse(code=200, data={"ok": True})


class RebuildMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    file_name: str | None = None
    contract_data: dict | None = None
    thinking_chain: list | None = None


class RebuildMessagesRequest(BaseModel):
    messages: list[RebuildMessage]


@router.post("/conversations/{conv_id}/rebuild", response_model=ConvResponse)
async def rebuild_conv(conv_id: str, payload: RebuildMessagesRequest):
    _require_conversation(conv_id)
    history.rebuild_messages(conv_id, [message.model_dump() for message in payload.messages])
    return ConvResponse(code=200, data={"ok": True})


@router.delete("/conversations/{conv_id}", response_model=ConvResponse)
async def delete_conversation(conv_id: str):
    history.delete_conversation(conv_id)
    return ConvResponse(code=200, data={"ok": True})


class SaveMessagesRequest(BaseModel):
    user_content: str
    assistant_content: str
    file_name: str | None = None
    contract_data: dict | None = None
    thinking_chain: list | None = None


@router.post("/conversations/{conv_id}/messages", response_model=ConvResponse)
async def save_messages(conv_id: str, req: SaveMessagesRequest):
    _require_conversation(conv_id)
    history.add_messages(
        conv_id,
        [
            {"role": "user", "content": req.user_content, "file_name": req.file_name},
            {
                "role": "assistant",
                "content": req.assistant_content,
                "contract_data": req.contract_data,
                "thinking_chain": req.thinking_chain,
            },
        ],
    )
    return ConvResponse(code=200, data={"ok": True})
