import createDOMPurify from 'dompurify'

const purifier = createDOMPurify(window)

// 不允许正文借用应用的布局类名，代码块仅保留语言标记。
purifier.addHook('uponSanitizeAttribute', (node, attribute) => {
  if (attribute.attrName !== 'class') return
  const isCodeLanguage =
    node.nodeName === 'CODE' && /^language-[a-z0-9_+-]+$/i.test(attribute.attrValue)
  attribute.keepAttr = isCodeLanguage
})

/** 净化渲染后的 Markdown，保留常用排版，不允许脚本、表单或自定义样式。 */
export function sanitizeMarkdownHtml(html) {
  return purifier.sanitize(html, {
    ALLOWED_TAGS: [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'br',
      'hr',
      'blockquote',
      'ul',
      'ol',
      'li',
      'strong',
      'em',
      'b',
      'i',
      'del',
      's',
      'pre',
      'code',
      'a',
      'img',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'th',
      'td',
      'div',
      'span',
      'sup',
      'sub',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'start', 'colspan', 'rowspan', 'align'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  })
}

/** 同时适用于文本和双引号属性值，不能用文本节点转义替代属性转义。 */
export function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  )
}
