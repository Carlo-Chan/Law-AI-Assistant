# AI 法律咨询与合同分析系统

[![Backend CI](https://github.com/Carlo-Chan/Law-AI-Assistant/actions/workflows/backend.yml/badge.svg?branch=main)](https://github.com/Carlo-Chan/Law-AI-Assistant/actions/workflows/backend.yml)
[![Frontend CI](https://github.com/Carlo-Chan/Law-AI-Assistant/actions/workflows/frontend.yml/badge.svg?branch=main)](https://github.com/Carlo-Chan/Law-AI-Assistant/actions/workflows/frontend.yml)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)

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
| Node.js | 20.19+ / 22.13+ / 24+ | 前端运行与开发工具链，需满足 `frontend/package.json` 中的 engines 约束 |
| DeepSeek API Key | — | 核心推理引擎，[获取地址](https://platform.deepseek.com/) |
| Tavily API Key | — | 联网搜索（免费额度 1000 次/月），[获取地址](https://tavily.com/) |
| 元典智库 API Key | — | 法律专业检索，[注册地址](https://open.chineselaw.com/) |

> 以上三个 API Key 缺一不可。Tavily 和元典智库不配置也不会报错，但检索效果会严重下降。

## 项目结构

```
Law-AI-Assistant/
├── .github/workflows/           # 前后端自动检查与测试
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口，CORS 配置
│   │   ├── init_db.py           # ChromaDB 法律向量库初始化
│   │   ├── agent/
│   │   │   ├── chain.py         # LangChain Agent 编排，流式对话 / 合同审查链
│   │   │   ├── retriever.py     # ChromaDB 向量检索 + BM25 + ArticleMap 精确匹配
│   │   │   └── tools.py         # 4 个 LangChain @tool 定义
│   │   ├── api/
│   │   │   └── routes.py        # RESTful 接口 + SSE 流式路由
│   │   ├── core/
│   │   │   ├── config.py        # 全局配置（API Key / 模型参数 / 路径）
│   │   │   └── logging.py       # 应用日志配置与安全异常格式
│   │   └── services/
│   │       ├── history.py       # SQLite 会话与消息 CRUD
│   │       ├── parser.py        # PDF / Word 文档文本提取
│   │       └── uploads.py       # 合同上传大小校验与有限读取
│   ├── data/                    # SQLite 数据库 + 法律文本 Markdown 源文件
│   ├── .env.example             # 环境变量模板
│   ├── tests/                   # 后端自动化测试
│   ├── pyproject.toml           # Ruff 检查与格式化配置
│   ├── pytest.ini               # 测试收集与异步配置
│   ├── requirements.txt         # Python 运行依赖
│   └── requirements-dev.txt     # 开发与测试依赖
├── frontend/
│   ├── src/
│   │   ├── main.js              # 应用入口，Element Plus 注册
│   │   ├── App.vue              # 根组件
│   │   ├── views/
│   │   │   └── MainView.vue     # 主页面（对话区 / 侧边栏 / 合同预览）
│   │   ├── utils/
│   │   │   ├── api.js           # 前端 API 封装
│   │   │   ├── highlight.js     # 合同高亮匹配与原文安全标记
│   │   │   ├── html.js          # Markdown 净化与纯文本转义
│   │   │   └── upload.js        # 合同上传大小校验与提示
│   │   └── composables/
│   │       ├── useTypewriter.js # 打字机队列
│   │       ├── useSearch.js     # 拼音模糊搜索
│   │       ├── useTextTools.js  # 复制（纯文本 / Markdown）
│   │       └── messageExport.js # 消息导出
│   ├── tests/                  # 前端 HTML 安全回归测试
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

## 后端开发检查

在 `backend/` 目录中激活虚拟环境后，安装开发依赖并执行：

```bash
pip install -r requirements-dev.txt
python -m ruff check .
python -m ruff format . --check
python -m pytest
```

需要统一代码格式时运行 `python -m ruff format .`。Ruff 以 Python 3.10 为兼容目标、行宽为 100，排除虚拟环境、`eval/`、数据与向量库目录。

测试使用临时数据库和占位 API Keys，禁用 `.env` 读取及外部服务连接，无需启动 Ollama 或配置真实 API Keys。Windows 事件循环内部通信所需的套接字对保留可用。

### 后端日志

后端通过标准库 logging 输出应用日志，在 `backend/.env` 中设置 `APP_LOG_LEVEL` 后重启服务即可生效，默认为 `INFO`，可选 `DEBUG`、`WARNING`、`ERROR`、`CRITICAL`。

- `INFO`：咨询与审查的开始、完成，以及输入长度、风险点数量等元数据。
- `DEBUG`：工具名称、召回数量、JSON 修复及流式阶段等详细追踪，不记录咨询正文、模型回复、工具参数或合同内容。
- `WARNING`：检索服务降级、引用匹配失败、历史思维链格式损坏等可恢复问题。
- `ERROR`：请求处理失败、数据库操作异常或审查 JSON 无法解析等问题。

应用日志统一写入标准错误流，包含时间、级别和模块名；重复初始化不会增加控制台处理器，也不接管 Uvicorn 或第三方库的日志配置。应用控制台的异常输出保留异常类型、文件、行号及异常链，省略异常消息、源码行和局部变量，避免第三方异常携带敏感正文或 API Keys。此保护仅覆盖应用自己的控制台输出，不等于日志中的任意字符串都已自动脱敏，也不改变现有 API 错误响应。

`python -m app.init_db` 的命令行进度输出仍保留，未将其作为服务请求日志改造；日志文件持久化、轮转及收集可在部署时另行配置。

## 前端开发检查

在 `frontend/` 目录中执行：

```bash
npm ci
npm run lint
npm run format:check
npm test
npm run build
```

ESLint 检查 JavaScript 常见错误和 Vue 模板必要规则，Prettier 负责格式统一；通过 `eslint-config-prettier` 避免规则冲突。需要格式化时运行 `npm run format`。格式化保留模板空白语义，并沿用文件现有换行符以兼容 Windows 与 Git 的换行转换。

前端回归测试使用 Node.js 内置测试运行器与 jsdom，离线检查 Markdown 注入载荷、流式未闭合片段、合同原文转义、高亮坐标和气泡元数据，不访问真实后端或外部资源。

## 持续集成

推送到 `main`、创建或更新 Pull Request 时，GitHub Actions 会分别运行后端与前端检查，也可在 Actions 页面手动触发。两个工作流均使用只读仓库权限，官方 Actions 固定到完整提交 SHA；同一分支或 PR 的旧运行会在新运行开始时取消。

| 工作流 | 环境 | 检查内容 |
|--------|------|---------|
| Backend CI | Ubuntu / Python 3.13 | 安装开发依赖、`pip check`、Ruff 检查与格式校验、pytest |
| Frontend CI | Ubuntu / Node.js 24 | `npm ci`、ESLint、Prettier 格式校验、HTML 安全回归测试、生产构建 |

后端测试不需要 GitHub Secrets、真实 API Keys、Ollama 或预先构建的向量库；数据库与外部调用由测试配置隔离。安装依赖仍需要网络，依赖下载缓存由工作流自动管理。CI 仅检查和构建，不会自动部署或修改业务数据。

README 顶部的 CI 徽章展示 `main` 分支实际运行结果，新增工作流首次推送并运行之前不会显示成功状态。Python / Vue 徽章只标注项目技术版本，不代表全版本兼容测试；License 徽章待正式添加许可证后再补充。

## 使用方式

1. **法律问答**：在输入框输入法律问题（如"民法典第 585 条是什么""试用期被辞退有赔偿吗"），按回车或点击发送按钮
2. **合同审查**：点击输入框左侧 + 按钮上传 PDF 或 Word 合同文件，可选输入审查指令（如"帮我审查这份租房合同"），点击发送
3. **查看报告**：审查完成后左侧显示结构化报告，右侧同步展示合同原文的高亮标注。鼠标悬停高亮区域查看风险详情，点击可钉住气泡
4. **思维链**：点击回复上方的思维链标题可展开 / 收起 AI 的工具调用与推理过程
5. **对话管理**：左侧侧边栏支持搜索（拼音首字母 / 全拼 / 中文模糊）、重命名（行内编辑，回车保存）、删除对话
6. **消息操作**：鼠标悬停消息气泡，LLM 回复可复制（纯文本 / Markdown）、重新生成、删除；用户消息可复制、编辑、删除

### 合同上传限制

单个合同文件最大 **10 MiB（10 × 1024 × 1024 字节）**，恰好达到上限允许上传。选择超限文件会在导航栏下方显示浅暖白圆角警告提示，约 3 秒后自动消失，不替换原先已选附件，也不清空输入草稿；发送前会再次校验。

后端普通与流式审查接口均独立检查文件大小，最多读取上限加一字节，避免缺失或不准确的大小元数据绕过检查。超限返回 HTTP `413` 及中文提示，不进入文档解析或模型调用；流式接口在开始 SSE 前拒绝请求，前端会识别 HTTP 错误并显示提示。

该限制是单文件业务校验，不是整个 HTTP 请求的接收上限。multipart 解析阶段仍可能将文件写入临时目录；公开部署时还应在反向代理或网关设置请求体大小、并发等资源限制。

### 动态内容安全边界

用户消息、历史消息和模型回复的 Markdown 在解析后通过 DOMPurify 白名单净化，保留标题、列表、表格、代码块等常用格式，移除脚本、事件属性、危险链接、表单和自定义样式。正文不能借用页面布局类名，代码块可保留语言标记。此处理仅影响展示，不改写数据库内容或 Markdown 复制结果。

合同原文始终按纯文本转义，不将文档中的 HTML 当成标签执行；高亮先在原文上定位，再转义对应文本，避免实体字符长度变化影响坐标。仅由应用生成 `mark`、风险等级和气泡属性，气泡通过 `textContent` 显示，保留文字选择及复制。

这不是完整的公开部署安全方案：正常图片和链接仍可指向外部地址；身份认证、访问控制、请求资源限制及部署层安全策略需另行配置。

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
| Markdown 渲染与净化 | marked + DOMPurify |
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
