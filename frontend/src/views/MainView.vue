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
              <span v-if="searchText" class="search-clear-btn" @click.stop="searchText = ''"
                >✕</span
              >
            </template>
          </el-input>
          <el-button text size="small" class="sidebar-close-btn" @click="closeSidebar"
            ><el-icon><Fold /></el-icon
          ></el-button>
        </div>
        <el-button class="new-chat-btn" @click="newChat">
          <el-icon><Edit /></el-icon> 开启新对话
        </el-button>
        <div v-if="filteredConvs.length" class="conv-list">
          <div
            v-for="conv in filteredConvs"
            :key="conv.id"
            :class="['conv-item', { active: conv.id === currentConvId }]"
            @click="loadConversation(conv.id)"
          >
            <span v-if="renamingConvId !== conv.id" class="conv-title">{{ conv.title }}</span>
            <input
              v-else
              :key="renameSession.key"
              :data-rename-key="renameSession.key"
              v-model="renameText"
              class="conv-title-input"
              @keydown.enter="finishRename(conv.id, $event)"
              @keydown.esc="cancelRename($event)"
              @blur="finishRename(conv.id, $event)"
              @click.stop
              ref="renameInput"
            />
            <el-dropdown
              v-if="renamingConvId !== conv.id"
              trigger="click"
              popper-class="menu-pop"
              @command="
                (cmd) => (cmd === 'rename' ? startRename(conv.id) : handleDeleteConv(conv.id))
              "
              @visible-change="(v) => (sidebarMenuConvId = v ? conv.id : null)"
            >
              <span
                :class="['conv-more', { 'conv-more-visible': sidebarMenuConvId === conv.id }]"
                @click.stop
                ><el-icon><MoreFilled /></el-icon
              ></span>
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
        </div>
        <div v-if="!filteredConvs.length" class="conv-empty-wrap">
          <span class="conv-empty">暂无历史对话</span>
        </div>
      </div>
    </transition>
    <div class="main-area">
      <!-- 左侧：对话区 -->
      <div
        class="chat-panel"
        :class="{
          'with-preview': showPreview && !isNarrow,
          'hidden-narrow': showPreview && isNarrow,
        }"
      >
        <div ref="chatHeader" class="chat-header">
          <template v-if="!sidebarVisible">
            <el-button :icon="Expand" text size="small" class="toggle-btn" @click="openSidebar" />
            <el-button
              text
              size="small"
              class="new-chat-header-btn"
              @click="newChat"
              title="新对话"
            >
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
                  :disabled="editSession?.saving"
                  @keydown.esc="cancelEdit"
                />
                <div class="edit-actions">
                  <el-button
                    size="small"
                    text
                    :disabled="editSession?.submitted"
                    @click="cancelEdit"
                    >取消</el-button
                  >
                  <el-button
                    size="small"
                    type="primary"
                    :loading="editSession?.saving"
                    @click="saveEdit"
                    >保存</el-button
                  >
                </div>
              </div>
            </div>
            <template v-else>
              <div v-if="msg.role === 'user' && msg.file" class="msg-file-card">
                <div class="msg-file-card-icon"
                  ><el-icon><Document /></el-icon
                ></div>
                <span class="msg-file-card-name">{{ msg.file.name }}</span>
              </div>
              <!-- 思维链：流式输出时实时展示，或持久化保存 -->
              <div
                v-if="
                  msg.role === 'assistant' &&
                  loading &&
                  (regeneratingMessage ? msg === regeneratingMessage : i === messages.length - 1)
                "
                class="thinking-chain"
              >
                <div class="thinking-summary" @click="msg.thinkingExpanded = !msg.thinkingExpanded">
                  <span class="thinking-dot" />
                  <span>{{ thinkingLabel }}</span>
                  <span class="thinking-arrow"
                    ><el-icon :class="{ rotated: msg.thinkingExpanded }"><ArrowRight /></el-icon
                  ></span>
                </div>
                <div v-if="msg.thinkingExpanded" class="thinking-details">
                  <div v-for="(step, si) in thinkingSteps" :key="si" class="thinking-step">
                    <span class="thinking-step-icon">
                      <el-icon v-if="step.type === 'tool'"><Search /></el-icon>
                      <el-icon v-else-if="step.type === 'reasoning'"><ChatDotRound /></el-icon>
                      <el-icon v-else><CircleCheck /></el-icon>
                    </span>
                    <span class="thinking-step-text"
                      >{{ cleanFences(step.label)
                      }}{{ step.snippet ? '：\n' + step.snippet : '' }}</span
                    >
                  </div>
                </div>
              </div>
              <div v-else-if="msg.thinkingChain?.length" class="thinking-chain">
                <div
                  class="thinking-summary persisted"
                  @click="msg.thinkingExpanded = !msg.thinkingExpanded"
                >
                  <span
                    >{{
                      msg.thinkingChain.filter((s) => s.type === 'tool' || s.type === 'reasoning')
                        .length
                    }}
                    次思考步骤</span
                  >
                  <span class="thinking-arrow"
                    ><el-icon :class="{ rotated: msg.thinkingExpanded }"><ArrowRight /></el-icon
                  ></span>
                </div>
                <div v-if="msg.thinkingExpanded" class="thinking-details">
                  <div v-for="(step, si) in msg.thinkingChain" :key="si" class="thinking-step">
                    <span class="thinking-step-icon">
                      <el-icon v-if="step.type === 'tool'"><Search /></el-icon>
                      <el-icon v-else-if="step.type === 'reasoning'"><ChatDotRound /></el-icon>
                      <el-icon v-else><CircleCheck /></el-icon>
                    </span>
                    <span class="thinking-step-text"
                      >{{ cleanFences(step.label)
                      }}{{ step.snippet ? '：\n' + step.snippet : '' }}</span
                    >
                  </div>
                </div>
              </div>
              <div
                class="message-content"
                v-html="renderMd(msg.regenerationDraft?.content ?? msg.content)"
              />
            </template>
            <transition name="contract-card-pop">
              <div
                v-if="msg.contractRawText"
                class="contract-card"
                @click="openContractPreview(msg)"
              >
                <div class="contract-card-icon"
                  ><el-icon><Document /></el-icon
                ></div>
                <div class="contract-card-body">
                  <span class="contract-card-title">合同原文 · 风险标注</span>
                  <span class="contract-card-hint">点击查看高亮标注</span>
                </div>
                <el-icon class="contract-card-arrow"><ArrowRight /></el-icon>
              </div>
            </transition>
            <div
              v-if="msg.role === 'assistant' && editingIndex === -1"
              :class="[
                'msg-actions',
                'msg-actions-left',
                { 'msg-actions-visible': dropdownOpenIndex === i },
              ]"
            >
              <el-dropdown
                trigger="click"
                popper-class="menu-pop"
                @command="(cmd) => copyMessage(i, cmd === 'md')"
                @visible-change="(v) => (dropdownOpenIndex = v ? i : -1)"
              >
                <span class="action-btn" title="复制"
                  ><el-icon><CopyDocument /></el-icon
                ></span>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="text">复制纯文本</el-dropdown-item>
                    <el-dropdown-item command="md">复制 Markdown</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <span class="action-btn" title="重新生成" @click="regenerateMessage(i)"
                ><el-icon><Refresh /></el-icon
              ></span>
              <span class="action-btn" title="删除" @click="deleteMessage(i)"
                ><el-icon><Delete /></el-icon
              ></span>
            </div>
            <div
              v-if="msg.role === 'user' && editingIndex !== i"
              :class="[
                'msg-actions',
                'msg-actions-right',
                { 'msg-actions-visible': dropdownOpenIndex === i },
              ]"
            >
              <el-dropdown
                trigger="click"
                popper-class="menu-pop"
                @command="(cmd) => copyMessage(i, cmd === 'md')"
                @visible-change="(v) => (dropdownOpenIndex = v ? i : -1)"
              >
                <span class="action-btn" title="复制"
                  ><el-icon><CopyDocument /></el-icon
                ></span>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="text">复制纯文本</el-dropdown-item>
                    <el-dropdown-item command="md">复制 Markdown</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <span class="action-btn" title="编辑" @click="editMessage(i)"
                ><el-icon><EditPen /></el-icon
              ></span>
              <span class="action-btn" title="删除" @click="deleteMessage(i)"
                ><el-icon><Delete /></el-icon
              ></span>
            </div>
          </div>
        </div>

        <div
          class="chat-input-anchor"
          :class="{ 'input-floating': messages.length === 0, 'has-file': pendingFile }"
          ><div class="chat-input-area">
            <transition name="fade">
              <div v-if="showScrollBtn" class="scroll-bottom-btn" @click="scrollToBottom">
                <el-icon><ArrowDown /></el-icon>
              </div>
            </transition>
            <div class="input-row">
              <div class="input-wrapper" :class="{ 'is-sending': loading }">
                <transition name="file-expand">
                  <div v-if="pendingFile" class="file-card">
                    <div class="file-card-icon"
                      ><el-icon><Document /></el-icon
                    ></div>
                    <span class="file-card-name">{{ pendingFile.name }}</span>
                    <el-button text size="small" class="file-card-close" @click="pendingFile = null"
                      ><el-icon><Close /></el-icon
                    ></el-button>
                  </div>
                </transition>
                <el-input
                  v-model="input"
                  type="textarea"
                  :autosize="{ minRows: 3, maxRows: 8 }"
                  placeholder="输入法律问题，或上传合同文件进行审查..."
                  :disabled="loading || historyLoading"
                  @keydown.enter.exact.prevent="handleSend"
                />
                <div class="input-actions">
                  <el-upload
                    ref="fileUploadRef"
                    :auto-upload="false"
                    :show-file-list="false"
                    :on-change="handleFileChange"
                    accept=".pdf,.doc,.docx,.txt"
                  >
                    <el-button
                      text
                      size="small"
                      class="upload-btn"
                      :disabled="loading || historyLoading"
                      ><el-icon><Plus /></el-icon
                    ></el-button>
                  </el-upload>
                  <el-button
                    v-if="!loading"
                    size="small"
                    :disabled="!canSend"
                    @click="handleSend"
                    class="send-btn"
                    ><el-icon><Top /></el-icon
                  ></el-button>
                  <el-button v-else size="small" @click="stopGeneration(pageKey())" class="stop-btn"
                    ><span class="stop-square"></span
                  ></el-button>
                </div>
              </div>
            </div> </div
        ></div>
        <div v-if="frostedOverlay" class="frosted-overlay" @click="closeSidebar" />
      </div>

      <!-- 拖拽分隔条 -->
      <div
        v-if="showPreview"
        class="split-divider"
        :class="{ active: dragging }"
        @mousedown="onDividerDragStart"
      ></div>
      <transition name="slide">
        <div v-if="showPreview" :class="['preview-panel', { 'preview-fullscreen': isNarrow }]">
          <div class="preview-header">
            <span>合同原文 · 风险标注</span>
            <el-button
              :icon="Close"
              text
              size="small"
              class="preview-close-btn"
              @click="showPreview = false"
            />
          </div>
          <div class="preview-body">
            <div
              class="contract-text"
              v-html="highlightedContract"
              @click="onContractClick"
              @mouseover="onContractHover"
              @mouseout="onContractLeave"
            />
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
  <!-- 确认弹窗（毛玻璃 + 圆角框） -->
  <teleport to="body">
    <transition name="confirm-fade">
      <div v-if="confirmState.visible" class="confirm-overlay" @click.self="resolveConfirm(false)">
        <div class="confirm-dialog">
          <p class="confirm-message">{{ confirmState.message }}</p>
          <div class="confirm-actions">
            <el-button class="confirm-cancel-btn" @click="resolveConfirm(false)">{{
              confirmState.cancelText || '取消'
            }}</el-button>
            <el-button type="primary" class="confirm-ok-btn" @click="resolveConfirm(true)">{{
              confirmState.okText || '确定'
            }}</el-button>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup>
