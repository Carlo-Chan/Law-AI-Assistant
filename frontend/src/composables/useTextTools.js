/**
 * 文本处理工具函数
 *
 * 提供 Markdown 渲染、纯文本提取、代码块清理等功能。
 */
import { marked } from 'marked'
import { sanitizeMarkdownHtml } from '../utils/html.js'

const textBlocks = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'UL',
  'OL',
  'TABLE',
  'HR',
])
const structuralContainers = new Set(['#document-fragment', 'BLOCKQUOTE', 'UL', 'OL'])

/** 按块边界补换行，忽略渲染器在块之间插入的排版空白。 */
function childrenText(node, separator = '\n\n') {
  let text = ''
  let previousBlock = false
  for (const child of node.childNodes) {
    const value = nodeText(child)
    const block = textBlocks.has(child.nodeName)
    if (!value) {
      if (block) previousBlock = true
      continue
    }
    if (
      child.nodeType === window.Node.TEXT_NODE &&
      !value.trim() &&
      value.includes('\n') &&
      (structuralContainers.has(node.nodeName) ||
        textBlocks.has(child.previousSibling?.nodeName) ||
        textBlocks.has(child.nextSibling?.nodeName))
    )
      continue
    if (text && (block || previousBlock)) text += separator
    text += value
    previousBlock = block
  }
  return text
}

/** 只读取已净化节点的文字，不重新解析代码正文，也不依赖布局相关的 innerText。 */
function nodeText(node) {
  if (node.nodeType === window.Node.TEXT_NODE) return node.nodeValue
  if (node.nodeName === 'BR') return '\n'
  if (node.nodeName === 'IMG') return node.getAttribute('alt') || ''
  if (node.nodeName === 'HR') return ''
  if (node.nodeName === 'PRE') return node.textContent.replace(/\n$/, '')
  if (node.nodeName === 'TABLE') {
    return [...node.rows]
      .map((row) => [...row.cells].map((cell) => childrenText(cell)).join('\t'))
      .join('\n')
  }
  if (node.nodeName === 'UL' || node.nodeName === 'OL') {
    const start = Number(node.getAttribute('start') ?? 1)
    const first = Number.isSafeInteger(start) ? start : 1
    return [...node.children]
      .filter((child) => child.nodeName === 'LI')
      .map((item, index) => {
        const prefix = node.nodeName === 'OL' ? `${first + index}. ` : '- '
        const content = childrenText(item, '\n')
        return prefix + content.replace(/\n/g, '\n' + ' '.repeat(prefix.length))
      })
      .join('\n')
  }
  return childrenText(node)
}

/**
 * 去除 Markdown 格式标记，提取纯文本用于复制
 *
 * @param {string} md  Markdown 格式文本
 * @returns {string} 纯文本
 */
export function stripMarkdown(md) {
  if (!md) return ''
  // 复用页面的解析和净化规则；template 内容不挂载，不能为复制加载图片等资源。
  const template = window.document.createElement('template')
  template.innerHTML = renderMd(md)
  return childrenText(template.content).replace(/^\n+|\n+$/g, '')
}

/**
 * 清理 Markdown 代码块围栏标记
 *
 * @param {string} text  可能包含代码块围栏的文本
 * @returns {string} 清理后的文本
 */
export function cleanFences(text) {
  return text.replace(/```\w*\s*\n?/g, '').replace(/```/g, '')
}

/**
 * 将 Markdown 文本渲染为 HTML
 *
 * @param {string} text  Markdown 文本
 * @returns {string} HTML 字符串
 */
export function renderMd(text) {
  if (!text) return ''
  return sanitizeMarkdownHtml(marked.parse(text))
}
