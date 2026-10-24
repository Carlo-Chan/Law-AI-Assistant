import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { readSSEStream, StreamCallbackError } from '../src/utils/sse.js'

const encoder = new TextEncoder()
const privateText = 'sk-private 错误页中的敏感正文'
const send = (callbacks, signal, options) =>
  readSSEStream('/test', { method: 'POST' }, signal, callbacks, options)
const flush = () => new Promise(setImmediate)

// 禁用预读，区分主动读取的分包与尚未接收的尾部，并能清理红灯用例的挂起响应。
function fixture(context, chunks, { pending = false, headers = {} } = {}) {
  const state = { reads: 0, cancelled: 0, closed: false }
  let index = 0
  let sink
  state.body = new ReadableStream(
    {
      start(controller) {
        sink = controller
      },
      pull(controller) {
        state.reads++
        if (index < chunks.length) controller.enqueue(chunks[index++])
        else if (!pending) {
          state.closed = true
          controller.close()
        }
      },
      cancel() {
        state.cancelled++
        state.closed = true
      },
    },
    { highWaterMark: 0 },
  )
  state.response = new Response(state.body, { status: 502, headers })
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    state.transport = options.signal
    return state.response
  })
  state.warning = context.mock.method(console, 'warn', () => {})
  state.push = (bytes) => sink.enqueue(bytes)
  state.fail = (error) => {
    state.closed = true
    sink.error(error)
  }
  state.close = () => {
    if (!state.closed) {
      state.closed = true
      sink.close()
    }
  }
  context.after(state.close)
  return state
}

function assertHttpFallback(onError, onDone) {
  assert.equal(onError.mock.callCount(), 1)
  assert.deepEqual(onError.mock.calls[0].arguments, [
    '请求失败（HTTP 502）',
    { kind: 'http', status: 502 },
  ])
  assert.equal(onDone.mock.callCount(), 0)
}

test('默认限制 HTTP 错误响应为 64 KiB，不信任较小的 Content-Length 声明', async (context) => {
  const state = fixture(
    context,
    [encoder.encode(JSON.stringify({ detail: privateText, padding: 'x'.repeat(64 * 1024) }))],
    { headers: { 'Content-Length': '1' } },
  )
  const onError = mock.fn()
  const onDone = mock.fn()
  assert.deepEqual(await send({ onError, onDone }), { status: 'error' })
  assertHttpFallback(onError, onDone)
  assert.equal(state.cancelled, 1)
  assert.equal(state.body.locked, false)
  assert.ok(!JSON.stringify(state.warning.mock.calls).includes(privateText))
})

for (const chunkSize of [32, 1000]) {
  test(`HTTP 错误${chunkSize === 32 ? '跨分包累计' : '单个大分包'}超限即停止，不继续读取尾部`, async (context) => {
    const bytes = encoder.encode(JSON.stringify({ detail: privateText, padding: 'x'.repeat(100) }))
    const chunks = []
    for (let offset = 0; offset < bytes.length; offset += chunkSize)
      chunks.push(bytes.subarray(offset, offset + chunkSize))
    const state = fixture(context, chunks)
    const onError = mock.fn()
    const onDone = mock.fn()
    await send({ onError, onDone }, undefined, { maxErrorBodyBytes: 64 })
    assertHttpFallback(onError, onDone)
    assert.equal(state.reads, chunkSize === 32 ? 3 : 1)
    assert.equal(state.cancelled, 1)
    assert.equal(state.body.locked, false)
    assert.equal(state.transport.aborted, true)
  })
}

for (const bytewise of [false, true]) {
  for (const overflow of [false, true]) {
    test(`中文与 emoji 错误提示${bytewise ? '逐字节' : '整包'}读取，按字节${overflow ? '超限回退' : '恰好达限保留'}`, async (context) => {
      const detail = '服务暂不可用，请稍后重试。😀'
      const bytes = encoder.encode(JSON.stringify({ detail }))
      const state = fixture(
        context,
        bytewise ? [...bytes].map((byte) => Uint8Array.of(byte)) : [bytes],
      )
      const onError = mock.fn()
      const onDone = mock.fn()
      await send({ onError, onDone }, undefined, {
        maxErrorBodyBytes: bytes.length - (overflow ? 1 : 0),
      })
      assert.equal(onError.mock.callCount(), 1)
      assert.equal(onError.mock.calls[0].arguments[0], overflow ? '请求失败（HTTP 502）' : detail)
      assert.equal(onError.mock.calls[0].arguments[1].kind, 'http')
      assert.equal(onDone.mock.callCount(), 0)
      assert.equal(state.body.locked, false)
    })
  }
}

