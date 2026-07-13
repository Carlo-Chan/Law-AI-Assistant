# AI 法律咨询与合同分析系统

基于 LangChain + DeepSeek V4 的多路召回智能法律助手，支持法律知识问答与合同风险自动审查。

## 功能简介

- **法律智能问答**：自然语言提问，Agent 自动检索法规库并生成带法条引用的专业回复
- **合同风险审查**：上传 PDF / Word 合同，自动逐条分析并输出结构化审查报告（高/中/低风险等级 + 修改建议）
- **风险条款可视化**：合同原文中以红 / 黄 / 灰三色高亮标注风险点，悬停查看详情、点击钉住修改建议
- **对话历史管理**：支持创建、切换、搜索（拼音模糊匹配）、重命名、删除对话，本地 SQLite 持久化
- **流式交互**：逐字打字机输出、思维链可视化、随时停止生成、多对话并发隔离

## 环境依赖

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Python | 3.10+ | 后端运行环境 |
| Node.js | 18+ | 前端构建工具链 |
| DeepSeek API Key | — | 核心推理引擎，[获取地址](https://platform.deepseek.com/) |
| Tavily API Key | — | 联网搜索（免费额度 1000 次/月），[获取地址](https://tavily.com/) |
| 元典智库 API Key | — | 法律专业检索，[注册地址](https://open.chineselaw.com/) |

> 以上三个 API Key 缺一不可。Tavily 和元典智库不配置也不会报错，但检索效果会严重下降。

## 项目结构

```
Law-AI-Assistant/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口，CORS 配置
│   │   ├── init_db.py           # SQLite 数据库初始化建表
│   │   ├── agent/
│   │   │   ├── chain.py         # LangChain Agent 编排，流式对话 / 合同审查链
│   │   │   ├── retriever.py     # ChromaDB 向量检索 + BM25 + ArticleMap 精确匹配
│   │   │   └── tools.py         # 4 个 LangChain @tool 定义
│   │   ├── api/
│   │   │   └── routes.py        # RESTful 接口 + SSE 流式路由
│   │   ├── core/
│   │   │   └── config.py        # 全局配置（API Key / 模型参数 / 路径）
│   │   └── services/
│   │       ├── history.py       # SQLite 会话与消息 CRUD
│   │       └── parser.py        # PDF / Word 文档文本提取
│   ├── data/                    # SQLite 数据库 + 法律文本 Markdown 源文件
│   ├── .env.example             # 环境变量模板
│   └── requirements.txt         # Python 依赖
├── frontend/
│   ├── src/
│   │   ├── main.js              # 应用入口，Element Plus 注册
│   │   ├── App.vue              # 根组件
│   │   ├── views/
│   │   │   └── MainView.vue     # 主页面（对话区 / 侧边栏 / 合同预览）
│   │   ├── components/
│   │   │   ├── ChatInput.vue    # 输入框（文本 / 文件上传 / 发送 / 停止）
│   │   │   ├── ChatMessage.vue  # 消息气泡（Markdown 渲染 / 复制 / 重生成 / 编辑）
│   │   │   ├── ContractPreview.vue  # 合同预览（高亮 / 气泡 / 钉住）
│   │   │   ├── Sidebar.vue      # 侧边栏（搜索 / 重命名 / 删除）
│   │   │   └── WelcomeScreen.vue    # 新对话欢迎页
│   │   ├── utils/
│   │   │   ├── api.js           # 前端 API 封装
│   │   │   └── highlight.js     # 合同高亮算法（LCS 匹配 / mark 标签 / 重叠合并）
│   │   └── composables/
│   │       ├── useTypewriter.js # 打字机队列
│   │       ├── useSearch.js     # 拼音模糊搜索
│   │       ├── useTextTools.js  # 复制（纯文本 / Markdown）
│   │       └── messageExport.js # 消息导出
│   └── package.json
├── README.md
└── .gitignore
```

## 快速启动

### 1. 克隆并进入项目

```bash
cd Law-AI-Assistant
```

### 2. 配置 API Key

```bash
cd backend
cp .env.example .env
```

编辑 `.env`，填入三个 API Key：

```env
DEEPSEEK_API_KEY=sk-xxxxxxxx
TAVILY_API_KEY=tvly-xxxxxxxx
YUANDIAN_API_KEY=xxxxxxxx
```

### 3. 启动后端

```bash
cd backend
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # macOS / Linux

pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 初始化数据库（首次运行必须执行）
python -m app.init_db

# 启动服务
uvicorn app.main:app --reload --port 8000
```

后端启动后访问 http://localhost:8000/docs 可查看 Swagger 接口文档。

### 4. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端启动后访问 http://localhost:5173 即可使用。

## 使用方式

1. **法律问答**：在输入框输入法律问题（如"民法典第 585 条是什么""试用期被辞退有赔偿吗"），按回车或点击发送按钮
2. **合同审查**：点击输入框左侧 + 按钮上传 PDF 或 Word 合同文件，可选输入审查指令（如"帮我审查这份租房合同"），点击发送
3. **查看报告**：审查完成后左侧显示结构化报告，右侧同步展示合同原文的高亮标注。鼠标悬停高亮区域查看风险详情，点击可钉住气泡
4. **思维链**：点击回复上方的思维链标题可展开 / 收起 AI 的工具调用与推理过程
5. **对话管理**：左侧侧边栏支持搜索（拼音首字母 / 全拼 / 中文模糊）、重命名（行内编辑，回车保存）、删除对话
6. **消息操作**：鼠标悬停消息气泡，LLM 回复可复制（纯文本 / Markdown）、重新生成、删除；用户消息可复制、编辑、删除

## 技术栈

| 层级 | 技术 |
|------|------|
| 大模型 | DeepSeek V4 API |
| AI 框架 | LangChain（Agent + Tool + astream_events） |
| 向量数据库 | ChromaDB（PersistentClient 本地持久化） |
| 稀疏检索 | BM25（rank-bm25） |
| 后端框架 | FastAPI（RESTful + SSE 流式） |
| 数据库 | SQLite（history.db） |
| 文档解析 | pdfplumber + python-docx |
| 前端框架 | Vue 3 + Vite |
| UI 组件库 | Element Plus |
| Markdown 渲染 | marked |
| 拼音匹配 | pinyin-pro |

## 常见问题

**Q: 启动后端时报错 `ModuleNotFoundError`？**
A: 确认已激活虚拟环境并执行 `pip install -r requirements.txt`。

**Q: 合同审查返回"⚠️ 合同审查失败"？**
A: 通常是因为 DeepSeek API Key 未配置或额度耗尽，检查 `.env` 文件。

**Q: 法律问答搜不到某条法条？**
A: 当前向量模型为 Qwen3-Embedding-8B Q4 量化版，部分精确查询依赖 BM25 和 ArticleMap 兜底。如仍检索不到，可能是该法条未包含在 data/ 目录的法律文本中。

**Q: 前端页面空白？**
A: 确认后端已启动（http://localhost:8000/docs 可访问），且前端 Vite 代理配置正确。
