import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createConversationRenaming,
  saveConversationTitle,
  TitleSaveError,
} from '../src/composables/conversationRenaming.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const ack = (id, title) => ({ conversation_id: id, title, saved: true })
function fixture(overrides = {}) {
  const titles = new Map([
    ['A', { title: 'A原题' }],
    ['B', { title: 'B原题' }],
  ])
  const calls = []
  const notices = []
  const manager = createConversationRenaming({
    find: (id) => titles.get(id),
    patch: async (id, title, expected) => {
      calls.push([id, title, expected])
      return ack(id, title)
    },
    getConversation: async (id) => ({ id, title: titles.get(id).title }),
    apply: (id, title) => {
      titles.get(id).title = title
    },
    warn: (message) => notices.push(message),
    confirm: async () => false,
    unavailable: () => false,
    ...overrides,
  })
  return { manager, titles, calls, notices }
}

test('明确保存回执不额外读取，提交的是原始标题而非后来输入', async () => {
  const state = fixture({ getConversation: () => assert.fail('无需回读') })
  const session = state.manager.start('A')
  session.text = '  新标题  '
  await state.manager.save('A')
  assert.deepEqual(state.calls, [['A', '新标题', 'A原题']])
  assert.equal(state.titles.get('A').title, '新标题')
  assert.equal(state.manager.active.value, null)
})

for (const failure of ['lost', 'invalid']) {
  test(`${failure} 回执只核实目标一次，服务端已保存时不重复写入`, async () => {
    let patches = 0
    let reads = 0
    const result = await saveConversationTitle({
      id: 'A',
      title: '新题',
      expected: '旧题',
      isCancelled: () => false,
      patch: async () => {
        patches++
        if (failure === 'lost') throw new Error('网络断开')
        return { saved: true }
      },
      getConversation: async (id) => {
        reads++
        return { id, title: '新题' }
      },
    })
    assert.deepEqual(result, { status: 'saved', title: '新题' })
    assert.equal(patches, 1)
    assert.equal(reads, 1)
  })
}

for (const latest of [null, { id: 'B', title: '新题' }, { id: 'A' }, { id: 'A', title: '旧题' }]) {
  test(`未确认的回读不伪装成功：${JSON.stringify(latest)}`, async () => {
    await assert.rejects(
      saveConversationTitle({
        id: 'A',
        title: '新题',
        expected: '旧题',
        isCancelled: () => false,
        patch: async () => {
          throw new Error('private failure')
        },
        getConversation: async () => latest,
      }),
      TitleSaveError,
    )
  })
}

test('回读也失败时只抛固定安全提示', async () => {
  await assert.rejects(
    saveConversationTitle({
      id: 'A',
      title: '新题',
      expected: '旧题',
      isCancelled: () => false,
      patch: async () => {
        throw new Error('sk-private')
      },
      getConversation: async () => {
        throw new Error('private path')
      },
    }),
    (error) => error instanceof TitleSaveError && !error.message.includes('private'),
  )
})

test('失败的 A 草稿后台保留，重开时恢复而不清空 B 编辑文字', async () => {
  const state = fixture({
    patch: async () => {
      throw new Error('保存失败')
    },
  })
  const first = state.manager.start('A')
  first.text = 'A待保存'
  const pending = state.manager.save('A')
  const second = state.manager.start('B')
  second.text = 'B草稿'
  await pending
  assert.equal(state.manager.active.value, second)
  assert.equal(second.text, 'B草稿')
  state.manager.start('A')
  assert.equal(state.manager.active.value.text, 'A待保存')
  state.manager.dispose()
})

test('保存期间继续输入新文字，旧成功回执只更新基线不关闭新草稿', async () => {
  const gate = deferred()
  const state = fixture({ patch: () => gate.promise })
  const session = state.manager.start('A')
  session.text = '先保存'
  const pending = state.manager.save('A')
  session.text = '后来继续编辑'
  gate.resolve(ack('A', '先保存'))
  await pending
  assert.equal(state.manager.active.value, session)
  assert.equal(session.text, '后来继续编辑')
  assert.equal(session.base, '先保存')
  assert.equal(state.titles.get('A').title, '先保存')
})

for (const overwrite of [false, true]) {
  test(`真实标题冲突保留草稿，${overwrite ? '明确确认才覆盖' : '取消不再发写入'}`, async () => {
    let writes = 0
    const expected = []
    const state = fixture({
      patch: async (id, title, base) => {
        expected.push(base)
        if (writes++ === 0) throw new Error('409 title_changed')
        return ack(id, title)
      },
      getConversation: async (id) => ({ id, title: '远端最新题' }),
      confirm: async () => overwrite,
    })
    const session = state.manager.start('A')
    session.text = '本地草稿'
    await state.manager.save('A')
    assert.equal(session.conflict, true)
    assert.equal(session.text, '本地草稿')
    assert.equal(state.titles.get('A').title, '远端最新题')
    await state.manager.save('A')
    assert.equal(writes, overwrite ? 2 : 1)
    if (overwrite) assert.deepEqual(expected, ['A原题', '远端最新题'])
    else assert.equal(state.manager.active.value.text, '本地草稿')
  })
}

test('取消再重开同一项，旧输入框的迟到事件不能保存新草稿', async () => {
  const state = fixture()
  const first = state.manager.start('A')
  first.text = '已取消'
  state.manager.cancel(first.key)
  const second = state.manager.start('A')
  second.text = '新草稿'
  await state.manager.save('A', first.key)
  state.manager.cancel(first.key)
  assert.equal(state.calls.length, 0)
  assert.equal(state.manager.active.value, second)
})

for (const stop of ['forget', 'dispose']) {
  test(`${stop} 不撤回已发写入，但迟到失败不再核实或恢复编辑器`, async () => {
    const gate = deferred()
    let reads = 0
    const state = fixture({
      patch: () => gate.promise,
      getConversation: () => {
        reads++
        assert.fail('不应核实')
      },
    })
    state.manager.start('A').text = '保存中的题'
    const pending = state.manager.save('A')
    if (stop === 'forget') state.manager.forget('A')
    else state.manager.dispose()
    gate.reject(new Error('迟到失败'))
    await pending
    assert.equal(reads, 0)
    assert.equal(state.manager.active.value, null)
    assert.equal(state.notices.length, 0)
  })
}

test('Esc 隐藏编辑后仍能核实已发写入，卸载会取消该旧任务的核实读取', async () => {
  const entered = deferred()
  let signal
  const state = fixture({
    patch: async () => {
      throw new Error('回执丢失')
    },
    getConversation: (_id, ownedSignal) =>
      new Promise((_resolve, reject) => {
        signal = ownedSignal
        signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
        entered.resolve()
      }),
  })
  const session = state.manager.start('A')
  session.text = '新题'
  const pending = state.manager.save('A')
  await entered.promise
  state.manager.cancel(session.key)
  state.manager.dispose()
  assert.equal(signal.aborted, true)
  await pending
  assert.equal(state.notices.length, 0)
})
