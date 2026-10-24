import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { readSSEStream, StreamCallbackError } from '../src/utils/sse.js'

const headers = { 'Content-Type': 'text/event-stream; charset=utf-8' }
const encoder = new TextEncoder()
const frame = (event) => 'data: ' + JSON.stringify(event) + '\n\n'
const response = (body) => new Response(body, { headers })
const send = (callbacks, signal, options) =>
  readSSEStream('/test', { method: 'POST' }, signal, callbacks, options)

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const newline of ['\n', '\r', '\r\n']) {
  test(`支持 ${JSON.stringify(newline)}、逐字节中文、心跳及多行 data`, async (context) => {
    const text = [
      '\uFEFF: heartbeat',
      'event: message',
      'id: 1',
      'retry: 1000',
      'data:{',
      'data: "type":"token",',
      'data: "content":"中文<&>"}',
      '',
      'data:{"type":"done"}',
      '',
      '',
    ].join(newline)
    const bytes = encoder.encode(text)
    context.mock.method(globalThis, 'fetch', async () =>
      response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
            controller.close()
          },
        }),
      ),
    )
    const onToken = mock.fn()
    const onDone = mock.fn()
    assert.deepEqual(await send({ onToken, onDone }), { status: 'completed' })
    assert.deepEqual(
      onToken.mock.calls.map((call) => call.arguments[0]),
      ['中文<&>'],
    )
    assert.equal(onDone.mock.callCount(), 1)
  })
}

test('所有工具与推理事件按原有参数顺序分发', async (context) => {
  const events = [
    { type: 'thinking', label: 'search' },
    { type: 'thinking_reasoning', content: '分析' },
    { type: 'thinking_reasoning_token', content: '片段' },
    { type: 'tool_result_chunk', tool: 'search', content: '结果', first: true },
    { type: 'tool_result_end', tool: 'search' },
    { type: 'tool_result', tool: 'search', output: '完整结果' },
    { type: 'done' },
  ]
  context.mock.method(globalThis, 'fetch', async () => response(events.map(frame).join('')))
  const calls = []
  await send(
    Object.fromEntries(
      [
        'onThinking',
        'onReasoning',
        'onReasoningToken',
        'onToolChunk',
        'onToolResult',
        'onDone',
      ].map((name) => [name, (...args) => calls.push([name, ...args])]),
    ),
  )
  assert.deepEqual(calls.slice(0, -1), [
    ['onThinking', 'search'],
    ['onReasoning', '分析'],
    ['onReasoningToken', '片段'],
    ['onToolChunk', 'search', '结果', true],
    ['onToolResult', 'search', '完整结果'],
  ])
})

for (const event of [
  null,
  [],
  {},
  { type: 'unknown' },
  { type: ['done'] },
  { type: 'token', content: 42 },
  { type: 'thinking', label: null },
  { type: 'error', message: '' },
  { type: 'error', message: null },
  { type: 'tool_result_chunk', tool: 'search', content: '结果', first: 'yes' },
]) {
  test(`非法事件只触发一次协议错误：${JSON.stringify(event)}`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () =>
      response(frame(event) + frame({ type: 'done' })),
    )
    const onError = mock.fn()
    const onDone = mock.fn()
    await send({ onError, onDone })
    assert.equal(onError.mock.callCount(), 1)
    assert.equal(onError.mock.calls[0].arguments[1].kind, 'protocol')
    assert.equal(onDone.mock.callCount(), 0)
  })
}

for (const body of [
  'data: {"type":"token"',
  'data: \n\n',
  ': heartbeat\n\n',
  'data: {broken}\n\n',
]) {
  test(`截断、空帧或无合法结束帧都不伪造完成：${JSON.stringify(body)}`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => response(body))
    const onError = mock.fn()
    const onDone = mock.fn()
    await send({ onError, onDone })
    assert.equal(onError.mock.callCount(), 1)
    assert.equal(onDone.mock.callCount(), 0)
  })
}

test('UTF-8 尾部残缺按协议错误处理，不用替代字符掩盖损坏', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => response(Uint8Array.of(0xe4, 0xb8)))
  const onError = mock.fn()
  await send({ onError })
  assert.equal(onError.mock.calls[0].arguments[1].kind, 'protocol')
})

test('错误内容类型或空响应体不能被当作成功', async (context) => {
  for (const invalid of [new Response('private html'), new Response(null, { headers })]) {
    context.mock.method(globalThis, 'fetch', async () => invalid)
    const onError = mock.fn()
    await send({ onError })
    assert.equal(onError.mock.calls[0].arguments[1].kind, 'protocol')
    assert.ok(!onError.mock.calls[0].arguments[0].includes('private'))
  }
})

test('错误结束后忽略后续完成与正文，并等待异步错误回调', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    response(
      frame({ type: 'error', message: '服务暂不可用' }) +
        frame({ type: 'done' }) +
        frame({ type: 'token', content: '不可追加' }),
    ),
  )
  const gate = deferred()
  const entered = deferred()
  let finished = false
  const onDone = mock.fn()
  const onToken = mock.fn()
  const onError = mock.fn(async () => {
    entered.resolve()
    await gate.promise
  })
  const pending = send({ onError, onDone, onToken }).then(() => {
    finished = true
  })
  try {
    await entered.promise
    await new Promise(setImmediate)
    assert.equal(finished, false)
  } finally {
    gate.resolve()
    await pending
  }
  assert.equal(onError.mock.callCount(), 1)
  assert.equal(onDone.mock.callCount(), 0)
  assert.equal(onToken.mock.callCount(), 0)
})