import { ref, reactive, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Document,
  Close,
  Plus,
  Delete,
  Expand,
  CopyDocument,
  Refresh,
  Edit,
  MoreFilled,
  ArrowDown,
  Search,
  ChatDotRound,
  CircleCheck,
  Top,
  EditPen,
  Fold,
  ArrowRight,
} from '@element-plus/icons-vue'
import {
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
  saveMessages,
  updateConvTitle,
  chatStream,
  analyzeContractStream,
  regenerateContractStream,
  regenerateChatStream,
  deleteSavedMessage,
  editSavedMessage,
} from '../utils/api'
import { renderHighlightedContract } from '../utils/highlight'
import { getHighlightRect, isSameHighlight, setHighlightPinned } from '../utils/highlightSelection'
import { getContractUploadError } from '../utils/upload'
import { normalizeContractInstruction } from '../utils/contractInstruction'
import { createTypewriterScope } from '../composables/useTypewriter'
import { createConversationRequests, LOADING_DOTS } from '../composables/conversationRequests'
import { createDraftRecovery } from '../composables/draftRecovery'
import { createLatestRead } from '../composables/latestRead'
import { createConversationRenaming } from '../composables/conversationRenaming'
import {
  assignSavedMessageIdentities,
  hasMessageIdentity,
  resolveSavedMessage,
} from '../composables/messageIdentity'
import { MessageEditError, saveUserMessageEdit } from '../composables/messageEditing'
import { ChatRegenerationError, regenerateChatReply } from '../composables/chatRegeneration'
import { pinyinMatch, fuzzyMatch } from '../composables/useSearch'
import { stripMarkdown, cleanFences, renderMd } from '../composables/useTextTools'
import {
  ContractRegenerationError,
  regenerateContractReport,
} from '../composables/contractRegeneration'

// ---- 状态 ----
const { appendToTypewriter, flushTypewriter, dispose: disposeTypewriters } = createTypewriterScope()
const messages = ref([])
const input = ref('')
const draftInputs = {} // 按对话ID记忆输入框草稿
const draftFiles = {} // 按对话ID记忆已选文件
const pendingFile = ref(null)
const fileUploadRef = ref(null)
const chatHeader = ref(null)
const loadingConvIds = ref(new Set())
let nextDraftId = 0
const draftKey = ref(`__draft_${nextDraftId}`)
const historyLoading = ref(false)
const historyReads = createLatestRead()
const conversationListReads = createLatestRead()
const pageKey = () => currentConvId.value || draftKey.value
const loading = computed(() => loadingConvIds.value.has(pageKey()))
const abortControllers = ref({})
const editSession = ref(null)
const messageEditDrafts = new Set()
const pendingMessageEdits = ref(new Set())
const editingIndex = computed(() => {
  const session = editSession.value
  if (!session || !editBelongsToCurrent(session)) return -1
  return messages.value.findIndex(
    (message) =>
      message === session.target || (editTargetId(session) && message.id === editTargetId(session)),
  )
})
const editingText = computed({
  get: () => editSession.value?.text ?? '',
  set: (text) => {
    if (editSession.value) editSession.value.text = text
  },
})
const dropdownOpenIndex = ref(-1)
const confirmState = reactive({ visible: false, message: '', okText: '确定', cancelText: '取消' })
let confirmResolve = null
let confirmationDisposed = false
function showConfirm(message, { okText, cancelText } = {}) {
  // 同时只接收一个确认请求，不能覆盖旧等待者；卸载后不再打开弹窗。
  if (confirmationDisposed || confirmResolve) return Promise.resolve(false)
  return new Promise((resolve) => {
    confirmState.message = message
    confirmState.okText = okText || '确定'
    confirmState.cancelText = cancelText || '取消'
    confirmState.visible = true
    confirmResolve = resolve
  })
}
function resolveConfirm(result) {
  const resolve = confirmResolve
  confirmResolve = null
  confirmState.visible = false
  resolve?.(result === true)
}
const sidebarMenuConvId = ref(null)
const renaming = createConversationRenaming({
  find: (id) => conversations.value.find((conv) => conv.id === id),
  patch: (id, title, expected) => updateConvTitle(id, title, undefined, expected),
  getConversation,
  apply(id, title) {
    const conv = conversations.value.find((item) => item.id === id)
    if (conv) {
      conversationListReads.cancel()
      conv.title = title
    }
  },
  warn: showContractWarning,
  confirm: showConfirm,
  unavailable: (id) => deletedConvIds.has(id) || deletingConvIds.value.has(id),
})
const renameSession = renaming.active
const renamingConvId = computed(() => renameSession.value?.id || null)
const renameText = computed({
  get: () => renameSession.value?.text || '',
  set: (text) => {
    if (renameSession.value) renameSession.value.text = text
  },
})
const streamMessageCache = ref({})
const thinkingSteps = ref([])
const deletingConvIds = ref(new Set())
const pendingConversationDeletions = new Map()
// 页面生命周期内记住已确认删除的身份，阻止迟到的历史或列表响应重新显示它。
const deletedConvIds = new Set()
const deletedMessageIds = new Map()
const confirmedMessageEdits = new Map()
let messageEditVersion = 0
const pendingMessageDeletions = ref(new Set())
const regenerationTasks = new WeakMap()

