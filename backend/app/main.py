"""
Law-AI-Assistant 后端入口
启动命令：uvicorn app.main:app --reload --port 8000
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.api.routes import router as api_router

settings = get_settings()

app = FastAPI(
    title="Law-AI-Assistant",
    description="AI 法律咨询与合同分析系统",
    version="0.1.0",
)

# CORS 跨域配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.app_cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(api_router, prefix="/api")




@app.get("/health")
async def health_check():
    return {"status": "ok", "version": "0.1.0"}
