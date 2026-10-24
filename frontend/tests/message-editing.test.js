import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergeMessageEdits,
  saveUserMessageEdit,
  MessageEditError,
} from '../src/composables/messageEditing.js'

const identity = { id: 1, revision: 'a'.repeat(64) }
const newer = 'b'.repeat(64)
const conflictError = () =>
  Object.assign(new Error('私有异常正文'), {
    response: { status: 409, data: { code: 'message_changed' } },
  })
const ack = (content, revision = newer) => ({ message_id: 1, revision, content, saved: true })
const saved = (content, extras = {}) => ({
  id: 'A',
  messages: [{ id: 1, role: 'user', revision: newer, content, ...extras }],
})

for (const [name, base, local, remote, expected] of [
  ['服务器未修改', '原文', '修改原文', '原文', '修改原文'],
  ['用户未修改', '原文', '原文', '服务端原文', '服务端原文'],
  ['两方内容相同', '原文', '同一改动', '同一改动', '同一改动'],
  ['分离替换', '甲乙丙丁戊', '甲乙丙丁己', '壹乙丙丁戊', '壹乙丙丁己'],
  ['相邻非空替换', '甲乙丙', '壹乙丙', '甲贰丙', '壹贰丙'],
  ['分离插入', '甲乙丙丁', '甲新乙丙丁', '甲乙丙新丁', '甲新乙丙新丁'],
  ['分离删除', '甲乙丙丁戊', '甲丙丁戊', '甲乙丙丁', '甲丙丁'],
  ['中文与 emoji', '😀甲乙丙丁', '😀甲乙丙新', '🙂甲乙丙丁', '🙂甲乙丙新'],
  ['同处替换', '租金1000元', '租金1200元', '租金1500元', null],
  ['同处插入', '甲乙', '甲新乙', '甲另乙', null],
  ['边界插入', '甲乙丙', '甲新乙丙', '甲贰丙', null],
  ['整段删除与修改', '甲乙丙', '', '甲贰丙', null],
  ['多处改动的保守范围', '甲乙丙丁戊', '壹乙丙丁伍', '甲乙叁丁戊', null],
]) {
  test(`三方合并：${name}`, () => assert.equal(mergeMessageEdits(base, local, remote), expected))
}

test('长文本合并为线性范围处理，不向函数参数展开大数组', () => {
  const large = '甲'.repeat(200000)
  assert.equal(mergeMessageEdits('甲乙丙丁', large + '乙丙丁', '甲乙丙新'), large + '乙丙新')
})

test('正常保存只提交稳定身份和正文，不回查整段历史', async () => {
  const result = await saveUserMessageEdit({
    convId: 'A',
    identity,
    baseContent: '原文',
    content: '修改',
    patch: async (...args) => {
      assert.deepEqual(args, ['A', 1, identity.revision, '修改'])
      return ack('修改')
    },
    getConversation: () => assert.fail('正常保存不需要读取历史'),
  })
  assert.equal(result.status, 'saved')
})

for (const remote of ['原文', '原文。']) {
  test(`409 后安全合并并最多重试一次：${remote}`, async () => {
    const calls = []
    const result = await saveUserMessageEdit({
      convId: 'A',
      identity,
      baseContent: '原文',
      content: '正文',
      patch: async (...args) => {
        calls.push(args)
        if (calls.length === 1) throw conflictError()
        return ack(args[3])
      },
      getConversation: async () => saved(remote),
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[1][2], newer)
    assert.equal(result.content, remote === '原文' ? '正文' : '正文。')
  })
}

test('重叠修改返回最新内容供确认，不自动发起覆盖', async () => {
  let calls = 0
  const result = await saveUserMessageEdit({
    convId: 'A',
    identity,
    baseContent: '租金1000元',
    content: '租金1200元',
    patch: async () => {
      calls++
      throw conflictError()
    },
    getConversation: async () => saved('租金1500元'),
  })
  assert.equal(calls, 1)
  assert.equal(result.status, 'conflict')
  assert.equal(result.latest.content, '租金1500元')
})

test('连续冲突有次数上限，不无限读取和写入', async () => {
  let calls = 0
  const result = await saveUserMessageEdit({
    convId: 'A',
    identity,
    baseContent: '甲乙丙丁',
    content: '壹乙丙丁',
    patch: async () => {
      calls++
      throw conflictError()
    },
    getConversation: async () => saved('甲乙丙新'),
  })
  assert.equal(calls, 2)
  assert.equal(result.status, 'conflict')
})

for (const failure of ['lost-response', 'invalid-ack']) {
  test(`提交后 ${failure} 但回查内容已一致，不重复保存`, async () => {
    let calls = 0
    const result = await saveUserMessageEdit({
      convId: 'A',
      identity,
      baseContent: '原文',
      content: '修改',
      patch: async () => {
        calls++
        if (failure === 'lost-response') throw new Error('Connection error')
        return { saved: true }
      },
      getConversation: async () => saved('修改'),
    })
    assert.equal(result.status, 'saved')
    assert.equal(calls, 1)
  })
}

for (const kind of [
  'deleted',
  'foreign',
  'duplicate-id',
  'assistant',
  'bad-revision',
  'failed-read',
  'unconfirmed',
]) {
  test(`核实结果为 ${kind} 时不猜测覆盖，不泄漏原始异常`, async () => {
    let calls = 0
    await assert.rejects(
      saveUserMessageEdit({
        convId: 'A',
        identity,
        baseContent: '原文',
        content: '修改',
        patch: async () => {
          calls++
          if (kind === 'unconfirmed') throw new Error('私有异常')
          throw conflictError()
        },
        getConversation: async () => {
          if (kind === 'failed-read') throw new Error('私有异常')
          if (kind === 'deleted') return { id: 'A', messages: [] }
          const data = saved(
            '原文',
            kind === 'assistant'
              ? { role: 'assistant' }
              : kind === 'bad-revision'
                ? { revision: 'bad' }
                : {},
          )
          if (kind === 'foreign') data.id = 'B'
          if (kind === 'duplicate-id') data.messages.push({ ...data.messages[0] })
          return data
        },
      }),
      (error) => error instanceof MessageEditError && !error.message.includes('私有异常'),
    )
    assert.equal(calls, 1)
  })
}

test('核实期间取消或所属会话删除，不重试覆盖', async () => {
  let cancelled = false
  let calls = 0
  const result = await saveUserMessageEdit({
    convId: 'A',
    identity,
    baseContent: '原文',
    content: '修改',
    patch: async () => {
      calls++
      throw conflictError()
    },
    getConversation: async () => {
      cancelled = true
      return saved('原文')
    },
    isCancelled: () => cancelled,
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(calls, 1)
})