// 只锁住所属页面的新增与改写，不阻止已有生成继续，也不影响其他会话。
function messageMutationBlocksCurrent() {
  return [...pendingMessageDeletions.value, ...pendingMessageEdits.value].some(
    (operation) =>
      operation.messages === messages.value ||
      (currentConvId.value &&
        (operation.request?.convId || operation.convId) === currentConvId.value),
  )
}
const requests = createConversationRequests({
  currentKey: () => (historyLoading.value ? null : pageKey()),
  canBegin: () => !deletingConvIds.value.has(pageKey()) && !messageMutationBlocksCurrent(),
  messages,
  thinkingSteps,
  loadingIds: loadingConvIds,
  controllers: abortControllers,
  cache: streamMessageCache,
})
const draftRecovery = createDraftRecovery({
  read(owner) {
    if (!historyLoading.value && (currentConvId.value || '__new__') === owner) {
      return { text: input.value, file: pendingFile.value }
    }
    return { text: draftInputs[owner] || '', file: draftFiles[owner] || null }
  },
  write(owner, draft) {
    draftInputs[owner] = draft.text
    draftFiles[owner] = draft.file
    if (!historyLoading.value && (currentConvId.value || '__new__') === owner) {
      input.value = draft.text
      pendingFile.value = draft.file
    }
  },
  canRestore(owner) {
    // 另一个尚未创建完成的新对话也可能正在发送，不能把恢复内容塞进它的输入框。
    return !(owner === '__new__' && !currentConvId.value && loading.value)
  },
})
const regeneratingMessage = computed(() => messages.value.find((message) => message.regenerating))

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

function openSidebar() {
  sidebarOpen.value = true
  forceSidebar.value = isNarrow.value
}

function closeSidebar() {
  sidebarOpen.value = false
  forceSidebar.value = false
}

const sidebarVisible = computed(
  () => sidebarOpen.value && (sidebarFits.value || forceSidebar.value),
)
const frostedOverlay = computed(() => isNarrow.value && forceSidebar.value && sidebarOpen.value)
const filteredConvs = computed(() => {
  if (!searchText.value) return conversations.value
  const q = searchText.value.toLowerCase()
  return conversations.value.filter((c) => {
    const t = c.title.toLowerCase()
    return t.includes(q) || pinyinMatch(c.title, q) || fuzzyMatch(t, q)
  })
})
const splitRatio = ref(0.55)
const dragging = ref(false)
let stopDividerDrag = null
const isNarrow = ref(false)
function checkNarrow() {
  const wasNarrow = isNarrow.value
  // 预览区全屏临界宽度：700px
  isNarrow.value = window.innerWidth < 700
  if (isNarrow.value) stopDividerDrag?.()
  // 侧边栏适配：最小需要侧边栏(260) + 聊天区(400) + 预览区(280)
  const needForSidebar = 260 + 400 + (showPreview.value && !isNarrow.value ? 280 : 0)
  sidebarFits.value = window.innerWidth >= needForSidebar
  if (!isNarrow.value && wasNarrow) forceSidebar.value = false
}
let tooltipEl = null
let pinnedMark = null
let pinnedScrollHandler = null
let pinnedScrollElement = null
let hoverTimer = null

const canSend = computed(
  () =>
    (input.value.trim() || pendingFile.value) &&
    !historyLoading.value &&
    !deletingConvIds.value.has(pageKey()) &&
    !messageMutationBlocksCurrent() &&
    !loadingConvIds.value.has(pageKey()),
)

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
async function refreshConvList(signal) {
  const read = conversationListReads.begin({ signal })
  if (!read) return
  try {
    const result = await listConversations(read.signal)
    if (conversationListReads.isCurrent(read))
      conversations.value = result.filter((conv) => !deletedConvIds.has(conv.id))
  } catch (error) {
    if (!conversationListReads.isCurrent(read)) return
    console.warn('刷新历史对话列表失败，异常类型：', error.name)
  } finally {
    conversationListReads.finish(read)
  }
}
// 创建新对话：保存草稿、缓存活跃对话消息、清空界面
async function newChat() {
  editSession.value = null
  historyReads.cancel()
  historyLoading.value = false
  // 保存当前对话的输入框草稿
  if (currentConvId.value) {
    draftInputs[currentConvId.value] = input.value
  } else {
    draftInputs['__new__'] = input.value
  }
  // 保存当前文件
  if (currentConvId.value) {
    draftFiles[currentConvId.value] = pendingFile.value
  } else {
    draftFiles['__new__'] = pendingFile.value
  }
  // 发送开始时已登记所属缓存；新空白页使用独立临时身份，允许并行创建会话。
  draftKey.value = `__draft_${++nextDraftId}`
  currentConvId.value = null
  messages.value = []
  thinkingSteps.value = []
  showScrollBtn.value = false
  showPreview.value = false
  previewData.value = null
  pendingFile.value = draftFiles['__new__'] || null
  input.value = draftInputs['__new__'] || ''
  draftRecovery.resume('__new__')
}
// 加载历史对话：缓存当前对话 → 恢复目标对话（缓存优先，否则查数据库）
async function loadConversation(id) {
  if (deletedConvIds.has(id) || deletingConvIds.value.has(id)) return
  const read = historyReads.begin({ key: id })
  if (!read) return
  const editVersion = messageEditVersion
  editSession.value = null
  historyLoading.value = true
  showScrollBtn.value = false
  // 保存当前对话的输入框草稿
  if (currentConvId.value) {
    draftInputs[currentConvId.value] = input.value
  } else {
    draftInputs['__new__'] = input.value
  }
  // 保存当前文件
  if (currentConvId.value) {
    draftFiles[currentConvId.value] = pendingFile.value
  } else {
    draftFiles['__new__'] = pendingFile.value
  }
  // 如果目标对话有活跃流，从缓存恢复消息
  if (streamMessageCache.value[id]) {
    const cache = streamMessageCache.value[id]
    messages.value = cache.messages
    thinkingSteps.value = cache.thinkingSteps || []
    currentConvId.value = id
    restoreMessageEdit()
    pendingFile.value = draftFiles[id] || null
    input.value = draftInputs[id] || ''
    showPreview.value = false
    previewData.value = null
    historyLoading.value = false
    draftRecovery.resume(id)
    historyReads.finish(read)
    if (cache.messages.some((message) => message.saveFailed)) {
      showContractWarning(
        '此会话有未确认保存的回复，内容仍保留在页面。请先复制，再刷新会话确认。',
        6500,
      )
    }
    return
  }
  try {
    const conv = await getConversation(id, read.signal)
    if (!historyReads.isCurrent(read) || deletedConvIds.has(id)) return
    currentConvId.value = id
    pendingFile.value = draftFiles[id] || null
    input.value = draftInputs[id] || ''
    const msgs = conv.messages
      .filter((message) => !deletedMessageIds.get(id)?.has(message.id))
      .map((m) => {
        const edited = confirmedMessageEdits.get(id)?.get(m.id)
        const saved = edited?.version > editVersion ? edited : m
        const msg = { id: m.id, revision: saved.revision, role: m.role, content: saved.content }
        if (m.file_name) msg.file = { name: m.file_name }
        const persistedSteps = saved.thinkingChain ?? m.thinking_chain
        if (persistedSteps) {
          try {
            msg.thinkingChain =
              typeof persistedSteps === 'string' ? JSON.parse(persistedSteps) : persistedSteps
            msg.thinkingExpanded = false
          } catch (error) {
            console.warn('解析历史思维链失败', error)
          }
        }
        if (m.contract_data) {
          try {
            const cd =
              typeof m.contract_data === 'string' ? JSON.parse(m.contract_data) : m.contract_data
            msg.contractData = cd
            msg.contractRawText = cd.raw_text || ''
            msg.contractRiskPoints = cd.risk_points || []
          } catch (error) {
            console.warn('解析历史合同审查数据失败', error)
          }
        }
        return msg
      })
    // 跳过以问候语作为首条消息的旧数据（向后兼容）
    if (msgs.length && msgs[0].content && msgs[0].content.includes('AI 法律助手')) {
      msgs.shift()
    }
    messages.value = msgs
    restoreMessageEdit()
    await nextTick()
    if (!historyReads.isCurrent(read)) return
    // DOM 更新后再次复核归属，不能让旧读取滚动或关闭后来切换的页面。
    if (msgContainer.value) msgContainer.value.scrollTop = msgContainer.value.scrollHeight
    showPreview.value = false
    previewData.value = null
  } catch (error) {
    if (historyReads.isCurrent(read)) console.warn('加载历史对话失败，异常类型：', error.name)
  } finally {
    if (historyReads.isCurrent(read)) {
      historyLoading.value = false
      if (currentConvId.value === id) draftRecovery.resume(id)
    }
    historyReads.finish(read)
  }
}
async function startRename(convId) {
  const session = renaming.start(convId)
  if (!session) return
  await nextTick()
  if (renameSession.value !== session) return
  document.querySelector(`.conv-title-input[data-rename-key="${session.key}"]`)?.focus()
}
function finishRename(convId, event) {
  if (event?.isComposing || event?.keyCode === 229) return
  event?.preventDefault?.()
  return renaming.save(convId, event?.currentTarget?.dataset?.renameKey)
}
function cancelRename(event) {
  if (event?.isComposing || event?.keyCode === 229) return
  event?.preventDefault?.()
  renaming.cancel(event?.currentTarget?.dataset?.renameKey)
}

