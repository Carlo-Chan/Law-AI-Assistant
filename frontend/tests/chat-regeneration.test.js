import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { regenerateChatReply, ChatRegenerationError } from '../src/composables/chatRegeneration.js'
import { createRegenerationProgress } from '../src/composables/regenerationProgress.js'
import { regenerateChatStream } from '../src/utils/api.js'

const revision = 'a'.repeat(64)
const nextRevision = 'b'.repeat(64)
function fixture() {
  const user = { id: 1, revision, role: 'user', content: '原问题' }
  const target = {
    id: 2,
    revision,
    role: 'assistant',
    content: '原回复',
    thinkingChain: [{ type: 'tool', label: '旧工具' }],
  }
  const messages = [
    user,
    target,
    { id: 3, revision, role: 'user', content: '后续问题' },
    { id: 4, revision, role: 'assistant', content: '后续回复' },
  ]
  const done = {
    saved: true,
    message_id: 2,
    revision: nextRevision,
    source_message_id: 1,
    source_revision: revision,
    query: '原问题',
    chat_reply: '新回复',
    thinking_chain: [{ type: 'tool', label: '新工具' }],
  }
  return {
    user,
    target,
    messages,
    done,
    convId: 'A',
    getConversation: () => assert.fail('稳定身份不应回查历史'),
  }
}

test('只在完整保存确认后替换目标，流式预览不能改写原正文', async () => {
  const state = fixture()
  const before = structuredClone(state.messages)
  const tokens = []
  const result = await regenerateChatReply({
    ...state,
    onToken: (text) => tokens.push(text),
    stream: async (cid, id, version, _signal, callbacks) => {
      assert.deepEqual([cid, id, version], ['A', 2, revision])
      callbacks.onToken('新回复')
      callbacks.onDone(state.done)
      assert.deepEqual(state.messages, before)
    },
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.user, state.user)
  assert.equal(state.target.content, '新回复')
  assert.deepEqual(state.target.thinkingChain, state.done.thinking_chain)
  assert.deepEqual(state.messages.slice(2), before.slice(2))
  assert.deepEqual(tokens, ['新回复'])
})

test('已保存问题在另一个客户端被编辑时，同步服务端实际使用的问题', async () => {
  const state = fixture()
  await regenerateChatReply({
    ...state,
    stream: async (_cid, _id, _rev, _signal, callbacks) =>
      callbacks.onDone({ ...state.done, query: '最新已保存问题', source_revision: nextRevision }),
  })
  assert.equal(state.user.content, '最新已保存问题')
  assert.equal(state.user.revision, nextRevision)
})

test('旧保存回执缺少身份时只允许完整顺序一致的回查', async () => {
  const state = fixture()
  delete state.target.id
  delete state.target.revision
  await regenerateChatReply({
    ...state,
    getConversation: async () => ({
      id: 'A',
      messages: state.messages.map((message, index) => ({ ...message, id: index + 1, revision })),
    }),
    stream: async (_cid, id, _rev, _signal, callbacks) => {
      assert.equal(id, 2)
      callbacks.onDone(state.done)
    },
  })
  assert.equal(state.target.id, 2)
})

for (const field of [
  'saved',
  'message_id',
  'revision',
  'source_message_id',
  'source_revision',
  'query',
  'chat_reply',
  'thinking_chain',
]) {
  test(`完成帧缺少 ${field} 不覆盖原回复`, async () => {
    const state = fixture()
    const before = structuredClone(state.messages)
    delete state.done[field]
    await assert.rejects(
      regenerateChatReply({
        ...state,
        stream: async (_cid, _id, _rev, _signal, callbacks) => callbacks.onDone(state.done),
      }),
      ChatRegenerationError,
    )
    assert.deepEqual(state.messages, before)
  })
}

for (const failure of [
  'error',
  'eof',
  'wrong-target',
  'wrong-source',
  'changed-source',
  'changed-target',
]) {
  test(`重跑发生 ${failure} 时不覆盖现有内容`, async () => {
    const state = fixture()
    let expected
    await assert.rejects(
      regenerateChatReply({
        ...state,
        stream: async (_cid, _id, _rev, _signal, callbacks) => {
          callbacks.onToken('预览部分')
          if (failure === 'error') callbacks.onError('生成暂不可用。')
          else if (failure !== 'eof') {
            if (failure === 'wrong-target') state.done.message_id = 99
            if (failure === 'wrong-source') state.done.source_message_id = 99
            if (failure === 'changed-source') state.user.content = '本地新的修改'
            if (failure === 'changed-target') state.target.content = '另一次修改的回复'
            callbacks.onDone(state.done)
          }
          expected = structuredClone(state.messages)
        },
      }),
      ChatRegenerationError,
    )
    assert.deepEqual(state.messages, expected)
  })
}

for (const stage of ['before', 'during']) {
  test(`${stage} 停止只返回中止状态，原问答不变`, async () => {
    const state = fixture()
    const controller = new AbortController()
    const before = structuredClone(state.messages)
    if (stage === 'before') controller.abort()
    const result = await regenerateChatReply({
      ...state,
      signal: controller.signal,
      stream: async (_cid, _id, _rev, _signal, callbacks) => {
        controller.abort()
        callbacks.onDone({ aborted: true })
      },
    })
    assert.equal(result.status, 'aborted')
    assert.deepEqual(state.messages, before)
  })
}

test('无法对齐旧身份不猜测其他回复，不开始模型请求', async () => {
  const state = fixture()
  delete state.target.id
  delete state.target.revision
  await assert.rejects(
    regenerateChatReply({
      ...state,
      getConversation: async () => ({ id: 'A', messages: [] }),
      stream: () => assert.fail('不能发送'),
    }),
    ChatRegenerationError,
  )
})

test('首次结束后不再接受正文、工具事件或重复完成', () => {
  const tokens = []
  const steps = []
  const progress = createRegenerationProgress({
    onToken: (text) => tokens.push(text),
    onSteps: (value) => steps.push(value),
  })
  progress.callbacks.onToken('最初正文')
  progress.callbacks.onReasoningToken('分析')
  progress.callbacks.onReasoning('完整分析')
  progress.callbacks.onThinking('search_laws')
  progress.callbacks.onToolChunk('search_laws', '依据', true)
  progress.callbacks.onToolChunk('search_laws', '全文', false)
  progress.callbacks.onToolResult('search_web', '补充')
  progress.callbacks.onDone({ saved: true })
  const before = structuredClone(progress.steps)
  progress.callbacks.onToken('迟到正文')
  progress.callbacks.onThinking('迟到工具')
  progress.callbacks.onDone({ saved: false })
  assert.deepEqual(tokens, ['最初正文'])
  assert.deepEqual(progress.steps, before)
  assert.equal(progress.terminal.saved, true)
  assert.equal(steps.length, 6)
})

test('真实咨询重跑封装只提交身份版本，等待 SSE 完成', async (context) => {
  const done = fixture().done
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/conversations/A%2FB/messages/2/regenerate_chat/stream')
    assert.deepEqual(JSON.parse(options.body), { expected_revision: revision })
    return new Response('data: ' + JSON.stringify({ type: 'done', ...done }) + '\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
  const onDone = mock.fn()
  await regenerateChatStream('A/B', 2, revision, new AbortController().signal, { onDone })
  assert.equal(onDone.mock.callCount(), 1)
  assert.deepEqual(onDone.mock.calls[0].arguments[0], { type: 'done', ...done })
})
