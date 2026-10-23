import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'

// 只提供离线 DOM，不加载外部资源，也不执行文档中的脚本。
const dom = new JSDOM('', { url: 'https://example.test/' })
globalThis.window = dom.window
const { renderMd } = await import('../src/composables/useTextTools.js')
const { fuzzyFind, renderHighlightedContract } = await import('../src/utils/highlight.js')
after(() => {
  dom.window.close()
  delete globalThis.window
})

function fragment(html) {
  const template = dom.window.document.createElement('template')
  template.innerHTML = html
  return template.content
}

function assertNoExecutableMarkup(content) {
  assert.equal(
    content.querySelector('script, iframe, object, embed, svg, math, form, input, style'),
    null,
  )
  for (const element of content.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      assert.doesNotMatch(attribute.name, /^on|^(style|id|name|srcdoc)$/i)
      if (['href', 'src'].includes(attribute.name)) {
        assert.doesNotMatch(attribute.value.replace(/\s/g, ''), /^(javascript|vbscript):/i)
      }
    }
  }
}

test('空 Markdown 保持为空', () => {
  assert.equal(renderMd(''), '')
})

test('保留标题、列表、引用、表格、强调和代码块', () => {
  const content = fragment(
    renderMd(
      [
        '# 审查报告',
        '',
        '**原文**与*分析*',
        '',
        '> 建议',
        '',
        '- 第一项',
        '',
        '| 风险 | 等级 |',
        '| --- | --- |',
        '| 违约金 | 高 |',
        '',
        '```javascript',
        'const value = "<script>"',
        '```',
      ].join('\n'),
    ),
  )
  for (const selector of ['h1', 'strong', 'em', 'blockquote', 'ul > li', 'table th', 'table td']) {
    assert.ok(content.querySelector(selector), selector)
  }
  const code = content.querySelector('pre > code.language-javascript')
  assert.equal(code.textContent, 'const value = "<script>"\n')
  assert.equal(code.querySelector('script'), null)
})

test('保留正常链接与图片，但不允许强制新窗口或自定义样式', () => {
  const content = fragment(
    renderMd(
      '[法规](https://example.test/law)\n\n![说明](https://example.test/image.png)\n\n<a href="/law" target="_blank" style="position:fixed">原文</a>',
    ),
  )
  assert.equal(content.querySelector('a').getAttribute('href'), 'https://example.test/law')
  assert.equal(content.querySelector('img').getAttribute('alt'), '说明')
  assert.equal(content.querySelector('a[target], [style]'), null)
})

const attacks = [
  '<script>alert(1)</script><p>正文</p>',
  '<img src="missing" onerror="alert(1)"><div onclick="alert(1)">正文</div>',
  '<a href="javascript:alert(1)">链接</a><a href="java&#x73;cript:alert(1)">链接</a>',
  '<a href="java&#10;script:alert(1)">链接</a><img src="javascript:alert(1)">',
  '<svg><a xlink:href="javascript:alert(1)">链接</a></svg><math><mtext>正文</mtext></math>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://example.test/"></object>',
  '<form id="location" name="attributes"><input autofocus onfocus="alert(1)"></form><style>body{display:none}</style>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
]
for (const [index, attack] of attacks.entries()) {
  test(`移除 Markdown 注入载荷 ${index + 1}`, () => {
    assertNoExecutableMarkup(fragment(renderMd(attack)))
  })
}

test('流式输出的未闭合 HTML 片段同样经过净化', () => {
  const attack =
    '<a href="javascript:alert(1)">链接</a><img src=x onerror="alert(1)"><script>alert(1)</script>'
  for (let length = 1; length <= attack.length; length++) {
    assertNoExecutableMarkup(fragment(renderMd(attack.slice(0, length))))
  }
})

