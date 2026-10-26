/**
 * 合同原文高亮匹配工具
 *
 * 核心问题：LLM 返回的 quote 可能与原文有细微差异（标点、空格）
 * 先保留数字和英文精确定位，再对不含数字及英文的引文作汉字模糊回退。
 */
import { escapeHtml } from './html.js'
import { renderContractDocument } from './contractDocument.js'

/**
 * 提取字符串中的纯汉字序列（去除标点、空格、数字、英文）
 */
function extractChinese(str) {
  return str.replace(/[^\u4e00-\u9fa5]/g, '')
}

function literalOffset(text, quote) {
  let offset = text.indexOf(quote)
  while (offset >= 0) {
    const before = text[offset - 1] || ''
    const after = text[offset + quote.length] || ''
    // 金额不能命中更长数字的尾部，5% 也不能命中 0.5% 的一部分。
    if (!(
      (/^\p{N}/u.test(quote) && /[\p{N}.+\-−]/u.test(before)) ||
      (/\p{N}$/u.test(quote) && /[\p{N}.]/u.test(after))
    ))
      return offset
    offset = text.indexOf(quote, offset + 1)
  }
  return -1
}

/**
 * 在原文中模糊定位 quote 的位置
 * @param {string} rawText 合同原文
 * @param {string} quote   LLM 返回的风险句子
 * @returns {{ start: number, end: number } | null}
 */
export function fuzzyFind(rawText, quote) {
  if (!quote.trim()) return null
  const exact = literalOffset(rawText, quote)
  if (exact >= 0) return { start: exact, end: exact + quote.length }
  // 表格列分隔与模型空白可能不同，但不能丢弃金额、编号、百分号或英文。
  const positions = []
  let normalized = ''
  for (let index = 0; index < rawText.length; index++) {
    if (!/\s/.test(rawText[index])) {
      normalized += rawText[index]
      positions.push(index)
    }
  }
  const query = quote.replace(/\s/g, '')
  const matched = literalOffset(normalized, query)
  if (matched >= 0)
    return { start: positions[matched], end: positions[matched + query.length - 1] + 1 }
  if (/[\p{N}\p{Script=Latin}]/u.test(quote)) return null
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

function longestCommonSubstring(text, quote) {
  // 只保留上一行并暂存左上角旧值，避免按合同长度乘引文长度分配二维表。
  const lengths = new Uint32Array(quote.length + 1)
  let longestLength = 0
  let endIndex = 0
  for (let textIndex = 0; textIndex < text.length; textIndex++) {
    let diagonal = 0
    for (let quoteIndex = 1; quoteIndex <= quote.length; quoteIndex++) {
      const previous = lengths[quoteIndex]
      const length = text[textIndex] === quote[quoteIndex - 1] ? diagonal + 1 : 0
      lengths[quoteIndex] = length
      diagonal = previous
      // 仍按原文从左到右扫描，同长时不覆盖，保留原有的最早匹配规则。
      if (length > longestLength) {
        longestLength = length
        endIndex = textIndex + 1
      }
    }
  }
  return text.slice(endIndex - longestLength, endIndex)
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
export function renderHighlightedContract(rawText, riskPoints, documentBlocks = null) {
  const matches = riskPoints
    .map((rp, index) => {
      const q = rp.quote || rp.key_phrase || ''
      const pos = fuzzyFind(rawText, q)
      if (!pos) console.warn('合同风险引文未匹配，保留原文。')
      return pos ? { ...rp, pos, index } : null
    })
    .filter(Boolean)

  const renderRange = (start, end) => renderHighlightedRange(rawText, matches, start, end)
  return (
    renderContractDocument(rawText, documentBlocks, renderRange) ?? renderRange(0, rawText.length)
  )
}

function renderHighlightedRange(rawText, matches, start, end) {
  // 截断的是显示片段而非逻辑风险身份，跨格风险仍可统一悬停及钉住。
  matches = matches
    .filter((point) => point.pos.start < end && point.pos.end > start)
    .map((point) => ({
      ...point,
      pos: { start: Math.max(start, point.pos.start), end: Math.min(end, point.pos.end) },
    }))
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
  let previous = start
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
  parts.push(escapeHtml(rawText.slice(previous, end)).replace(/\n/g, '<br>'))
  // 标签与属性名均为应用常量，外部文本全部转义；气泡仍按纯文本读取。
  return parts.join('')
}
