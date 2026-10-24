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

test('保存身份未确认时只允许整段顺序完全一致后对齐身份', async () => {
  const messages = [
    { role: 'user', content: '重复' },
    { role: 'assistant', content: '重复' },
  ]
  const result = await resolveSavedMessage('A', messages[1], messages, async (id) => {
    assert.equal(id, 'A')
    return {
      id,
      messages: messages.map((message, index) => ({ ...message, id: index + 1, revision })),
    }
  })
  assert.deepEqual(result, { id: 2, revision })
})

for (const change of ['order', 'missing', 'source', 'instruction', 'during-lookup']) {
  test(`未确认身份定位遇到 ${change} 拒绝删除`, async () => {
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
        return { id: 'A', messages: saved }
      }),
      /无法确认消息/,
    )
  })
}

test('合同回复的附件镜像不参与持久化身份匹配，用户附件信息仍须一致', async () => {
  const messages = [
    { role: 'user', content: '审查合同', file: { name: '合同.pdf' } },
    {
      role: 'assistant',
      content: '合同报告',
      file: { name: '合同.pdf' },
      contractData: { raw_text: '合同原文', instruction: '审查重点' },
    },
  ]
  const saved = {
    id: 'A',
    messages: messages.map((message, index) => ({
      id: index + 1,
      revision,
      role: message.role,
      content: message.content,
      file_name: index === 0 ? '合同.pdf' : null,
      contract_data: message.contractData ? JSON.stringify(message.contractData) : null,
    })),
  }
  const before = structuredClone(messages)
  assert.deepEqual(await resolveSavedMessage('A', messages[1], messages, async () => saved), {
    id: 2,
    revision,
  })
  assert.deepEqual(messages, before)
  saved.messages[0].file_name = '另一合同.pdf'
  await assert.rejects(
    resolveSavedMessage('A', messages[1], messages, async () => saved),
    /无法确认消息/,
  )
})

for (const change of [
  'conversation',
  'missing-conversation',
  'known-id',
  'known-revision',
  'duplicate-id',
  'invalid-other-identity',
  'during-identity-change',
]) {
  test(`身份回查遇到${change}不按相同正文猜测目标`, async () => {
    const messages = [
      { id: 1, revision, role: 'user', content: '重复问题' },
      { id: 2, revision, role: 'assistant', content: '重复回复' },
      { role: 'user', content: '重复问题' },
      { role: 'assistant', content: '重复回复' },
    ]
    const saved = {
      id: 'A',
      messages: messages.map((message, index) => ({ ...message, id: index + 1, revision })),
    }
    if (change === 'conversation') saved.id = 'B'
    if (change === 'missing-conversation') delete saved.id
    if (change === 'known-id') {
      // 删除旧问答再追加相同正文时，数量和角色顺序都可能不变，但身份已不同。
      for (const message of saved.messages) message.id += 2
    }
    if (change === 'known-revision') saved.messages[0].revision = 'b'.repeat(64)
    if (change === 'duplicate-id') saved.messages[0].id = saved.messages[3].id
    if (change === 'invalid-other-identity') saved.messages[2].revision = 'invalid'
    const before = structuredClone(messages[3])
    await assert.rejects(
      resolveSavedMessage('A', messages[3], messages, async () => {
        if (change === 'during-identity-change') messages[0].id = 9
        return saved
      }),
      /无法确认消息/,
    )
    assert.deepEqual(messages[3], before)
  })
}
