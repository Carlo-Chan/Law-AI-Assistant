<template>
  <transition name="sidebar-slide">
    <div v-if="visible" class="sidebar" :class="{ 'sidebar-overlay': overlay }">
      <div class="sidebar-header">
        <el-input v-model="searchInput" placeholder="搜索对话..." class="search-input">
          <template #prefix>
            <el-icon class="search-icon"><Search /></el-icon>
          </template>
          <template #suffix>
            <span v-if="searchInput" class="search-clear-btn" @click.stop="searchInput = ''">✕</span>
          </template>
        </el-input>
        <el-button text size="small" class="sidebar-close-btn" @click="$emit('close-sidebar')"><el-icon><Fold /></el-icon></el-button>
      </div>
      <el-button class="new-chat-btn" @click="$emit('new-chat')">
        <el-icon><Edit /></el-icon> 开启新对话
      </el-button>
      <div class="conv-list">
        <div
          v-for="conv in filteredConvs"
          :key="conv.id"
          :class="['conv-item', { active: conv.id === currentConvId }]"
          @click="$emit('load-conversation', conv.id)"
        >
          <span v-if="renamingConvId !== conv.id" class="conv-title">{{ conv.title }}</span>
          <input
            v-else
            v-model="renameInput"
            class="conv-title-input"
            @keydown.enter.prevent="$emit('finish-rename', conv.id)"
            @keydown.esc.prevent="$emit('cancel-rename')"
            @blur="$emit('finish-rename', conv.id)"
            @click.stop
          />
          <el-dropdown v-if="renamingConvId !== conv.id" trigger="click" popper-class="menu-pop" @command="(cmd) => cmd === 'rename' ? $emit('start-rename', conv.id) : $emit('delete-conv', conv.id)" @visible-change="(v) => $emit('menu-visible-change', { id: conv.id, visible: v })">
            <span :class="['conv-more', { 'conv-more-visible': menuConvId === conv.id }]" @click.stop><el-icon><MoreFilled /></el-icon></span>
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
</template>

<script setup>
import { computed } from 'vue'
import { Search, Fold, Edit, MoreFilled, EditPen, Delete } from '@element-plus/icons-vue'
import { pinyinMatch, fuzzyMatch } from '../composables/useSearch'

const renameInput = computed({
  get: () => props.renameText,
  set: (val) => emit('update:renameText', val),
})

const searchInput = computed({
  get: () => props.searchQuery,
  set: (val) => emit('update:searchQuery', val),
})

const props = defineProps({
  visible: { type: Boolean, default: false },
  overlay: { type: Boolean, default: false },
  conversations: { type: Array, default: () => [] },
  currentConvId: { type: String, default: null },
  searchQuery: { type: String, default: '' },
  renamingConvId: { type: String, default: null },
  renameText: { type: String, default: '' },
  menuConvId: { type: String, default: null },
})

const emit = defineEmits([
  'update:searchQuery', 'new-chat', 'load-conversation',
  'start-rename', 'finish-rename', 'cancel-rename',
  'delete-conv', 'close-sidebar', 'menu-visible-change',
])

// 搜索过滤（拼音 + 模糊匹配）
const filteredConvs = computed(() => {
  if (!props.searchQuery) return props.conversations
  const q = props.searchQuery.toLowerCase()
  return props.conversations.filter(c => {
    const t = c.title.toLowerCase()
    return t.includes(q) || pinyinMatch(c.title, q) || fuzzyMatch(t, q)
  })
})
</script>
