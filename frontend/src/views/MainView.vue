<template>
  <div class="app-layout" :style="{ '--split-ratio': splitRatio }">
    <!-- 左侧：对话区 -->
    <div class="chat-panel" :class="{ 'with-preview': showPreview && !isNarrow, 'hidden-narrow': showPreview && isNarrow }">
      <div class="chat-header">
        <h2>AI 法律助手</h2>
        <span class="subtitle">法律咨询 · 合同审查</span>
      </div>

      <div class="chat-messages" ref="msgContainer">
        <div v-for="(msg, i) in messages" :key="i" :class="['message', msg.role]">
          <div v-if="msg.role === 'user' && msg.file" class="file-badge">
            <el-icon><Document /></el-icon> {{ msg.file.name }}
          </div>
          <div class="message-content" v-html="renderMd(msg.content)" />
          <div v-if="msg.hasContract" class="contract-actions">
            <el-button type="primary" size="small" @click="openContractPreview(msg)">
              <el-icon><View /></el-icon> 查看合同标注
            </el-button>
          </div>
        </div>
        <div v-if="loading" class="message assistant">
          <div class="loading-animation">
            <div class="terminal">
              <div class="terminal-header">
                <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
                <span class="terminal-title">Law-AI 分析引擎</span>
              </div>
              <div class="terminal-body">
                <p v-for="(line, i) in loadingLines" :key="i" class="terminal-line">
                  <span class="prompt">$</span> {{ line }}
                </p>
                <p class="terminal-line cursor"><span class="prompt">$</span> _</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="chat-input-area">
        <div class="input-row">
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            :on-change="handleFileChange"
            accept=".pdf,.doc,.docx,.txt"
          >
            <el-button :icon="Upload" circle :disabled="loading" />
          </el-upload>
          <el-input
            v-model="input"
            type="textarea"
            :rows="2"
            placeholder="输入法律问题，或上传合同文件进行审查..."
            :disabled="loading"
            @keydown.enter.exact.prevent="sendText"
          />
          <el-button type="primary" :icon="Promotion" :disabled="!canSend" @click="sendText" />
        </div>
        <div v-if="pendingFile" class="file-tag">
          <el-tag closable @close="pendingFile = null">{{ pendingFile.name }}</el-tag>
          <el-button type="success" size="small" :loading="loading" @click="sendFile">
            开始审查
          </el-button>
        </div>
      </div>
    </div>

    <!-- 拖拽分隔条 -->
    <div v-if="showPreview" class="split-divider" :class="{ active: dragging }" @mousedown="onDividerDragStart"></div>
    <transition name="slide">
      <div v-if="showPreview" :class="['preview-panel', { 'preview-fullscreen': isNarrow }]">
        <div class="preview-header">
          <span>合同原文 · 风险标注</span>
          <el-button :icon="Close" circle size="small" @click="showPreview = false" />
        </div>
        <div class="preview-body">
          <div class="contract-text" v-html="highlightedContract" @click="onContractClick" @mouseover="onContractHover" @mouseout="onContractLeave" />
        </div>
        <div class="preview-legend">
          <span class="legend-item"><span class="legend-dot high"></span>高风险</span>
          <span class="legend-item"><span class="legend-dot medium"></span>中风险</span>
          <span class="legend-item"><span class="legend-dot low"></span>低风险</span>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Upload, Promotion, Document, View, Close } from '@element-plus/icons-vue'
import { marked } from 'marked'
import { chat as chatApi, analyzeContract } from '../utils/api'
import { renderHighlightedContract } from '../utils/highlight'

// ---- 状态 ----
const messages = ref([
  { role: 'assistant', content: '您好！我是 AI 法律助手。您可以向我咨询法律问题，或上传合同文件进行风险审查。' }
])
const input = ref('')
const pendingFile = ref(null)
const loading = ref(false)
const loadingLines = ref([])
const msgContainer = ref(null)

const showPreview = ref(false)
const previewData = ref(null)
const splitRatio = ref(0.55)
const dragging = ref(false)
const isNarrow = ref(false)
function checkNarrow() { isNarrow.value = window.innerWidth < 700 }
let tooltipEl = null

const LOADING_STEPS = [
  '正在提取合同文本...',
  '解析完成',
  '正在比对《民法典》相关条款...',
  '正在检索相关司法解释...',
  '正在生成审查报告...',
  '正在标注风险条款...',
]

const canSend = computed(() => (input.value.trim() || pendingFile.value) && !loading.value)

// ---- Mock 降级数据 ----
const MOCK_POINTS = [
  { quote: '如乙方提前退租，甲方有权没收全部押金并要求额外赔偿', level: 'high', bubble_text: '涉嫌霸王条款。违约金过高时可请求法院适当减少。' },
  { quote: '每日按租金总额的 5% 支付违约金', level: 'high', bubble_text: '违约金比例畸高（日 5% 即月 150%），建议修改为 0.05%/日。' },
  { quote: '租赁期间的物业费由乙方承担', level: 'low', bubble_text: '属于常规条款，建议明确具体的物业费单价。' },
]

