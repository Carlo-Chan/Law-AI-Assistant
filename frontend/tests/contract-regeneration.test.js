import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import {
  ContractRegenerationError,
  regenerateContractReport,
} from '../src/composables/contractRegeneration.js'
import { regenerateContractStream } from '../src/utils/api.js'

const source = '第一条：甲方按期退还押金。'
const revision = 'a'.repeat(64)
const nextRevision = 'b'.repeat(64)

function fixture() {
  const target = {
    id: 12,
    revision,
    role: 'assistant',
    content: '旧审查报告',
    contractData: { raw_text: source, chat_reply: '旧审查报告', risk_points: [] },
    thinkingChain: [{ type: 'tool', label: '旧过程' }],
  }
  const messages = [
    { role: 'user', content: '审查附件', file: { name: '历史合同.pdf' } },
    target,
    { role: 'user', content: '后续问题' },
    { role: 'assistant', content: '后续回答' },
  ]
  const done = {
    type: 'done',
    saved: true,
    message_id: 12,
    revision: nextRevision,
    raw_text: source,
    chat_reply: '新审查报告',
    risk_points: [],
    thinking_chain: [{ type: 'tool', label: '新过程' }],
  }
  return { target, messages, done }
}

function options(state, stream) {
  return { convId: 'conversation-A', ...state, stream, getConversation: mock.fn() }
}

test('历史元数据附件无需上传，保存确认后仅替换目标报告', async () => {
  const state = fixture()
  const original = structuredClone(state)
  const args = options(state, async (convId, id, version, signal, callbacks) => {
    assert.equal(convId, 'conversation-A')
    assert.equal(id, 12)
    assert.equal(version, revision)
    callbacks.onThinking('search_laws')
    callbacks.onDone(state.done)
    assert.deepEqual(state.target, original.target)
  })
  assert.deepEqual(await regenerateContractReport(args), { status: 'completed' })
  assert.equal(args.getConversation.mock.callCount(), 0)
  assert.equal(state.messages.length, 4)
  assert.equal(state.messages[1], state.target)
  for (const index of [0, 2, 3]) assert.deepEqual(state.messages[index], original.messages[index])
  assert.equal(state.target.content, '新审查报告')
  assert.equal(state.target.fullContent, '新审查报告')
  assert.equal(state.target.revision, nextRevision)
  assert.deepEqual(state.target.thinkingChain, state.done.thinking_chain)
})

test('当前内存报告无 ID 时依据完整保存顺序取得目标身份', async () => {
  const state = fixture()
  delete state.target.id
  delete state.target.revision
  const getConversation = mock.fn(async () => ({
    id: 'conversation-A',
    messages: state.messages.map((message, index) => ({
      role: message.role,
      content: message.content,
      id: index === 1 ? 12 : index + 20,
      revision,
      file_name: message.file?.name || null,
      contract_data: message.contractData ? JSON.stringify(message.contractData) : null,
    })),
  }))
  const stream = mock.fn(async (convId, id, version, signal, callbacks) => {
    assert.equal(id, 12)
    callbacks.onDone(state.done)
  })
  await regenerateContractReport({ ...options(state, stream), getConversation })
  assert.equal(getConversation.mock.callCount(), 1)
  assert.equal(state.target.id, 12)
})

test('保存历史与本地顺序不一致时不猜测相同报告的归属', async () => {
  const state = fixture()
  delete state.target.id
  const original = structuredClone(state.target)
  const stream = mock.fn()
  await assert.rejects(
    regenerateContractReport({
      ...options(state, stream),
      getConversation: async () => ({
        id: 'conversation-A',
        messages: [
          {
            role: 'assistant',
            content: state.target.content,
            id: 12,
            revision,
            contract_data: state.target.contractData,
          },
        ],
      }),
    }),
    /无法确认目标合同/,
  )
  assert.equal(stream.mock.callCount(), 0)
  assert.deepEqual(state.target, original)
})