// 删除对话：若为当前对话则清空界面
function forgetConversation(id) {
  conversationListReads.cancel()
  if (historyReads.cancel(id)) historyLoading.value = false
  deletedConvIds.add(id)
  renaming.forget(id)
  deletedMessageIds.delete(id)
  confirmedMessageEdits.delete(id)
  for (const session of messageEditDrafts) {
    if ((session.request?.convId || session.convId) !== id) continue
    session.cancelled = true
    messageEditDrafts.delete(session)
    if (editSession.value === session) editSession.value = null
  }
  const ownedMessages = requests.invalidate(id)
  for (const message of ownedMessages) flushTypewriter(message)
  conversations.value = conversations.value.filter((conv) => conv.id !== id)
  delete draftInputs[id]
  delete draftFiles[id]
  draftRecovery.forget(id)
  if (currentConvId.value === id) {
    // 不取消其他历史加载，也不覆盖新对话草稿。
    currentConvId.value = null
    draftKey.value = `__draft_${++nextDraftId}`
    messages.value = []
    thinkingSteps.value = []
    input.value = draftInputs.__new__ || ''
    pendingFile.value = draftFiles.__new__ || null
    showScrollBtn.value = false
    showPreview.value = false
    previewData.value = null
  }
}

async function handleDeleteConv(id) {
  if (deletedConvIds.has(id) || deletingConvIds.value.has(id) || confirmState.visible) return
  const ok = await showConfirm('删除后不可恢复', { okText: '删除', cancelText: '取消' })
  if (!ok || confirmationDisposed || deletedConvIds.has(id) || deletingConvIds.value.has(id)) return
  deletingConvIds.value.add(id)
  let release
  const outcome = new Promise((resolve) => {
    release = resolve
  })
  pendingConversationDeletions.set(id, outcome)
  let deleted = false
  try {
    await deleteConversation(id)
    deleted = true
    forgetConversation(id)
  } catch (error) {
    console.warn('删除历史对话未获确认，异常类型：', error.name)
    showContractWarning('删除未获确认，页面暂保留原对话，请刷新确认后再操作。')
  } finally {
    pendingConversationDeletions.delete(id)
    deletingConvIds.value.delete(id)
    release()
  }
  if (deleted) await refreshConvList()
}
// 创建结果只绑定原请求；用户已离开时不得切回或占用另一个新对话。
async function ensureConversation(request) {
  if (!request.convId) {
    const conv = await createConversation(request.controller.signal)
    if (typeof conv?.id !== 'string' || !conv.id) throw new Error('会话创建结果缺少有效 ID')
    if (requests.bind(request, conv.id)) currentConvId.value = conv.id
    conversationListReads.cancel()
    conversations.value = [conv, ...conversations.value.filter((item) => item.id !== conv.id)]
  }
  return request.convId
}

// 保存对话消息到后端数据库
async function doSaveMessages(
  overrideConvId,
  userContent,
  assistantContent,
  fileName,
  contractData,
  thinkingChain,
) {
  const _cid = overrideConvId
  if (!_cid) return
  const result = await saveMessages(
    _cid,
    userContent,
    assistantContent,
    fileName,
    contractData,
    thinkingChain,
  )
  await refreshConvList()
  return result
}

// 发送与停止入口分开，旧发送按钮上的连续点击不能被误判为停止。
function handleSend(event) {
  if (
    historyLoading.value ||
    deletingConvIds.value.has(pageKey()) ||
    messageMutationBlocksCurrent() ||
    event?.isComposing
  )
    return
  const _key = pageKey()
  if (loadingConvIds.value.has(_key)) return
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
  if (!msg) return
  const preview = msg.regenerationDraft?.content ?? msg.content
  if (!preview) return
  const raw = typeof preview === 'string' ? preview : ''
  const text = asMarkdown ? raw : stripMarkdown(raw)
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
}

// 固定确认时的消息身份，等所属生成保存后只删除目标，不重建整段历史。
async function deleteMessage(idx) {
  const ownedMessages = messages.value
  const target = ownedMessages[idx]
  if (
    !target ||
    confirmState.visible ||
    messageMutationBlocksCurrent() ||
    deletingConvIds.value.has(pageKey())
  )
    return
  const operation = {
    messages: ownedMessages,
    target,
    convId: currentConvId.value,
    request: requests.findMessage(target),
    regenerationTarget: target.role === 'assistant' ? target : ownedMessages[idx + 1],
  }
  const originalIdentity = hasMessageIdentity(target)
    ? { id: target.id, revision: target.revision }
    : null
  const prompt = operation.request
    ? target.role === 'assistant'
      ? '删除这条回复会停止本轮生成，你的问题和附件消息将保留。删除后不可恢复。'
      : '删除这条问题会停止本轮生成，已收到的回复将保留。删除后不可恢复。'
    : operation.regenerationTarget?.regenerating
      ? '删除这条消息会停止本轮重新生成，其他消息将保留。删除后不可恢复。'
      : '删除后不可恢复'
  const ok = await showConfirm(prompt, { okText: '删除', cancelText: '取消' })
  if (!ok || confirmationDisposed) return
  pendingMessageDeletions.value.add(operation)
  try {
    const request = operation.request
    if (request) {
      request.stopForDeletion = true
      if (request.modelStarted) request.controller.abort()
      await request.task
      if (request.invalidated) return
    }
    const convId = request?.convId || operation.convId
    if (!convId || deletedConvIds.has(convId) || !ownedMessages.includes(target)) return
    const regeneration = regenerationTasks.get(operation.regenerationTarget)
    if (regeneration) {
      abortControllers.value[convId]?.abort()
      await regeneration
    }
    const deletion = pendingConversationDeletions.get(convId)
    if (deletion) await deletion
    if (deletedConvIds.has(convId)) return
    const identity =
      originalIdentity ||
      (await resolveSavedMessage(convId, target, ownedMessages, getConversation))
    const relatedArrays = [ownedMessages, streamMessageCache.value[convId]?.messages]
    if (currentConvId.value === convId) relatedArrays.push(messages.value)
    const preserveEmpty = relatedArrays.some((array) =>
      array?.some(
        (message) =>
          message !== target && message.id !== identity.id && !hasMessageIdentity(message),
      ),
    )
    const result = await deleteSavedMessage(convId, identity.id, identity.revision, preserveEmpty)
    if (result?.message_id !== identity.id || typeof result.conversation_deleted !== 'boolean') {
      throw new Error('删除结果缺少有效确认')
    }
    if (!deletedMessageIds.has(convId)) deletedMessageIds.set(convId, new Set())
    deletedMessageIds.get(convId).add(identity.id)
    for (const session of messageEditDrafts) {
      if (
        (session.request?.convId || session.convId) !== convId ||
        (session.target !== target && editTargetId(session) !== identity.id)
      )
        continue
      session.cancelled = true
      messageEditDrafts.delete(session)
      if (editSession.value === session) editSession.value = null
    }
    // 同时清理所属缓存及可能重新加载的同一页面，绝不沿用旧下标删除其他消息。
    const arrays = new Set([ownedMessages, streamMessageCache.value[convId]?.messages])
    if (currentConvId.value === convId) arrays.add(messages.value)
    for (const array of arrays) {
      if (!array) continue
      const index = array.findIndex((message) => message === target || message.id === identity.id)
      if (index >= 0) array.splice(index, 1)
    }
    if (currentConvId.value === convId) {
      if (editingIndex.value < 0) editSession.value = null
      if (target.contractData && previewData.value === target.contractData) {
        showPreview.value = false
        previewData.value = null
      }
    }
    if (result.conversation_deleted) forgetConversation(convId)
    await refreshConvList()
  } catch (error) {
    console.warn('删除消息未获确认，异常类型：', error.name)
    showContractWarning('删除未获确认，页面暂保留原消息，请刷新会话确认后再操作。', 6500)
  } finally {
    pendingMessageDeletions.value.delete(operation)
  }
}

// 两种模式都固定目标并等待保存确认，不删除问答、不占用输入草稿。
async function regenerateMessage(idx) {
  if (
    historyLoading.value ||
    loading.value ||
    deletingConvIds.value.has(pageKey()) ||
    messageMutationBlocksCurrent()
  )
    return
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'assistant') return
  const user = messages.value[idx - 1]
  if (user?.role !== 'user') {
    showContractWarning('此回复缺少对应问题，原回复已保留，无法重新生成。')
    return
  }
  const task =
    user.file || msg.contractData || msg.contractRawText
      ? regenerateContractMessage(msg)
      : regenerateSavedReply(msg, false)
  regenerationTasks.set(msg, task)
  try {
    await task
  } finally {
    regenerationTasks.delete(msg)
  }
}

function regenerateContractMessage(target) {
  return regenerateSavedReply(target, true)
}

