/**
 * 文本处理工具函数
 *
 * 提供 Markdown 渲染、纯文本提取、代码块清理等功能。
 */
import { marked } from 'marked'
import { sanitizeMarkdownHtml } from '../utils/html.js'

/**
 * 去除 Markdown 格式标记，提取纯文本用于复制
 *
 * @param {string} md  Markdown 格式文本
 * @returns {string} 纯文本
 */
export function stripMarkdown(md) {
  if (!md) return ''
  let text = md
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  text = text.replace(/`{1,3}[^`]*`{1,3}/g, '')
  text = text.replace(/^[*-]\s+/gm, '')
  text = text.replace(/^>\s+/gm, '')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
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
