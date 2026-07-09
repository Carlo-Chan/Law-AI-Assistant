<template>
  <div class="app-layout" :style="{ '--split-ratio': splitRatio }">
    <!-- 侧边栏 -->
    <transition name="sidebar-slide">
      <div v-if="sidebarVisible" class="sidebar" :class="{ 'sidebar-overlay': forceSidebar }">
        <div class="sidebar-header">
          <el-input v-model="searchText" placeholder="搜索对话..." class="search-input">
            <template #prefix>
              <el-icon class="search-icon"><Search /></el-icon>
            </template>
            <template #suffix>
              <span v-if="searchText" class="search-clear-btn" @click.stop="searchText = ''">✕</span>
            </template>
          </el-input>
          <el-button text size="small" class="sidebar-close-btn" @click="sidebarOpen = false; forceSidebar = false"><el-icon><Fold /></el-icon></el-button>
        </div>
        <el-button class="new-chat-btn" @click="newChat">
          <el-icon><Edit /></el-icon> 开启新对话
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
            <el-dropdown v-if="renamingConvId !== conv.id" trigger="click" popper-class="menu-pop" @command="(cmd) => cmd === 'rename' ? startRename(conv.id) : handleDeleteConv(conv.id)" @visible-change="(v) => sidebarMenuConvId = v ? conv.id : null">
              <span :class="['conv-more', { 'conv-more-visible': sidebarMenuConvId === conv.id }]" @click.stop><el-icon><MoreFilled /></el-icon></span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename">
                    <el-icon><EditPen /></el-icon> 重命名
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
          <el-button :icon="Expand" text size="small" class="toggle-btn" @click="sidebarOpen = true; forceSidebar = isNarrow" />
          <el-button text size="small" class="new-chat-header-btn" @click="newChat" title="新对话">
            <el-icon><Edit /></el-icon>
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
          <div v-if="msg.role === 'user' && msg.file" class="msg-file-card">
            <div class="msg-file-card-icon"><el-icon><Document /></el-icon></div>
            <span class="msg-file-card-name">{{ msg.file.name }}</span>
          </div>
          <!-- 思维链：流式输出时实时展示，或持久化保存 -->
          <div v-if="msg.role === 'assistant' && i === messages.length - 1 && loading" class="thinking-chain">
            <div class="thinking-summary" @click="messages[messages.length-1].thinkingExpanded = !messages[messages.length-1].thinkingExpanded">
              <span class="thinking-dot" />
              <span>{{ thinkingLabel }}</span>
              <span class="thinking-arrow"><el-icon :class="{ rotated: messages[messages.length-1].thinkingExpanded }"><ArrowRight /></el-icon></span>
            </div>
            <div v-if="messages[messages.length-1].thinkingExpanded" class="thinking-details">
              <div v-for="(step, si) in thinkingSteps" :key="si" class="thinking-step">
                <span class="thinking-step-icon">
                <el-icon v-if="step.type === 'tool'"><Search /></el-icon>
                <el-icon v-else-if="step.type === 'reasoning'"><ChatDotRound /></el-icon>
                <el-icon v-else><CircleCheck /></el-icon>
              </span>
                <span class="thinking-step-text">{{ cleanFences(step.label) }}{{ step.snippet ? '：\n' + step.snippet : '' }}</span>
              </div>
            </div>
          </div>
          <div v-else-if="msg.thinkingChain?.length" class="thinking-chain">
            <div class="thinking-summary persisted" @click="msg.thinkingExpanded = !msg.thinkingExpanded">
              <span>{{ msg.thinkingChain.filter(s => s.type === 'tool' || s.type === 'reasoning').length }} 次思考步骤</span>
              <span class="thinking-arrow"><el-icon :class="{ rotated: msg.thinkingExpanded }"><ArrowRight /></el-icon></span>
            </div>
            <div v-if="msg.thinkingExpanded" class="thinking-details">
              <div v-for="(step, si) in msg.thinkingChain" :key="si" class="thinking-step">
                <span class="thinking-step-icon">
                <el-icon v-if="step.type === 'tool'"><Search /></el-icon>
                <el-icon v-else-if="step.type === 'reasoning'"><ChatDotRound /></el-icon>
                <el-icon v-else><CircleCheck /></el-icon>
              </span>
                <span class="thinking-step-text">{{ cleanFences(step.label) }}{{ step.snippet ? '：\n' + step.snippet : '' }}</span>
              </div>
            </div>
          </div>
          <div class="message-content" v-html="renderMd(msg.content)" />
          </template>
          <transition name="contract-card-pop">
            <div v-if="msg.contractRawText" class="contract-card" @click="openContractPreview(msg)">
              <div class="contract-card-icon"><el-icon><Document /></el-icon></div>
              <div class="contract-card-body">
                <span class="contract-card-title">合同原文 · 风险标注</span>
                <span class="contract-card-hint">点击查看高亮标注</span>
              </div>
              <el-icon class="contract-card-arrow"><ArrowRight /></el-icon>
            </div>
          </transition>
          <div v-if="msg.role === 'assistant' && editingIndex === -1" :class="['msg-actions', 'msg-actions-left', { 'msg-actions-visible': dropdownOpenIndex === i }]">
            <el-dropdown trigger="click" popper-class="menu-pop" @command="(cmd) => copyMessage(i, cmd === 'md')" @visible-change="(v) => dropdownOpenIndex = v ? i : -1">
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
            <el-dropdown trigger="click" popper-class="menu-pop" @command="(cmd) => copyMessage(i, cmd === 'md')" @visible-change="(v) => dropdownOpenIndex = v ? i : -1">
              <span class="action-btn" title="复制"><el-icon><CopyDocument /></el-icon></span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="text">复制纯文本</el-dropdown-item>
                  <el-dropdown-item command="md">复制 Markdown</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <span class="action-btn" title="编辑" @click="editMessage(i)"><el-icon><EditPen /></el-icon></span>
            <span class="action-btn" title="删除" @click="deleteMessage(i)"><el-icon><Delete /></el-icon></span>
          </div>
        </div>
      </div>

      <div class="chat-input-anchor" :class="{ 'input-floating': messages.length === 0, 'has-file': pendingFile }"><div class="chat-input-area">
        <transition name="fade">
          <div v-if="showScrollBtn" class="scroll-bottom-btn" @click="scrollToBottom">
            <el-icon><ArrowDown /></el-icon>
          </div>
        </transition>
        <div class="input-row">
          <div class="input-wrapper" :class="{ 'is-sending': loading }">
            <transition name="file-expand">
              <div v-if="pendingFile" class="file-card">
              <div class="file-card-icon"><el-icon><Document /></el-icon></div>
              <span class="file-card-name">{{ pendingFile.name }}</span>
              <el-button text size="small" class="file-card-close" @click="pendingFile = null"><el-icon><Close /></el-icon></el-button>
            </div>
            </transition>
            <el-input
              v-model="input"
              type="textarea"
              :rows="3"
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
                <el-button text size="small" class="upload-btn" :disabled="loading"><el-icon><Plus /></el-icon></el-button>
              </el-upload>
              <el-button v-if="!loading" size="small" :disabled="!canSend" @click="handleSend" class="send-btn"><el-icon><Top /></el-icon></el-button>
              <el-button v-else size="small" @click="handleSend" class="stop-btn"><span class="stop-square"></span></el-button>
            </div>
          </div>
        </div>
      </div></div>
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
import { Upload, Promotion, Document, View, Close, ArrowLeft, Plus, Delete, Expand, VideoPause, CopyDocument, Refresh, Edit, MoreFilled, ArrowDown, Search, ChatDotRound, CircleCheck, Top, EditPen, Fold, ArrowRight } from '@element-plus/icons-vue'
import { chat as chatApi, analyzeContract, listConversations, createConversation, getConversation, deleteConversation, saveMessages, updateConvTitle, chatStream, analyzeContractStream, rebuildMessages } from '../utils/api'
import { renderHighlightedContract } from '../utils/highlight'
import { appendToTypewriter, flushTypewriter } from '../composables/useTypewriter'
import { toExportable } from '../composables/messageExport'
import { pinyinMatch, fuzzyMatch } from '../composables/useSearch'
import { stripMarkdown, cleanFences, renderMd } from '../composables/useTextTools'

