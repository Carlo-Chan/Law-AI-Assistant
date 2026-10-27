import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('')
globalThis.window = dom.window
const { fuzzyFind, renderHighlightedContract } = await import('../src/utils/highlight.js')
const cases = JSON.parse(
  await readFile(new URL('../../tests/fixtures/quote-matching.json', import.meta.url), 'utf8'),
)

after(() => {
  dom.window.close()
  delete globalThis.window
})

// 与后端共享引用样本，防止后处理已保留金额，展示时却高亮成另一个表格项。
for (const { name, raw_text: raw, phrase, expected } of cases) {
  test(`后端引用与前端高亮衔接：${name}`, (context) => {
    const position = fuzzyFind(raw, phrase)
    assert.equal(position ? raw.slice(position.start, position.end) : null, expected)

    context.mock.method(console, 'warn', () => {})
    const root = dom.window.document.createElement('div')
    root.innerHTML = renderHighlightedContract(raw, [
      { quote: expected ?? phrase, key_phrase: phrase, level: 'high', bubble_text: '核对条款' },
    ])
    const marks = [...root.querySelectorAll('mark')]
    if (expected === null) assert.equal(marks.length, 0)
    else assert.equal(marks.map((mark) => mark.textContent).join(''), expected.replace(/\n/g, ''))
    assert.equal(root.textContent, raw.replace(/\n/g, ''))
  })
}
