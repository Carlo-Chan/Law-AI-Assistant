import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { validDocumentBlocks } from '../src/utils/contractDocument.js'
import { getHighlightFragments, setHighlightPinned } from '../src/utils/highlightSelection.js'

const dom = new JSDOM('')
globalThis.window = dom.window
const { fuzzyFind, renderHighlightedContract } = await import('../src/utils/highlight.js')
const fixture = JSON.parse(
  await readFile(new URL('../../tests/fixtures/word-contract.json', import.meta.url), 'utf8'),
)
const pdfFixture = JSON.parse(
  await readFile(new URL('../../tests/fixtures/pdf-contract.json', import.meta.url), 'utf8'),
)
after(() => {
  dom.window.close()
  delete globalThis.window
})

function render(document = fixture, points = []) {
  const root = dom.window.document.createElement('div')
  root.className = 'contract-text'
  root.innerHTML = renderHighlightedContract(document.raw_text, points, document.document_blocks)
  return root
}
const risk = (quote, level = 'high') => ({ quote, level, bubble_text: '建议：' + quote })
const paragraph = (start, end) => ({ type: 'paragraph', start, end })
const cell = (column, start, end, extra = {}) => ({
  column,
  start,
  end,
  colspan: 1,
  rowspan: 1,
  blocks: [paragraph(start, end)],
  ...extra,
})

test('前后端共用 UTF-16 样本，表格行列及金额不因 emoji 坐标错位', () => {
  assert.equal(validDocumentBlocks(fixture.raw_text, fixture.document_blocks), true)
  const root = render()
  assert.equal(root.querySelectorAll('table').length, 1)
  assert.equal(root.querySelectorAll('tr').length, 2)
  assert.deepEqual(
    [...root.querySelectorAll('td')].map((node) => node.textContent),
    ['押金', '2000元', '租金', '3000元'],
  )
  assert.equal(root.firstChild.textContent, '合同😀')
  assert.equal(root.lastChild.textContent, '尾')
})

for (const quote of ['2000元', '3000元', '租金 3000元']) {
  test(`含金额的引文只匹配对应范围：${quote}`, () => {
    const root = render(fixture, [risk(quote)])
    const marked = [...root.querySelectorAll('mark')].map((node) => node.textContent).join('')
    assert.equal(marked, quote === '租金 3000元' ? '租金3000元' : quote)
    assert.equal(
      root.querySelector('mark').closest('td').textContent,
      quote.startsWith('租金') ? '租金' : quote,
    )
  })
}

for (const quote of ['租金4000元', '4000元', 'USD 3000']) {
  test(`数字或英文不符时不退化成汉字相同的错误高亮：${quote}`, () => {
    assert.equal(fuzzyFind(fixture.raw_text, quote), null)
  })
}

for (const quote of ['押金\t2000元', '2000元\n租金', '押金\t2000元\n租金\t3000元']) {
  test(`跨格及跨行高亮保留逻辑身份，钉住覆盖全部片段：${quote}`, () => {
    const root = render(fixture, [risk(quote)])
    const mark = root.querySelector('mark')
    const fragments = getHighlightFragments(mark)
    assert.ok(fragments.length > 1)
    assert.equal(fragments.map((node) => node.textContent).join(''), quote.replace(/[\n\t]/g, ''))
    assert.equal(root.querySelectorAll('td').length, 4)
    setHighlightPinned(mark, true)
    assert.equal(root.querySelectorAll('mark.pinned').length, fragments.length)
    setHighlightPinned(fragments.at(-1), false)
    assert.equal(root.querySelectorAll('mark.pinned').length, 0)
  })
}

test('大小范围重叠时按单元格切片，内层颜色及风险身份不丢失', () => {
  const root = render(fixture, [risk('押金\t2000元\n租金\t3000元', 'medium'), risk('2000元')])
  assert.equal(root.querySelector('mark.risk-high').parentElement.className, 'risk-medium')
  assert.equal(root.querySelector('mark.risk-high').closest('td').textContent, '2000元')
  assert.equal(root.querySelectorAll('td').length, 4)
})