test('正文不能借用页面布局类或伪造风险交互属性', () => {
  const content = fragment(
    renderMd(
      '<div class="confirm-overlay" id="chat" data-bubble="伪造">正文</div><code class="language-js confirm-overlay">代码</code><mark class="risk-high" data-level="high">标注</mark>',
    ),
  )
  assert.equal(content.querySelector('[class], [id], [data-bubble], [data-level], mark'), null)
  assert.ok(content.textContent.includes('正文'))
})

test('没有风险点时合同中的 HTML 原样作为文字展示', () => {
  const raw = '合同<script>alert(1)</script>&amp;<img src=x onerror="alert(1)">'
  const content = fragment(renderHighlightedContract(raw, []))
  assert.equal(content.textContent, raw)
  assert.equal(content.children.length, 0)
})

test('转义前后的长度差不会改变高亮坐标或原文', () => {
  const raw = '<img src=x>&甲方有权没收全部押金。\n第四条另行约定。'
  const bubble = '分析："不合理" <script>alert(1)</script> & 建议\n另行约定'
  const content = fragment(
    renderHighlightedContract(raw, [
      { quote: '没收全部押金', level: 'high', bubble_text: bubble },
      { quote: '第四条另行约定', level: 'medium', bubble_text: '第二条风险' },
    ]),
  )
  const marks = [...content.querySelectorAll('mark')]
  assert.deepEqual(
    marks.map((mark) => mark.textContent),
    ['没收全部押金', '第四条另行约定'],
  )
  assert.equal(marks[0].dataset.bubble, bubble)
  assert.equal(marks[0].dataset.level, 'high')
  assert.equal(marks[0].className, 'risk-high')
  assert.equal(content.querySelectorAll('br').length, 1)
  assert.equal(content.textContent, raw.replace('\n', ''))
  assertNoExecutableMarkup(content)
})

test('风险等级与气泡内容不能逃逸属性边界', () => {
  const bubble = '"><img src=x onerror="alert(1)">'
  const content = fragment(
    renderHighlightedContract('甲方没收押金', [
      { quote: '没收押金', level: 'high" onclick="alert(1)', bubble_text: bubble },
    ]),
  )
  const mark = content.querySelector('mark')
  assert.equal(mark.className, 'risk-low')
  assert.equal(mark.dataset.level, 'low')
  assert.equal(mark.dataset.bubble, bubble)
  assert.equal(content.querySelector('img'), null)
  assertNoExecutableMarkup(content)
})

test('空引文和没有汉字的引文不应误标整份合同', () => {
  for (const quote of ['', '123', '<img src=x>']) {
    assert.equal(fuzzyFind('甲方有权没收押金', quote), null)
  }
})

test('包含和相邻风险范围保留各自完整文本', () => {
  const content = fragment(
    renderHighlightedContract('甲方没收押金乙方承担费用', [
      { quote: '甲方没收押金', level: 'medium', bubble_text: '大范围' },
      { quote: '没收押金', level: 'high', bubble_text: '小范围' },
      { quote: '乙方承担费用', level: 'low', bubble_text: '相邻范围' },
    ]),
  )
  assert.equal(content.querySelector('.risk-medium').textContent, '甲方没收押金')
  assert.equal(content.querySelector('.risk-medium > .risk-high').textContent, '没收押金')
  assert.equal(content.querySelector('.risk-low').textContent, '乙方承担费用')
  assert.equal(content.textContent, '甲方没收押金乙方承担费用')
})

test('完全相同的风险范围保留各自气泡元数据', () => {
  const content = fragment(
    renderHighlightedContract('没收押金', [
      { quote: '没收押金', level: 'high', bubble_text: '第一项' },
      { quote: '没收押金', level: 'medium', bubble_text: '第二项' },
    ]),
  )
  assert.deepEqual(
    [...content.querySelectorAll('mark')].map((mark) => mark.dataset.bubble),
    ['第一项', '第二项'],
  )
  for (const mark of content.querySelectorAll('mark')) assert.equal(mark.textContent, '没收押金')
})