async function regenerateSavedReply(target, contract) {
  const convId = currentConvId.value
  if (!convId || loadingConvIds.value.has(convId) || deletingConvIds.value.has(convId)) return
  const ownedMessages = messages.value
  const previousData = target.contractData
  const previousExpanded = target.thinkingExpanded
  const controller = new AbortController()
  let completed = false
  flushTypewriter(target)
  loadingConvIds.value.add(convId)
  abortControllers.value[convId] = controller
  target.regenerating = true
  const draft = contract ? null : reactive({ content: LOADING_DOTS })
  if (draft) target.regenerationDraft = draft
  target.thinkingExpanded = false
  streamMessageCache.value = {
    ...streamMessageCache.value,
    [convId]: { messages: ownedMessages, thinkingSteps: [] },
  }
  thinkingSteps.value = []
  try {
    const result = await (contract ? regenerateContractReport : regenerateChatReply)({
      convId,
      target,
      messages: ownedMessages,
      getConversation,
      stream: contract ? regenerateContractStream : regenerateChatStream,
      signal: controller.signal,
      onToken(chunk) {
        if (!draft || abortControllers.value[convId] !== controller) return
        const active = () =>
          currentConvId.value === convId && abortControllers.value[convId] === controller
        if (active()) appendToTypewriter(draft, chunk, active, scrollToBottom)
        else {
          flushTypewriter(draft)
          if (draft.content === LOADING_DOTS) draft.content = ''
          draft.fullContent = (draft.fullContent ?? draft.content) + chunk
          draft.content = draft.fullContent
        }
      },
      onSteps(steps) {
        if (abortControllers.value[convId] !== controller) return
        const cache = streamMessageCache.value[convId]
        streamMessageCache.value = {
          ...streamMessageCache.value,
          [convId]: { ...cache, messages: cache?.messages || ownedMessages, thinkingSteps: steps },
        }
        if (currentConvId.value === convId) thinkingSteps.value = steps
      },
    })
    if (abortControllers.value[convId] !== controller) return
    completed = result.status === 'completed'
    if (completed) {
      if (!contract) {
        if (!confirmedMessageEdits.has(convId)) confirmedMessageEdits.set(convId, new Map())
        for (const message of [target, result.user])
          confirmedMessageEdits.get(convId).set(message.id, {
            content: message.content,
            revision: message.revision,
            thinkingChain: message.thinkingChain,
            version: ++messageEditVersion,
          })
      }
      if (contract && currentConvId.value === convId && previewData.value === previousData) {
        clearContractSelection()
        previewData.value = target.contractData
      }
      await refreshConvList()
    } else if (
      ![...pendingMessageDeletions.value].some(
        (operation) => operation.regenerationTarget === target,
      )
    ) {
      showContractWarning(
        contract
          ? '已停止重新审查，页面保留原报告；可刷新会话确认最新结果。'
          : '已停止重新生成，原回复已保留；可重新读取会话确认最新结果。',
      )
    }
  } catch (error) {
    if (abortControllers.value[convId] !== controller) return
    console.warn('重新生成未完成，异常类型：', error.name)
    showContractWarning(
      error instanceof ContractRegenerationError || error instanceof ChatRegenerationError
        ? error.message
        : contract
          ? '重新审查未完成，页面暂保留原报告；请刷新确认最新结果。'
          : '重新生成未完成，原回复已保留；请重新读取会话确认最新结果。',
    )
  } finally {
    if (draft) flushTypewriter(draft)
    delete target.regenerationDraft
    target.regenerating = false
    if (!completed) target.thinkingExpanded = previousExpanded
    if (abortControllers.value[convId] === controller) {
      loadingConvIds.value.delete(convId)
      delete abortControllers.value[convId]
      const cache = { ...streamMessageCache.value }
      if (ownedMessages.some((message) => message.saveFailed)) {
        cache[convId] = { messages: ownedMessages, thinkingSteps: target.thinkingChain || [] }
      } else delete cache[convId]
      streamMessageCache.value = cache
      if (currentConvId.value === convId) thinkingSteps.value = target.thinkingChain || []
    }
  }
}

function editBelongsToCurrent(session) {
  const owner = session.request?.convId || session.convId
  return owner ? owner === currentConvId.value : session.messages === messages.value
}

function editTargetId(session) {
  return session.identity?.id || (hasMessageIdentity(session.target) ? session.target.id : null)
}

// 切换页面只隐藏编辑器，未保存的修改留在内存中，返回原会话仍可继续。
function restoreMessageEdit() {
  editSession.value =
    [...messageEditDrafts].find(
      (session) =>
        !session.cancelled &&
        editBelongsToCurrent(session) &&
        messages.value.some(
          (message) =>
            message === session.target ||
            (editTargetId(session) && message.id === editTargetId(session)),
        ),
    ) || null
}

// 保存确认及冲突核实只更新所属对象；迟到的旧历史响应不能把正文改回去。
function applyConfirmedUserEdit(session, convId, saved) {
  const id = saved.message_id ?? saved.id
  if (!confirmedMessageEdits.has(convId)) confirmedMessageEdits.set(convId, new Map())
  confirmedMessageEdits
    .get(convId)
    .set(id, { content: saved.content, revision: saved.revision, version: ++messageEditVersion })
  const arrays = new Set([session.messages, streamMessageCache.value[convId]?.messages])
  if (currentConvId.value === convId) arrays.add(messages.value)
  for (const array of arrays) {
    const target = array?.find((message) => message === session.target || message.id === id)
    if (target?.role === 'user')
      Object.assign(target, { id, content: saved.content, revision: saved.revision })
  }
}

// 编辑开始时固定原文与版本，不把稍后切换的页面或下标当作保存目标。
function editMessage(idx) {
  if (
    historyLoading.value ||
    deletingConvIds.value.has(pageKey()) ||
    messageMutationBlocksCurrent()
  )
    return
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'user') return
  editSession.value = [...messageEditDrafts].find(
    (session) =>
      editBelongsToCurrent(session) &&
      (session.target === msg || (editTargetId(session) && editTargetId(session) === msg.id)),
  ) || {
    messages: messages.value,
    target: msg,
    convId: currentConvId.value,
    request: requests.findMessage(msg),
    identity: hasMessageIdentity(msg) ? { id: msg.id, revision: msg.revision } : null,
    baseContent: msg.content,
    text: msg.content,
    saving: false,
    submitted: false,
    cancelled: false,
    conflict: false,
  }
  messageEditDrafts.add(editSession.value)
}

// 未落库的问题等待原请求完成，不停止生成，也不把编辑倒灌到模型输入。
async function saveEdit() {
  const session = editSession.value
  if (
    !session ||
    session.saving ||
    editingIndex.value < 0 ||
    messageMutationBlocksCurrent() ||
    historyLoading.value ||
    deletingConvIds.value.has(pageKey())
  )
    return
  const content = session.text
  session.saving = true
  pendingMessageEdits.value.add(session)
  let convId = session.request?.convId || session.convId
  const cancelled = () => session.cancelled || deletedConvIds.has(convId)
  try {
    if (session.conflict) {
      if (confirmState.visible) return
      const ok = await showConfirm(
        '这条消息已在其他位置修改。\n\n最新正文：\n' +
          session.baseContent +
          '\n\n是否用你的编辑覆盖这条消息？其他消息和附件不受影响。',
        { okText: '覆盖保存', cancelText: '返回编辑' },
      )
      if (!ok || confirmationDisposed || cancelled()) return
    }
    if (session.request && !hasMessageIdentity(session.target)) {
      showContractWarning('本轮消息尚未保存，修改将在本轮完成后保存，生成不会中断。')
      await session.request.task
      convId = session.request.convId || convId
      if (cancelled() || session.request.invalidated) return
      if (!session.messages.includes(session.target)) {
        const status = draftRecovery.recover(convId || '__new__', {
          text: content,
          file: session.target.file || null,
        })
        showContractWarning(
          status === 'restored'
            ? '本轮发送未完成，编辑文字已恢复到原草稿。'
            : '本轮发送未完成，原草稿保持不变，编辑文字已暂存；发送或清空草稿后重新打开原会话可恢复。',
          6500,
        )
        messageEditDrafts.delete(session)
        if (editSession.value === session) editSession.value = null
        return
      }
    }
    if (!convId || cancelled()) return
    session.convId = convId
    const deletion = pendingConversationDeletions.get(convId)
    if (deletion) await deletion
    if (cancelled()) return
    const identity =
      session.identity ||
      (await resolveSavedMessage(convId, session.target, session.messages, getConversation))
    if (cancelled()) return
    session.identity = identity
    const result = await saveUserMessageEdit({
      convId,
      identity,
      baseContent: session.baseContent,
      content,
      patch: (...args) => {
        session.submitted = true
        return editSavedMessage(...args)
      },
      getConversation,
      isCancelled: cancelled,
    })
    if (cancelled() || result.status === 'cancelled') return
    if (result.status === 'conflict') {
      applyConfirmedUserEdit(session, convId, result.latest)
      session.identity = { id: result.latest.id, revision: result.latest.revision }
      session.baseContent = result.latest.content
      session.conflict = true
      showContractWarning(
        '这条消息已有新版本，无法安全合并，编辑文字已保留。再次点击保存可查看最新正文并确认是否覆盖。',
        6500,
      )
      return
    }
    applyConfirmedUserEdit(session, convId, result)
    messageEditDrafts.delete(session)
    if (editSession.value === session) editSession.value = null
    await refreshConvList()
  } catch (error) {
    if (!cancelled()) {
      console.warn('保存消息修改未获确认，异常类型：', error.name)
      showContractWarning(
        error instanceof MessageEditError
          ? error.message
          : '修改未获确认，原消息及编辑文字已保留，请稍后再试。',
        6500,
      )
    }
  } finally {
    session.saving = false
    session.submitted = false
    pendingMessageEdits.value.delete(session)
  }
}

