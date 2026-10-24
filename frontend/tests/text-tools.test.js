import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'

// 不加载外部资源或执行脚本，只验证与页面相同的 Markdown 净化及文字提取。
const dom = new JSDOM('', { url: 'https://example.test/' })
globalThis.window = dom.window
const { stripMarkdown } = await import('../src/composables/useTextTools.js')
after(() => {
  dom.window.close()
  delete globalThis.window
})

for (const [name, source, expected] of [
  ['行内引用', '请核对 `民法典第585条`。', '请核对 民法典第585条。'],
  [
    '代码围栏',
    '```text\n第一条：退还押金。\n\n第二条：支付租金。\n```',
    '第一条：退还押金。\n\n第二条：支付租金。',
  ],
  ['波浪围栏内的字面格式', '~~~markdown\n**保留原文星号**\n~~~', '**保留原文星号**'],
  ['嵌套反引号', '说明：``引用 `原文` 片段``', '说明：引用 `原文` 片段'],
  ['缩进代码', '    第一行\n      第二行', '第一行\n  第二行'],
  ['代码内部缩进与行尾空格', '```text\n  第一行  \n    第二行\n```', '  第一行  \n    第二行'],
  ['代码内部连续空行', '```text\n第一行\n\n\n第四行\n```', '第一行\n\n\n第四行'],
  [
    '标题与强调',
    '# 审查报告\n\n## 风险点\n\n**原文：** *押金条款*。',
    '审查报告\n\n风险点\n\n原文： 押金条款。',
  ],
  ['引用段落', '> 第一段\n>\n> 第二段', '第一段\n\n第二段'],
  ['显式换行', '第一行  \n第二行<br>第三行', '第一行\n第二行\n第三行'],
  ['普通换行', '甲方应付款，\n乙方应收款。', '甲方应付款，\n乙方应收款。'],
  ['转义符号', '\\*不是加粗\\*，\\[不是链接\\]', '*不是加粗*，[不是链接]'],
  ['实体字符', 'A &amp; B &lt; 10 &gt; 1，&quot;合同&quot;', 'A & B < 10 > 1，"合同"'],
  ['代码中的 HTML 字面量', '`<script>alert(1)</script>`', '<script>alert(1)</script>'],
  ['HTML 段落', '<p>第一段<strong>重点</strong></p><p>第二段</p>', '第一段重点\n\n第二段'],
  ['水平分隔边界', '<div>甲方<hr>乙方</div>', '甲方\n\n乙方'],
  ['链接标题', '[**官方规定**](https://example.test/a_(b))', '官方规定'],
  ['图片替代文字', '![合同示例](https://example.test/file.png)', '合同示例'],
  ['无序列表', '- 甲方义务\n- 乙方义务', '- 甲方义务\n- 乙方义务'],
  ['有序列表起始编号', '3. 核对金额\n4. 核对日期', '3. 核对金额\n4. 核对日期'],
  [
    '嵌套列表',
    '- 甲方\n  - 交付义务\n  - 维修义务\n- 乙方',
    '- 甲方\n  - 交付义务\n  - 维修义务\n- 乙方',
  ],
  ['列表内部行内换行', '- **甲方**\n  **乙方**', '- 甲方\n  乙方'],
  ['列表与后续段落边界', '- 甲方\n  - 子项\n\n后续段落', '- 甲方\n  - 子项\n\n后续段落'],
  [
    '表格行列',
    '| 风险 | 建议 |\n| --- | --- |\n| 高危 | 修改押金 |\n| 中危 | 明确日期 |',
    '风险\t建议\n高危\t修改押金\n中危\t明确日期',
  ],
  ['非格式符号', '合同 # 编号，金额 * 2', '合同 # 编号，金额 * 2'],
  ['空文本', '', ''],
  ['仅空白内容', '\n \n', ''],
]) {
  test(`纯文本复制保留${name}的正文与必要结构`, () => {
    assert.equal(stripMarkdown(source), expected)
  })
}

test('纯文本复制只解码一层实体，不将代码里的实体再解释为 HTML', () => {
  assert.equal(stripMarkdown('`&lt;原文&gt;` 与 &amp;lt;'), '&lt;原文&gt; 与 &lt;')
})

test('纯文本复制移除不可见脚本和样式，图片只取说明文字', () => {
  const source =
    '正文<script>不可见脚本</script><img src="https://example.test/pixel" onerror="alert(1)" alt="附件说明"><style>不可见样式</style>'
  assert.equal(stripMarkdown(source), '正文附件说明')
  assert.equal(dom.window.document.querySelector('script, img, style'), null)
})

test('复制使用脱离页面的文档片段，不修改现有 DOM 或净化配置', () => {
  dom.window.document.body.innerHTML = '<p>已有页面内容</p>'
  const before = dom.window.document.body.innerHTML
  const source = '# 标题\n\n`合同原文`'
  assert.equal(stripMarkdown(source), '标题\n\n合同原文')
  assert.equal(stripMarkdown(source), '标题\n\n合同原文')
  assert.equal(dom.window.document.body.innerHTML, before)
})