test('非终止回调失败归类为本地处理失败，不暴露异常详情', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    response(frame({ type: 'token', content: '部分正文' }) + frame({ type: 'done' })),
  )
  const onError = mock.fn()
  await send({
    onToken: () => {
      throw new Error('sk-private local exception')
    },
    onError,
  })
  assert.equal(onError.mock.calls[0].arguments[1].kind, 'processing')
  assert.ok(!onError.mock.calls[0].arguments[0].includes('sk-private'))
})

for (const type of ['done', 'error']) {
  test(`${type} 回调失败向调用方抛出安全处理错误，不二次保存`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () =>
      response(frame({ type, message: '服务错误' })),
    )
    const onError = mock.fn(async () => {
      if (type === 'error') throw new Error('sk-private save failure')
    })
    const onDone = mock.fn(async () => {
      throw new Error('sk-private save failure')
    })
    await assert.rejects(
      send({ onError, onDone }),
      (error) => error instanceof StreamCallbackError && !error.message.includes('sk-private'),
    )
    assert.equal(onError.mock.callCount(), type === 'error' ? 1 : 0)
    assert.equal(onDone.mock.callCount(), type === 'done' ? 1 : 0)
  })
}

test('已完成但连接不关闭时立即收尾并释放读锁', async (context) => {
  let cancelled = 0
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frame({ type: 'done' })))
    },
    cancel() {
      cancelled++
    },
  })
  context.mock.method(globalThis, 'fetch', async () => response(body))
  await send({})
  assert.equal(cancelled, 1)
  assert.equal(body.locked, false)
})

test('读取途中发生网络异常只报告一次，已分发的内容不撤回', async (context) => {
  let reads = 0
  const body = new ReadableStream({
    pull(controller) {
      if (reads++ === 0)
        controller.enqueue(encoder.encode(frame({ type: 'token', content: '已有内容' })))
      else controller.error(new TypeError('private network details'))
    },
  })
  context.mock.method(globalThis, 'fetch', async () => response(body))
  context.mock.method(console, 'warn', () => {})
  const onToken = mock.fn()
  const onError = mock.fn()
  await send({ onToken, onError })
  assert.equal(onToken.mock.callCount(), 1)
  assert.equal(onError.mock.calls[0].arguments[1].kind, 'network')
  assert.equal(body.locked, false)
})

test('开始前停止不发请求，只触发一次取消完成', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('不应调用')
  })
  const controller = new AbortController()
  controller.abort()
  const onDone = mock.fn()
  assert.deepEqual(await send({ onDone }, controller.signal), { status: 'aborted' })
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(onDone.mock.calls[0].arguments, [{ aborted: true }])
})

for (const phase of ['headers', 'body']) {
  test(`等待 ${phase} 时空闲超时可中断并释放资源`, async (context) => {
    let cancelled = 0
    let transport
    const body = new ReadableStream({
      cancel() {
        cancelled++
      },
    })
    context.mock.method(globalThis, 'fetch', (_url, options) => {
      transport = options.signal
      return phase === 'headers' ? new Promise(() => {}) : Promise.resolve(response(body))
    })
    const onError = mock.fn()
    await send({ onError }, undefined, { idleTimeoutMs: 20 })
    assert.equal(onError.mock.calls[0].arguments[1].kind, 'timeout')
    assert.equal(transport.aborted, true)
    if (phase === 'body') {
      assert.equal(cancelled, 1)
      assert.equal(body.locked, false)
    }
  })
}

test('等待下一片数据时主动停止不会误报超时或网络错误', async (context) => {
  const entered = deferred()
  let cancelled = 0
  const body = new ReadableStream({
    pull() {
      entered.resolve()
    },
    cancel() {
      cancelled++
    },
  })
  context.mock.method(globalThis, 'fetch', async () => response(body))
  const controller = new AbortController()
  const onError = mock.fn()
  const onDone = mock.fn()
  const pending = send({ onError, onDone }, controller.signal)
  await entered.promise
  controller.abort()
  await pending
  assert.equal(onError.mock.callCount(), 0)
  assert.deepEqual(onDone.mock.calls[0].arguments[0], { aborted: true })
  assert.equal(cancelled, 1)
  assert.equal(body.locked, false)
})

test('空闲超时不计算本地回调耗时，完成后取消也不改变结论', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    response(frame({ type: 'token', content: '正文' }) + frame({ type: 'done' })),
  )
  const controller = new AbortController()
  const onError = mock.fn()
  const onDone = mock.fn(async () => {
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const result = await send(
    {
      onToken: () => new Promise((resolve) => setTimeout(resolve, 20)),
      onDone,
      onError,
    },
    controller.signal,
    { idleTimeoutMs: 5 },
  )
  assert.deepEqual(result, { status: 'completed' })
  assert.equal(onDone.mock.callCount(), 1)
  assert.equal(onError.mock.callCount(), 0)
})

test('异步正文回调等待期间停止，不接受同一分包中尚未处理的完成帧', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    response(frame({ type: 'token', content: '部分正文' }) + frame({ type: 'done' })),
  )
  const entered = deferred()
  const gate = deferred()
  const controller = new AbortController()
  const onDone = mock.fn()
  const pending = send(
    {
      onToken: async () => {
        entered.resolve()
        await gate.promise
      },
      onDone,
    },
    controller.signal,
  )
  await entered.promise
  controller.abort()
  gate.resolve()
  assert.deepEqual(await pending, { status: 'aborted' })
  assert.deepEqual(onDone.mock.calls[0].arguments[0], { aborted: true })
})
