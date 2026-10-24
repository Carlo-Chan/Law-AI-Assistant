import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { chatStream } from '../src/utils/api.js'

const response = (body) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
const frame = (event) => 'data: ' + JSON.stringify(event) + '\n\n'

test('缺少结束帧时报告截断，而不是静默漏存', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    response(frame({ type: 'token', content: '已有部分内容' })),
  )
  const onError = mock.fn()
  const onDone = mock.fn()
  await chatStream('问题', [], undefined, { onError, onDone })
  assert.equal(onError.mock.callCount(), 1)
  assert.equal(onDone.mock.callCount(), 0)
})

test('末尾没有换行的结束帧仍正常完成', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => response('data: {"type":"done"}'))
  const onDone = mock.fn()
  await chatStream('问题', [], undefined, { onDone })
  assert.equal(onDone.mock.callCount(), 1)
})

test('首次结束后不再处理重复结束或追加 token', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    response(
      [
        frame({ type: 'done' }),
        frame({ type: 'token', content: '不可追加' }),
        frame({ type: 'done' }),
      ].join(''),
    ),
  )
  const onDone = mock.fn()
  const onToken = mock.fn()
  await chatStream('问题', [], undefined, { onDone, onToken })
  assert.equal(onDone.mock.callCount(), 1)
  assert.equal(onToken.mock.callCount(), 0)
})

test('返回前等待异步完成回调，不提前释放保存中的请求', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => response(frame({ type: 'done' })))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let finished = false
  const sending = chatStream('问题', [], undefined, {
    onDone: async () => {
      entered()
      await gate
    },
  })
  sending.then(() => {
    finished = true
  })
  try {
    await started
    await new Promise(setImmediate)
    assert.equal(finished, false)
  } finally {
    release()
    await sending
  }
})
