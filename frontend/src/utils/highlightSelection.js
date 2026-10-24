/** 同一份合同中，被边界切开的风险片段仍属于同一逻辑标注。 */
export function getHighlightFragments(mark) {
  if (!mark) return []
  const root = mark.closest('.contract-text')
  const riskId = mark.dataset.riskId
  if (!root || riskId === undefined) return [mark]
  return [...root.querySelectorAll('mark[data-risk-id]')].filter(
    (fragment) => fragment.dataset.riskId === riskId,
  )
}

export function isSameHighlight(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  const root = left.closest('.contract-text')
  return Boolean(
    root &&
    root === right.closest('.contract-text') &&
    left.dataset.riskId !== undefined &&
    left.dataset.riskId === right.dataset.riskId,
  )
}

/** 钉住或取消时统一更新全部片段，而非只操作鼠标命中的那一段。 */
export function setHighlightPinned(mark, pinned) {
  for (const fragment of getHighlightFragments(mark)) fragment.classList.toggle('pinned', pinned)
}

/** 气泡以完整逻辑范围定位，滚动时重新读取布局，不缓存过期的坐标。 */
export function getHighlightRect(mark) {
  const rects = getHighlightFragments(mark).map((fragment) => fragment.getBoundingClientRect())
  const left = Math.min(...rects.map((rect) => rect.left))
  const right = Math.max(...rects.map((rect) => rect.right))
  const top = Math.min(...rects.map((rect) => rect.top))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return { left, right, top, bottom, width: right - left, height: bottom - top }
}