// ---- 状态 ----
const messages = ref([])
const input = ref('')
const draftInputs = {}  // 按对话ID记忆输入框草稿
const draftFiles = {}    // 按对话ID记忆已选文件
const pendingFile = ref(null)
const loadingConvIds = ref(new Set())
const loading = computed(() => loadingConvIds.value.has(currentConvId.value || "__pending__"))
const abortControllers = ref({})
const editingIndex = ref(-1)
const editingText = ref('')
const dropdownOpenIndex = ref(-1)
const sidebarMenuConvId = ref(null)
const renamingConvId = ref(null)
const renameText = ref('')
const activeStreamConvId = ref(null)
const streamMessageCache = ref({})
const thinkingSteps = ref([])

const thinkingLabel = computed(() => {
  if (thinkingSteps.value.length === 0) return '正在思考...'
  const last = thinkingSteps.value[thinkingSteps.value.length - 1]
  if (last.type === 'tool') return '正在搜索：' + last.label + '...'
  if (last.type === 'reasoning') return '正在分析：' + last.label.slice(0, 20) + '...'
  return '思考中…'
})
const msgContainer = ref(null)
const showScrollBtn = ref(false)

// 监听聊天区滚动事件，控制一键到底按钮显隐
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
  return conversations.value.filter(c => {
    const t = c.title.toLowerCase()
    return t.includes(q) || pinyinMatch(c.title, q) || fuzzyMatch(t, q)
  })
})
const splitRatio = ref(0.55)
const dragging = ref(false)
const isNarrow = ref(false)
function checkNarrow() {
  const wasNarrow = isNarrow.value
  // 预览区全屏临界宽度：700px
  isNarrow.value = window.innerWidth < 700
  // 侧边栏适配：最小需要侧边栏(260) + 聊天区(400) + 预览区(280)
  const needForSidebar = 260 + 400 + (showPreview.value && !isNarrow.value ? 280 : 0)
  sidebarFits.value = window.innerWidth >= needForSidebar
  if (!isNarrow.value && wasNarrow) forceSidebar.value = false
}
let tooltipEl = null
let pinnedMark = null
let pinnedScrollHandler = null
let hoverTimer = null

const canSend = computed(() => (input.value.trim() || pendingFile.value) && !loadingConvIds.value.has(currentConvId.value || "__pending__"))

// ---- Mock 降级数据 ----
const MOCK_POINTS = [
  { quote: '如乙方提前退租，甲方有权没收全部押金并要求额外赔偿', level: 'high', bubble_text: '涉嫌霸王条款。违约金过高时可请求法院适当减少。' },
  { quote: '每日按租金总额的 5% 支付违约金', level: 'high', bubble_text: '违约金比例畸高（日 5% 即月 150%），建议修改为 0.05%/日。' },
  { quote: '租赁期间的物业费由乙方承担', level: 'low', bubble_text: '属于常规条款，建议明确具体的物业费单价。' },
]

