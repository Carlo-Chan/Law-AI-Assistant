<template>
  <div class="app-layout" :style="{ '--split-ratio': splitRatio }">
    <!-- 侧边栏 -->
    <transition name="sidebar-slide">
      <div v-if="sidebarVisible" class="sidebar" :class="{ 'sidebar-overlay': forceSidebar }">
        <div class="sidebar-header">
          <el-input v-model="searchText" placeholder="搜索对话..." size="small" clearable />
          <el-button :icon="ArrowLeft" circle size="small" @click="sidebarOpen = false; forceSidebar = false" />
        </div>
        <el-button type="primary" class="new-chat-btn" @click="newChat">
          <el-icon><Plus /></el-icon> 开启新对话
        </el-button>
        <div class="conv-list">
          <div
            v-for="conv in filteredConvs"
            :key="conv.id"
            :class="['conv-item', { active: conv.id === currentConvId }]"
            @click="loadConversation(conv.id)"
          >
            <span v-if="renamingConvId !== conv.id" class="conv-title">{{ conv.title }}</span>
            <input
              v-else
              v-model="renameText"
              class="conv-title-input"
              @keydown.enter.prevent="finishRename(conv.id)"
              @keydown.esc.prevent="cancelRename"
              @blur="finishRename(conv.id)"
              @click.stop
              ref="renameInput"
            />
            <el-dropdown v-if="renamingConvId !== conv.id" trigger="click" @command="(cmd) => cmd === 'rename' ? startRename(conv.id) : handleDeleteConv(conv.id)" @visible-change="(v) => sidebarMenuConvId = v ? conv.id : null">
              <span :class="['conv-more', { 'conv-more-visible': sidebarMenuConvId === conv.id }]" @click.stop><el-icon><MoreFilled /></el-icon></span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename">
                    <el-icon><Edit /></el-icon> 重命名
                  </el-dropdown-item>
                  <el-dropdown-item command="delete">
                    <el-icon><Delete /></el-icon> 删除
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <div v-if="!filteredConvs.length" class="conv-empty">暂无历史对话</div>
        </div>
      </div>
    </transition>
    <div class="main-area">
    <!-- 左侧：对话区 -->
    <div class="chat-panel" :class="{ 'with-preview': showPreview && !isNarrow, 'hidden-narrow': showPreview && isNarrow }">
      <div class="chat-header">
        <template v-if="!sidebarVisible">
          <el-button :icon="Expand" circle size="small" class="toggle-btn" @click="sidebarOpen = true; forceSidebar = isNarrow" />
          <el-button size="small" class="new-chat-header-btn" @click="newChat">
            <el-icon><Plus /></el-icon> 新对话
          </el-button>
        </template>
        <h2>AI 法律助手</h2>
        <span class="subtitle">法律咨询 · 合同审查</span>
      </div>

      <div v-if="messages.length === 0" class="welcome-screen">
        <div class="welcome-content">
          <h1>AI 法律助手</h1>
          <p>您可以向我咨询法律问题，或上传合同文件进行风险审查</p>
        </div>
      </div>
      <div v-else class="chat-messages" ref="msgContainer" @scroll="onMsgScroll">
        <div v-for="(msg, i) in messages" :key="i" :class="['message', msg.role]">
          <div v-if="msg.role === 'user' && editingIndex === i" class="edit-inline">
            <div class="edit-inline-wrapper">
              <el-input
                v-model="editingText"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 12 }"
                @keydown.esc="cancelEdit"
              />
              <div class="edit-actions">
                <el-button size="small" text @click="cancelEdit">取消</el-button>
                <el-button size="small" type="primary" @click="saveEdit(i)">保存</el-button>
              </div>
            </div>
          </div>
          <template v-else>
          <div v-if="msg.role === 'user' && msg.file" class="file-badge">
            <el-icon><Document /></el-icon> {{ msg.file.name }}
          </div>
          <!-- thinking chain: live during streaming, or persisted -->
          <div v-if="msg.role === 'assistant' && i === messages.length - 1 && loading && currentConvId === activeStreamConvId" class="thinking-chain">
            <div class="thinking-summary" @click="thinkingExpanded = !thinkingExpanded">
              <span class="thinking-dot" />
              <span>{{ thinkingLabel }}</span>
              <span class="thinking-arrow">{{ thinkingExpanded ? '∨' : '>' }}</span>
            </div>
            <div v-if="thinkingExpanded" class="thinking-details">
              <div v-for="(step, si) in thinkingSteps" :key="si" class="thinking-step">
                <span class="thinking-step-icon">{{ step.type === 'tool' ? '🔍' : step.type === 'reasoning' ? '💬' : '✅' }}</span>
                <span class="thinking-step-text">{{ cleanFences(step.label) }}{{ step.snippet ? '：\n' + step.snippet : '' }}</span>
              </div>
            </div>
          </div>
          <div v-else-if="msg.thinkingChain?.length" class="thinking-chain">
            <div class="thinking-summary persisted" @click="msg.thinkingExpanded = !msg.thinkingExpanded">
              <span>{{ msg.thinkingChain.filter(s => s.type === 'tool' || s.type === 'reasoning').length }} 次思考步骤</span>
              <span class="thinking-arrow">{{ msg.thinkingExpanded ? '∨' : '>' }}</span>
            </div>
            <div v-if="msg.thinkingExpanded" class="thinking-details">
              <div v-for="(step, si) in msg.thinkingChain" :key="si" class="thinking-step">
                <span class="thinking-step-icon">{{ step.type === 'tool' ? '🔍' : step.type === 'reasoning' ? '💬' : '✅' }}</span>
                <span class="thinking-step-text">{{ cleanFences(step.label) }}{{ step.snippet ? '：\n' + step.snippet : '' }}</span>
              </div>
            </div>
          </div>
          <div class="message-content" v-html="renderMd(msg.content)" />
          </template>
          <div v-if="msg.role === 'assistant' && editingIndex === -1" :class="['msg-actions', 'msg-actions-left', { 'msg-actions-visible': dropdownOpenIndex === i }]">
            <el-dropdown trigger="click" @command="(cmd) => copyMessage(i, cmd === 'md')" @visible-change="(v) => dropdownOpenIndex = v ? i : -1">
              <span class="action-btn" title="复制"><el-icon><CopyDocument /></el-icon></span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="text">复制纯文本</el-dropdown-item>
                  <el-dropdown-item command="md">复制 Markdown</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <span class="action-btn" title="重新生成" @click="regenerateMessage(i)"><el-icon><Refresh /></el-icon></span>
            <span class="action-btn" title="删除" @click="deleteMessage(i)"><el-icon><Delete /></el-icon></span>
          </div>
          <div v-if="msg.role === 'user' && editingIndex !== i" :class="['msg-actions', 'msg-actions-right', { 'msg-actions-visible': dropdownOpenIndex === i }]">
            <el-dropdown trigger="click" @command="(cmd) => copyMessage(i, cmd === 'md')" @visible-change="(v) => dropdownOpenIndex = v ? i : -1">
              <span class="action-btn" title="复制"><el-icon><CopyDocument /></el-icon></span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="text">复制纯文本</el-dropdown-item>
                  <el-dropdown-item command="md">复制 Markdown</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <span class="action-btn" title="编辑" @click="editMessage(i)"><el-icon><Edit /></el-icon></span>
            <span class="action-btn" title="删除" @click="deleteMessage(i)"><el-icon><Delete /></el-icon></span>
          </div>
          <div v-if="msg.contractRawText" class="contract-actions">
            <el-button type="primary" size="small" @click="openContractPreview(msg)">
              <el-icon><View /></el-icon> 查看合同标注
            </el-button>
          </div>
        </div>
      </div>

      <div class="chat-input-area">
        <transition name="fade">
          <div v-if="showScrollBtn" class="scroll-bottom-btn" @click="scrollToBottom">
            <el-icon><ArrowDown /></el-icon>
          </div>
        </transition>
        <div v-if="pendingFile" class="file-tag">
          <el-tag closable @close="pendingFile = null">{{ pendingFile.name }}</el-tag>
        </div>
        <div class="input-row">
          <div class="input-wrapper">
            <el-input
              v-model="input"
              type="textarea"
              :rows="2"
              placeholder="输入法律问题，或上传合同文件进行审查..."
              :disabled="loading"
              @keydown.enter.exact.prevent="handleSend"
            />
            <div class="input-actions">
              <el-upload
                :auto-upload="false"
                :show-file-list="false"
                :on-change="handleFileChange"
                accept=".pdf,.doc,.docx,.txt"
              >
                <el-button :icon="Upload" circle size="small" :disabled="loading" />
              </el-upload>
              <el-button v-if="!loading" type="primary" :icon="Promotion" size="small" :disabled="!canSend" @click="handleSend" />
              <el-button v-else type="danger" :icon="VideoPause" size="small" @click="handleSend" />
            </div>
          </div>
        </div>
      </div>
      <div v-if="frostedOverlay" class="frosted-overlay" @click="sidebarOpen = false; forceSidebar = false" />
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
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Upload, Promotion, Document, View, Close, ArrowLeft, Plus, Delete, Expand, VideoPause, CopyDocument, Refresh, Edit, MoreFilled, ArrowDown } from '@element-plus/icons-vue'
import { marked } from 'marked'
import { chat as chatApi, analyzeContract, listConversations, createConversation, getConversation, deleteConversation, saveMessages, updateConvTitle, chatStream, analyzeContractStream, rebuildMessages } from '../utils/api'
import { renderHighlightedContract } from '../utils/highlight'

