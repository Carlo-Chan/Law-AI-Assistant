# Law-AI-Assistant

AI 法律咨询与合同分析系统

## 环境依赖

- Python 3.10+
- Node.js 18+
- DeepSeek API Key

## 快速启动

### 后端

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
cp .env.example .env          # 编辑填入 API Key
uvicorn app.main:app --reload  # http://localhost:8000
```

### 前端

```bash
cd frontend
npm install
npm run dev                    # http://localhost:5173
```

## 项目结构

```
Law-AI-Assistant/
├── backend/
│   ├── app/
│   │   ├── api/          # API 路由
│   │   ├── core/         # 配置
│   │   ├── agent/        # LangChain 智能体
│   │   └── services/     # 业务服务
│   └── data/             # 数据文件
├── frontend/
│   └── src/
│       ├── views/        # 页面组件
│       └── utils/        # 工具函数
└── .gitignore
```
