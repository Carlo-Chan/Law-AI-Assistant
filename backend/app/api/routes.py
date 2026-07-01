"""
API 路由：法律问答 + 合同审查
"""
from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import List

from app.agent.chain import run_chat, run_contract_analysis
from app.services.parser import DocumentParser
from app.services import history

router = APIRouter()


# ============================================================
# 数据模型
# ============================================================

class ChatRequest(BaseModel):
    query: str
    history: List[dict] = []


class ChatResponse(BaseModel):
    code: int = 200
    data: dict


class RiskPoint(BaseModel):
    quote: str
    level: str
    bubble_text: str


class ContractAnalysisData(BaseModel):
    raw_text: str
    risk_points: List[RiskPoint]
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
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/analyze_contract", response_model=ContractAnalysisResponse)
async def analyze_contract(file: UploadFile = File(...)):
    """合同审查：上传文件 -> 解析文本 -> AI 分析"""
    # 1. 读取并解析文件
    raw_bytes = await file.read()
    try:
        raw_text = DocumentParser.parse(raw_bytes, file.filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # 2. 调用 AI 审查
    try:
        result = await run_contract_analysis(raw_text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # 3. 构造响应
    return ContractAnalysisResponse(
        code=200,
        data=ContractAnalysisData(
            raw_text=result["raw_text"],
            risk_points=[RiskPoint(**rp) for rp in result["risk_points"]],
            chat_reply=result["chat_reply"],
        ),
    )


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

@router.post("/conversations/{conv_id}/title", response_model=ConvResponse)
async def update_title(conv_id: str, req: UpdateTitleRequest):
    history.update_title(conv_id, req.title)
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

@router.post("/conversations/{conv_id}/messages", response_model=ConvResponse)
async def save_messages(conv_id: str, req: SaveMessagesRequest):
    history.add_message(conv_id, "user", req.user_content, req.file_name)
    history.add_message(conv_id, "assistant", req.assistant_content, contract_data=req.contract_data)
    return ConvResponse(code=200, data={"ok": True})

class GreetingRequest(BaseModel):
    content: str

@router.post("/conversations/{conv_id}/greeting", response_model=ConvResponse)
async def save_greeting(conv_id: str, req: GreetingRequest):
    history.add_message(conv_id, "assistant", req.content)
    return ConvResponse(code=200, data={"ok": True})

