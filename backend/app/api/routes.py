"""
API 路由：法律问答 + 合同审查
"""
from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import List

from app.agent.chain import run_chat, run_contract_analysis
from app.services.parser import DocumentParser

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

