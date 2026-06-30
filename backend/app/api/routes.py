"""
API 路由：法律问答 + 合同审查
阶段一使用 Mock 数据，后续接入 LangChain Agent 替换
"""
from fastapi import APIRouter, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional, List
import json

router = APIRouter()


# ============================================================
# 数据模型（前后端契约，不可随意修改字段名）
# ============================================================

class ChatRequest(BaseModel):
    query: str
    history: List[dict] = []


class ChatResponse(BaseModel):
    code: int = 200
    data: dict


class RiskPoint(BaseModel):
    quote: str
    level: str          # "high" | "medium" | "low"
    bubble_text: str


class ContractAnalysisData(BaseModel):
    raw_text: str
    risk_points: List[RiskPoint]
    chat_reply: str


class ContractAnalysisResponse(BaseModel):
    code: int = 200
    data: ContractAnalysisData


# ============================================================
# Mock 假数据（前端开发期间使用）
# ============================================================

MOCK_CHAT_REPLY = """
根据 **《中华人民共和国民法典》第七百一十二条**，出租人应当履行租赁物的维修义务，但当事人另有约定的除外。

### 分析

您的情况属于典型的出租人怠于履行维修义务。建议采取以下步骤：

1. **书面通知房东**，明确告知漏水情况和维修期限
2. 若房东在合理期限内仍不维修，您可以**自行维修并要求房东承担费用**
3. 若漏水严重影响居住，您有权**要求减免租金**

### 参考法条
- 《民法典》第 712 条
- 《民法典》第 713 条
"""

MOCK_CONTRACT_RAW = """
房屋租赁合同

甲方（出租人）：张三
乙方（承租人）：李四

第一条 租赁期限
租赁期限为 2026 年 7 月 1 日至 2027 年 6 月 30 日。

第二条 租金及支付方式
每月租金 3000 元，乙方应于每月 1 日前支付。

第三条 押金
乙方应支付押金 6000 元。如乙方提前退租，甲方有权没收全部押金并要求额外赔偿。

第四条 物业费
租赁期间的物业费由乙方承担。

第五条 违约责任
若乙方逾期支付租金，每日按租金总额的 5% 支付违约金。
"""

MOCK_RISK_POINTS = [
    {
        "quote": "如乙方提前退租，甲方有权没收全部押金并要求额外赔偿",
        "level": "high",
        "bubble_text": "涉嫌霸王条款。根据《民法典》第 585 条，违约金过高时当事人可请求法院适当减少。"
    },
    {
        "quote": "每日按租金总额的 5% 支付违约金",
        "level": "high",
        "bubble_text": "违约金比例畸高（日 5% 即月 150%）。法律支持的上限一般为实际损失的 30%，建议修改为 0.05%/日。"
    },
    {
        "quote": "租赁期间的物业费由乙方承担",
        "level": "low",
        "bubble_text": "属于常规条款，但建议在附件中明确具体的物业费单价与支付方式。"
    }
]

MOCK_CHAT_ANALYSIS_REPLY = """
## 合同审查总体报告

您好，我已完成对该《房屋租赁合同》的审查。

### 总体评估
该合同**风险较高**，条款明显偏向甲方（出租人），存在 **2 处高风险条款**。

### 风险详情

| 等级 | 条款 | 问题 |
|------|------|------|
| 🔴 高危 | 提前退租没收全部押金 | 违反《民法典》第 585 条，违约金不得过分高于实际损失 |
| 🔴 高危 | 日 5% 违约金 | 年化 1825%，法律支持的上限约为实际损失的 30% |
| ⚪ 低风险 | 物业费由乙方承担 | 常规条款，建议明确费用标准 |

### 修改建议
1. **押金条款**：改为"违约金不超过一个月租金"
2. **违约金条款**：改为"日 0.05%"
3. **增补条款**：补充维修责任、提前解约通知期限等
"""


# ============================================================
# 路由
# ============================================================

@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """法律咨询对话接口（阶段一：返回 Mock 数据）"""
    return ChatResponse(
        code=200,
        data={
            "reply": MOCK_CHAT_REPLY,
            "sources": ["《民法典》第七百一十二条", "《民法典》第七百一十三条"]
        }
    )


@router.post("/analyze_contract", response_model=ContractAnalysisResponse)
async def analyze_contract(file: UploadFile = File(...)):
    """合同审查接口（阶段一：返回 Mock 数据，不读文件）"""
    return ContractAnalysisResponse(
        code=200,
        data=ContractAnalysisData(
            raw_text=MOCK_CONTRACT_RAW,
            risk_points=[RiskPoint(**rp) for rp in MOCK_RISK_POINTS],
            chat_reply=MOCK_CHAT_ANALYSIS_REPLY
        )
    )