function cancelEdit() {
  const session = editSession.value
  if (!session || session.submitted) return
  session.cancelled = true
  pendingMessageEdits.value.delete(session)
  messageEditDrafts.delete(session)
  editSession.value = null
}

// 停止当前对话的 LLM 生成
function stopGeneration(convId) {
  const targetId = convId || pageKey()
  if (abortControllers.value[targetId]) {
    abortControllers.value[targetId].abort()
  }
  const ownedMessages =
    streamMessageCache.value[targetId]?.messages || (targetId === pageKey() ? messages.value : [])
  if (ownedMessages.some((message) => message.regenerating)) return
  // 立即清空打字机队列中未输出的内容
  const last = ownedMessages.at(-1)
  if (last && last.role === 'assistant') {
    flushTypewriter(last)
    if (last.content === LOADING_DOTS) {
      last.content = '已停止生成。'
    }
  }
}

// 先同步固定输入和消息归属，再进入任何异步准备操作。
function sendText() {
  const draft = { text: input.value, file: pendingFile.value }
  const query = input.value.trim()
  if (!query) return
  const request = requests.begin(currentConvId.value, { role: 'user', content: query })
  if (!request) return
  input.value = ''
  delete draftInputs[request.convId || '__new__']
  return runMessageRequest(request, { userContent: query, title: query, draft })
}

// 模型尚未启动时撤回占位消息并恢复草稿，不把准备失败伪装成模型回复写入历史。
function recoverPreparation(request, draft) {
  const status = draftRecovery.recover(request.convId || '__new__', draft)
  const prefix = request.controller.signal.aborted ? '已取消发送，' : '发送准备未完成，'
  showContractWarning(
    status === 'restored'
      ? prefix + '待发内容已恢复到原草稿，可编辑后重新发送。'
      : prefix +
          '内容已暂存，当前草稿保持不变。发送或清空草稿后，重新打开原对话（未创建时点击“新对话”）可恢复。',
    status === 'restored' ? 3000 : 6500,
  )
}

// 文本和合同共用归属与清理流程，只有模型接口和报告附件不同。
function runMessageRequest(request, context) {
  request.task = executeMessageRequest(request, context)
  return request.task
}

async function executeMessageRequest(
  request,
  { userContent, title, file = null, draft, instruction = '' },
) {
  const assistant = request.assistant
  const steps = request.steps
  const isActive = () => requests.isActive(request)
  const publish = () => requests.publish(request)
  const scrollOwned = async () => {
    await nextTick()
    if (isActive() && msgContainer.value) {
      msgContainer.value.scrollTop = msgContainer.value.scrollHeight
    }
  }
  let completion = null
  let settled = false
  let modelStarted = false
  let restoreDraft = false
  async function complete(data = {}, errorMessage = null) {
    // 删除结果明确前暂缓追加保存；删除失败时仍可正常完成，成功后绝不恢复已删除内容。
    const deletion = pendingConversationDeletions.get(request.convId)
    if (deletion) await deletion
    if (request.invalidated) return
    flushTypewriter(assistant)
    if (assistant.fullContent) assistant.content = assistant.fullContent
    const validReport =
      file &&
      typeof data.raw_text === 'string' &&
      data.raw_text.trim() &&
      typeof data.chat_reply === 'string' &&
      data.chat_reply.trim() &&
      Array.isArray(data.risk_points) &&
      data.risk_points.every(
        (point) =>
          point &&
          ['quote', 'level', 'bubble_text'].every((field) => typeof point[field] === 'string'),
      )
    if (file && !data.aborted && !errorMessage && !validReport) {
      errorMessage = '未收到完整的合同报告，已接收内容暂保留，请重新审查。'
    }
    if (errorMessage) {
      const partial = assistant.content === LOADING_DOTS ? '' : assistant.content
      const warning = (file ? '### ⚠️ 合同审查失败\n\n' : '### ⚠️ 请求失败\n\n') + errorMessage
      assistant.content = partial ? partial + '\n\n---\n\n' + warning : warning
    } else if (validReport) {
      assistant.content = data.chat_reply
    } else if (assistant.content === LOADING_DOTS) {
      assistant.content = data.aborted ? '已停止生成。' : data.chat_reply || ''
    }
    assistant.thinkingChain = [...steps]
    assistant.thinkingExpanded = false
    assistant.fullContent = assistant.content
    const contractData =
      file && !errorMessage && !data.aborted
        ? {
            raw_text: data.raw_text,
            chat_reply: data.chat_reply,
            risk_points: data.risk_points,
            ...(instruction ? { instruction } : {}),
          }
        : null
    if (contractData) {
      assistant.contractData = contractData
      pushContractAttach(assistant, contractData, file)
    }
    publish()
    if (request.convId) {
      try {
        const saved = await doSaveMessages(
          request.convId,
          userContent,
          assistant.content,
          file?.name || null,
          contractData,
          assistant.thinkingChain,
        )
        if (request.invalidated) return
        assignSavedMessageIdentities(request, saved)
        assistant.saveFailed = false
      } catch (error) {
        const deletion = pendingConversationDeletions.get(request.convId)
        if (deletion) await deletion
        if (request.invalidated) return
        console.warn('保存回复未获确认，异常类型：', error.name)
        assistant.saveFailed = true
        showContractWarning(
          '回复已保留在页面，但未确认保存。请先复制内容，再刷新会话确认；不要直接重复发送。',
          6500,
        )
      }
    }
    await scrollOwned()
  }
  function settle(data, errorMessage) {
    if (!settled) {
      settled = true
      completion = complete(data, errorMessage)
      // 保留原任务供读取器及 finally 等待，兼容未等待回调的测试或其他调用者。
      completion.catch(() => {})
    }
    return completion
  }
  try {
    await scrollOwned()
    if (request.controller.signal.aborted) {
      restoreDraft = true
      return
    }
    await ensureConversation(request)
    if (request.stopForDeletion && !request.invalidated) {
      await settle({ aborted: true })
      return
    }
    if (request.controller.signal.aborted) {
      restoreDraft = true
      return
    }
    if (!request.history.some((message) => message.role === 'user')) {
      try {
        await updateConvTitle(
          request.convId,
          title.length > 14 ? title.slice(0, 14) + '…' : title,
          request.controller.signal,
          '新对话',
        )
      } catch (error) {
        if (!request.controller.signal.aborted) {
          console.warn('自动命名对话失败，异常类型：', error.name)
        }
      }
    }
    if (request.controller.signal.aborted) {
      restoreDraft = true
      return
    }
    await refreshConvList(request.controller.signal)
    if (request.controller.signal.aborted) {
      restoreDraft = true
      return
    }
    const callbacks = {
      onThinking(label) {
        if (settled || request.invalidated) return
        steps.push({ type: 'tool', label })
        publish()
      },
      onReasoning(text) {
        if (settled || request.invalidated) return
        if (steps.at(-1)?.type === 'reasoning') steps.at(-1).label = text
        else steps.push({ type: 'reasoning', label: text })
        publish()
      },
      onReasoningToken(text) {
        if (settled || request.invalidated) return
        if (steps.at(-1)?.type !== 'reasoning') steps.push({ type: 'reasoning', label: '' })
        steps.at(-1).label += text
        publish()
      },
      onToolChunk(tool, content, first) {
        if (settled || request.invalidated) return
        if (first) steps.push({ type: 'done', label: tool + ' 完成', snippet: content })
        else if (steps.at(-1)?.type === 'done') steps.at(-1).snippet += content
        publish()
      },
      onToolResult(tool, output) {
        if (settled || request.invalidated) return
        steps.push({ type: 'done', label: tool + ' 完成', snippet: output })
        publish()
      },
      onToken(content) {
        if (settled || request.invalidated) return
        if (isActive()) {
          appendToTypewriter(assistant, content, isActive, scrollOwned)
        } else {
          flushTypewriter(assistant)
          if (assistant.content === LOADING_DOTS) assistant.content = ''
          assistant.fullContent = (assistant.fullContent ?? assistant.content) + content
          assistant.content = assistant.fullContent
        }
      },
      onDone(data) {
        return settle(data)
      },
      onError(message) {
        return settle({}, message)
      },
    }
    if (request.stopForDeletion) {
      await settle({ aborted: true })
      return
    }
    modelStarted = true
    request.modelStarted = true
    if (file) {
      await analyzeContractStream(file, request.controller.signal, callbacks, instruction)
    } else {
      await chatStream(userContent, request.history, request.controller.signal, callbacks)
    }
  } catch (error) {
    if (!request.controller.signal.aborted) console.warn('发送消息失败，异常类型：', error.name)
    if (!modelStarted) restoreDraft = true
    else if (!settled && request.controller.signal.aborted) settle({ aborted: true })
    else if (!settled) settle({}, '请求未完成，请确认后端服务已启动后重试。')
  } finally {
    try {
      await completion
    } catch (error) {
      if (!request.invalidated) {
        console.warn('处理回复结果失败，异常类型：', error.name)
        assistant.saveFailed = true
        showContractWarning(
          '回复处理未完成，内容暂保留在页面。请先复制内容，再刷新会话确认。',
          6500,
        )
      }
    } finally {
      if (restoreDraft) requests.discard(request)
      requests.finish(request)
      if (restoreDraft && !request.invalidated) recoverPreparation(request, draft)
      await scrollOwned()
    }
  }
}

