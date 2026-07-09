<template>
  <div :class="['message', msg.role]">
    <!-- 用户消息编辑模式 -->
    <div v-if="msg.role === 'user' && editing" class="edit-inline">
      <div class="edit-inline-wrapper">
        <el-input
          v-model="editText"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 12 }"
          @keydown.esc="$emit('cancel-edit')"
        />
        <div class="edit-actions">
          <el-button size="small" text @click="$emit('cancel-edit')">取消</el-button>
          <el-button size="small" type="primary" @click="$emit('save-edit')">保存</el-button>
        </div>
      </div>
    </div>
    <template v-else>
      <!-- 用户消息文件卡片 -->
      <div v-if="msg.role === 'user' && msg.file" class="msg-file-card">
        <div class="msg-file-card-icon"><el-icon><Document /></el-icon></div>
        <span class="msg-file-card-name">{{ msg.file.name }}</span>
      </div>
      <!-- 思维链：流式输出时实时展示 -->
      <div v-if="msg.role === 'assistant' && isLast && loading" class="thinking-chain">
        <div class="thinking-summary" @click="toggleLiveThinking">
          <span class="thinking-dot" />
          <span>{{ thinkingLabel }}</span>
          <span class="thinking-arrow"><el-icon :class="{ rotated: liveExpanded }"><ArrowRight /></el-icon></span>
        </div>
        <div v-if="liveExpanded" class="thinking-details">
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
      <!-- 思维链：持久化保存 -->
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
      <!-- 消息内容 -->
      <div class="message-content" v-html="renderMd(msg.content)" />
    </template>
    <!-- 合同标注卡片 -->
    <transition name="contract-card-pop">
      <div v-if="msg.contractRawText" class="contract-card" @click="$emit('open-contract', msg)">
        <div class="contract-card-icon"><el-icon><Document /></el-icon></div>
        <div class="contract-card-body">
          <span class="contract-card-title">合同原文 · 风险标注</span>
          <span class="contract-card-hint">点击查看高亮标注</span>
        </div>
        <el-icon class="contract-card-arrow"><ArrowRight /></el-icon>
      </div>
    </transition>
    <!-- LLM 操作按钮 -->
    <div v-if="msg.role === 'assistant' && !editingAny" :class="['msg-actions', 'msg-actions-left', { 'msg-actions-visible': dropdownOpen }]">
      <el-dropdown trigger="click" popper-class="menu-pop" @command="(cmd) => $emit('copy', { index, asMarkdown: cmd === 'md' })" @visible-change="(v) => $emit('dropdown-change', { index, visible: v })">
        <span class="action-btn" title="复制"><el-icon><CopyDocument /></el-icon></span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="text">复制纯文本</el-dropdown-item>
            <el-dropdown-item command="md">复制 Markdown</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <span class="action-btn" title="重新生成" @click="$emit('regenerate', index)"><el-icon><Refresh /></el-icon></span>
      <span class="action-btn" title="删除" @click="$emit('delete', index)"><el-icon><Delete /></el-icon></span>
    </div>
    <!-- 用户操作按钮 -->
    <div v-if="msg.role === 'user' && !editing" :class="['msg-actions', 'msg-actions-right', { 'msg-actions-visible': dropdownOpen }]">
      <el-dropdown trigger="click" popper-class="menu-pop" @command="(cmd) => $emit('copy', { index, asMarkdown: cmd === 'md' })" @visible-change="(v) => $emit('dropdown-change', { index, visible: v })">
        <span class="action-btn" title="复制"><el-icon><CopyDocument /></el-icon></span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="text">复制纯文本</el-dropdown-item>
            <el-dropdown-item command="md">复制 Markdown</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <span class="action-btn" title="编辑" @click="$emit('edit', index)"><el-icon><EditPen /></el-icon></span>
      <span class="action-btn" title="删除" @click="$emit('delete', index)"><el-icon><Delete /></el-icon></span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Document, Search, ChatDotRound, CircleCheck, ArrowRight, CopyDocument, Refresh, Delete, EditPen } from '@element-plus/icons-vue'
import { cleanFences, renderMd } from '../composables/useTextTools'

const props = defineProps({
  msg: { type: Object, required: true },
  index: { type: Number, required: true },
  isLast: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  editing: { type: Boolean, default: false },
  editingAny: { type: Boolean, default: false },
  editText: { type: String, default: '' },
  dropdownOpen: { type: Boolean, default: false },
  thinkingSteps: { type: Array, default: () => [] },
  thinkingLabel: { type: String, default: '' },
})

const emit = defineEmits([
  'update:editText', 'cancel-edit', 'save-edit',
  'copy', 'regenerate', 'delete', 'edit', 'open-contract',
  'dropdown-change',
])

// 编辑文本的 computed 代理
const editText = computed({
  get: () => props.editText,
  set: (val) => emit('update:editText', val),
})

// 实时思维链展开状态（由父组件通过 msg 控制）
const liveExpanded = computed(() => props.msg?.thinkingExpanded ?? false)

function toggleLiveThinking() {
  if (props.msg) {
    props.msg.thinkingExpanded = !props.msg.thinkingExpanded
  }
}
</script>