for (const [raw, quote, expected] of [
  ['甲方1000元，乙方100元', '100元', '100元'],
  ['折扣0.5%，违约金5%', '5%', '5%'],
  ['编号2000', '200', null],
  ['冲抵-100元', '100元', null],
]) {
  test(`数字片段不会选中其他金额的子串：${raw}`, () => {
    const position = fuzzyFind(raw, quote)
    assert.equal(position ? raw.slice(position.start, position.end) : null, expected)
    if (position) assert.equal(position.start, raw.lastIndexOf(quote))
  })
}

test('纵向合并保留 rowspan，不重复显示锚点，也不插入占用列的空格', () => {
  const document = {
    raw_text: '付款\t100元\n200元',
    document_blocks: [
      {
        type: 'table',
        start: 0,
        end: 12,
        columns: 2,
        rows: [[cell(0, 0, 2, { rowspan: 2 }), cell(1, 3, 7)], [cell(1, 8, 12)]],
      },
    ],
  }
  const root = render(document)
  assert.equal(root.querySelector('td').rowSpan, 2)
  assert.equal(root.querySelectorAll('tr')[1].children.length, 1)
  assert.equal(root.querySelectorAll('td').length, 3)
})

test('横向合并保留 colspan，嵌套表格仍在所属单元格中', () => {
  const document = {
    raw_text: '费用\n物业\t100元',
    document_blocks: [
      {
        type: 'table',
        start: 0,
        end: 10,
        columns: 2,
        rows: [
          [
            cell(0, 0, 10, {
              colspan: 2,
              blocks: [
                paragraph(0, 2),
                {
                  type: 'table',
                  start: 3,
                  end: 10,
                  columns: 2,
                  rows: [[cell(0, 3, 5), cell(1, 6, 10)]],
                },
              ],
            }),
          ],
        ],
      },
    ],
  }
  const root = render(document)
  assert.equal(root.querySelector('td').colSpan, 2)
  assert.equal(root.querySelectorAll('table').length, 2)
  assert.equal(root.querySelector('td table td').textContent, '物业')
})

test('外部原文与气泡只按文本渲染，不成为表格 HTML 或事件属性', () => {
  const raw = '<img src=x onerror=alert(1)> & "原文"'
  const root = render({ raw_text: raw, document_blocks: [paragraph(0, raw.length)] }, [risk(raw)])
  assert.equal(root.querySelectorAll('img,script,[onerror]').length, 0)
  assert.equal(root.textContent, raw)
  assert.equal(root.querySelector('mark').dataset.bubble, '建议：' + raw)
})

for (const [name, change] of [
  [
    '超出原文',
    (blocks) => {
      blocks[0].end = 9999
    },
  ],
  [
    '截断 emoji',
    (blocks) => {
      blocks[0].end = 3
    },
  ],
  [
    '遗漏有效文字',
    (blocks) => {
      blocks[0].end = 1
    },
  ],
  [
    '块范围重叠',
    (blocks) => {
      blocks[1].start = 2
    },
  ],
  [
    '未知块类型',
    (blocks) => {
      blocks[0].type = 'script'
    },
  ],
  [
    '超出列数',
    (blocks) => {
      blocks[1].rows[0][0].colspan = 3
    },
  ],
  [
    '超出行数',
    (blocks) => {
      blocks[1].rows[0][0].rowspan = 3
    },
  ],
  [
    '列占位冲突',
    (blocks) => {
      blocks[1].rows[0][1].column = 0
    },
  ],
  [
    '纵向占位冲突',
    (blocks) => {
      blocks[1].rows[0][0].rowspan = 2
    },
  ],
  [
    '空列数',
    (blocks) => {
      blocks[1].columns = 0
    },
  ],
  [
    '异常行结构',
    (blocks) => {
      blocks[1].rows[0] = null
    },
  ],
  [
    '异常单元格',
    (blocks) => {
      blocks[1].rows[0][0] = null
    },
  ],
  [
    '丢失单元格内容',
    (blocks) => {
      blocks[1].rows[0][0].blocks = []
    },
  ],
]) {
  test(`异常结构回退完整原文，不执行不可信布局：${name}`, () => {
    const document = structuredClone(fixture)
    change(document.document_blocks)
    assert.equal(validDocumentBlocks(document.raw_text, document.document_blocks), false)
    const root = render(document)
    assert.equal(root.querySelector('table'), null)
    assert.equal(root.textContent, document.raw_text.replace(/\n/g, ''))
  })
}

