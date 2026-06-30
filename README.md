# Law-AI-Assistant

AI 法律咨询与合同分析系统 —— 软件工程项目进阶实践

---

## 技术栈

| 层 | 技术 |
|---|---|
| 大模型 | DeepSeek V4 API |
| AI 编排 | LangChain (Agent + Tool Calling + RAG) |
| 向量库 | ChromaDB (本地持久化) |
| 后端 | Python 3.10+ / FastAPI |
| 前端 | Vue 3 + Element Plus + Vite |
| 文档解析 | pdfplumber / python-docx |
| 数据存储 | SQLite |

---

## 🚀 快速启动（见下方分步计划）

```bash
# 后端
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
cp .env.example .env          # 填入真实 API Key
python app/init_db.py          # 初始化 Chroma 向量库
uvicorn app.main:app --reload  # http://localhost:8000

# 前端
cd frontend
npm install
npm run dev                    # http://localhost:5173
```

---

## ⏱ 单人 6 步执行计划（6/30 下午 ~ 7/3 中期检查）

每个步骤标明了目标、操作和验证标准。按顺序执行，不要跳步。

---

### 第 1 步：环境准备（30 分钟）

**目标**：Python 虚拟环境和 Node.js 就绪。

`ash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
cp .env.example .env
`

编辑 ackend/.env，填入 DEEPSEEK_API_KEY。元典智库和 Tavily 的 Key 可以中期后再补。

`ash
cd frontend
npm install
`

✅ **验证**：pip list | grep fastapi 和 
pm list vue 正常输出。

---

### 第 2 步：后端 Mock 接口跑通（30 分钟）

**目标**：FastAPI 返回假数据，Swagger 文档可访问。

`ash
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload
`

✅ **验证**：
- 浏览器打开 http://localhost:8000/docs ，看到 Swagger 接口文档
- 在 Swagger 中测试 POST /api/chat：{"query":"测试"}
- 在 Swagger 中测试 POST /api/analyze_contract：上传任意 PDF 文件（Mock 阶段不读文件内容）

---

### 第 3 步：前端骨架跑通（1 小时）

**目标**：Chat 和 Contract 两个页面正常渲染，能调通后端 Mock 接口。

`ash
cd frontend
npm run dev
`

✅ **验证**：
- http://localhost:5173 打开，看到深色导航栏 + "法律咨询"和"合同审查"两个标签
- Chat 页面：发送消息，收到 Mock 的法律回复
- Contract 页面：上传文件 → 点击"开始审查" → 终端过场动画 → 双视窗出现（高亮 + 气泡）
- 如果后端未启动，Contract 页面有**内置 Mock 降级**，仍可演示

---

### 第 4 步：ChromaDB 灌库 + RAG 验证（2 小时）

**目标**：法律文本切片后灌入本地向量库，能跑通语义检索。

首先获取法律文本数据：

`ash
cd backend/data
git clone https://github.com/lawtext/laws.git .
# 或者手动下载民法典.md、劳动法.md 等放入此目录
`

然后运行灌库脚本：

`ash
cd backend
venv\Scripts\activate
python app/init_db.py
`

✅ **验证**：终端输出"知识库就绪"，并看到 3 条相似度查询结果。

---

### 第 5 步：Agent 三引擎串联（3 小时）

**目标**：用真实 LangChain + DeepSeek 替换 Mock 数据。

按顺序编写三个文件：

| 文件 | 内容 | 说明 |
|------|------|------|
| ackend/app/agent/retriever.py | ChromaDB 检索器 | 读取已灌好的向量库 |
| ackend/app/agent/tools.py | 自定义 Tool | @tool 装饰器封装 Tavily 搜索 |
| ackend/app/agent/chain.py | Agent 执行链 | 组装 Prompt + Tools + LLM，导出 
un_chat() 和 
un_contract_analysis() |

然后修改 ackend/app/api/routes.py，把 chat() 和 nalyze_contract() 中的 Mock 替换为：

`python
from app.agent.chain import run_chat, run_contract_analysis
from app.services.parser import DocumentParser

# chat 接口：替换 Mock
result = await run_chat(request.query, request.history)
return ChatResponse(code=200, data=result)

# analyze_contract 接口：替换 Mock
raw_text = DocumentParser.parse(await file.read(), file.filename)
result = await run_contract_analysis(raw_text)
return ContractAnalysisResponse(code=200, data=result)
`

✅ **验证**：前端 Chat 页面发送真实问题，返回带法条出处的回复。

---

### 第 6 步：收尾 + 中期检查表（2 小时）

**目标**：确保演示流程流畅，填写中期检查表。

- [ ] 前端 Chat 页面：3 轮法律问答正常
- [ ] 前端 Contract 页面：上传 → 过场动画 → 双视窗报告 → 高亮标注 → 气泡提示
- [ ] 至少 1 份真实合同能跑通全流程
- [ ] 用手机录一段 1 分钟屏幕录像（备用）
- [ ] 填写中期检查表：进度、困难、下一步计划
- [ ] **7/3 17:00 前**发邮件：软工项目进阶实践-中期检查表-陈浩文

---

## 📁 目录结构

`
Law-AI-Assistant/
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   └── routes.py          # API 路由（Mock → Agent 替换）
│   │   ├── core/
│   │   │   └── config.py          # 环境变量配置
│   │   ├── agent/                 # LangChain 核心（中期后填充）
│   │   │   ├── retriever.py       # ChromaDB 检索器
│   │   │   ├── tools.py           # 自定义 Tool（Tavily/元典）
│   │   │   └── chain.py           # Agent 执行链
│   │   ├── services/
│   │   │   └── parser.py          # 文档解析（PDF/Word → 纯文本）
│   │   ├── main.py                # FastAPI 入口
│   │   └── init_db.py             # ChromaDB 灌库脚本
│   ├── data/                      # 法律 Markdown 文本
│   ├── chroma_db/                 # 向量库持久化（.gitignore）
│   ├── .env.example               # 环境变量模板
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── views/
│   │   │   ├── Chat.vue           # 法律问答页面
│   │   │   └── Contract.vue       # 合同审查双视窗页面
│   │   ├── utils/
│   │   │   ├── api.js             # 后端 API 封装
│   │   │   └── highlight.js       # 模糊匹配高亮算法
│   │   ├── App.vue
│   │   └── main.js
│   ├── package.json
│   └── vite.config.js            # 含 API 代理配置
├── .gitignore
└── README.md
`

---

## 📋 课程交付件清单

| 序号 | 交付件 | 格式 | 截止 |
|------|--------|------|------|
| 1 | 项目立项书 | PDF | 6/30 17:00 ✅ |
| 2 | 中期检查表 | 邮件 | 7/3 17:00 |
| 3 | 项目报告 | PDF | 7/9 23:00 |
| 4 | 项目源代码 | ZIP | 7/9 23:00 |
| 5 | 演示视频 | MP4 | 7/9 23:00 |
| 6 | 汇报 PPT | PDF | 7/9 23:00 |

邮件主题：软工项目进阶实践-项目成果-陈浩文

---

## ⚠️ 重要提醒

- .env 文件**绝对不能提交到 Git**
- chroma_db/ 目录已加入 .gitignore
- Contract 页面内置 Mock 降级：后端宕机也能演示 UI
