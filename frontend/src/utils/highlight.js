/**
 * 合同原文高亮匹配工具
 *
 * 核心问题：LLM 返回的 quote 可能与原文有细微差异（标点、空格）
 * 解决策略：忽略所有非汉字字符，仅按汉字序列模糊匹配
 */
import { escapeHtml } from './html.js'

/**
 * 提取字符串中的纯汉字序列（去除标点、空格、数字、英文）
 */
function extractChinese(str) {
  return str.replace(/[^\u4e00-\u9fa5]/g, '')
}

/**
 * 在原文中模糊定位 quote 的位置
 * @param {string} rawText 合同原文
 * @param {string} quote   LLM 返回的风险句子
 * @returns {{ start: number, end: number } | null}
 */
export function fuzzyFind(rawText, quote) {
  const quoteChinese = extractChinese(quote)
  if (!quoteChinese) return null
  const textChinese = extractChinese(rawText)

  // 精确匹配
  let idx = textChinese.indexOf(quoteChinese)
  let matchLen = quoteChinese.length

  if (idx === -1) {
    // 回退：尝试最长公共子串匹配（处理措辞微小差异）
    const lcs = longestCommonSubstring(textChinese, quoteChinese)
    if (lcs.length < Math.min(4, quoteChinese.length * 0.6)) return null
    idx = textChinese.indexOf(lcs)
    matchLen = lcs.length
  }

  let charCount = 0
  let start = -1,
    end = -1
  let foundStart = false

  for (let i = 0; i < rawText.length; i++) {
    if (/[一-龥]/.test(rawText[i])) {
      if (charCount === idx) {
        start = i
        foundStart = true
      }
      if (charCount === idx + matchLen - 1) {
        end = i + 1
        break
      }
      charCount++
    }
  }

  if (foundStart && end === -1) end = rawText.length

  return foundStart ? { start, end } : null
}

function longestCommonSubstring(a, b) {
  const m = a.length,
    n = b.length
  let maxLen = 0,
    endIdx = 0
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
        if (dp[i][j] > maxLen) {
          maxLen = dp[i][j]
          endIdx = i
        }
      }
    }
  }
  return a.slice(endIdx - maxLen, endIdx)
}

/**
 * 根据风险等级返回 CSS 类名
 */
export function getRiskClass(level) {
  return (
    {
      high: 'risk-high',
      medium: 'risk-medium',
      low: 'risk-low',
    }[level] || ''
  )
}

/**
 * 将合同原文渲染为带高亮的 HTML
 * @param {string} rawText
 * @param {Array} riskPoints  [{ quote, level, bubble_text }]
 * @returns {string} HTML 字符串
 */
export function renderHighlightedContract(rawText, riskPoints) {
  const matches = riskPoints
    .map((rp, index) => {
      const q = rp.quote || rp.key_phrase || ''
      const pos = fuzzyFind(rawText, q)
      if (!pos) console.warn('[highlight] match failed:', q.slice(0, 40))
      return pos ? { ...rp, pos, index } : null
    })
    .filter(Boolean)

  // 始终按原文坐标分段，转义后的字符长度不再参与定位。
  const boundaries = new Map()
  for (const point of matches) {
    for (const [offset, opening] of [
      [point.pos.start, true],
      [point.pos.end, false],
    ]) {
      if (!boundaries.has(offset)) boundaries.set(offset, [])
      boundaries.get(offset).push({ point, opening })
    }
  }

  const parts = []
  const active = new Set()
  let stack = []
  let previous = 0
  for (const offset of [...boundaries.keys()].sort((left, right) => left - right)) {
    parts.push(escapeHtml(rawText.slice(previous, offset)).replace(/\n/g, '<br>'))
    for (const { point, opening } of boundaries.get(offset)) {
      if (opening) active.add(point)
      else active.delete(point)
    }
    // 每段只生成合法嵌套，小范围置于内层；交叉时关闭再重开，不让浏览器修复标签。
    const nextStack = [...active].sort(
      (left, right) =>
        right.pos.end - right.pos.start - (left.pos.end - left.pos.start) ||
        left.index - right.index,
    )
    let common = 0
    while (common < stack.length && stack[common] === nextStack[common]) common++
    parts.push('</mark>'.repeat(stack.length - common))
    for (const point of nextStack.slice(common)) {
      const level = ['high', 'medium', 'low'].includes(point.level) ? point.level : 'low'
      parts.push(
        `<mark class="risk-${level}" data-risk-id="${point.index}" data-bubble="${escapeHtml(point.bubble_text || '')}" data-level="${level}">`,
      )
    }
    stack = nextStack
    previous = offset
  }
  parts.push(escapeHtml(rawText.slice(previous)).replace(/\n/g, '<br>'))
  // 标签与属性名均为应用常量，外部文本全部转义；气泡仍按纯文本读取。
  return parts.join('')
}