test('无结构文本不猜测制表符为原表格，继续原有纯文本展示', () => {
  const root = render({ raw_text: fixture.raw_text }, [risk('3000元')])
  assert.equal(root.querySelector('table'), null)
  assert.equal(root.querySelector('mark').textContent, '3000元')
})

test('超出结构预算时回退完整正文，避免分配超大网格', () => {
  const document = structuredClone(fixture)
  document.document_blocks[1].columns = 1000000
  const root = render(document)
  assert.equal(root.querySelector('table'), null)
  assert.equal(root.textContent, fixture.raw_text.replace(/\n/g, ''))
})

test('真实 PDF 解析样本保留内外表格及前后正文，不重复内层金额', () => {
  assert.equal(validDocumentBlocks(pdfFixture.raw_text, pdfFixture.document_blocks), true)
  const root = render(pdfFixture)
  assert.equal(root.querySelectorAll('table').length, 2)
  assert.equal(
    root.querySelector('td table').closest('td').textContent,
    'BeforeDue7 daysAmount3000After',
  )
  assert.equal(root.textContent.split('3000').length - 1, 1)
  assert.equal(root.firstChild.textContent, 'Contract')
  assert.equal(root.lastChild.textContent, 'End')
})

test('PDF 内层单元格金额只高亮一次，切换钉住不影响其他格', () => {
  const root = render(pdfFixture, [risk('3000')])
  const mark = root.querySelector('mark')
  assert.equal(mark.closest('td').textContent, '3000')
  assert.equal(getHighlightFragments(mark).length, 1)
  setHighlightPinned(mark, true)
  assert.equal(root.querySelectorAll('mark.pinned').length, 1)
  setHighlightPinned(mark, false)
  assert.equal(root.querySelectorAll('mark.pinned').length, 0)
})

test('PDF 从内表跨到外层正文的高亮保持完整片段身份', () => {
  const quote = '7 days\nAmount\t3000\nAfter'
  const root = render(pdfFixture, [risk(quote)])
  const mark = root.querySelector('mark')
  const fragments = getHighlightFragments(mark)
  assert.equal(fragments.map((node) => node.textContent).join(''), quote.replace(/[\n\t]/g, ''))
  assert.equal(root.querySelectorAll('table').length, 2)
  assert.equal(root.querySelectorAll('td').length, 8)
  setHighlightPinned(mark, true)
  assert.equal(root.querySelectorAll('mark.pinned').length, fragments.length)
})

test('PDF 页间空行不影响后页表格的校验及高亮坐标', () => {
  const document = {
    raw_text: '合同😀\n\n2000元',
    document_blocks: [
      paragraph(0, 4),
      { type: 'table', columns: 1, start: 6, end: 11, rows: [[cell(0, 6, 11)]] },
    ],
  }
  assert.equal(validDocumentBlocks(document.raw_text, document.document_blocks), true)
  const root = render(document, [risk('2000元')])
  assert.equal(root.querySelector('mark').closest('td').textContent, '2000元')
  assert.equal(root.firstChild.textContent, '合同😀')
})