// ---- 渲染 ----
function renderMd(text) {
  if (!text) return ''
  return marked.parse(text)
}

const highlightedContract = computed(() => {
  if (!previewData.value) return ''
  return renderHighlightedContract(previewData.value.raw_text, previewData.value.risk_points)
})

// ---- 滚动 ----
async function scrollToBottom() {
  await nextTick()
  if (msgContainer.value) {
    msgContainer.value.scrollTop = msgContainer.value.scrollHeight
  }
}

// ---- 文本发送 ----
async function sendText() {
  const query = input.value.trim()
  if (!query || loading.value) return

  messages.value.push({ role: 'user', content: query })
  input.value = ''
  loading.value = true
  await scrollToBottom()

  try {
    const history = messages.value
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1)
      .map(m => ({ role: m.role, content: m.content }))
    const res = await chatApi(query, history)
    messages.value.push({ role: 'assistant', content: res.reply })
  } catch (e) {
    messages.value.push({ role: 'assistant', content: '### \u26a0\ufe0f 请求失败\n\n请确认后端服务已启动。' })
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

// ---- 文件选择 ----
function handleFileChange(file) {
  pendingFile.value = file.raw
}

// ---- 合同审查发送 ----
async function sendFile() {
  if (!pendingFile.value || loading.value) return

  messages.value.push({
    role: 'user',
    content: `📄 上传合同：${pendingFile.value.name}`,
    file: pendingFile.value,
  })
  const fileToSend = pendingFile.value
  pendingFile.value = null
  loading.value = true
  await scrollToBottom()

  // 过场动画
  for (const step of LOADING_STEPS) {
    await delay(500 + Math.random() * 800)
    loadingLines.value = [...loadingLines.value, step]
  }

  try {
    const res = await analyzeContract(fileToSend)
    pushContractResult(res)
  } catch (e) {
    const errMsg = e?.response?.data?.detail || e.message || '请确认后端服务已启动。'
    messages.value.push({ role: 'assistant', content: '### ⚠️ 合同审查失败\n\n' + errMsg })
  } finally {
    loading.value = false
    loadingLines.value = []
    await scrollToBottom()
  }
}

function onContractClick(e) {
  const mark = e.target.closest('mark')
  if (!mark) return
  const bubble = mark.dataset.bubble
  if (bubble) {
    ElMessage({
      message: bubble,
      type: mark.dataset.level === 'high' ? 'error' : mark.dataset.level === 'medium' ? 'warning' : 'info',
      duration: 8000,
      showClose: true,
    })
  }
}

// ---- 分隔条拖拽 ----
function onDividerDragStart(e) {
  e.preventDefault()
  dragging.value = true
  const appLayout = document.querySelector('.app-layout')
  if (!appLayout) return
  const startX = e.clientX
  const startRatio = splitRatio.value
  const totalW = appLayout.offsetWidth
  let rafId = null

  // Disable text selection during drag
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'

  function onMove(ev) {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      const dx = ev.clientX - startX
      const newRatio = startRatio + dx / totalW
      splitRatio.value = Math.max(0.25, Math.min(0.75, newRatio))
    })
  }

  function onUp() {
    if (rafId) cancelAnimationFrame(rafId)
    dragging.value = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function onContractHover(e) {
  const mark = e.target.closest('mark')
  if (!mark || !tooltipEl) return
  const bubble = mark.dataset.bubble
  if (!bubble) return
  tooltipEl.textContent = bubble
  tooltipEl.style.display = 'block'
  const rect = mark.getBoundingClientRect()
  // Use preview-panel bounds as the visible area
  const panel = document.querySelector('.preview-panel')
  const panelRect = panel ? panel.getBoundingClientRect() : { left: 0, right: window.innerWidth }
  const tipW = tooltipEl.offsetWidth
  const tipH = tooltipEl.offsetHeight
  const gap = 8
  // Center over mark, clamp within preview panel
  let left = rect.left + rect.width / 2 - tipW / 2
  left = Math.max(panelRect.left + 8, Math.min(left, panelRect.right - tipW - 8))
  let top = rect.top - tipH - gap
  if (top < panelRect.top + 8) {
    top = rect.bottom + gap
  }
  tooltipEl.style.left = left + 'px'
  tooltipEl.style.top = top + 'px'
}

function onContractLeave(e) {
  if (!tooltipEl) return
  tooltipEl.style.display = 'none'
}

onMounted(() => {
  checkNarrow()
  window.addEventListener("resize", checkNarrow)
  tooltipEl = document.createElement('div')
  tooltipEl.className = 'contract-tooltip'
  tooltipEl.style.cssText = 'display:none;position:fixed;z-index:9999;max-width:300px;padding:10px 14px;background:#fff;color:#303133;font-size:13px;line-height:1.6;border-radius:8px;white-space:normal;word-break:break-word;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.15);font-family:"Microsoft YaHei",sans-serif;'
  document.body.appendChild(tooltipEl)
})

onUnmounted(() => {
  window.removeEventListener("resize", checkNarrow)
  if (tooltipEl) {
    tooltipEl.remove()
    tooltipEl = null
  }
})

function pushContractResult(data) {
  messages.value.push({
    role: 'assistant',
    content: data.chat_reply,
    hasContract: true,
    contractData: data,
  })
}

function openContractPreview(msg) {
  previewData.value = msg.contractData
  showPreview.value = true
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* 左侧对话 */
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 400px;
  transition: all 0.3s;
}
.chat-panel.with-preview {
  flex: 0 0 calc(var(--split-ratio) * 100%);
  min-width: 280px;
}
.chat-header {
  padding: 16px 24px;
  background: #1a1a2e;
  color: #fff;
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-shrink: 0;
}
.chat-header h2 {
  margin: 0;
  font-size: 18px;
}
.subtitle {
  font-size: 13px;
  color: #a6adc8;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  background: #f5f7fa;
}
.message {
  margin-bottom: 20px;
}
.message.user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.message.assistant {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.file-badge {
  font-size: 13px;
  color: #909399;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.message-content {
  display: inline-block;
  padding: 12px 16px;
  border-radius: 10px;
  line-height: 1.7;
  font-size: 14px;
}
.message.user .message-content {
  background: #409EFF;
  color: #fff;
  max-width: 75%;
}
.message.assistant .message-content {
  background: #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  max-width: 90%;
}
.contract-actions {
  margin-top: 8px;
}

/* 输入区 */
.chat-input-area {
  padding: 12px 20px;
  background: #fff;
  border-top: 1px solid #ebeef5;
  flex-shrink: 0;
}
.input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.input-row .el-textarea {
  flex: 1;
}
.file-tag {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Loading 终端 */
.loading-animation {
  width: 100%;
  max-width: 480px;
}
.terminal {
  background: #1e1e2e;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 12px rgba(0,0,0,0.2);
}
.terminal-header {
  background: #181825;
  padding: 6px 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot { width: 8px; height: 8px; border-radius: 50%; }
.red  { background: #ff5f56; }
.yellow { background: #ffbd2e; }
.green { background: #27c93f; }
.terminal-title { margin-left: 6px; color: #a6adc8; font-size: 12px; }
.terminal-body { padding: 12px 16px; font-family: 'Consolas', monospace; font-size: 13px; }
.terminal-line { color: #cdd6f4; margin: 2px 0; }
.prompt { color: #a6e3a1; margin-right: 8px; }
.cursor { animation: blink 1s infinite; opacity: 0.6; }
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

/* 右侧预览 */
.split-divider {
  width: 3px;
  cursor: col-resize;
  background: #e4e7ed;
  flex-shrink: 0;
  transition: background 0.2s;
  position: relative;
}
.split-divider::after {
  content: '';
  position: absolute;
  inset: -4px 0;
}
.split-divider:hover,
.split-divider.active {
  background: #a0c4ff;
}

.preview-panel {
  flex: 1;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-left: 1px solid #ebeef5;
  box-shadow: -2px 0 12px rgba(0,0,0,0.06);
}
.preview-header {
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #ebeef5;
  font-weight: 600;
  font-size: 14px;
  flex-shrink: 0;
}
.preview-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}
.contract-text {
  font-family: 'SimSun', '宋体', serif;
  font-size: 15px;
  line-height: 2.2;
  white-space: pre-wrap;
}
.contract-text :deep(mark) {
  padding: 1px 3px;
  border-radius: 2px;
  cursor: pointer;
  transition: background 0.2s;
  position: relative;
}
.contract-text :deep(mark.risk-high)   { background: rgba(220, 80, 80, 0.55); }
.contract-text :deep(mark.risk-medium) { background: rgba(245, 195, 50, 0.50); }
.contract-text :deep(mark.risk-low)    { background: rgba(144, 147, 153, 0.35); }
.contract-text :deep(mark):hover { filter: brightness(0.88); }

.preview-legend {
  padding: 10px 16px;
  border-top: 1px solid #ebeef5;
  display: flex;
  gap: 18px;
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
}
.legend-item { display: flex; align-items: center; gap: 4px; }
.legend-dot { width: 10px; height: 10px; border-radius: 2px; }
.legend-dot.high   { background: rgba(220, 80, 80, 0.85); }
.legend-dot.medium { background: rgba(245, 195, 50, 0.85); }
.legend-dot.low    { background: rgba(144, 147, 153, 0.65); }

/* 右侧滑入动画 */
.slide-enter-active, .slide-leave-active { transition: all 0.3s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); opacity: 0; }

/* ---- 响应式：窄屏 ---- */
.chat-panel.hidden-narrow {
  display: none !important;
}
.preview-panel.preview-fullscreen {
  flex: 1 1 100% !important;
  min-width: 0 !important;
}
.split-divider {
  display: block;
}
@media (max-width: 699px) {
  .split-divider {
    display: none;
  }
  .chat-panel.hidden-narrow {
    display: none !important;
  }
}
</style>