test('过程步骤独立更新，不把临时过程写入原报告', async () => {
  const state = fixture()
  const original = structuredClone(state.target)
  const updates = []
  await regenerateContractReport({
    ...options(state, async (_convId, _id, _version, _signal, callbacks) => {
      callbacks.onThinking('search_laws')
      callbacks.onReasoningToken('核对')
      callbacks.onReasoningToken('条款')
      callbacks.onReasoning('完整过程')
      callbacks.onToolChunk('search_laws', '法律', true)
      callbacks.onToolChunk('search_laws', '依据', false)
      callbacks.onToolResult('verify_legal', '校验结果')
      assert.deepEqual(state.target, original)
      callbacks.onDone(state.done)
    }),
    onSteps: (steps) => updates.push(structuredClone(steps)),
  })
  assert.deepEqual(updates.at(-1), [
    { type: 'tool', label: 'search_laws' },
    { type: 'reasoning', label: '完整过程' },
    { type: 'done', label: 'search_laws 完成', snippet: '法律依据' },
    { type: 'done', label: 'verify_legal 完成', snippet: '校验结果' },
  ])
})

for (const [name, change] of [
  ['未保存', { saved: false }],
  ['非布尔确认', { saved: 'true' }],
  ['消息 ID 不符', { message_id: 99 }],
  ['版本无效', { revision: '' }],
  ['原文不符', { raw_text: '其他合同' }],
  ['报告为空', { chat_reply: ' ' }],
  ['风险结构错误', { risk_points: null }],
  ['过程结构错误', { thinking_chain: null }],
]) {
  test(`${name}的完成帧不能替换原报告`, async () => {
    const state = fixture()
    const original = structuredClone(state.target)
    await assert.rejects(
      regenerateContractReport(
        options(state, async (_convId, _id, _version, _signal, callbacks) => {
          callbacks.onDone({ ...state.done, ...change })
        }),
      ),
      /未收到完整保存确认/,
    )
    assert.deepEqual(state.target, original)
  })
}

test('中途失败保留报告且不会把后续完成帧当作成功', async () => {
  const state = fixture()
  const original = structuredClone(state.target)
  await assert.rejects(
    regenerateContractReport(
      options(state, async (_convId, _id, _version, _signal, callbacks) => {
        callbacks.onError('服务响应超时')
        callbacks.onDone(state.done)
      }),
    ),
    /服务响应超时/,
  )
  assert.deepEqual(state.target, original)
})

test('EOF 没有保存确认时保留原报告并提示刷新确认', async () => {
  const state = fixture()
  const original = structuredClone(state.target)
  await assert.rejects(regenerateContractReport(options(state, async () => {})), /请刷新会话确认/)
  assert.deepEqual(state.target, original)
})

test('主动停止不会用部分内容或失败气泡覆盖报告', async () => {
  const state = fixture()
  const original = structuredClone(state.target)
  const result = await regenerateContractReport(
    options(state, async (_convId, _id, _version, _signal, callbacks) => {
      callbacks.onDone({ aborted: true })
    }),
  )
  assert.equal(result.status, 'aborted')
  assert.deepEqual(state.target, original)
})

test('停止发生在保存确认之后时，以已确认保存的结果为准', async () => {
  const state = fixture()
  const controller = new AbortController()
  await regenerateContractReport({
    ...options(state, async (_convId, _id, _version, _signal, callbacks) => {
      callbacks.onDone(state.done)
      controller.abort()
      callbacks.onDone({ aborted: true })
    }),
    signal: controller.signal,
  })
  assert.equal(state.target.content, '新审查报告')
})

test('报告生成期间的本地编辑不会被异步完成覆盖', async () => {
  const state = fixture()
  await assert.rejects(
    regenerateContractReport(
      options(state, async (_convId, _id, _version, _signal, callbacks) => {
        state.target.content = '用户刚修改的内容'
        callbacks.onDone(state.done)
      }),
    ),
    /未覆盖页面内容/,
  )
  assert.equal(state.target.content, '用户刚修改的内容')
})

test('缺少原文时直接提示补传，不读取其他合同', async () => {
  const state = fixture()
  delete state.target.contractData
  const stream = mock.fn()
  await assert.rejects(regenerateContractReport(options(state, stream)), /未保存合同原文/)
  assert.equal(stream.mock.callCount(), 0)
})