for (const reason of ['timeout', 'abort']) {
  test(`HTTP 错误体读取中${reason === 'timeout' ? '空闲超时' : '主动停止'}会取消流并释放读锁`, async (context) => {
    const state = fixture(context, [encoder.encode('{"detail":"未结束')], { pending: true })
    const controller = new AbortController()
    const onError = mock.fn()
    const onDone = mock.fn()
    const sending = send({ onError, onDone }, controller.signal, { idleTimeoutMs: 20 })
    try {
      await flush()
      if (reason === 'abort') controller.abort()
      const result = await sending
      if (reason === 'abort') {
        assert.deepEqual(result, { status: 'aborted' })
        assert.equal(onError.mock.callCount(), 0)
        assert.deepEqual(onDone.mock.calls[0].arguments, [{ aborted: true }])
      } else {
        assert.deepEqual(result, { status: 'error' })
        assert.equal(onError.mock.calls[0].arguments[1].kind, 'timeout')
        assert.equal(onDone.mock.callCount(), 0)
      }
      assert.equal(state.cancelled, 1)
      assert.equal(state.body.locked, false)
      assert.equal(state.transport.aborted, true)
    } finally {
      state.close()
      await sending
    }
  })
}

test('HTTP 错误体持续收到新分包时重置空闲计时，不把整个读取时长当作超时', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const state = fixture(context, [], { pending: true })
  const detail = '服务暂不可用'
  const bytes = encoder.encode(JSON.stringify({ detail }))
  const onError = mock.fn()
  const sending = send({ onError }, undefined, { idleTimeoutMs: 20 })
  try {
    await flush()
    for (let offset = 0; offset < bytes.length; offset += 8) {
      context.mock.timers.tick(15)
      state.push(bytes.subarray(offset, offset + 8))
      await flush()
    }
    state.close()
    await sending
    assert.deepEqual(onError.mock.calls[0].arguments, [detail, { kind: 'http', status: 502 }])
    assert.equal(state.response.body.locked, false)
  } finally {
    state.close()
    await sending
  }
})

test('损坏的 UTF-8 错误提示不以替代字符展示，回退为原 HTTP 状态', async (context) => {
  const state = fixture(context, [
    encoder.encode('{"detail":"'),
    Uint8Array.of(0xe4, 0xb8),
    encoder.encode('"}'),
  ])
  const onError = mock.fn()
  const onDone = mock.fn()
  await send({ onError, onDone })
  assertHttpFallback(onError, onDone)
  assert.equal(state.body.locked, false)
})

test('HTTP 错误体读取失败只保留已知状态，不泄露原异常或伪造完成', async (context) => {
  const state = fixture(context, [], { pending: true })
  state.fail(new TypeError(privateText))
  const onError = mock.fn()
  const onDone = mock.fn()
  await send({ onError, onDone })
  assertHttpFallback(onError, onDone)
  assert.ok(!JSON.stringify(state.warning.mock.calls).includes(privateText))
  assert.equal(state.response.body.locked, false)
})

test('HTTP 错误没有响应体时仍只报告原状态', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 502 }))
  const onError = mock.fn()
  const onDone = mock.fn()
  await send({ onError, onDone })
  assertHttpFallback(onError, onDone)
})

for (const maxErrorBodyBytes of [0, -1, 1.5, Infinity]) {
  test(`HTTP 错误体限制为 ${maxErrorBodyBytes} 时在联网前拒绝配置`, async (context) => {
    const fetch = context.mock.method(
      globalThis,
      'fetch',
      async () => new Response(null, { status: 502 }),
    )
    await assert.rejects(send({}, undefined, { maxErrorBodyBytes }), RangeError)
    assert.equal(fetch.mock.callCount(), 0)
  })
}

test('HTTP 错误体超限仍等待异步收尾，回调失败不触发第二次错误或完成', async (context) => {
  const state = fixture(context, [encoder.encode('x'.repeat(100))])
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const onError = mock.fn(async () => {
    entered()
    await gate
    throw new Error(privateText)
  })
  const onDone = mock.fn()
  const sending = send({ onError, onDone }, undefined, { maxErrorBodyBytes: 64 })
  let finished = false
  const checked = assert.rejects(sending, StreamCallbackError).then(() => {
    finished = true
  })
  try {
    await started
    await flush()
    assert.equal(finished, false)
    assert.equal(state.cancelled, 1)
  } finally {
    release()
    await checked
  }
  assert.equal(onError.mock.callCount(), 1)
  assert.equal(onDone.mock.callCount(), 0)
  assert.equal(state.body.locked, false)
})

test('HTTP 错误体额度不限制正常 SSE 长正文', async (context) => {
  const text = '正常长回复'.repeat(2000)
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: 'token', content: text })}\n\ndata: {"type":"done"}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  )
  const onToken = mock.fn()
  const onDone = mock.fn()
  const onError = mock.fn()
  assert.deepEqual(await send({ onToken, onDone, onError }, undefined, { maxErrorBodyBytes: 8 }), {
    status: 'completed',
  })
  assert.equal(onToken.mock.calls[0].arguments[0], text)
  assert.equal(onDone.mock.callCount(), 1)
  assert.equal(onError.mock.callCount(), 0)
})