// ---- 状态 ----
const messages = ref([])
const input = ref('')
const pendingFile = ref(null)
const loading = ref(false)
const abortController = ref(null)
const editingIndex = ref(-1)
const editingText = ref('')
const dropdownOpenIndex = ref(-1)
const sidebarMenuConvId = ref(null)
const renamingConvId = ref(null)
const renameText = ref('')
const activeStreamConvId = ref(null)
const streamMessageCache = ref(null)
const thinkingSteps = ref([])
const thinkingExpanded = ref(false)

const thinkingLabel = computed(() => {
  if (thinkingSteps.value.length === 0) return '正在思考...'
  const last = thinkingSteps.value[thinkingSteps.value.length - 1]
  if (last.type === 'tool') return '正在搜索：' + last.label + '...'
  if (last.type === 'reasoning') return '正在分析：' + last.label.slice(0, 20) + '...'
  return '思考中…'
})
const msgContainer = ref(null)
const showScrollBtn = ref(false)

function onMsgScroll() {
  const el = msgContainer.value
  if (!el) return
  showScrollBtn.value = el.scrollHeight - el.scrollTop - el.clientHeight > 100
}

const showPreview = ref(false)
const previewData = ref(null)

// ---- 侧边栏 & 历史 ----
const sidebarOpen = ref(false)
const conversations = ref([])
const currentConvId = ref(null)
const searchText = ref('')
const forceSidebar = ref(false)
const sidebarFits = ref(true)
const sidebarVisible = computed(() => sidebarOpen.value && (sidebarFits.value || forceSidebar.value))
const frostedOverlay = computed(() => isNarrow.value && forceSidebar.value && sidebarOpen.value)
const filteredConvs = computed(() => {
  if (!searchText.value) return conversations.value
  const q = searchText.value.toLowerCase()
  return conversations.value.filter(c => c.title.toLowerCase().includes(q))
})
const splitRatio = ref(0.55)
const dragging = ref(false)
const isNarrow = ref(false)
function checkNarrow() {
  const wasNarrow = isNarrow.value
  // Preview fullscreen threshold: 700px
  isNarrow.value = window.innerWidth < 700
  // Sidebar fit: need at least sidebar(260) + chat(400) + preview(280 if open)
  const needForSidebar = 260 + 400 + (showPreview.value && !isNarrow.value ? 280 : 0)
  sidebarFits.value = window.innerWidth >= needForSidebar
  if (!isNarrow.value && wasNarrow) forceSidebar.value = false
}
let tooltipEl = null
let pinnedMark = null
let pinnedScrollHandler = null
let hoverTimer = null

