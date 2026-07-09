<template>
  <div class="chat-input-anchor" :class="{ 'input-floating': floating, 'has-file': pendingFile }">
    <div class="chat-input-area">
      <transition name="fade">
        <div v-if="showScrollBtn" class="scroll-bottom-btn" @click="$emit('scroll-to-bottom')">
          <el-icon><ArrowDown /></el-icon>
        </div>
      </transition>
      <div class="input-row">
        <div class="input-wrapper" :class="{ 'is-sending': loading }">
          <transition name="file-expand">
            <div v-if="pendingFile" class="file-card">
              <div class="file-card-icon"><el-icon><Document /></el-icon></div>
              <span class="file-card-name">{{ pendingFile.name }}</span>
              <el-button text size="small" class="file-card-close" @click="$emit('clear-file')"><el-icon><Close /></el-icon></el-button>
            </div>
          </transition>
          <el-input
            v-model="inputText"
            type="textarea"
            :rows="3"
            placeholder="输入法律问题，或上传合同文件进行审查..."
            :disabled="loading"
            @keydown.enter.exact.prevent="$emit('send')"
          />
          <div class="input-actions">
            <el-upload
              :auto-upload="false"
              :show-file-list="false"
              :on-change="onFileChange"
              accept=".pdf,.doc,.docx,.txt"
            >
              <el-button text size="small" class="upload-btn" :disabled="loading"><el-icon><Plus /></el-icon></el-button>
            </el-upload>
            <el-button v-if="!loading" size="small" :disabled="!canSend" @click="$emit('send')" class="send-btn"><el-icon><Top /></el-icon></el-button>
            <el-button v-else size="small" @click="$emit('send')" class="stop-btn"><span class="stop-square"></span></el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Document, Close, Plus, Top, ArrowDown } from '@element-plus/icons-vue'
const props = defineProps({
  modelValue: { type: String, default: '' },
  pendingFile: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  canSend: { type: Boolean, default: false },
  showScrollBtn: { type: Boolean, default: false },
  floating: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'send', 'scroll-to-bottom', 'file-change', 'clear-file'])

const inputText = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
})

function onFileChange(file) {
  emit('file-change', file)
}
</script>
