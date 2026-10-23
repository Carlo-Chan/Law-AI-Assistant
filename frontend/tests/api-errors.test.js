import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { analyzeContractStream, chatStream } from '../src/utils/api.js'

const privateMessage = 'sk-private-key 敏感合同正文 E:/private/config.py'

for (const mode of ['chat', 'contract']) {
  async function send(callbacks) {
    if (mode === 'chat') return chatStream('咨询问题', [], undefined, callbacks)
    return analyzeContractStream(new File(['合同正文'], '合同.txt'), undefined, callbacks)
  }

  test(`${mode} 网络异常使用中文提示而不是原始异常`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError(privateMessage)
    })
    const onError = mock.fn()
    const onDone = mock.fn()
    await send({ onError, onDone })
    assert.equal(onError.mock.callCount(), 1)
    assert.equal(onError.mock.calls[0].arguments[0], '网络连接中断，请检查网络后重试。')
    assert.equal(onDone.mock.callCount(), 0)
  })

  test(`${mode} 保留后端安全 HTTP 提示且不伪造完成`, async (context) => {
    const message = '服务配置或访问权限异常，请联系管理员检查配置。'
    context.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ detail: message }), { status: 503 }),
    )
    const onError = mock.fn()
    const onDone = mock.fn()
    await send({ onError, onDone })
    assert.equal(onError.mock.callCount(), 1)
    assert.equal(onError.mock.calls[0].arguments[0], message)
    assert.equal(onDone.mock.callCount(), 0)
  })

  test(`${mode} 流中错误仍通过原 onError 回调处理`, async (context) => {
    const message = '服务响应超时，请稍后重试。'
    context.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          [
            'data: {"type":"token","content":"已有内容"}\n\n',
            `data: ${JSON.stringify({ type: 'error', message, code: 'service_timeout' })}\n\n`,
          ].join(''),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    )
    const onToken = mock.fn()
    const onError = mock.fn()
    const onDone = mock.fn()
    await send({ onToken, onError, onDone })
    assert.equal(onToken.mock.calls[0].arguments[0], '已有内容')
    assert.equal(onError.mock.callCount(), 1)
    assert.equal(onError.mock.calls[0].arguments[0], message)
    assert.equal(onDone.mock.callCount(), 0)
  })

  test(`${mode} 用户停止生成不被当作连接错误`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => {
      throw new DOMException('用户停止', 'AbortError')
    })
    const onError = mock.fn()
    const onDone = mock.fn()
    await send({ onError, onDone })
    assert.equal(onError.mock.callCount(), 0)
    assert.deepEqual(onDone.mock.calls[0].arguments[0], { aborted: true })
  })

  test(`${mode} 网关非 JSON 错误不会暴露响应片段`, async (context) => {
    context.mock.method(
      globalThis,
      'fetch',
      async () => new Response(privateMessage, { status: 502 }),
    )
    const warning = context.mock.method(console, 'warn', () => {})
    const onError = mock.fn()
    await send({ onError })
    assert.equal(onError.mock.calls[0].arguments[0], '请求失败（HTTP 502）')
    assert.equal(onError.mock.callCount(), 1)
    assert.equal(warning.mock.callCount(), 1)
    assert.ok(!JSON.stringify(warning.mock.calls).includes(privateMessage))
  })
}