// ---- 文件选择 ----
// 手动上传模式在选择时校验，before-upload 不会在此阶段触发。
function validateContractFile(file) {
  const message = getContractUploadError(file)
  if (!message) return true
  showContractWarning(message)
  return false
}

function showContractWarning(message, duration = 3000) {
  const headerBottom = chatHeader.value?.getBoundingClientRect().bottom || 0
  // 根据导航栏实际位置留出间距，避免提示条覆盖导航按钮。
  ElMessage.warning({
    message,
    offset: Math.max(16, headerBottom + 12),
    customClass: 'contract-upload-notice',
    duration,
  })
}

// 清理上传组件的内部队列，草稿仍只由 pendingFile 与 draftFiles 管理。
function handleFileChange(file) {
  fileUploadRef.value?.clearFiles()
  if (!file.raw || !validateContractFile(file.raw)) return
  pendingFile.value = file.raw
}

// ---- 合同审查发送 ----
// 文件与附加文字同步快照；创建会话期间切换页面不会取走另一会话的附件。
function sendFile(instruction = null) {
  const draft = { text: input.value || instruction || '', file: pendingFile.value }
  const file = pendingFile.value
  if (!file || !validateContractFile(file)) return
  try {
    instruction = normalizeContractInstruction(instruction ?? '')
  } catch (error) {
    showContractWarning(error.message)
    return
  }
  const userContent = instruction
    ? `📄 上传合同：${file.name}\n${instruction}`
    : `📄 上传合同：${file.name}`
  const request = requests.begin(currentConvId.value, { role: 'user', content: userContent, file })
  if (!request) return
  pendingFile.value = null
  input.value = ''
  delete draftInputs[request.convId || '__new__']
  delete draftFiles[request.convId || '__new__']
  return runMessageRequest(request, {
    userContent,
    title: instruction || file.name.replace(/\.[^.]+$/, ''),
    file,
    draft,
    instruction,
  })
}

// 更新钉住的高亮气泡位置
function updatePinnedBubble() {
  if (!pinnedMark || !tooltipEl) return
  positionContractBubble(pinnedMark)
}

function positionContractBubble(mark) {
  const rect = getHighlightRect(mark)
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

// 隐藏时同时撤销鼠标命中，避免透明气泡遮挡其他高亮。
function clearContractSelection() {
  clearTimeout(hoverTimer)
  setHighlightPinned(pinnedMark, false)
  pinnedMark = null
  if (tooltipEl) {
    tooltipEl.style.opacity = '0'
    tooltipEl.style.pointerEvents = 'none'
  }
  pinnedScrollElement?.removeEventListener('scroll', pinnedScrollHandler)
  pinnedScrollHandler = null
  pinnedScrollElement = null
}

// 合同预览区点击事件：钉住或取消整个逻辑风险范围。
function onContractClick(e) {
  const mark = e.target.closest?.('mark')
  if (!mark || !tooltipEl) return
  if (isSameHighlight(pinnedMark, mark)) {
    clearContractSelection()
  } else {
    clearContractSelection()
    pinnedMark = mark
    setHighlightPinned(mark, true)
    showContractBubble(mark)
    tooltipEl.style.pointerEvents = 'auto'
    pinnedScrollHandler = () => updatePinnedBubble()
    pinnedScrollElement = mark.closest('.preview-body')
    pinnedScrollElement?.addEventListener('scroll', pinnedScrollHandler, { passive: true })
  }
}

// ---- 分隔条拖拽 ----
function onDividerDragStart(e) {
  if (e.button !== 0) return
  e.preventDefault()
  stopDividerDrag?.()
  const appLayout = document.querySelector('.app-layout')
  const totalW = appLayout?.offsetWidth
  if (!showPreview.value || isNarrow.value || !Number.isFinite(totalW) || totalW <= 0) return
  dragging.value = true
  const startX = e.clientX
  const startRatio = splitRatio.value
  let latestX = startX
  let rafId = null
  let active = true
  const bodyStyle = document.body.style
  const previousStyles = ['user-select', 'cursor'].map((name) => [
    name,
    bodyStyle.getPropertyValue(name),
    bodyStyle.getPropertyPriority(name),
  ])

  // 仅在本次拖拽期间占用全局光标和选字样式，结束后还原原值及优先级。
  bodyStyle.userSelect = 'none'
  bodyStyle.cursor = 'col-resize'

  function onMove(ev) {
    if (!active) return
    latestX = ev.clientX
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (!active) return
      const dx = latestX - startX
      const newRatio = startRatio + dx / totalW
      splitRatio.value = Math.max(0.25, Math.min(0.75, newRatio))
    })
  }

  function onUp() {
    if (!active) return
    active = false
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    dragging.value = false
    for (const [name, value, priority] of previousStyles)
      bodyStyle.setProperty(name, value, priority)
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    window.removeEventListener('blur', onUp)
    if (stopDividerDrag === onUp) stopDividerDrag = null
  }

  stopDividerDrag = onUp
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  window.addEventListener('blur', onUp)
}

// 合同预览区悬停事件：显示高亮气泡
function onContractHover(e) {
  const mark = e.target.closest?.('mark')
  if (!mark || !tooltipEl) return
  // 如果已有其他标记被钉住，不抢占气泡
  if (pinnedMark && !isSameHighlight(pinnedMark, mark)) return
  if (!mark.dataset.bubble) return
  clearTimeout(hoverTimer)
  if (tooltipEl.style.opacity === '1') {
    showContractBubble(mark)
  } else {
    hoverTimer = setTimeout(() => showContractBubble(mark), 200)
  }
}

function showContractBubble(mark) {
  tooltipEl.textContent = mark.dataset.bubble || ''
  tooltipEl.style.opacity = '1'
  positionContractBubble(mark)
}

function onContractLeave(e) {
  if (isSameHighlight(e?.target?.closest?.('mark'), e?.relatedTarget?.closest?.('mark'))) return
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
  window.addEventListener('resize', checkNarrow)
  watch(showPreview, (val) => {
    nextTick(checkNarrow)
    if (!val) {
      stopDividerDrag?.()
      clearContractSelection()
    }
  })
  watch(previewData, clearContractSelection)
  refreshConvList()
  tooltipEl = document.createElement('div')
  tooltipEl.className = 'contract-tooltip'
  tooltipEl.style.cssText =
    'display:block;opacity:0;pointer-events:none;transition:opacity 0.15s ease;position:fixed;z-index:9999;max-width:300px;padding:10px 14px;background:#fff;color:#303133;font-size:14px;line-height:1.6;border-radius:10px;white-space:normal;word-break:break-word;box-shadow:0 4px 20px rgba(0,0,0,0.15);font-family:"Microsoft YaHei",sans-serif;'
  document.body.appendChild(tooltipEl)
})

