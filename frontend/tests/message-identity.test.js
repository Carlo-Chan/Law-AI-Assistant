import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assignSavedMessageIdentities,
  hasMessageIdentity,
  resolveSavedMessage,
} from '../src/composables/messageIdentity.js'

const revision = 'a'.repeat(64)
const receipt = () => ({
  messages: [
    { id: 1, role: 'user', revision },
    { id: 2, role: 'assistant', revision },
  ],
})

test('保存回执仅绑定所属请求对象，不能修改另一个页面', () => {
  const request = { userMessage: {}, assistant: {} }
  const other = { userMessage: {}, assistant: {} }
  assert.equal(assignSavedMessageIdentities(request, receipt()), true)
  assert.equal(request.userMessage.id, 1)
  assert.equal(request.assistant.id, 2)
  assert.deepEqual(other, { userMessage: {}, assistant: {} })
})

for (const kind of ['missing', 'null', 'duplicate', 'order', 'revision', 'extra']) {
  test(`保存身份回执为 ${kind} 时不部分写入身份`, () => {
    const result = receipt()
    if (kind === 'missing') delete result.messages
    if (kind === 'null') result.messages[0] = null
    if (kind === 'duplicate') result.messages[1].id = 1
    if (kind === 'order') result.messages.reverse()
    if (kind === 'revision') result.messages[0].revision = 'bad'
    if (kind === 'extra') result.messages.push({ id: 3, role: 'assistant', revision })
    const request = { userMessage: {}, assistant: {} }
    assert.equal(assignSavedMessageIdentities(request, result), false)
    assert.deepEqual(request, { userMessage: {}, assistant: {} })
  })
}

test('已有稳定身份不按正文重新查找，重复正文也不会猜测其他消息', async () => {
  const target = { id: 2, revision }
  assert.equal(hasMessageIdentity(target), true)
  assert.deepEqual(await resolveSavedMessage('A', target, [], () => assert.fail()), target)
})

test('旧回执只允许整段顺序完全一致时对齐身份', async () => {
  const messages = [
    { role: 'user', content: '重复' },
    { role: 'assistant', content: '重复' },
  ]
  const result = await resolveSavedMessage('A', messages[1], messages, async (id) => {
    assert.equal(id, 'A')
    return { messages: messages.map((message, index) => ({ ...message, id: index + 1, revision })) }
  })
  assert.deepEqual(result, { id: 2, revision })
})

for (const change of ['order', 'missing', 'source', 'instruction', 'during-lookup']) {
  test(`旧消息定位遇到 ${change} 拒绝删除`, async () => {
    const messages = [
      { role: 'user', content: '提问' },
      {
        role: 'assistant',
        content: '回复',
        contractData: { raw_text: '原文', instruction: '指令' },
      },
    ]
    const target = messages[1]
    const saved = structuredClone(messages).map((message, index) => ({
      ...message,
      id: index + 1,
      revision,
    }))
    if (change === 'order') saved.reverse()
    if (change === 'missing') saved.pop()
    if (change === 'source') saved[1].contractData.raw_text = '其他原文'
    if (change === 'instruction') saved[1].contractData.instruction = '其他指令'
    await assert.rejects(
      resolveSavedMessage('A', target, messages, async () => {
        if (change === 'during-lookup') target.content = '刚修改的回复'
        return { messages: saved }
      }),
      /无法确认消息/,
    )
  })
}