const canSend = computed(() => (input.value.trim() || pendingFile.value) && !loading.value)

// ---- Mock 降级数据 ----
const MOCK_POINTS = [
  { quote: '如乙方提前退租，甲方有权没收全部押金并要求额外赔偿', level: 'high', bubble_text: '涉嫌霸王条款。违约金过高时可请求法院适当减少。' },
  { quote: '每日按租金总额的 5% 支付违约金', level: 'high', bubble_text: '违约金比例畸高（日 5% 即月 150%），建议修改为 0.05%/日。' },
  { quote: '租赁期间的物业费由乙方承担', level: 'low', bubble_text: '属于常规条款，建议明确具体的物业费单价。' },
]

// ---- 打字机队列机制 ----
const typewriters = new WeakMap()

function appendToTypewriter(msg, chunk, isActiveFn) {
  if (msg.content === LOADING_DOTS) {
    msg.content = ''
  }
  if (typeof msg.fullContent !== 'string') {
    msg.fullContent = msg.content || ''
  }
  msg.fullContent += chunk

  let tw = typewriters.get(msg)
  if (!tw) {
    tw = { queue: '', timer: null }
    typewriters.set(msg, tw)
  }
  tw.queue += chunk

  if (!tw.timer) {
    tw.timer = setInterval(() => {
      if (tw.queue.length > 0) {
        let chars = 1
        if (tw.queue.length > 200) chars = 10
        else if (tw.queue.length > 50) chars = 4
        else if (tw.queue.length > 20) chars = 2

        msg.content += tw.queue.slice(0, chars)
        tw.queue = tw.queue.slice(chars)

        if (isActiveFn && isActiveFn()) {
          scrollToBottom()
        }
      } else {
        clearInterval(tw.timer)
        tw.timer = null
      }
    }, 30)
  }
}

function flushTypewriter(msg) {
  const tw = typewriters.get(msg)
  if (tw) {
    if (tw.timer) clearInterval(tw.timer)
    if (typeof msg.fullContent === 'string') {
      msg.content = msg.fullContent
    }
    typewriters.delete(msg)
  }
}

