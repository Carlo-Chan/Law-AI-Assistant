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
const { fuzzyFind, renderHighlightedContract } = await import('../src/utils/highlight.js')
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

// 用短文本穷举子串作为独立参照，不复制生产代码的动态规划实现。
function referenceFind(raw, quote) {
  const positions = [...raw.matchAll(/[一-龥]/g)]
  const text = positions.map((match) => match[0]).join('')
  const query = quote.replace(/[^一-龥]/g, '')
  if (!query) return null
  let start = text.indexOf(query)
  let length = query.length
  if (start < 0) {
    length = 0
    for (let offset = 0; offset < text.length; offset++) {
      for (let end = offset + length + 1; end <= text.length; end++) {
        if (query.includes(text.slice(offset, end))) {
          start = offset
          length = end - offset
        }
      }
    }
    if (length < Math.min(4, query.length * 0.6)) return null
  }
  return { start: positions[start].index, end: positions[start + length - 1].index + 1 }
}

for (const [name, raw, quote, expected] of [
  [
    '精确匹配忽略标点与数字但保留原始坐标',
    '前言\n甲方：支付100，押金。',
    '甲方支付押金',
    { start: 3, end: 14 },
  ],
  ['回退处理重复字符且每行失配时归零', '甲乙甲乙丙丁', '乙甲乙丙戊丁', { start: 1, end: 5 }],
  [
    '最长范围同长时选择原文中更早出现的范围',
    '甲乙丙丁，戊己庚辛',
    '戊己庚辛壬甲乙丙丁',
    { start: 0, end: 4 },
  ],
  ['短引文仍采用原有六成阈值', '甲乙丙丁', '乙丙戊', { start: 1, end: 3 }],
  ['不足短引文阈值时不标注', '甲乙丙丁', '乙戊', null],
  ['公共子串必须连续而非公共子序列', '甲乙丙丁戊己', '甲丙戊庚辛壬癸', null],
  ['引文无汉字时不标注', '甲乙丙丁', 'ABC 123', null],
  ['原文无汉字时不标注', 'ABC 123', '甲乙丙丁', null],
]) {
  test(`模糊定位：${name}`, () => {
    assert.deepEqual(fuzzyFind(raw, quote), expected)
  })
}

test('模糊定位与独立穷举参照一致，保留重复字符、阈值和并列选择规则', () => {
  let seed = 20261025
  function next(bound) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed >>> 16) % bound
  }
  function sample(size) {
    const alphabet = '甲乙丙丁， 1\n'
    return Array.from({ length: size }, () => alphabet[next(alphabet.length)]).join('')
  }
  for (let index = 0; index < 512; index++) {
    const raw = sample(next(24))
    const quote = sample(next(16))
    assert.deepEqual(fuzzyFind(raw, quote), referenceFind(raw, quote), `${raw} / ${quote}`)
  }
})

for (const textLength of [4000, 12000]) {
  test(`长合同模糊匹配不分配原文乘引文大小的数组：${textLength} 字`, () => {
    const raw = '甲'.repeat(textLength) + '乙丙丁戊'
    const quote = '乙丙丁戊' + '己'.repeat(996)
    const budget = 8 * (quote.length + 1)
    const originalArray = globalThis.Array
    const originalTypedArray = globalThis.Uint32Array
    let allocated = 0
    let actual
    const track = (constructor) =>
      new Proxy(constructor, {
        construct(target, args, receiver) {
          if (typeof args[0] === 'number') {
            allocated += args[0]
            if (allocated > budget) throw new Error('匹配临时数组超过线性槽位预算')
          }
          return Reflect.construct(target, args, receiver)
        },
      })
    try {
      // 仅同步拦截本次匹配的显式数组分配，超预算即失败，不制造真实内存耗尽。
      globalThis.Array = track(originalArray)
      globalThis.Uint32Array = track(originalTypedArray)
      actual = fuzzyFind(raw, quote)
    } finally {
      globalThis.Array = originalArray
      globalThis.Uint32Array = originalTypedArray
    }
    assert.deepEqual(actual, { start: textLength, end: textLength + 4 })
    assert.ok(allocated <= budget)
  })
}

test('模糊定位后的交叉风险仍保留完整范围与钉住身份', () => {
  const root = contract('甲乙丙丁戊己庚辛', [
    point('甲乙丙丁戊壬', 'high', '第一项'),
    point('丁戊己庚癸', 'medium', '第二项'),
  ])
  assert.equal(textFor(root, '第一项'), '甲乙丙丁戊')
  assert.equal(textFor(root, '第二项'), '丁戊己庚')
  assert.equal(root.textContent, '甲乙丙丁戊己庚辛')
  const fragments = [...root.querySelectorAll('.risk-medium')]
  assert.equal(fragments.length, 2)
  setHighlightPinned(fragments[1], true)
  assert.equal(root.querySelectorAll('mark.pinned').length, 2)
  assert.equal(root.querySelector('.risk-high').classList.contains('pinned'), false)
})

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
