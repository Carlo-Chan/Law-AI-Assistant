<template>
  <div :style="show ? 'display:flex;flex:1;min-width:0;overflow:hidden;' : 'display:none;'">
    <!-- 拖拽分隔条 -->
    <div v-if="show" class="split-divider" :class="{ active: dragging }" @mousedown="$emit('drag-start', $event)"></div>
    <transition name="slide">
      <div v-if="show" :class="['preview-panel', { 'preview-fullscreen': isNarrow }]">
        <div class="preview-header">
          <span>合同原文 · 风险标注</span>
          <el-button :icon="Close" circle size="small" @click="$emit('close')" />
        </div>
        <div class="preview-body">
          <div class="contract-text" v-html="highlightedHtml" @click="$emit('contract-click', $event)" @mouseover="$emit('contract-hover', $event)" @mouseout="$emit('contract-leave', $event)" />
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
import { computed } from 'vue'
import { Close } from '@element-plus/icons-vue'
import { renderHighlightedContract } from '../utils/highlight'

const props = defineProps({
  show: { type: Boolean, default: false },
  isNarrow: { type: Boolean, default: false },
  dragging: { type: Boolean, default: false },
  previewData: { type: Object, default: null },
})

defineEmits(['close', 'drag-start', 'contract-click', 'contract-hover', 'contract-leave'])

const highlightedHtml = computed(() => {
  if (!props.previewData) return ''
  return renderHighlightedContract(props.previewData.raw_text, props.previewData.risk_points)
})
</script>
<style scoped>
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
.contract-text :deep(mark.pinned) {
  outline: 2px solid #409EFF;
  outline-offset: 1px;
  filter: brightness(0.85);
}
</style>