const highlightedContract = computed(() => {
  if (!previewData.value) return ''
  return renderHighlightedContract(previewData.value.raw_text, previewData.value.risk_points)
})

// ---- 滚动 ----
// 滚动聊天区到底部
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
// 创建新对话：保存草稿、缓存活跃对话消息、清空界面
async function newChat() {
  // 保存当前对话的输入框草稿
  if (currentConvId.value) {
    draftInputs[currentConvId.value] = input.value
  } else {
    draftInputs['__new__'] = input.value
  }
  // 保存当前文件
  if (currentConvId.value) { draftFiles[currentConvId.value] = pendingFile.value }
  else { draftFiles['__new__'] = pendingFile.value }
  // 切换前保存当前对话中正在生成的消息（仅针对活跃流的对话）
  if (loading.value && activeStreamConvId.value && currentConvId.value === activeStreamConvId.value) {
    streamMessageCache.value = {
      ...streamMessageCache.value,
      [currentConvId.value]: { messages: [...messages.value], thinkingSteps: [...thinkingSteps.value] },
    }
  }
  currentConvId.value = null
  messages.value = []
  showScrollBtn.value = false
  showPreview.value = false
  previewData.value = null
  sidebarOpen.value = false
  forceSidebar.value = false
  pendingFile.value = draftFiles['__new__'] || null
  input.value = draftInputs['__new__'] || ''
}
// 加载历史对话：缓存当前对话 → 恢复目标对话（缓存优先，否则查数据库）
async function loadConversation(id) {
  showScrollBtn.value = false
  // 保存当前对话的输入框草稿
  if (currentConvId.value) {
    draftInputs[currentConvId.value] = input.value
  } else {
    draftInputs['__new__'] = input.value
  }
  // 保存当前文件
  if (currentConvId.value) { draftFiles[currentConvId.value] = pendingFile.value }
  else { draftFiles['__new__'] = pendingFile.value }
  // 切换前保存正在生成的消息到缓存
  if (loadingConvIds.value.has(currentConvId.value) && currentConvId.value !== id) {
    streamMessageCache.value = {
      ...streamMessageCache.value,
      [currentConvId.value]: {
        messages: [...messages.value],
        thinkingSteps: [...thinkingSteps.value],
      },
    }
  }
  // 如果目标对话有活跃流，从缓存恢复消息
  if (streamMessageCache.value[id]) {
    const cache = streamMessageCache.value[id]
    messages.value = cache.messages
    thinkingSteps.value = cache.thinkingSteps || []
    currentConvId.value = id
    pendingFile.value = draftFiles[id] || null
    input.value = draftInputs[id] || ''
    return
  }
  try {
    const conv = await getConversation(id)
    currentConvId.value = id
    pendingFile.value = draftFiles[id] || null
    input.value = draftInputs[id] || ''
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
    // 跳过以问候语作为首条消息的旧数据（向后兼容）
    if (msgs.length && msgs[0].content && msgs[0].content.includes('AI 法律助手')) {
      msgs.shift()
    }
    messages.value = msgs
    await nextTick()
    await scrollToBottom()
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
  // 自动聚焦输入框，确保失焦检测即时生效
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

// 删除对话：若为当前对话则清空界面
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
// 确保当前有活跃对话，没有则自动创建
async function ensureConversation() {
  if (!currentConvId.value) {
    const conv = await createConversation()
    currentConvId.value = conv.id
    await refreshConvList()
  }
}

const LOADING_DOTS = '<span class="loading-dots">…</span>'
// 保存对话消息到后端数据库
async function doSaveMessages(overrideConvId, userContent, assistantContent, fileName, contractData, thinkingChain) {
  const _cid = overrideConvId || currentConvId.value
  if (!_cid) return
  try {
    await saveMessages(_cid, userContent, assistantContent, fileName, contractData, thinkingChain)
    await refreshConvList()
  } catch {}
}
// 简易内联 POST 辅助函数（避免循环引用）

// 发送按钮处理：生成中则停止，否则发送文本或文件
function handleSend() {
  const _key = currentConvId.value || "__pending__"
  if (loadingConvIds.value.has(_key)) {
    stopGeneration(currentConvId.value)
    return
  }
  if (pendingFile.value) {
    sendFile(input.value.trim() || null)
  } else {
    sendText()
  }
}

// ---- 消息操作 ----
// 复制消息内容到剪贴板（支持纯文本 / Markdown 两种格式）
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

// 删除单条消息（用户消息连带删除对应 LLM 回复）
async function deleteMessage(idx) {
  const msg = messages.value[idx]
  if (!msg) return
  messages.value.splice(idx, 1)
  // 同步到后端数据库
  if (currentConvId.value) {
    try {
      await rebuildMessages(currentConvId.value, toExportable(messages.value))
    } catch {}
  }
}

// 重新生成 LLM 回复：删除旧回复 → 重跑对应请求
async function regenerateMessage(idx) {
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'assistant') return
  // 查找对应的上一条用户消息
  if (idx > 0 && messages.value[idx - 1].role === 'user') {
    const userMsg = messages.value[idx - 1]
    // 移除该对消息
    messages.value.splice(idx - 1, 2)
    // 重新生成前先同步删除到后端
    if (currentConvId.value) {
      try {
        await rebuildMessages(currentConvId.value, toExportable(messages.value))
      } catch {}
    }
    if (userMsg.file) {
      // 文件上传消息，重新发送文件
      pendingFile.value = userMsg.file
      input.value = ''
      // 提取用户附加的文字指令
      const displayText = userMsg.content
      const fileMark = '📄 上传合同：' + userMsg.file.name
      if (displayText.startsWith(fileMark)) {
        const instr = displayText.slice(fileMark.length).trim().replace(/^\n/, '')
        input.value = instr

        input.value = instr
      }
      sendFile(input.value.trim() || null)
    } else {
      // 普通文本消息
      input.value = userMsg.content
      sendText()
    }
  }
}

// 进入消息编辑模式：将原内容填入输入框
function editMessage(idx) {
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'user') return
  editingIndex.value = idx
  editingText.value = msg.content
}
// 保存编辑后的用户消息并同步到后端
async function saveEdit(idx) {
  const msg = messages.value[idx]
  if (!msg) return
  msg.content = editingText.value
  editingIndex.value = -1
  editingText.value = ''
  // 同步到后端
  if (currentConvId.value) {
    try {
      await rebuildMessages(currentConvId.value, toExportable(messages.value))
    } catch {}
  }
}
function cancelEdit() {
  editingIndex.value = -1
  editingText.value = ''
}