// ---- 渲染 ----
function cleanFences(text) {
  return text.replace(/```\w*\s*\n?/g, '').replace(/```/g, '')
}
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
// ---- 会话管理 ----
async function refreshConvList() {
  try { conversations.value = await listConversations() } catch {}
}
async function newChat() {
  // Save in-progress messages before switching away (only for the active stream's conversation)
  if (loading.value && activeStreamConvId.value && currentConvId.value === activeStreamConvId.value) {
    streamMessageCache.value = { convId: currentConvId.value, messages: [...messages.value] }
  }
  currentConvId.value = null
  messages.value = []
  showPreview.value = false
  previewData.value = null
  sidebarOpen.value = false
  forceSidebar.value = false
}
async function loadConversation(id) {
  // Restore cached messages if this conversation has an active stream
  if (loading.value && activeStreamConvId.value === id && streamMessageCache.value?.convId === id) {
    messages.value = streamMessageCache.value.messages
    currentConvId.value = id
    return
  }
  // Save in-progress messages before switching away from the active stream's conversation
  if (loading.value && activeStreamConvId.value && currentConvId.value === activeStreamConvId.value && currentConvId.value !== id) {
    streamMessageCache.value = { convId: currentConvId.value, messages: [...messages.value] }
  }
  try {
    const conv = await getConversation(id)
    currentConvId.value = id
    const msgs = conv.messages.map(m => {
      const msg = { role: m.role, content: m.content }
      if (m.file_name) msg.file = { name: m.file_name }
      if (m.thinking_chain) {
        try {
          msg.thinkingChain = typeof m.thinking_chain === 'string'
            ? JSON.parse(m.thinking_chain) : m.thinking_chain
          msg.thinkingExpanded = false
        } catch {}
      }
      if (m.contract_data) {
        try {
          const cd = typeof m.contract_data === 'string'
            ? JSON.parse(m.contract_data) : m.contract_data
          msg.contractData = cd
          msg.contractRawText = cd.raw_text || ''
          msg.contractRiskPoints = cd.risk_points || []
        } catch {}
      }
      return msg
    })
    // Skip greeting if stored as first message (backward compat)
    if (msgs.length && msgs[0].content && msgs[0].content.includes('AI 法律助手')) {
      msgs.shift()
    }
    messages.value = msgs
    showPreview.value = false
    previewData.value = null
  } catch { /* ignore */ }
}
async function startRename(convId) {
  const conv = conversations.value.find(c => c.id === convId)
  if (!conv) return
  renamingConvId.value = convId
  renameText.value = conv.title
  await nextTick()
  // Auto-focus the input so blur detection works immediately
  const input = document.querySelector('.conv-title-input')
  if (input) input.focus()
}
async function finishRename(convId) {
  const val = renameText.value.trim()
  if (val) {
    try { await updateConvTitle(convId, val) } catch {}
    const conv = conversations.value.find(c => c.id === convId)
    if (conv) conv.title = val
  }
  renamingConvId.value = null
  renameText.value = ''
}
function cancelRename() {
  renamingConvId.value = null
  renameText.value = ''
}

async function handleDeleteConv(id) {
  try {
    await deleteConversation(id)
    if (currentConvId.value === id) {
      currentConvId.value = null
      messages.value = []
    }
    await refreshConvList()
  } catch {}
}
async function ensureConversation() {
  if (!currentConvId.value) {
    const conv = await createConversation()
    currentConvId.value = conv.id
    await refreshConvList()
  }
}

const LOADING_DOTS = '<span class="loading-dots">…</span>'
async function doSaveMessages(overrideConvId, userContent, assistantContent, fileName, contractData, thinkingChain) {
  const _cid = overrideConvId || currentConvId.value
  if (!_cid) return
  try {
    await saveMessages(_cid, userContent, assistantContent, fileName, contractData, thinkingChain)
    await refreshConvList()
  } catch {}
}
// Simple inline POST helper (avoid circular import)

