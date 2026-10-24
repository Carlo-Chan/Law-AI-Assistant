import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeContractInstruction } from '../src/utils/contractInstruction.js'
import { analyzeContractStream } from '../src/utils/api.js'

test('指令只去首尾空白，保留中文和内部换行', () => {
  assert.equal(
    normalizeContractInstruction(' \n重点审查乙方责任\n检查押金退还\t'),
    '重点审查乙方责任\n检查押金退还',
  )
  assert.equal(normalizeContractInstruction(), '')
  assert.equal(normalizeContractInstruction(' \n\t'), '')
})

test('指令上限按 Unicode 字符计，拒绝超限而非截断', () => {
  assert.equal(normalizeContractInstruction(' 🙂'.trim().repeat(4000)).length, 8000)
  assert.equal(normalizeContractInstruction(' 字'.trim().repeat(4000)).length, 4000)
  assert.throws(() => normalizeContractInstruction('字'.repeat(4001)), /4000/)
  assert.throws(() => normalizeContractInstruction('🙂'.repeat(4001)), /4000/)
  assert.throws(() => normalizeContractInstruction({ text: '不要隐式转成对象字符串' }), TypeError)
})

for (const instruction of ['', ' \n\t ', '  重点审查乙方责任\n检查押金  ']) {
  test(`流式上传正确传递${instruction.trim() ? '多行指令' : '空白或省略指令'}`, async (context) => {
    const file = new File(['甲方退还押金'], '合同.txt')
    context.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.body.get('file'), file)
      assert.equal(options.body.get('instruction'), instruction.trim() || null)
      assert.deepEqual(
        [...options.body.keys()],
        instruction.trim() ? ['file', 'instruction'] : ['file'],
      )
      return new Response('data: {"type":"done"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    assert.equal(
      (await analyzeContractStream(file, undefined, {}, instruction)).status,
      'completed',
    )
  })
}

test('流式上传在超限时不发请求', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('不应联网')
  })
  await assert.rejects(
    analyzeContractStream(new File(['合同'], '合同.txt'), undefined, {}, '字'.repeat(4001)),
    /4000/,
  )
  assert.equal(fetch.mock.callCount(), 0)
})

test('浏览器 multipart 换行统一为 LF，边界不因 CRLF 膨胀而超限', () => {
  assert.equal(normalizeContractInstruction('  重点\r\n检查\r押金  '), '重点\n检查\n押金')
  const boundary = '甲'.repeat(3998) + '\r\n乙'
  assert.equal(normalizeContractInstruction(boundary), '甲'.repeat(3998) + '\n乙')
  assert.equal([...normalizeContractInstruction(boundary)].length, 4000)
})