// 停止当前对话的 LLM 生成
function stopGeneration(convId) {
  const targetId = convId || '__pending__'
  if (abortControllers.value[targetId]) {
    abortControllers.value[targetId].abort()
    delete abortControllers.value[targetId]
  }
  // 立即清空打字机队列中未输出的内容
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant') {
    flushTypewriter(last)
    if (last.content === LOADING_DOTS) {
      last.content = '已停止生成。'
    }
  }
}

// 发送文本消息：创建/复用对话 → 调用流式 API → 逐字输出
async function sendText() {
  const query = input.value.trim()
  if (!query) return
  const _pendingId = currentConvId.value || '__pending__'
  if (loadingConvIds.value.has(_pendingId)) return
  loadingConvIds.value.add(_pendingId)

  input.value = ""
  if (currentConvId.value) { delete draftInputs[currentConvId.value] } else { delete draftInputs["__new__"] }
  messages.value.push({ role: "user", content: query })
  await scrollToBottom()

  await ensureConversation()
  const _convId = currentConvId.value
  loadingConvIds.value.delete(_pendingId)
  loadingConvIds.value.add(_convId)
  activeStreamConvId.value = _convId

  await scrollToBottom()

  try {
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
    const _asstMsg = { role: 'assistant', content: LOADING_DOTS, thinkingChain: [], thinkingExpanded: false }
    messages.value.push(_asstMsg)
    const asstMsgProxy = messages.value[messages.value.length - 1]
    const _isActive = () => currentConvId.value === _convId
    const controller = new AbortController(); abortControllers.value[_convId] = controller
    await chatStream(query, history, controller.signal, {
      onThinking(label) {
        _localSteps.push({ type: 'tool', label })
        if (_isActive()) {
          thinkingSteps.value = [..._localSteps]
        } else {
          if (!streamMessageCache.value[_convId]) {
            streamMessageCache.value = {
              ...streamMessageCache.value,
              [_convId]: { messages: [...messages.value], thinkingSteps: [] },
            }
          }
          streamMessageCache.value = {
            ...streamMessageCache.value,
            [_convId]: { ...streamMessageCache.value[_convId], thinkingSteps: [..._localSteps] },
          }
        }
      },
      onReasoning(text) {
        const steps = _localSteps
        if (steps.length && steps[steps.length - 1].type === 'reasoning') {
          steps[steps.length - 1].label = text
        } else {
          steps.push({ type: 'reasoning', label: text })
        }
        if (_isActive()) {
          thinkingSteps.value = [..._localSteps]
        } else {
          if (!streamMessageCache.value[_convId]) {
            streamMessageCache.value = {
              ...streamMessageCache.value,
              [_convId]: { messages: [...messages.value], thinkingSteps: [] },
            }
          }
          streamMessageCache.value = {
            ...streamMessageCache.value,
            [_convId]: { ...streamMessageCache.value[_convId], thinkingSteps: [..._localSteps] },
          }
        }
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
        if (_isActive()) {
          if (asstMsgProxy.fullContent && (!asstMsgProxy.content || asstMsgProxy.content === LOADING_DOTS)) {
            asstMsgProxy.content = asstMsgProxy.fullContent
          }
          appendToTypewriter(asstMsgProxy, content, _isActive, scrollToBottom)
        } else {
          if (asstMsgProxy.content === LOADING_DOTS) asstMsgProxy.content = ''
          if (typeof asstMsgProxy.fullContent !== 'string') asstMsgProxy.fullContent = asstMsgProxy.content || ''
          asstMsgProxy.fullContent += content
        }
      },
      async onDone(data) {
        if (_isActive()) {
          flushTypewriter(asstMsgProxy)
        } else {
          asstMsgProxy.content = asstMsgProxy.fullContent || asstMsgProxy.content
        }
        asstMsgProxy.thinkingChain = [..._localSteps]
        asstMsgProxy.thinkingExpanded = false
        if (_isActive()) {
          thinkingSteps.value = [..._localSteps]
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
    loadingConvIds.value.delete(_convId)
    delete abortControllers.value[_convId]
    activeStreamConvId.value = null
    const newCache = { ...streamMessageCache.value }
    delete newCache[_convId]
    streamMessageCache.value = newCache
    await scrollToBottom()
  }
}

// ---- 文件选择 ----
// 文件上传回调：暂存文件引用到 pendingFile
function handleFileChange(file) {
  pendingFile.value = file.raw
}

// ---- 合同审查发送 ----
// 发送文件审查：上传合同 → 调用合同审查流式 API → 展示结果
async function sendFile(instruction = null) {
  if (!pendingFile.value) return
  const _pendingId = currentConvId.value || '__pending__'
  if (loadingConvIds.value.has(_pendingId)) return
  loadingConvIds.value.add(_pendingId)

  const displayContent = instruction
    ? `📄 上传合同：${pendingFile.value.name}\n${instruction}`
    : `📄 上传合同：${pendingFile.value.name}`
  const _userDisplayContent = displayContent

  await ensureConversation()
  const _convId = currentConvId.value
  loadingConvIds.value.delete(_pendingId)
  loadingConvIds.value.add(_convId)
  activeStreamConvId.value = _convId

  messages.value.push({
    role: 'user',
    content: displayContent,
    file: pendingFile.value,
  })
  const fileToSend = pendingFile.value
  pendingFile.value = null
  input.value = ''
  if (_convId) { delete draftInputs[_convId]; delete draftFiles[_convId] } else { delete draftInputs['__new__']; delete draftFiles['__new__'] }
  await scrollToBottom()

  try {
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
    const _asstMsg = { role: 'assistant', content: LOADING_DOTS, thinkingChain: [], thinkingExpanded: false }
    messages.value.push(_asstMsg)
    const asstMsgProxy = messages.value[messages.value.length - 1]
    const _isActive = () => currentConvId.value === _convId
    const controller2 = new AbortController(); abortControllers.value[_convId] = controller2
    await analyzeContractStream(fileToSend, controller2.signal, {
      onThinking(label) {
        _localSteps.push({ type: 'tool', label })
        if (_isActive()) {
          thinkingSteps.value = [..._localSteps]
        } else {
          if (!streamMessageCache.value[_convId]) {
            streamMessageCache.value = {
              ...streamMessageCache.value,
              [_convId]: { messages: [...messages.value], thinkingSteps: [] },
            }
          }
          streamMessageCache.value = {
            ...streamMessageCache.value,
            [_convId]: { ...streamMessageCache.value[_convId], thinkingSteps: [..._localSteps] },
          }
        }
      },
      onReasoning(text) {
        const steps = _localSteps
        if (steps.length && steps[steps.length - 1].type === 'reasoning') {
          steps[steps.length - 1].label = text
        } else {
          steps.push({ type: 'reasoning', label: text })
        }
        if (_isActive()) {
          thinkingSteps.value = [..._localSteps]
        } else {
          if (!streamMessageCache.value[_convId]) {
            streamMessageCache.value = {
              ...streamMessageCache.value,
              [_convId]: { messages: [...messages.value], thinkingSteps: [] },
            }
          }
          streamMessageCache.value = {
            ...streamMessageCache.value,
            [_convId]: { ...streamMessageCache.value[_convId], thinkingSteps: [..._localSteps] },
          }
        }
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
        if (_isActive()) {
          if (asstMsgProxy.fullContent && (!asstMsgProxy.content || asstMsgProxy.content === LOADING_DOTS)) {
            asstMsgProxy.content = asstMsgProxy.fullContent
          }
          appendToTypewriter(asstMsgProxy, content, _isActive, scrollToBottom)
        } else {
          if (asstMsgProxy.content === LOADING_DOTS) asstMsgProxy.content = ''
          if (typeof asstMsgProxy.fullContent !== 'string') asstMsgProxy.fullContent = asstMsgProxy.content || ''
          asstMsgProxy.fullContent += content
        }
      },
      async onDone(data) {
        if (_isActive()) {
          flushTypewriter(asstMsgProxy)
        } else {
          asstMsgProxy.content = asstMsgProxy.fullContent || asstMsgProxy.content
        }
        asstMsgProxy.thinkingChain = [..._localSteps]
        asstMsgProxy.thinkingExpanded = false
        asstMsgProxy.contractData = data
        pushContractAttach(asstMsgProxy, data, fileToSend)
        if (_isActive()) {
          thinkingSteps.value = [..._localSteps]
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
    loadingConvIds.value.delete(_convId)
    activeStreamConvId.value = null
    const newCache = { ...streamMessageCache.value }
    delete newCache[_convId]
    streamMessageCache.value = newCache
    await scrollToBottom()
  }
}

// 更新钉住的高亮气泡位置
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

// 合同预览区点击事件：钉住/取消气包
function onContractClick(e) {
  const mark = e.target.closest('mark')
  if (!mark) return
  if (pinnedMark === mark) {
    // 取消钉住
    pinnedMark.classList.remove('pinned')
    pinnedMark = null
    if (tooltipEl) {
      tooltipEl.style.opacity = '0'
      tooltipEl.style.pointerEvents = 'none'
    }
    if (pinnedScrollHandler) {
      document.querySelector('.preview-body')?.removeEventListener('scroll', pinnedScrollHandler)
      pinnedScrollHandler = null
    }
  } else {
    // 取消钉住 previous
    if (pinnedMark) {
      pinnedMark.classList.remove('pinned')
      if (pinnedScrollHandler) {
        document.querySelector('.preview-body')?.removeEventListener('scroll', pinnedScrollHandler)
      }
    }
    // 钉住当前标记
    pinnedMark = mark
    mark.classList.add('pinned')
    // 立即显示气泡（跳过防抖）
    if (tooltipEl) {
      tooltipEl.style.opacity = '1'
      tooltipEl.style.pointerEvents = 'auto'
    }
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

  // 拖拽分割条时禁用文本选择
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

// 合同预览区悬停事件：显示高亮气泡
function onContractHover(e) {
  const mark = e.target.closest('mark')
  if (!mark || !tooltipEl) return
  // 如果已有其他标记被钉住，不抢占气泡
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
  // 以预览面板边界作为可视区域
  const panel = document.querySelector('.preview-panel')
  const panelRect = panel ? panel.getBoundingClientRect() : { left: 0, right: window.innerWidth }
  const tipW = tooltipEl.offsetWidth
  const tipH = tooltipEl.offsetHeight
  const gap = 8
  // 居中于标记上方，限制在预览面板内
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
    if (!pinnedMark) {
      tooltipEl.style.opacity = '0'
      tooltipEl.style.pointerEvents = 'none'
    }
  }, 100)
}

onMounted(() => {
  checkNarrow()
  window.addEventListener("resize", checkNarrow)
  watch(showPreview, (val) => {
    nextTick(checkNarrow)
    if (!val && pinnedMark) {
      pinnedMark.classList.remove("pinned")
      if (tooltipEl) tooltipEl.style.pointerEvents = "none"
      pinnedMark = null
      if (tooltipEl) {
      tooltipEl.style.opacity = "0"
      tooltipEl.style.pointerEvents = "none"
    }
      if (pinnedScrollHandler) {
        document.querySelector(".preview-body")?.removeEventListener("scroll", pinnedScrollHandler)
        pinnedScrollHandler = null
      }
    }
  })
  refreshConvList()
  tooltipEl = document.createElement('div')
  tooltipEl.className = 'contract-tooltip'
  tooltipEl.style.cssText = 'display:block;opacity:0;pointer-events:none;transition:opacity 0.15s ease;position:fixed;z-index:9999;max-width:300px;padding:10px 14px;background:#fff;color:#303133;font-size:14px;line-height:1.6;border-radius:10px;white-space:normal;word-break:break-word;box-shadow:0 4px 20px rgba(0,0,0,0.15);font-family:"Microsoft YaHei",sans-serif;'
  document.body.appendChild(tooltipEl)
})

onUnmounted(() => {
  window.removeEventListener("resize", checkNarrow)
  if (tooltipEl) {
    tooltipEl.remove()
    tooltipEl = null
  }
})

// 将合同审查结果挂载到消息对象上
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

// 打开合同预览面板
function openContractPreview(msg) {
  previewData.value = msg.contractData
  showPreview.value = true
}

</script>

<style scoped>
/* 滚动条 */
.chat-messages::-webkit-scrollbar,.conv-list::-webkit-scrollbar,.preview-body::-webkit-scrollbar{width:6px}
.chat-messages::-webkit-scrollbar-track,.conv-list::-webkit-scrollbar-track,.preview-body::-webkit-scrollbar-track{background:transparent}
.chat-messages::-webkit-scrollbar-thumb,.conv-list::-webkit-scrollbar-thumb,.preview-body::-webkit-scrollbar-thumb{background:#d0d5dd;border-radius:3px}
.chat-messages::-webkit-scrollbar-thumb:hover,.conv-list::-webkit-scrollbar-thumb:hover,.preview-body::-webkit-scrollbar-thumb:hover{background:#b0b5bd}
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
  position: relative;
}
.chat-panel.with-preview {
  flex: 0 0 calc(var(--split-ratio) * 100%);
  min-width: 280px;
}
.chat-header {
  position: relative;
  z-index: 20;
  padding: 10px 20px;
  min-height: 56px;
  box-sizing: border-box;
  background: #fff;
  color: #303133;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  border-bottom: 1px solid #ebeef5;
}

.toggle-btn{flex-shrink:0;width:36px;height:36px;padding:0!important;border-radius:8px}.toggle-btn:hover{background:#f0f2f5!important}.toggle-btn :deep(.el-icon){font-size:20px}.new-chat-header-btn{margin-left:0;margin-right:10px;flex-shrink:0;width:36px;height:36px;padding:0!important;border-radius:8px}.new-chat-header-btn:hover{background:#f0f2f5!important}.new-chat-header-btn :deep(.el-icon){font-size:20px}
.chat-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.subtitle {
  font-size: 13px;
  color: #909399;
  margin-left: 20px;
}

/* 欢迎页 */
.welcome-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  background: radial-gradient(circle at 20% 50%, rgba(64,158,255,0.03) 0%, transparent 50%), radial-gradient(circle at 80% 50%, rgba(64,158,255,0.03) 0%, transparent 50%), #f8f9fb;
}
.welcome-content {
  position: absolute;
  bottom: calc(50% + 120px);
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  max-width: 480px;
  padding: 0 24px;
}
.welcome-content h1 {
  font-size: 32px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 16px;
  letter-spacing: -0.5px;
}
.welcome-content p {
  font-size: 15px;
  color: #86909c;
  margin: 0;
  line-height: 1.6;
}
.chat-messages {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px 20px 140px 20px;
  background: #f8f9fb;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.chat-messages > * {
  width: 100%;
  max-width: 768px;
}
.message {
  margin-bottom: 24px;
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
.msg-file-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding: 10px 12px;
  background: #f5f7fa;
  border: 1px solid #e8eaed;
  border-radius: 10px;
  max-width: 100%;
}
.msg-file-card-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e6f0ff;
  border-radius: 8px;
  color: #409eff;
  font-size: 18px;
  flex-shrink: 0;
}
.msg-file-card-name {
  font-size: 14px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-content {
  display: block;
  width: fit-content;
  max-width: 90%;
  padding: 10px 16px;
  border-radius: 16px;
  line-height: 1.7;
  font-size: 15px;
  overflow: hidden;
}
.message.user .message-content {
  background: #dfedff;
  color: #1d2129;
  max-width: 75%;
}
.message.assistant .message-content {
  background: transparent;
  box-shadow: none;
  max-width: 100%;
  padding: 0 4px;
  user-select: text;
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
/* 防止代码块在流式输出时溢出 */
.message-content :deep(pre),
.message-content :deep(code) {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.contract-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 20px 0;
  padding: 14px 16px;
  background: #f5f7fa;
  border: 1px solid #e8eaed;
  border-radius: 12px;
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.contract-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  border-color: #d0d5dd;
}
.contract-card-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e6f0ff;
  border-radius: 10px;
  color: #409eff;
  font-size: 22px;
  flex-shrink: 0;
}
.contract-card-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}
.contract-card-title {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}
.contract-card-hint {
  font-size: 12px;
  color: #909399;
}
.contract-card-arrow {
  color: #c0c4cc;
  font-size: 16px;
  flex-shrink: 0;
  transition: color 0.2s;
}
.contract-card:hover .contract-card-arrow {
  color: #409eff;
}

.contract-card-pop-enter-active {
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
.contract-card-pop-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.contract-card-pop-enter-from {
  opacity: 0;
  transform: translateY(12px);
  max-height: 0;
  margin-top: 0;
  padding-top: 0;
  padding-bottom: 0;
}
.contract-card-pop-enter-to {
  opacity: 1;
  transform: translateY(0);
  max-height: 80px;
}
.contract-card-pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
  max-height: 0;
  margin-top: 0;
  padding-top: 0;
  padding-bottom: 0;
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
  bottom: 12px;
  right: 14px;
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
  margin-bottom: 12px;
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
.chat-input-anchor {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 16px;
  z-index: 10;
  transition: bottom 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.chat-input-anchor.input-floating {
  bottom: 50%;
}
.chat-input-area {
  transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  padding: 0 20px;
  background: transparent;
  display: flex;
  justify-content: center;
}
.chat-input-anchor.input-floating .chat-input-area {
  transform: translateY(50%);
}
.chat-input-anchor.input-floating.has-file .chat-input-area {
  transform: translateY(calc(50% + 30px));
}
.chat-input-area .input-row {
  max-width: 800px;
  width: 100%;
}
.chat-input-area .input-wrapper {
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.08);
  padding: 6px 10px 6px 14px;
}
.chat-input-area :deep(.el-textarea__inner) {
  border: none !important;
  box-shadow: none !important;
}
.chat-input-area :deep(.el-textarea__inner:focus) {
  border: none !important;
  box-shadow: none !important;
}
.input-wrapper.is-sending {
  background: #f5f7fa;
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
  font-size: 15px;
}
.input-actions {
  position: absolute;
  bottom: 12px;
  left: 15px;
  right: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.input-row .el-textarea {
  flex: 1;
}
.send-btn{width:36px!important;height:36px!important;padding:0!important;border-radius:50%!important;border:none!important;background:#409eff!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-width:0!important;flex-shrink:0}
.send-btn:hover{background:#337ecc!important}
.send-btn.is-disabled{background:#a0cfff!important}
.send-btn :deep(.el-icon){color:#fff;font-size:20px;font-weight:900;stroke:#fff;stroke-width:60;display:flex;align-items:center;justify-content:center;line-height:1}
.send-btn :deep(.el-icon svg){stroke:#fff;stroke-width:48px}
.stop-btn{width:36px!important;height:36px!important;padding:0!important;border-radius:50%!important;border:none!important;background:#e34d59!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-width:0!important;flex-shrink:0}
.stop-btn:hover{background:#c93542!important}
.stop-square{width:12px;height:12px;background:#fff;border-radius:2px}
.upload-btn{width:32px!important;height:32px!important;padding:0!important;border:none!important;color:#909399!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-width:0!important;border-radius:50%!important;flex-shrink:0}
.upload-btn:hover{color:#409eff!important;background:#ecf5ff!important}
.upload-btn.is-disabled{color:#c0c4cc!important}
.upload-btn .el-icon{font-size:18px}
.file-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  max-width: 100%;
  padding: 10px 12px;
  background: #f5f7fa;
  border-radius: 10px;
  font-size: 14px;
}
.file-card-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e6f0ff;
  border-radius: 8px;
  color: #409eff;
  font-size: 18px;
  flex-shrink: 0;
}
.file-card-name {
  flex: 1;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-card-close {
  width: 28px !important;
  height: 28px !important;
  padding: 0 !important;
  border: none !important;
  color: #909399 !important;
  min-width: 0 !important;
  flex-shrink: 0;
}
.file-card-close:hover {
  color: #606266 !important;
  background: rgba(0,0,0,0.05) !important;
  border-radius: 50% !important;
}

.file-expand-enter-active {
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
.file-expand-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
.file-expand-enter-from,
.file-expand-leave-to {
  opacity: 0;
  max-height: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
}
.file-expand-enter-to,
.file-expand-leave-from {
  opacity: 1;
  max-height: 64px;
}


/* 思维链 */
.thinking-chain {
  margin-bottom: 12px;
}
.thinking-summary.persisted {
  color: #606266;
  background: transparent;
  cursor: pointer;
}
.thinking-summary.persisted:hover {
  background: transparent;
  color: #409eff;
}
.thinking-summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  background: transparent;
  border-radius: 0;
  cursor: pointer;
  font-size: 15px;
  color: #4a6cf7;
  user-select: none;
  line-height: 1.3;
}
.thinking-dot {
  width: 10px;
  height: 10px;
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
  font-size: 14px;
  display: inline-flex;
  align-items: baseline;
}
.thinking-arrow .el-icon {
  font-size: 14px;
  padding-top: 1px;
  display: inline-block;
  will-change: transform;
  transition: transform 0.2s ease;
}
.thinking-arrow .el-icon.rotated {
  transform: rotate(90deg);
}
.thinking-details {
  margin-top: 4px;
  padding: 4px 0;
  background: transparent;
  border-radius: 0;
}
.thinking-step {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 3px 0;
  font-size: 14px;
  color: #909399;
  line-height: 1.4;
}
.thinking-step-icon :deep(svg) { vertical-align: middle; }
.thinking-step-icon :deep(svg) { vertical-align: middle; }
.thinking-step-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #909399;
  font-size: 15px;
  line-height: 1.4;
  padding-top: 3px;
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
  background: linear-gradient(180deg, #f8f9fb 0%, #fff 6%);
  border-left: 1px solid #ebeef5;
  box-shadow: -2px 0 12px rgba(0,0,0,0.06);
}
.preview-header {
  padding: 10px 20px;
  min-height: 56px;
  box-sizing: border-box;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
}
.preview-header span {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}
.preview-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}
.contract-text {
  font-family: 'SimSun', '宋体', serif;
  font-size: 17px;
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
.contract-text :deep(mark.risk-high)   { background: #eb9e9e; }
.contract-text :deep(mark.risk-medium) { background: #fae198; }
.contract-text :deep(mark.risk-low)    { background: #d8d9db; }
.contract-text :deep(mark):hover { filter: brightness(0.88); }

.preview-legend {
  padding: 10px 16px;
  border-top: 1px solid #ebeef5;
  display: flex;
  gap: 18px;
  font-size: 14px;
  color: #909399;
  flex-shrink: 0;
}
.legend-item { display: flex; align-items: center; gap: 4px; }
.legend-dot { width: 12px; height: 12px; border-radius: 2px; }
.legend-dot.high   { background: rgba(220, 80, 80, 0.85); }
.legend-dot.medium { background: rgba(245, 195, 50, 0.85); }
.legend-dot.low    { background: rgba(144, 147, 153, 0.65); }

/* 右侧滑入动画 */
.slide-enter-active, .slide-leave-active { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
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
  background: #f5f6f8;
  border-right: 1px solid #e8eaed;
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
.sidebar-close-btn{flex-shrink:0;width:36px;height:36px;padding:0!important;border-radius:8px}.sidebar-close-btn:hover{background:#e8ecf1!important}.sidebar-close-btn :deep(.el-icon){font-size:20px}
.search-input {
  --el-input-height: 36px;
  --el-input-inner-height: 36px;
}
.search-input :deep(.el-input__wrapper) {
  border-radius: 10px;
  box-shadow: none;
}
.search-icon {
  margin-left: 0px;
  margin-right: 8px;
  color: #909399;
  font-size: 18px;
}
.search-clear-btn {
  font-size: 14px;
  color: #909399;
  cursor: pointer;
  padding: 2px;
  line-height: 1;
}
.search-clear-btn:hover {
  color: #606266;
}
.new-chat-btn {
  margin: 12px;
  width: calc(100% - 24px);
  height: 40px;
  border-radius: 10px;
  border: 1px solid #e4e7ed;
  background: #fff;
  color: #303133;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  font-size: 14px;
}
.new-chat-btn:hover {
  background: #f0f2f5;
  color: #303133;
  border-color: #dcdfe6;
}
.new-chat-btn :deep(.el-icon) {
  font-size: 18px;
  margin-right: 10px;
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
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 2px;
  transition: background 0.15s;
  position: relative;
}
.conv-item:hover { background: #e8ecf1; }
.conv-item.active {
  background: #e2e8f0;
  border-left: 3px solid #409eff;
  padding-left: 9px;
  border-radius: 0 8px 8px 0;
}
.conv-title {
  flex: 1;
  font-size: 14px;
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
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1);
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


.contract-text :deep(mark.pinned) {
  outline: 2px solid #409EFF;
  outline-offset: 1px;
  filter: brightness(0.85);
}

</style>

<style>
/* 统一弹出菜单样式（去除箭头，圆角框） */
.menu-pop {
  padding: 0 !important;
  min-width: 130px !important;
  border-radius: 10px !important;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12) !important;
  border: 1px solid #e8eaed !important;
}
.menu-pop .el-popper__arrow {
  display: none !important;
}
.menu-pop .el-dropdown-menu {
  padding: 4px 0 !important;
  border-radius: 10px !important;
  overflow: hidden !important;
}
.menu-pop .el-dropdown-menu__item {
  font-size: 13px;
  padding: 8px 8px;
  margin: 0 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
}
.menu-pop .el-dropdown-menu__item:hover {
  background: #f5f7fa;
}
.menu-pop .el-dropdown-menu__item .el-icon {
  font-size: 16px;
}
</style>
