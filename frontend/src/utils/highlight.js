/**
 * 合同原文高亮匹配工具
 *
 * 核心问题：LLM 返回的 quote 可能与原文有细微差异（标点、空格）
 * 解决策略：忽略所有非汉字字符，仅按汉字序列模糊匹配
 */

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
  const textChinese = extractChinese(rawText)

  const idx = textChinese.indexOf(quoteChinese)
  if (idx === -1) return null

  let charCount = 0
  let start = -1, end = -1
  let foundStart = false

  for (let i = 0; i < rawText.length; i++) {
    if (/[\u4e00-\u9fa5]/.test(rawText[i])) {
      if (charCount === idx) {
        start = i
        foundStart = true
      }
      if (charCount === idx + quoteChinese.length - 1) {
        end = i + 1
        break
      }
      charCount++
    }
  }

  return foundStart ? { start, end } : null
}

/**
 * 根据风险等级返回 CSS 类名
 */
export function getRiskClass(level) {
  return {
    high: 'risk-high',
    medium: 'risk-medium',
    low: 'risk-low',
  }[level] || ''
}

/**
 * 将合同原文渲染为带高亮的 HTML
 * @param {string} rawText
 * @param {Array} riskPoints  [{ quote, level, bubble_text }]
 * @returns {string} HTML 字符串
 */
export function renderHighlightedContract(rawText, riskPoints) {
  const positions = riskPoints
    .map(rp => ({ ...rp, pos: fuzzyFind(rawText, rp.quote) }))
    .filter(rp => rp.pos !== null)
    .sort((a, b) => b.pos.start - a.pos.start)

  let result = rawText
  for (const rp of positions) {
    const { start, end } = rp.pos
    const before = result.slice(0, start)
    const match = result.slice(start, end)
    const after = result.slice(end)

    result = `${before}<mark class="${getRiskClass(rp.level)}" title="${escapeHtml(rp.bubble_text)}">${match}</mark>${after}`
  }

  return result.replace(/\n/g, '<br>')
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}