// Strip markdown for plain-text copy
function stripMarkdown(md) {
  if (!md) return ''
  let text = md
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  text = text.replace(/`{1,3}[^`]*`{1,3}/g, '')
  text = text.replace(/^[*-]\s+/gm, '')
  text = text.replace(/^>\s+/gm, '')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function handleSend() {
  if (loading.value) {
    stopGeneration()
    return
  }
  if (pendingFile.value) {
    sendFile(input.value.trim() || null)
  } else {
    sendText()
  }
}

// ---- 消息操作 ----
async function copyMessage(idx, asMarkdown = false) {
  const msg = messages.value[idx]
  if (!msg || !msg.content) return
  const raw = typeof msg.content === 'string' ? msg.content : ''
  const text = asMarkdown ? raw : stripMarkdown(raw)
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
}

async function deleteMessage(idx) {
  const msg = messages.value[idx]
  if (!msg) return
  messages.value.splice(idx, 1)
  // Sync with backend
  if (currentConvId.value) {
    try {
      const exportable = messages.value
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          role: m.role,
          content: m.content,
          file_name: m.file?.name || null,
          contract_data: m.contractData || null,
          thinking_chain: m.thinkingChain || null,
        }))
      await rebuildMessages(currentConvId.value, exportable)
    } catch {}
  }
}

async function regenerateMessage(idx) {
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'assistant') return
  // Find preceding user message
  if (idx > 0 && messages.value[idx - 1].role === 'user') {
    const userMsg = messages.value[idx - 1]
    // Remove the pair
    messages.value.splice(idx - 1, 2)
    // Sync removal to backend before re-sending
    if (currentConvId.value) {
      try {
        const exportable = messages.value
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({
            role: m.role,
            content: m.content,
            file_name: m.file?.name || null,
            contract_data: m.contractData || null,
            thinking_chain: m.thinkingChain || null,
          }))
        await rebuildMessages(currentConvId.value, exportable)
      } catch {}
    }
    if (userMsg.file) {
      // It was a file upload - re-send
      pendingFile.value = userMsg.file
      input.value = ''
      // Extract instruction if any
      const displayText = userMsg.content
      const fileMark = '📄 上传合同：' + userMsg.file.name
      if (displayText.startsWith(fileMark)) {
        const instr = displayText.slice(fileMark.length).trim().replace(/^\n/, '')
        input.value = instr

        input.value = instr
      }
      sendFile(input.value.trim() || null)
    } else {
      // Text message
      input.value = userMsg.content
      sendText()
    }
  }
}

function editMessage(idx) {
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'user') return
  editingIndex.value = idx
  editingText.value = msg.content
}
async function saveEdit(idx) {
  const msg = messages.value[idx]
  if (!msg) return
  msg.content = editingText.value
  editingIndex.value = -1
  editingText.value = ''
  // Sync to backend
  if (currentConvId.value) {
    try {
      const exportable = messages.value
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          role: m.role,
          content: m.content,
          file_name: m.file?.name || null,
          contract_data: m.contractData || null,
          thinking_chain: m.thinkingChain || null,
        }))
      await rebuildMessages(currentConvId.value, exportable)
    } catch {}
  }
}
function cancelEdit() {
  editingIndex.value = -1
  editingText.value = ''
}

function stopGeneration() {
  if (abortController.value) {
    abortController.value.abort()
    abortController.value = null
  }
  // Flush any pending typewriter content immediately
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant') {
    flushTypewriter(last)
    if (last.content === LOADING_DOTS) {
      last.content = '已停止生成。'
    }
  }
}

async function sendText() {
  const query = input.value.trim()
  if (!query || loading.value) return

  messages.value.push({ role: 'user', content: query })
  input.value = ''
  loading.value = true
  await scrollToBottom()

  try {
    await ensureConversation()
    const _convId = currentConvId.value
    const isFirstMsg = messages.value.filter(m => m.role === 'user').length === 1
    if (isFirstMsg) {
      try {
        const t = query
        await updateConvTitle(_convId, t.length > 14 ? t.slice(0, 14) + "…" : t)
      } catch {}
    }
    await refreshConvList()
    const history = messages.value
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1)
      .map(m => ({ role: m.role, content: m.content }))
    const _localSteps = []
    thinkingSteps.value = []
    thinkingExpanded.value = false
    const _asstMsg = { role: 'assistant', content: LOADING_DOTS, thinkingChain: [] }
    messages.value.push(_asstMsg)
    const asstMsgProxy = messages.value[messages.value.length - 1]
    const _isActive = () => currentConvId.value === _convId
    activeStreamConvId.value = _convId
    abortController.value = new AbortController()
    await chatStream(query, history, abortController.value.signal, {
      onThinking(label) {
        _localSteps.push({ type: 'tool', label })
        if (_isActive()) thinkingSteps.value = [..._localSteps]
      },
      onReasoning(text) {
        const steps = _localSteps
        if (steps.length && steps[steps.length - 1].type === 'reasoning') {
          steps[steps.length - 1].label = text
        } else {
          steps.push({ type: 'reasoning', label: text })
        }
        if (_isActive()) thinkingSteps.value = [..._localSteps]
      },
      async onReasoningToken(ch) {
        const steps = _localSteps
        if (!steps.length || steps[steps.length - 1].type !== 'reasoning') {
          steps.push({ type: 'reasoning', label: '' })
        }
        steps[steps.length - 1].label += ch
        if (_isActive()) thinkingSteps.value = [..._localSteps]
        await nextTick()
      },
      onToolChunk(tool, content, first) {
        const steps = _localSteps
        if (first) {
          steps.push({ type: 'done', label: tool + ' 完成', snippet: content })
        } else {
          const last = steps[steps.length - 1]
          if (last && last.type === 'done') last.snippet += content
        }
        if (_isActive()) thinkingSteps.value = [..._localSteps]
      },
      onToolResult(tool, output) {
        _localSteps.push({ type: 'done', label: tool + ' 完成', snippet: output })
        if (_isActive()) thinkingSteps.value = [..._localSteps]
      },
      async onToken(content) {
        appendToTypewriter(asstMsgProxy, content, _isActive)
      },
      async onDone(data) {
        flushTypewriter(asstMsgProxy)
        asstMsgProxy.thinkingChain = [..._localSteps]
        asstMsgProxy.thinkingExpanded = false
        if (_isActive()) {
          thinkingSteps.value = [..._localSteps]
          thinkingExpanded.value = false
        }
        const finalContent = asstMsgProxy.fullContent || asstMsgProxy.content
        await doSaveMessages(_convId, query, finalContent, null, null, asstMsgProxy.thinkingChain)
        if (_isActive()) await scrollToBottom()
      },
      onError(msg) {
        flushTypewriter(asstMsgProxy)
        asstMsgProxy.content = '### ⚠️ 请求失败\n\n' + msg
        if (_isActive()) thinkingSteps.value = [..._localSteps]
        doSaveMessages(_convId, query, asstMsgProxy.content, null, null, asstMsgProxy.thinkingChain).catch(() => {})
      },
    })
  } catch (e) {
    messages.value.push({ role: 'assistant', content: '### ⚠️ 请求失败\n\n请确认后端服务已启动。' })
  } finally {
    loading.value = false
    abortController.value = null
    activeStreamConvId.value = null
    streamMessageCache.value = null
    await scrollToBottom()
  }
}

// ---- 文件选择 ----
function handleFileChange(file) {
  pendingFile.value = file.raw
}

// ---- 合同审查发送 ----
async function sendFile(instruction = null) {
  if (!pendingFile.value || loading.value) return

  const displayContent = instruction
    ? `📄 上传合同：${pendingFile.value.name}\n${instruction}`
    : `📄 上传合同：${pendingFile.value.name}`
  const _userDisplayContent = displayContent

  messages.value.push({
    role: 'user',
    content: displayContent,
    file: pendingFile.value,
  })
  const fileToSend = pendingFile.value
  pendingFile.value = null
  input.value = ''
  loading.value = true
  await scrollToBottom()

  try {
    await ensureConversation()
    const _convId = currentConvId.value
    const isFirstMsg = messages.value.filter(m => m.role === 'user').length === 1
    if (isFirstMsg) {
      try {
        const t = instruction || fileToSend.name.replace(/\.[^.]+$/, "")
        await updateConvTitle(_convId, t.length > 14 ? t.slice(0, 14) + "…" : t)
      } catch {}
    }
    await refreshConvList()
    const _localSteps = []
    thinkingSteps.value = []
    thinkingExpanded.value = false
    const _asstMsg = { role: 'assistant', content: LOADING_DOTS, thinkingChain: [] }
    messages.value.push(_asstMsg)
    const asstMsgProxy = messages.value[messages.value.length - 1]
    const _isActive = () => currentConvId.value === _convId
    activeStreamConvId.value = _convId
    abortController.value = new AbortController()
    await analyzeContractStream(fileToSend, abortController.value.signal, {
      onThinking(label) {
        _localSteps.push({ type: 'tool', label })
        if (_isActive()) thinkingSteps.value = [..._localSteps]
      },
      onReasoning(text) {
        const steps = _localSteps
        if (steps.length && steps[steps.length - 1].type === 'reasoning') {
          steps[steps.length - 1].label = text
        } else {
          steps.push({ type: 'reasoning', label: text })
        }
        if (_isActive()) thinkingSteps.value = [..._localSteps]
      },
      async onReasoningToken(ch) {
        const steps = _localSteps
        if (!steps.length || steps[steps.length - 1].type !== 'reasoning') {
          steps.push({ type: 'reasoning', label: '' })
        }
        steps[steps.length - 1].label += ch
        if (_isActive()) thinkingSteps.value = [..._localSteps]
        await nextTick()
      },
      onToolChunk(tool, content, first) {
        const steps = _localSteps
        if (first) {
          steps.push({ type: 'done', label: tool + ' 完成', snippet: content })
        } else {
          const last = steps[steps.length - 1]
          if (last && last.type === 'done') last.snippet += content
        }
        if (_isActive()) thinkingSteps.value = [..._localSteps]
      },
      onToolResult(tool, output) {
        _localSteps.push({ type: 'done', label: tool + ' 完成', snippet: output })
        if (_isActive()) thinkingSteps.value = [..._localSteps]
      },
      async onToken(content) {
        appendToTypewriter(asstMsgProxy, content, _isActive)
      },
      async onDone(data) {
        flushTypewriter(asstMsgProxy)
        asstMsgProxy.thinkingChain = [..._localSteps]
        asstMsgProxy.thinkingExpanded = false
        asstMsgProxy.contractData = data
        pushContractAttach(asstMsgProxy, data, fileToSend)
        if (_isActive()) {
          thinkingSteps.value = [..._localSteps]
          thinkingExpanded.value = false
        }
        const finalContent = asstMsgProxy.fullContent || asstMsgProxy.content
        await doSaveMessages(_convId, _userDisplayContent, finalContent, fileToSend.name, data, asstMsgProxy.thinkingChain)
        if (_isActive()) await scrollToBottom()
      },
      onError(msg) {
        flushTypewriter(asstMsgProxy)
        asstMsgProxy.content = '### ⚠️ 合同审查失败\n\n' + msg
        if (_isActive()) thinkingSteps.value = [..._localSteps]
        doSaveMessages(_convId, _userDisplayContent, asstMsgProxy.content, fileToSend.name, null, asstMsgProxy.thinkingChain).catch(() => {})
      },
    })
  } catch (e) {
    const errMsg = e?.response?.data?.detail || e.message || '请确认后端服务已启动。'
    messages.value.push({ role: 'assistant', content: '### ⚠️ 合同审查失败\n\n' + errMsg })
  } finally {
    loading.value = false
    activeStreamConvId.value = null
    streamMessageCache.value = null
    await scrollToBottom()
  }
}

function updatePinnedBubble() {
  if (!pinnedMark || !tooltipEl) return
  const rect = pinnedMark.getBoundingClientRect()
  const panel = document.querySelector('.preview-panel')
  const panelRect = panel ? panel.getBoundingClientRect() : { left: 0, right: window.innerWidth }
  const tipW = tooltipEl.offsetWidth
  const tipH = tooltipEl.offsetHeight
  const gap = 8
  let left = rect.left + rect.width / 2 - tipW / 2
  left = Math.max(panelRect.left + 8, Math.min(left, panelRect.right - tipW - 8))
  let top = rect.top - tipH - gap
  if (top < panelRect.top + 8) {
    top = rect.bottom + gap
  }
  tooltipEl.style.left = left + 'px'
  tooltipEl.style.top = top + 'px'
}

function onContractClick(e) {
  const mark = e.target.closest('mark')
  if (!mark) return
  if (pinnedMark === mark) {
    // Unpin
    pinnedMark.classList.remove('pinned')
    pinnedMark = null
    if (tooltipEl) tooltipEl.style.opacity = '0'
    if (pinnedScrollHandler) {
      document.querySelector('.preview-body')?.removeEventListener('scroll', pinnedScrollHandler)
      pinnedScrollHandler = null
    }
  } else {
    // Unpin previous
    if (pinnedMark) {
      pinnedMark.classList.remove('pinned')
      if (pinnedScrollHandler) {
        document.querySelector('.preview-body')?.removeEventListener('scroll', pinnedScrollHandler)
      }
    }
    // Pin this one
    pinnedMark = mark
    mark.classList.add('pinned')
    // Show bubble immediately (bypass debounce)
    if (tooltipEl) tooltipEl.style.opacity = '1'
    onContractHover(e)
    pinnedScrollHandler = () => updatePinnedBubble()
    document.querySelector('.preview-body')?.addEventListener('scroll', pinnedScrollHandler, { passive: true })
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
  // If a different mark is pinned, don't steal the bubble
  if (pinnedMark && pinnedMark !== mark) return
  const bubble = mark.dataset.bubble
  if (!bubble) return
  clearTimeout(hoverTimer)
  const isVisible = tooltipEl.style.opacity === '1'
  const show = () => {
    tooltipEl.textContent = bubble
    tooltipEl.style.opacity = '1'
  }
  if (isVisible) {
    show()
  } else {
    hoverTimer = setTimeout(show, 200)
  }
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
  clearTimeout(hoverTimer)
  if (!tooltipEl || pinnedMark) return
  hoverTimer = setTimeout(() => {
    if (!pinnedMark) tooltipEl.style.opacity = '0'
  }, 100)
}

onMounted(() => {
  checkNarrow()
  window.addEventListener("resize", checkNarrow)
  watch(showPreview, (val) => {
    nextTick(checkNarrow)
    if (!val && pinnedMark) {
      pinnedMark.classList.remove("pinned")
      pinnedMark = null
      if (tooltipEl) tooltipEl.style.opacity = "0"
      if (pinnedScrollHandler) {
        document.querySelector(".preview-body")?.removeEventListener("scroll", pinnedScrollHandler)
        pinnedScrollHandler = null
      }
    }
  })
  refreshConvList()
  tooltipEl = document.createElement('div')
  tooltipEl.className = 'contract-tooltip'
  tooltipEl.style.cssText = 'display:block;opacity:0;pointer-events:none;transition:opacity 0.15s ease;position:fixed;z-index:9999;max-width:300px;padding:10px 14px;background:#fff;color:#303133;font-size:13px;line-height:1.6;border-radius:8px;white-space:normal;word-break:break-word;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.15);font-family:"Microsoft YaHei",sans-serif;'
  document.body.appendChild(tooltipEl)
})

onUnmounted(() => {
  window.removeEventListener("resize", checkNarrow)
  if (tooltipEl) {
    tooltipEl.remove()
    tooltipEl = null
  }
})

function pushContractAttach(msg, data, file) {
  msg.contractRawText = data.raw_text || ''
  msg.contractRiskPoints = data.risk_points || []
  if (file) {
    msg.file = file
  }
}

function pushContractResult(data) {
  messages.value.push({
    role: 'assistant',
    content: data.chat_reply,
    contractData: data,
  })
}

function openContractPreview(msg) {
  previewData.value = msg.contractData
  showPreview.value = true
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

.toggle-btn { flex-shrink: 0; }
.new-chat-header-btn { margin-left: 6px; flex-shrink: 0; }
.chat-header h2 {
  margin: 0;
  font-size: 18px;
}
.subtitle {
  font-size: 13px;
  color: #a6adc8;
}

/* 欢迎页 */
.welcome-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f7f8fa;
}
.welcome-content {
  text-align: center;
}
.welcome-content h1 {
  font-size: 28px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 12px;
}
.welcome-content p {
  font-size: 15px;
  color: #909399;
  margin: 0;
}
.chat-messages {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
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
  display: block;
  width: fit-content;
  max-width: 90%;
  padding: 12px 16px;
  border-radius: 10px;
  line-height: 1.7;
  font-size: 14px;
  overflow-wrap: anywhere;
  overflow: hidden;
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

.loading-dots {
  display: inline-block;
  font-size: 28px;
  color: #909399;
  animation: breathe 1.5s ease-in-out infinite;
}
@keyframes breathe {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}

.message-content :deep(.loading-dots) {
  display: inline-block;
  font-size: 28px;
  color: #909399;
  animation: breathe 1.5s ease-in-out infinite;
}
@keyframes breathe {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}
/* prevent pre/code blocks from overflowing during streaming */
.message-content :deep(pre),
.message-content :deep(code) {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.contract-actions {
  margin-top: 8px;
}

/* 消息操作按钮 */
.msg-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.message:hover .msg-actions,
.msg-actions-visible {
  opacity: 1;
}
.msg-actions-left {
  justify-content: flex-start;
}
.msg-actions-right {
  justify-content: flex-end;
}
.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  color: #909399;
  transition: all 0.15s;
}
.action-btn:hover {
  color: #409eff;
  background: #ecf5ff;
}
.action-btn .el-icon {
  font-size: 14px;
}

/* 行内编辑 */
.edit-inline {
  width: 100%;
  max-width: 100%;
}
.message.user .edit-inline {
  margin-left: auto;
}
.edit-inline-wrapper {
  position: relative;
}
.edit-inline-wrapper :deep(.el-textarea__inner) {
  padding-bottom: 36px;
  resize: none;
}
.edit-actions {
  position: absolute;
  bottom: 8px;
  right: 10px;
  display: flex;
  gap: 6px;
}

.scroll-bottom-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid #e4e7ed;
  cursor: pointer;
  color: #606266;
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  transition: all 0.15s;
  z-index: 10;
}
.scroll-bottom-btn:hover {
  color: #409eff;
  border-color: #409eff;
  box-shadow: 0 2px 12px rgba(64,158,255,0.2);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 输入区 */
.chat-input-area {
  padding: 12px 20px;
  background: #fff;
  border-top: 1px solid #ebeef5;
  flex-shrink: 0;
  position: relative;
}
.input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.input-wrapper {
  position: relative;
  flex: 1;
}
.input-wrapper :deep(.el-textarea__inner) {
  padding-bottom: 36px;
  resize: none;
}
.input-actions {
  position: absolute;
  bottom: 6px;
  left: 8px;
  right: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.input-row .el-textarea {
  flex: 1;
}
.file-tag {
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Thinking Chain */
.thinking-chain {
  margin-bottom: 8px;
}
.thinking-summary.persisted {
  color: #606266;
  background: #f5f7fa;
  cursor: pointer;
}
.thinking-summary.persisted:hover {
  background: #ebeef5;
}
.thinking-summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #f0f4ff;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #4a6cf7;
  user-select: none;
}
.thinking-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4a6cf7;
  animation: thinking-pulse 1.2s infinite;
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.thinking-arrow {
  color: #909399;
  font-size: 12px;
}
.thinking-details {
  margin-top: 4px;
  padding: 8px 12px;
  background: #f8f9fc;
  border-radius: 6px;
}
.thinking-step {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 3px 0;
  font-size: 12px;
  color: #909399;
}
.thinking-step-icon {
  flex-shrink: 0;
}
.thinking-step-text {
  word-break: break-all;
  line-height: 1.5;
  white-space: pre-wrap;
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

/* ---- 侧边栏 ---- */
.sidebar {
  width: 260px;
  background: #f8f9fb;
  border-right: 1px solid #e4e7ed;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
}
.sidebar-header {
  padding: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid #ebeef5;
}
.sidebar-header .el-input { flex: 1; }
.new-chat-btn {
  margin: 12px;
  width: calc(100% - 24px);
}
.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}
.conv-item {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 2px;
  transition: background 0.15s;
}
.conv-item:hover { background: #e8ecf1; }
.conv-item.active { background: #d4dce8; }
.conv-title {
  flex: 1;
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-title-input {
  flex: 1;
  min-width: 0;
  border: 1px solid #409eff;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 13px;
  outline: none;
  background: #fff;
  margin-right: 4px;
}
.conv-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  color: #909399;
  visibility: hidden;
  opacity: 0;
  transition: all 0.15s;
  flex-shrink: 0;
}
.conv-more:hover {
  color: #409eff;
  background: #ecf5ff;
}
.conv-item:hover .conv-more,
.conv-more-visible {
  visibility: visible;
  opacity: 1;
}
.conv-empty {
  padding: 20px;
  text-align: center;
  color: #c0c4cc;
  font-size: 13px;
}

/* main-area 包装 */
.main-area {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* 侧边栏滑入动画 */
.sidebar-slide-enter-active,
.sidebar-slide-leave-active {
  transition: width 0.25s ease, opacity 0.25s ease;
  overflow: hidden;
}
.sidebar-slide-enter-from,
.sidebar-slide-leave-to {
  width: 0 !important;
  opacity: 0;
}

/* ---- 毛玻璃遮罩 ---- */
.frosted-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* 窄屏强制侧边栏浮在对话区上方 */
.sidebar-overlay {
  position: absolute !important;
  z-index: 200;
  height: 100%;
  box-shadow: 4px 0 20px rgba(0,0,0,0.15);
}

.chat-panel {
  position: relative;
}


.contract-text :deep(mark.pinned) {
  outline: 2px solid #409EFF;
  outline-offset: 1px;
  filter: brightness(0.85);
}

</style>