onUnmounted(() => {
  renaming.dispose()
  historyReads.dispose()
  conversationListReads.dispose()
  historyLoading.value = false
  disposeTypewriters()
  // 取消尚未执行的确认操作；已发出的网络请求不等于能够撤回，不能伪称回滚。
  confirmationDisposed = true
  resolveConfirm(false)
  stopDividerDrag?.()
  window.removeEventListener('resize', checkNarrow)
  clearContractSelection()
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

// 打开合同预览面板
function openContractPreview(msg) {
  previewData.value = msg.contractData
  showPreview.value = true
}
</script>

<style scoped>
/* 滚动条 */
.chat-messages::-webkit-scrollbar,
.conv-list::-webkit-scrollbar,
.preview-body::-webkit-scrollbar {
  width: 6px;
}
.chat-messages::-webkit-scrollbar-track,
.conv-list::-webkit-scrollbar-track,
.preview-body::-webkit-scrollbar-track {
  background: transparent;
}
.chat-messages::-webkit-scrollbar-thumb,
.conv-list::-webkit-scrollbar-thumb,
.preview-body::-webkit-scrollbar-thumb {
  background: #d0d5dd;
  border-radius: 3px;
}
.chat-messages::-webkit-scrollbar-thumb:hover,
.conv-list::-webkit-scrollbar-thumb:hover,
.preview-body::-webkit-scrollbar-thumb:hover {
  background: #b0b5bd;
}
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

.toggle-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0 !important;
  border-radius: 8px;
}
.toggle-btn:hover {
  background: #f0f2f5 !important;
}
.toggle-btn :deep(.el-icon) {
  font-size: 20px;
}
.new-chat-header-btn {
  margin-left: 0;
  margin-right: 10px;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0 !important;
  border-radius: 8px;
}
.new-chat-header-btn:hover {
  background: #f0f2f5 !important;
}
.new-chat-header-btn :deep(.el-icon) {
  font-size: 20px;
}
.preview-close-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0 !important;
  border-radius: 8px;
}
.preview-close-btn:hover {
  background: #f0f2f5 !important;
}
.preview-close-btn :deep(.el-icon) {
  font-size: 20px;
}
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
  background:
    radial-gradient(circle at 20% 50%, rgba(64, 158, 255, 0.03) 0%, transparent 50%),
    radial-gradient(circle at 80% 50%, rgba(64, 158, 255, 0.03) 0%, transparent 50%), #f8f9fb;
}
.welcome-content {
  position: absolute;
  top: calc(50% - 192px);
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  max-width: 560px;
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
  white-space: nowrap;
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
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}

.message-content :deep(.loading-dots) {
  display: inline-block;
  font-size: 28px;
  color: #909399;
  animation: breathe 1.5s ease-in-out infinite;
}
@keyframes breathe {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
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
  transition:
    box-shadow 0.2s,
    border-color 0.2s;
}
.contract-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
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
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: all 0.15s;
  z-index: 10;
}
.scroll-bottom-btn:hover {
  color: #409eff;
  border-color: #409eff;
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.2);
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
  transition:
    bottom 0.5s cubic-bezier(0.4, 0, 0.2, 1),
    top 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.chat-input-anchor.input-floating {
  bottom: auto;
  top: calc(50% - 50px);
}
.chat-input-area {
  transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  padding: 0 20px;
  background: transparent;
  display: flex;
  justify-content: center;
}
.chat-input-area .input-row {
  max-width: 800px;
  width: 100%;
}
.chat-input-area .input-wrapper {
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  padding: 10px 5px 44px 5px;
  position: relative;
  transition: all 0.3s ease;
}
.chat-input-area :deep(.el-textarea__inner) {
  border: none !important;
  box-shadow: none !important;
  transition: height 0.25s ease;
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
  resize: none;
  font-size: 15px;
}
.input-actions {
  position: absolute;
  bottom: 8px;
  left: 10px;
  right: 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0;
}
.input-row .el-textarea {
  flex: 1;
}
.send-btn {
  width: 36px !important;
  height: 36px !important;
  padding: 0 !important;
  border-radius: 50% !important;
  border: none !important;
  background: #409eff !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 0 !important;
  flex-shrink: 0;
}
.send-btn:hover {
  background: #337ecc !important;
}
.send-btn.is-disabled {
  background: #a0cfff !important;
}
.send-btn :deep(.el-icon) {
  color: #fff;
  font-size: 20px;
  font-weight: 900;
  stroke: #fff;
  stroke-width: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.send-btn :deep(.el-icon svg) {
  stroke: #fff;
  stroke-width: 48px;
}
.stop-btn {
  width: 36px !important;
  height: 36px !important;
  padding: 0 !important;
  border-radius: 50% !important;
  border: none !important;
  background: #e34d59 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 0 !important;
  flex-shrink: 0;
}
.stop-btn:hover {
  background: #c93542 !important;
}
.stop-square {
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 2px;
}
.upload-btn {
  width: 32px !important;
  height: 32px !important;
  padding: 0 !important;
  border: none !important;
  color: #909399 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 0 !important;
  border-radius: 50% !important;
  flex-shrink: 0;
}
.upload-btn:hover {
  color: #409eff !important;
  background: #ecf5ff !important;
}
.upload-btn.is-disabled {
  color: #c0c4cc !important;
}
.upload-btn .el-icon {
  font-size: 18px;
}
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
  background: rgba(0, 0, 0, 0.05) !important;
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
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
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
.thinking-step-icon :deep(svg) {
  vertical-align: middle;
}
.thinking-step-icon :deep(svg) {
  vertical-align: middle;
}
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
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
}
.terminal-header {
  background: #181825;
  padding: 6px 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.red {
  background: #ff5f56;
}
.yellow {
  background: #ffbd2e;
}
.green {
  background: #27c93f;
}
.terminal-title {
  margin-left: 6px;
  color: #a6adc8;
  font-size: 12px;
}
.terminal-body {
  padding: 12px 16px;
  font-family: 'Consolas', monospace;
  font-size: 13px;
}
.terminal-line {
  color: #cdd6f4;
  margin: 2px 0;
}
.prompt {
  color: #a6e3a1;
  margin-right: 8px;
}
.cursor {
  animation: blink 1s infinite;
  opacity: 0.6;
}
@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

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
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.06);
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
.contract-text :deep(mark.risk-high) {
  background: #eb9e9e;
}
.contract-text :deep(mark.risk-medium) {
  background: #fae198;
}
.contract-text :deep(mark.risk-low) {
  background: #d8d9db;
}
.contract-text :deep(mark):hover {
  filter: brightness(0.88);
}

.preview-legend {
  padding: 10px 16px;
  border-top: 1px solid #ebeef5;
  display: flex;
  gap: 18px;
  font-size: 14px;
  color: #909399;
  flex-shrink: 0;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.legend-dot {
  width: 12px;
  height: 12px;
  border-radius: 2px;
}
.legend-dot.high {
  background: rgba(220, 80, 80, 0.85);
}
.legend-dot.medium {
  background: rgba(245, 195, 50, 0.85);
}
.legend-dot.low {
  background: rgba(144, 147, 153, 0.65);
}

/* 右侧滑入动画 */
.slide-enter-active,
.slide-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

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
  position: relative;
}
.sidebar-header {
  padding: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid #ebeef5;
}
.sidebar-header .el-input {
  flex: 1;
}
.sidebar-close-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0 !important;
  border-radius: 8px;
}
.sidebar-close-btn:hover {
  background: #e8ecf1 !important;
}
.sidebar-close-btn :deep(.el-icon) {
  font-size: 20px;
}
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
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
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
.conv-item:hover {
  background: #e8ecf1;
}
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
.conv-empty-wrap {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.conv-empty-wrap > * {
  pointer-events: auto;
}
.conv-empty {
  color: #c0c4cc;
  font-size: 14px;
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
  transition:
    width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1);
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
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* 窄屏强制侧边栏浮在对话区上方 */
.sidebar-overlay {
  position: absolute !important;
  z-index: 200;
  height: 100%;
  box-shadow: 4px 0 20px rgba(0, 0, 0, 0.15);
}

.contract-text :deep(mark.pinned) {
  outline: 2px solid #409eff;
  outline-offset: 1px;
  filter: brightness(0.85);
}
</style>

<style>
/* 提示挂载在页面根节点，使用专用类统一外观，不影响其他消息提示。 */
.contract-upload-notice.el-message {
  --el-message-bg-color: #fffaf1;
  --el-message-border-color: #f0e2c9;
  --el-message-text-color: #80561f;
  border-radius: 10px;
  padding: 12px 16px;
  box-shadow: 0 4px 16px rgba(70, 54, 22, 0.08);
}
.contract-upload-notice .el-message__content {
  line-height: 1.5;
}
.contract-upload-notice.el-message .el-message-icon--warning {
  color: #d99a2b;
}

/* 统一弹出菜单样式（去除箭头，圆角框） */
.menu-pop {
  padding: 0 !important;
  min-width: 130px !important;
  border-radius: 10px !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12) !important;
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

/* 确认弹窗 */
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-dialog {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  padding: 24px;
  max-width: 360px;
  width: 90%;
}
.confirm-message {
  margin: 0 0 20px;
  font-size: 14px;
  color: #303133;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: min(45vh, 320px);
  overflow-y: auto;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.confirm-cancel-btn {
  border-radius: 8px !important;
}
.confirm-ok-btn {
  border-radius: 8px !important;
  background: #f56c6c !important;
  border-color: #f56c6c !important;
}
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.2s ease;
}
.confirm-fade-enter-active .confirm-dialog,
.confirm-fade-leave-active .confirm-dialog {
  transition: transform 0.2s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
.confirm-fade-enter-from .confirm-dialog {
  transform: scale(0.95);
}
.confirm-fade-leave-to .confirm-dialog {
  transform: scale(0.95);
}
</style>