test('查询持久化身份失败时不向用户暴露原始异常', async () => {
  const state = fixture()
  delete state.target.id
  await assert.rejects(
    regenerateContractReport({
      ...options(state, mock.fn()),
      getConversation: async () => {
        throw new Error('sk-private-secret')
      },
    }),
    (error) => error instanceof ContractRegenerationError && !error.message.includes('sk-private'),
  )
})

test('已经停止的请求不再启动模型调用', async () => {
  const state = fixture()
  const controller = new AbortController()
  controller.abort()
  const stream = mock.fn()
  const result = await regenerateContractReport({
    ...options(state, stream),
    signal: controller.signal,
  })
  assert.equal(result.status, 'aborted')
  assert.equal(stream.mock.callCount(), 0)
})

test('重跑请求只传目标版本，不包含附件、正文或旧报告', async (context) => {
  const state = fixture()
  context.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, '/api/conversations/conversation-A/messages/12/regenerate_contract/stream')
    assert.equal(request.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(request.body), { expected_revision: revision })
    return new Response(`data: ${JSON.stringify(state.done)}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
  await regenerateContractReport(options(state, regenerateContractStream))
  assert.equal(state.target.content, '新审查报告')
})

test('两个会话反序完成时只更新各自的目标对象', async () => {
  const first = fixture()
  const second = fixture()
  second.target.id = 24
  second.done.message_id = 24
  second.done.chat_reply = '另一会话的新报告'
  const pending = new Map()
  const stream = (convId, _id, _version, _signal, callbacks) =>
    new Promise((resolve) => {
      pending.set(convId, () => {
        callbacks.onDone(convId === 'conversation-A' ? first.done : second.done)
        resolve()
      })
    })
  const firstRequest = regenerateContractReport(options(first, stream))
  const secondRequest = regenerateContractReport({
    ...options(second, stream),
    convId: 'conversation-B',
  })
  pending.get('conversation-B')()
  await secondRequest
  assert.equal(second.target.content, '另一会话的新报告')
  assert.equal(first.target.content, '旧审查报告')
  pending.get('conversation-A')()
  await firstRequest
  assert.equal(first.target.content, '新审查报告')
  assert.equal(second.target.content, '另一会话的新报告')
})

test('查询目标期间主动停止会取消后续模型请求', async () => {
  const state = fixture()
  delete state.target.id
  const controller = new AbortController()
  const stream = mock.fn()
  const result = await regenerateContractReport({
    ...options(state, stream),
    signal: controller.signal,
    getConversation: async (_convId, signal) => {
      controller.abort()
      assert.ok(signal.aborted)
      throw new Error('取消')
    },
  })
  assert.equal(result.status, 'aborted')
  assert.equal(stream.mock.callCount(), 0)
  assert.equal(state.target.content, '旧审查报告')
})

test('原文不一致的保存记录不能作为同一份合同重跑', async () => {
  const state = fixture()
  delete state.target.id
  const stream = mock.fn()
  await assert.rejects(
    regenerateContractReport({
      ...options(state, stream),
      getConversation: async () => ({
        id: 'conversation-A',
        messages: state.messages.map((message, index) => ({
          ...message,
          id: index + 10,
          revision,
          contractData: index === 1 ? { raw_text: '另一份合同' } : message.contractData,
        })),
      }),
    }),
    /无法确认目标合同/,
  )
  assert.equal(stream.mock.callCount(), 0)
})

test('重复完成帧和完成后的错误不能重复替换已确认结果', async () => {
  const state = fixture()
  await regenerateContractReport(
    options(state, async (_convId, _id, _version, _signal, callbacks) => {
      callbacks.onDone(state.done)
      callbacks.onDone({ ...state.done, chat_reply: '不能二次替换' })
      callbacks.onError('结束后的连接错误')
    }),
  )
  assert.equal(state.target.content, '新审查报告')
})

test('原指令随保存确认保留，下一次重跑仍使用同一指令', async () => {
  const state = fixture()
  state.target.contractData.instruction = '重点审查乙方责任\n检查押金'
  state.done.instruction = state.target.contractData.instruction
  await regenerateContractReport(
    options(state, async (_cid, _id, _revision, _signal, callbacks) =>
      callbacks.onDone(state.done),
    ),
  )
  assert.equal(state.target.contractData.instruction, state.done.instruction)
  const instruction = state.done.instruction
  state.done = { ...state.done, chat_reply: '再次审查后的报告' }
  await regenerateContractReport(
    options(state, async (_cid, _id, _revision, _signal, callbacks) =>
      callbacks.onDone(state.done),
    ),
  )
  assert.equal(state.target.content, '再次审查后的报告')
  assert.equal(state.target.contractData.instruction, instruction)
})

for (const changed of [undefined, '另一套审查重点']) {
  test(`不接受${changed ? '变更' : '丢失'}原指令的保存确认`, async () => {
    const state = fixture()
    state.target.contractData.instruction = '重点审查乙方责任'
    const before = structuredClone(state.target)
    state.done.instruction = changed
    await assert.rejects(
      regenerateContractReport(
        options(state, async (_cid, _id, _revision, _signal, callbacks) =>
          callbacks.onDone(state.done),
        ),
      ),
      /完整保存确认/,
    )
    assert.deepEqual(state.target, before)
  })
}

test('本地指令变更不会被已发出的重跑覆盖', async () => {
  const state = fixture()
  state.target.contractData.instruction = '原审查重点'
  state.done.instruction = '原审查重点'
  await assert.rejects(
    regenerateContractReport(
      options(state, async (_cid, _id, _revision, _signal, callbacks) => {
        state.target.contractData.instruction = '用户新改的重点'
        callbacks.onDone(state.done)
      }),
    ),
    /未覆盖页面内容/,
  )
  assert.equal(state.target.contractData.instruction, '用户新改的重点')
  assert.equal(state.target.content, '旧审查报告')
})

test('相同原文但不同指令的无 ID 记录不猜测对应关系', async () => {
  const state = fixture()
  delete state.target.id
  state.target.contractData.instruction = '原审查重点'
  const stream = mock.fn()
  await assert.rejects(
    regenerateContractReport({
      ...options(state, stream),
      getConversation: async () => ({
        id: 'conversation-A',
        messages: state.messages.map((message, index) => ({
          ...message,
          id: index + 10,
          revision,
          contractData:
            index === 1
              ? { ...message.contractData, instruction: '别的重点' }
              : message.contractData,
        })),
      }),
    }),
    /无法确认目标合同/,
  )
  assert.equal(stream.mock.callCount(), 0)
})

for (const change of [
  'wrong-conversation',
  'known-id',
  'filename',
  'other-contract-source',
  'local-target-removed',
  'local-identity-changed',
]) {
  test(`合同身份回查遇到${change}不启动审查或改写原报告`, async () => {
    const state = fixture()
    delete state.target.id
    state.messages[0].id = 11
    state.messages[0].revision = revision
    state.messages[3].contractData = { raw_text: '另一份已保存原文' }
    const saved = {
      id: 'conversation-A',
      messages: state.messages.map((message, index) => ({
        ...structuredClone(message),
        id: index + 11,
        revision,
      })),
    }
    if (change === 'wrong-conversation') saved.id = 'conversation-B'
    if (change === 'known-id') saved.messages[0].id = 50
    if (change === 'filename') saved.messages[0].file.name = '另一合同.pdf'
    if (change === 'other-contract-source') saved.messages[3].contractData.raw_text = '被替换的原文'
    const before = structuredClone(state.target)
    const stream = mock.fn(async (_cid, _id, _revision, _signal, callbacks) => {
      callbacks.onDone(state.done)
    })
    await assert.rejects(
      regenerateContractReport({
        ...options(state, stream),
        getConversation: async () => {
          if (change === 'local-target-removed') state.messages.splice(1, 1)
          if (change === 'local-identity-changed') state.messages[0].id = 60
          return saved
        },
      }),
      (error) => error instanceof ContractRegenerationError,
    )
    assert.equal(stream.mock.callCount(), 0)
    assert.deepEqual(state.target, before)
  })
}

test('合同重跑生成期间移除目标不恢复已脱离消息列表的报告', async () => {
  const state = fixture()
  const before = structuredClone(state.target)
  await assert.rejects(
    regenerateContractReport(
      options(state, async (_cid, _id, _revision, _signal, callbacks) => {
        state.messages.splice(1, 1)
        callbacks.onDone(state.done)
      }),
    ),
    /未覆盖页面内容/,
  )
  assert.deepEqual(state.target, before)
})
