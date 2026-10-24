import assert from 'node:assert/strict'
import { test } from 'node:test'
import axios from 'axios'

// 使用离线适配器验证真实 Axios 配置，不发起任何 HTTP 请求。
const calls = []
const previousAdapter = axios.defaults.adapter
axios.defaults.adapter = async (config) => {
  calls.push(config)
  return {
    data: { code: 200, data: { id: 'test' } },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }
}
let api
try {
  api = await import('../src/utils/api.js?preparation-test')
} finally {
  axios.defaults.adapter = previousAdapter
}

test('创建、自动命名和列表刷新均传递同一个取消信号', async () => {
  calls.length = 0
  const signal = new AbortController().signal
  await api.createConversation(signal)
  await api.updateConvTitle('test', '测试标题', signal)
  await api.listConversations(signal)
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/conversations', '/conversations/test/title', '/conversations'],
  )
  assert.ok(calls.every((call) => call.signal === signal))
  assert.equal(calls[0].data, undefined)
  assert.deepEqual(JSON.parse(calls[1].data), { title: '测试标题' })
})

test('已经停止的准备请求不会进入 HTTP 适配器', async () => {
  calls.length = 0
  const controller = new AbortController()
  controller.abort()
  for (const request of [
    () => api.createConversation(controller.signal),
    () => api.updateConvTitle('test', '标题', controller.signal),
    () => api.listConversations(controller.signal),
  ])
    await assert.rejects(request, (error) => axios.isCancel(error))
  assert.equal(calls.length, 0)
})

test('单条删除只提交会话、消息身份和版本，不上传整段历史', async () => {
  calls.length = 0
  const revision = 'a'.repeat(64)
  await api.deleteSavedMessage('A/测试', 123, revision, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'delete')
  assert.equal(calls[0].url, '/conversations/A%2F%E6%B5%8B%E8%AF%95/messages/123')
  assert.deepEqual(JSON.parse(calls[0].data), {
    expected_revision: revision,
    preserve_empty_conversation: true,
  })
})

test('普通保存向调用方返回身份回执', async () => {
  assert.deepEqual(await api.saveMessages('A', '提问', '回复'), { id: 'test' })
})

for (const instruction of ['', ' \n\t ', '  重点审查乙方责任\n检查押金  ']) {
  test(`普通审查表单支持${instruction.trim() ? '多行指令' : '空白或省略指令'}`, async () => {
    calls.length = 0
    const file = new File(['合同'], '合同.txt')
    await api.analyzeContract(file, instruction)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].data.get('file'), file)
    assert.equal(calls[0].data.get('instruction'), instruction.trim() || null)
  })
}

test('普通审查超限时不进入 HTTP 适配器', async () => {
  calls.length = 0
  await assert.rejects(
    api.analyzeContract(new File(['合同'], '合同.txt'), '字'.repeat(4001)),
    /4000/,
  )
  assert.equal(calls.length, 0)
})
