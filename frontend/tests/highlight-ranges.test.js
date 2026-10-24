import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import {
  getHighlightFragments,
  getHighlightRect,
  isSameHighlight,
  setHighlightPinned,
} from '../src/utils/highlightSelection.js'

const dom = new JSDOM('')
globalThis.window = dom.window
const { renderHighlightedContract } = await import('../src/utils/highlight.js')
after(() => {
  dom.window.close()
  delete globalThis.window
})

function contract(raw, points) {
  const root = dom.window.document.createElement('div')
  root.className = 'contract-text'
  root.innerHTML = renderHighlightedContract(raw, points)
  return root
}

function point(quote, level = 'high', bubble = quote) {
  return { quote, level, bubble_text: bubble }
}

// 同一逻辑风险可以分段，但拼接后必须恰好是它的原文范围。
function textFor(root, bubble) {
  return [...root.querySelectorAll('mark')]
    .filter((mark) => mark.dataset.bubble === bubble)
    .map((mark) => mark.textContent)
    .join('')
}

test('交叉高亮不扩张外层，也不截断后结束的风险', () => {
  const root = contract('甲乙丙丁戊己庚辛', [point('甲乙丙丁戊'), point('丁戊己庚', 'medium')])
  assert.equal(textFor(root, '甲乙丙丁戊'), '甲乙丙丁戊')
  assert.equal(textFor(root, '丁戊己庚'), '丁戊己庚')
  assert.equal(root.textContent, '甲乙丙丁戊己庚辛')
})

test('较小范围在交叉部分的最内层，不受输入顺序和起点影响', () => {
  for (const points of [
    [point('甲乙丙丁戊'), point('丁戊己庚', 'medium')],
    [point('丁戊己庚', 'medium'), point('甲乙丙丁戊')],
    [point('甲乙丙丁', 'medium'), point('丙丁戊己庚')],
  ]) {
    const root = contract('甲乙丙丁戊己庚辛', points)
    const inner = [...root.querySelectorAll('mark mark')]
    assert.ok(inner.length)
    assert.ok(inner.every((mark) => mark.dataset.level === 'medium'))
    for (const item of points) assert.equal(textFor(root, item.bubble_text), item.quote)
  }
})

test('多重交叉、包含、同边界和相邻范围保留完整原文及元数据', () => {
  const raw = '甲乙丙丁戊己庚辛壬癸'
  const quotes = ['甲乙丙丁戊', '丁戊己庚', '乙丙丁戊己庚辛', '丙丁戊', '甲乙', '壬癸', '己庚']
  const root = contract(
    raw,
    quotes.map((quote, index) => point(quote, 'low', `风险${index}`)),
  )
  assert.equal(root.textContent, raw)
  for (const [index, quote] of quotes.entries()) {
    assert.equal(textFor(root, `风险${index}`), quote)
    const marks = [...root.querySelectorAll('mark')].filter(
      (mark) => mark.dataset.bubble === `风险${index}`,
    )
    assert.equal(new Set(marks.map((mark) => mark.dataset.riskId)).size, 1)
    assert.ok(marks.every((mark) => mark.dataset.riskId !== undefined))
  }
  assert.equal(
    new Set([...root.querySelectorAll('mark')].map((mark) => mark.dataset.riskId)).size,
    quotes.length,
  )
})

test('分段以原文坐标定位，保留换行、标点、HTML 字符和安全转义', () => {
  const raw = '<甲>&乙\n丙"丁戊己庚辛'
  const bubble = '"><img src=x onerror=alert(1)>\n风险'
  const root = contract(raw, [point('甲乙丙丁戊', 'high', bubble), point('丁戊己庚', 'medium')])
  assert.equal(root.textContent, raw.replace('\n', ''))
  assert.equal(textFor(root, bubble), '甲>&乙丙"丁戊')
  assert.equal(textFor(root, '丁戊己庚'), '丁戊己庚')
  assert.equal(root.querySelectorAll('br').length, 1)
  assert.equal(root.querySelector('img, script, [onerror], [onclick]'), null)
})

test('穷举两段区间：交叉、包含、相同、同起止点、相邻均无越界或丢字', () => {
  const raw = '甲乙丙丁戊己'
  const ranges = []
  for (let start = 0; start < raw.length; start++) {
    for (let end = start + 1; end <= raw.length; end++) ranges.push(raw.slice(start, end))
  }
  for (const first of ranges) {
    for (const second of ranges) {
      const root = contract(raw, [point(first, 'high', '第一项'), point(second, 'low', '第二项')])
      assert.equal(root.textContent, raw)
      assert.equal(textFor(root, '第一项'), first, `${first} / ${second}`)
      assert.equal(textFor(root, '第二项'), second, `${first} / ${second}`)
    }
  }
})

test('分段共享身份，钉住和取消均覆盖完整风险，不串到另一份合同', () => {
  const points = [point('甲乙丙丁戊'), point('丁戊己庚', 'medium')]
  const root = contract('甲乙丙丁戊己庚辛', points)
  const other = contract('甲乙丙丁戊己庚辛', points)
  const fragments = [...root.querySelectorAll('.risk-medium')]
  assert.equal(fragments.length, 2)
  assert.deepEqual(getHighlightFragments(fragments[1]), fragments)
  assert.equal(isSameHighlight(fragments[0], fragments[1]), true)
  assert.equal(isSameHighlight(fragments[0], other.querySelector('.risk-medium')), false)
  setHighlightPinned(fragments[1], true)
  assert.equal(root.querySelectorAll('mark.pinned').length, 2)
  assert.equal(root.querySelector('.risk-high').classList.contains('pinned'), false)
  assert.equal(other.querySelectorAll('.pinned').length, 0)
  setHighlightPinned(fragments[0], false)
  assert.equal(root.querySelectorAll('.pinned').length, 0)
})

test('气泡坐标包含各片段，读取新坐标以跟随滚动', () => {
  const root = contract('甲乙丙丁戊己庚辛', [point('甲乙丙丁戊'), point('丁戊己庚', 'medium')])
  const fragments = [...root.querySelectorAll('.risk-medium')]
  let offset = 0
  fragments[0].getBoundingClientRect = () => ({
    left: 50,
    right: 90,
    top: 100 - offset,
    bottom: 120 - offset,
  })
  fragments[1].getBoundingClientRect = () => ({
    left: 10,
    right: 40,
    top: 130 - offset,
    bottom: 150 - offset,
  })
  assert.deepEqual(getHighlightRect(fragments[1]), {
    left: 10,
    right: 90,
    top: 100,
    bottom: 150,
    width: 80,
    height: 50,
  })
  offset = 30
  assert.equal(getHighlightRect(fragments[0]).top, 70)
})

test('未匹配的风险不改变后续身份，相同气泡文字也不合并不同风险', () => {
  const root = contract('甲乙丙丁戊己庚辛', [
    point(''),
    point('甲乙丙丁戊', 'high', '相同分析'),
    point('丁戊己庚', 'medium', '相同分析'),
  ])
  const high = root.querySelector('.risk-high')
  const medium = root.querySelector('.risk-medium')
  assert.equal(high.dataset.riskId, '1')
  assert.equal(medium.dataset.riskId, '2')
  assert.equal(isSameHighlight(high, medium), false)
})
