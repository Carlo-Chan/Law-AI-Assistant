import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { parse, compileScript } from 'vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import {
  chatStream as realChatStream,
  analyzeContractStream as realContractStream,
} from '../src/utils/api.js'

// 只挂载真实页面的脚本逻辑，接口全部替换为离线函数，不连接数据库或模型。
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'Element', 'SVGElement', 'HTMLElement']) {
  globalThis[name] = name === 'window' ? dom.window : dom.window[name]
}
const { createApp, h, nextTick } = await import('vue')
const { renderHighlightedContract } = await import('../src/utils/highlight.js')
const sourceUrl = new URL('../src/views/MainView.vue', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'sending-regression' }).content
const apiNames = [
  'listConversations',
  'createConversation',
  'getConversation',
  'deleteConversation',
  'deleteSavedMessage',
  'saveMessages',
  'updateConvTitle',
  'chatStream',
  'analyzeContractStream',
  'regenerateContractStream',
  'rebuildMessages',
]
const apiModule =
  'data:text/javascript;base64,' +
  Buffer.from(
    apiNames
      .map(
        (name) =>
          `export const ${name} = (...args) => globalThis.__sendingTestApi.${name}(...args);`,
      )
      .join('\n'),
  ).toString('base64')
const messageModule =
  'data:text/javascript;base64,' +
  Buffer.from(
    `export const ElMessage = Object.fromEntries(['warning', 'success', 'error'].map(kind => [kind, options => globalThis.__sendingTestNotices.push({ kind, options })]));`,
  ).toString('base64')
const rewritten = compiled.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier) => {
  const resolved =
    specifier === '../utils/api'
      ? apiModule
      : specifier === 'element-plus'
        ? messageModule
        : specifier.startsWith('.')
          ? new URL(specifier + '.js', sourceUrl).href
          : import.meta.resolve(specifier)
  return `from ${JSON.stringify(resolved)}`
})
const { default: component } = await import(
  'data:text/javascript;base64,' + Buffer.from(rewritten).toString('base64')
)

after(() => {
  dom.window.close()
  for (const name of [
    'window',
    'document',
    'Element',
    'SVGElement',
    'HTMLElement',
    '__sendingTestApi',
    '__sendingTestNotices',
  ]) {
    delete globalThis[name]
  }
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

// 真实页面脚本配合离线合同 DOM，验证事件处理而不依赖浏览器布局。
async function mountHighlights() {
  const view = await mount()
  view.state.showPreview = true
  await nextTick()
  const panel = document.createElement('div')
  panel.className = 'preview-panel'
  const body = document.createElement('div')
  body.className = 'preview-body'
  const root = document.createElement('div')
  root.className = 'contract-text'
  root.innerHTML = renderHighlightedContract('甲乙丙丁戊己庚辛', [
    { quote: '甲乙丙丁戊', level: 'high', bubble_text: '第一项分析' },
    { quote: '丁戊己庚', level: 'medium', bubble_text: '第二项分析' },
  ])
  body.append(root)
  panel.append(body)
  document.body.append(panel)
  const close = view.close
  return {
    ...view,
    panel,
    body,
    root,
    tooltip: document.querySelector('.contract-tooltip'),
    fragments: [...root.querySelectorAll('.risk-medium')],
    close() {
      close()
      panel.remove()
    },
  }
}

test('真实页面点击任一交叉片段钉住完整范围，再点另一个片段完整取消', async () => {
  const view = await mountHighlights()
  try {
    view.state.onContractClick({ target: view.fragments[1] })
    assert.equal(view.root.querySelectorAll('mark.pinned').length, 2)
    assert.equal(view.tooltip.textContent, '第二项分析')
    assert.equal(view.tooltip.style.pointerEvents, 'auto')
    view.state.onContractClick({ target: view.fragments[0] })
    assert.equal(view.root.querySelectorAll('.pinned').length, 0)
    assert.equal(view.tooltip.style.opacity, '0')
    assert.equal(view.tooltip.style.pointerEvents, 'none')
    view.state.onContractClick({ target: view.root.querySelector('.risk-high') })
    assert.equal(view.tooltip.textContent, '第一项分析')
    assert.equal(view.root.querySelectorAll('.pinned').length, 1)
  } finally {
    view.close()
  }
})

test('真实页面跨片段悬停不闪烁，钉住后其他风险不能抢占气泡', async (context) => {
  const view = await mountHighlights()
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const [first, second] = view.fragments
    view.state.onContractHover({ target: first })
    context.mock.timers.tick(201)
    assert.equal(view.tooltip.style.opacity, '1')
    assert.equal(view.tooltip.textContent, '第二项分析')
    view.state.onContractLeave({ target: first, relatedTarget: second })
    context.mock.timers.tick(101)
    assert.equal(view.tooltip.style.opacity, '1')
    view.state.onContractClick({ target: second })
    view.state.onContractHover({ target: view.root.querySelector('.risk-high') })
    context.mock.timers.tick(201)
    assert.equal(view.tooltip.textContent, '第二项分析')
    view.state.onContractLeave({ target: second, relatedTarget: null })
    assert.equal(view.tooltip.style.opacity, '1')
  } finally {
    view.close()
  }
})

test('真实页面取消后清除延迟显示，透明气泡不再拦截鼠标', async (context) => {
  const view = await mountHighlights()
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const target = view.fragments[0]
    view.state.onContractHover({ target })
    view.state.onContractClick({ target })
    view.state.onContractClick({ target })
    context.mock.timers.tick(500)
    assert.equal(view.tooltip.style.opacity, '0')
    assert.equal(view.tooltip.style.pointerEvents, 'none')
  } finally {
    view.close()
  }
})

for (const change of ['close', 'replace', 'unmount']) {
  test(`真实页面在${change}时清理全部钉住片段、延迟气泡及旧滚动监听`, async (context) => {
    const view = await mountHighlights()
    let removed = false
    const originalRemove = view.body.removeEventListener.bind(view.body)
    view.body.removeEventListener = (...args) => {
      if (args[0] === 'scroll') removed = true
      originalRemove(...args)
    }
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let closed = false
    try {
      view.state.onContractClick({ target: view.fragments[1] })
      if (change === 'close') view.state.showPreview = false
      else if (change === 'replace')
        view.state.previewData = { raw_text: '新合同', risk_points: [] }
      else {
        view.close()
        closed = true
      }
      await nextTick()
      context.mock.timers.tick(500)
      assert.equal(view.root.querySelectorAll('.pinned').length, 0)
      assert.equal(view.tooltip.style.opacity, '0')
      assert.equal(view.tooltip.style.pointerEvents, 'none')
      assert.equal(removed, true)
      view.body.dispatchEvent(new dom.window.Event('scroll'))
      assert.equal(view.tooltip.style.opacity, '0')
    } finally {
      if (!closed) view.close()
    }
  })
}

test('真实页面关闭未钉住的预览也不会在延时后重新弹出悬停气泡', async (context) => {
  const view = await mountHighlights()
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    view.state.onContractHover({ target: view.fragments[0] })
    view.state.showPreview = false
    await nextTick()
    context.mock.timers.tick(500)
    assert.equal(view.tooltip.style.opacity, '0')
    assert.equal(view.tooltip.style.pointerEvents, 'none')
  } finally {
    view.close()
  }
})

async function mount(overrides = {}) {
  const writes = []
  const streams = []
  const notices = []
  globalThis.__sendingTestNotices = notices
  globalThis.__sendingTestApi = {
    listConversations: async () => [],
    createConversation: async () => ({ id: 'created-A', title: '新对话' }),
    getConversation: async (id) => ({
      id,
      messages: [
        { role: 'user', content: id + '原问题' },
        { role: 'assistant', content: id + '原回复' },
      ],
    }),
    updateConvTitle: async () => {},
    saveMessages: async (...args) => {
      writes.push(args)
    },
    chatStream: async (query, history, _signal, callbacks) => {
      streams.push({ query, history })
      callbacks.onToken(query + '回复')
      callbacks.onDone({})
    },
    analyzeContractStream: async (file, _signal, callbacks, instruction) => {
      streams.push({ file, instruction })
      callbacks.onToken(file.name + '报告')
      callbacks.onDone({ raw_text: '合同原文', chat_reply: file.name + '报告', risk_points: [] })
    },
    ...overrides,
  }
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ ...component, render: () => h('div') })
  const instance = app.mount(root)
  await nextTick()
  return {
    state: instance.$.setupState,
    writes,
    streams,
    notices,
    close() {
      app.unmount()
      root.remove()
    },
  }
}

const messageRevision = 'a'.repeat(64)
function savedBubble(id, role = 'assistant', content = '原回复') {
  return { id, role, content, revision: messageRevision }
}
function savedPairReceipt() {
  return { messages: [savedBubble(101, 'user'), savedBubble(102)] }
}

test('单条删除固定确认时的会话和消息，切换页面及下标变化不误删', async () => {
  const deletes = []
  const view = await mount({
    deleteSavedMessage: async (...args) => {
      deletes.push(args)
      return { message_id: args[1], conversation_deleted: false }
    },
    rebuildMessages: () => assert.fail('不能重建整段历史'),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1), savedBubble(2), savedBubble(3)]
    const owned = view.state.messages
    const deleting = view.state.deleteMessage(1)
    owned.unshift(savedBubble(4))
    await view.state.loadConversation('B')
    view.state.resolveConfirm(true)
    await deleting
    assert.deepEqual(deletes, [['A', 2, messageRevision, false]])
    assert.deepEqual(
      owned.map((message) => message.id),
      [4, 1, 3],
    )
    assert.equal(view.state.currentConvId, 'B')
    assert.deepEqual(
      view.state.messages.map((message) => message.content),
      ['B原问题', 'B原回复'],
    )
  } finally {
    view.close()
  }
})

for (const failure of ['network', 'invalid-ack']) {
  test(`单条删除 ${failure} 时原消息和所属会话不丢失`, async () => {
    const view = await mount({
      deleteSavedMessage: async () => {
        if (failure === 'network') throw new Error('内部错误不能显示')
        return { message_id: 999, conversation_deleted: true }
      },
    })
    try {
      view.state.currentConvId = 'A'
      view.state.messages = [savedBubble(1)]
      const deleting = view.state.deleteMessage(0)
      view.state.resolveConfirm(true)
      await deleting
      assert.equal(view.state.messages[0].id, 1)
      assert.equal(view.state.currentConvId, 'A')
      assert.match(view.notices.at(-1).options.message, /删除未获确认/)
      assert.equal(view.state.pendingMessageDeletions.size, 0)
    } finally {
      view.close()
    }
  })
}

test('删除最后一条消息只在服务端确认后清理会话', async () => {
  const gate = deferred()
  const view = await mount({ deleteSavedMessage: () => gate.promise })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1)]
    view.state.draftInputs.A = '旧草稿'
    const deleting = view.state.deleteMessage(0)
    view.state.resolveConfirm(true)
    await nextTick()
    assert.equal(view.state.messages.length, 1)
    gate.resolve({ message_id: 1, conversation_deleted: true })
    await deleting
    assert.equal(view.state.currentConvId, null)
    assert.equal(view.state.messages.length, 0)
    assert.equal(view.state.draftInputs.A, undefined)
  } finally {
    view.close()
  }
})

for (const role of ['assistant', 'user']) {
  test(`删除生成中 ${role} 只停止所属请求并删除所点消息，保留另一气泡及并发会话`, async () => {
    const entered = deferred()
    const otherDone = deferred()
    const deletes = []
    let otherSignal
    const view = await mount({
      saveMessages: async (...args) => {
        view.writes.push(args)
        return savedPairReceipt()
      },
      deleteSavedMessage: async (...args) => {
        deletes.push(args)
        return { message_id: args[1], conversation_deleted: false }
      },
      chatStream: async (query, _history, signal, callbacks) => {
        if (query === 'B问题') {
          otherSignal = signal
          await otherDone.promise
          await callbacks.onDone({ chat_reply: 'B完整回复' })
          return
        }
        callbacks.onToken('A部分回复')
        entered.resolve()
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        await callbacks.onDone({ aborted: true })
      },
    })
    try {
      view.state.currentConvId = 'A'
      view.state.input = 'A问题'
      const sending = view.state.sendText()
      await entered.promise
      const owned = view.state.messages
      const deleting = view.state.deleteMessage(role === 'assistant' ? 1 : 0)
      view.state.resolveConfirm(true)
      await view.state.newChat()
      view.state.currentConvId = 'B'
      view.state.input = 'B问题'
      const other = view.state.sendText()
      await deleting
      await sending
      assert.equal(owned.length, 1)
      assert.equal(owned[0].role, role === 'assistant' ? 'user' : 'assistant')
      assert.equal(deletes[0][0], 'A')
      assert.equal(deletes[0][1], role === 'assistant' ? 102 : 101)
      assert.equal(view.writes.filter((args) => args[0] === 'A').length, 1)
      assert.equal(otherSignal.aborted, false)
      otherDone.resolve()
      await other
      assert.equal(view.state.messages[1].content, 'B完整回复')
    } finally {
      otherDone.resolve()
      view.close()
    }
  })
}

test('创建尚未完成时删除 AI 占位，保留问题且不启动模型', async () => {
  const created = deferred()
  const entered = deferred()
  const deletes = []
  const view = await mount({
    createConversation: () => {
      entered.resolve()
      return created.promise
    },
    saveMessages: async (...args) => {
      view.writes.push(args)
      return savedPairReceipt()
    },
    deleteSavedMessage: async (...args) => {
      deletes.push(args)
      return { message_id: args[1], conversation_deleted: false }
    },
    chatStream: () => assert.fail('删除占位不应启动模型'),
  })
  try {
    view.state.input = '保留我的问题'
    const sending = view.state.sendText()
    await entered.promise
    const owned = view.state.messages
    const deleting = view.state.deleteMessage(1)
    view.state.resolveConfirm(true)
    await nextTick()
    await view.state.newChat()
    view.state.input = '另一个草稿'
    assert.equal(Boolean(view.state.canSend), true)
    created.resolve({ id: 'created-A', title: '新对话' })
    await deleting
    await sending
    assert.equal(view.state.currentConvId, null)
    assert.equal(view.state.input, '另一个草稿')
    assert.equal(owned.length, 1)
    assert.equal(owned[0].content, '保留我的问题')
    assert.equal(deletes[0][0], 'created-A')
  } finally {
    created.resolve({ id: 'created-A' })
    view.close()
  }
})

test('删除历史消息不停止同会话的新一轮生成，并保护尚未保存的消息容器', async () => {
  const entered = deferred()
  const gate = deferred()
  const deletes = []
  let signal
  const view = await mount({
    deleteSavedMessage: async (...args) => {
      deletes.push(args)
      return { message_id: args[1], conversation_deleted: false }
    },
    chatStream: async (_query, _history, requestSignal, callbacks) => {
      signal = requestSignal
      entered.resolve()
      await gate.promise
      await callbacks.onDone({ chat_reply: '新回复' })
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1)]
    view.state.input = '新问题'
    const sending = view.state.sendText()
    await entered.promise
    assert.equal(view.state.messages.length, 3)
    const deleting = view.state.deleteMessage(0)
    view.state.resolveConfirm(true)
    await deleting
    assert.equal(signal.aborted, false)
    assert.equal(deletes[0][3], true)
    assert.equal(view.state.messages.length, 2)
    gate.resolve()
    await sending
    assert.equal(view.writes.length, 1)
    assert.equal(view.state.messages[1].content, '新回复')
  } finally {
    gate.resolve()
    view.close()
  }
})

test('取消删除生成中的回复不会中断请求或调用删除接口', async () => {
  const entered = deferred()
  const gate = deferred()
  let signal
  const view = await mount({
    deleteSavedMessage: () => assert.fail('取消不能删除'),
    chatStream: async (_query, _history, requestSignal, callbacks) => {
      signal = requestSignal
      entered.resolve()
      await gate.promise
      await callbacks.onDone({ chat_reply: '完整回复' })
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.input = '问题'
    const sending = view.state.sendText()
    await entered.promise
    const deleting = view.state.deleteMessage(1)
    view.state.resolveConfirm(false)
    await deleting
    assert.equal(signal.aborted, false)
    gate.resolve()
    await sending
    assert.equal(view.state.messages.length, 2)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('保存尚在途时删除等待身份回执，不重复保存或提前移除', async () => {
  const entered = deferred()
  const gate = deferred()
  const deletes = []
  const view = await mount({
    saveMessages: async (...args) => {
      view.writes.push(args)
      entered.resolve()
      return gate.promise
    },
    deleteSavedMessage: async (...args) => {
      deletes.push(args)
      return { message_id: args[1], conversation_deleted: false }
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.input = '问题'
    const sending = view.state.sendText()
    await entered.promise
    const deleting = view.state.deleteMessage(1)
    view.state.resolveConfirm(true)
    await nextTick()
    assert.equal(deletes.length, 0)
    assert.equal(view.state.messages.length, 2)
    gate.resolve(savedPairReceipt())
    await Promise.all([sending, deleting])
    assert.equal(view.writes.length, 1)
    assert.deepEqual(deletes, [['A', 102, messageRevision, false]])
    assert.equal(view.state.messages[0].role, 'user')
  } finally {
    gate.resolve(savedPairReceipt())
    view.close()
  }
})

test('旧回执与服务器记录不能安全对齐时不尝试删除', async () => {
  const view = await mount({ deleteSavedMessage: () => assert.fail('不能猜测删除身份') })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [{ role: 'assistant', content: '未确认保存的回复', saveFailed: true }]
    const deleting = view.state.deleteMessage(0)
    view.state.resolveConfirm(true)
    await deleting
    assert.equal(view.state.messages.length, 1)
    assert.match(view.notices.at(-1).options.message, /删除未获确认/)
  } finally {
    view.close()
  }
})

test('删除生成中的合同回复保留用户问题及原附件信息', async () => {
  const entered = deferred()
  const file = new File(['合同正文'], '原合同.txt')
  const view = await mount({
    analyzeContractStream: async (_file, signal, callbacks) => {
      entered.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      await callbacks.onDone({ aborted: true })
    },
    saveMessages: async (...args) => {
      view.writes.push(args)
      return savedPairReceipt()
    },
    deleteSavedMessage: async (_cid, id) => ({ message_id: id, conversation_deleted: false }),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.pendingFile = file
    view.state.input = '审查押金'
    const sending = view.state.sendFile('审查押金')
    await entered.promise
    const deleting = view.state.deleteMessage(1)
    view.state.resolveConfirm(true)
    await Promise.all([sending, deleting])
    assert.equal(view.state.messages.length, 1)
    assert.equal(view.state.messages[0].file, file)
    assert.match(view.state.messages[0].content, /审查押金/)
    assert.equal(view.writes[0][3], file.name)
  } finally {
    view.close()
  }
})

test('删除正在重跑的合同只停止该报告，关闭原预览而不丢用户消息', async () => {
  const entered = deferred()
  const deletes = []
  const view = await mount({
    regenerateContractStream: async (_cid, _id, _revision, signal, callbacks) => {
      entered.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      callbacks.onDone({ aborted: true })
    },
    deleteSavedMessage: async (...args) => {
      deletes.push(args)
      return { message_id: args[1], conversation_deleted: false }
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [
      savedBubble(1, 'user', '上传合同'),
      {
        ...savedBubble(2),
        contractData: { raw_text: '合同原文', chat_reply: '原回复', risk_points: [] },
      },
    ]
    view.state.previewData = view.state.messages[1].contractData
    view.state.showPreview = true
    const regenerating = view.state.regenerateMessage(1)
    await entered.promise
    const deleting = view.state.deleteMessage(1)
    view.state.resolveConfirm(true)
    await Promise.all([regenerating, deleting])
    assert.deepEqual(deletes, [['A', 2, messageRevision, false]])
    assert.equal(view.state.messages.length, 1)
    assert.equal(view.state.showPreview, false)
    assert.equal(view.state.loadingConvIds.size, 0)
    assert.equal(view.notices.length, 0)
  } finally {
    view.close()
  }
})

test('确认期间目标报告版本发生变化时仍提交旧版本，不能误删新报告', async () => {
  const view = await mount({
    deleteSavedMessage: async (_cid, _id, revision) => {
      assert.equal(revision, messageRevision)
      throw new Error('message_changed')
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(2)]
    const deleting = view.state.deleteMessage(0)
    view.state.messages[0].revision = 'b'.repeat(64)
    view.state.messages[0].content = '新报告'
    view.state.resolveConfirm(true)
    await deleting
    assert.equal(view.state.messages[0].content, '新报告')
  } finally {
    view.close()
  }
})

test('删除后迟到的同会话历史响应不能把该气泡带回来', async () => {
  const gate = deferred()
  const view = await mount({
    getConversation: () => gate.promise,
    deleteSavedMessage: async (_cid, id) => ({ message_id: id, conversation_deleted: false }),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '原问题'), savedBubble(2)]
    const stale = structuredClone(view.state.messages.map((message) => ({ ...message })))
    const deleting = view.state.deleteMessage(1)
    const loading = view.state.loadConversation('A')
    view.state.resolveConfirm(true)
    await deleting
    gate.resolve({ id: 'A', messages: stale })
    await loading
    assert.deepEqual(
      view.state.messages.map((message) => message.id),
      [1],
    )
  } finally {
    gate.resolve({ id: 'A', messages: [] })
    view.close()
  }
})

test('真实页面在自动命名等待期间切换历史，不串历史、占位回复或保存目标', async () => {
  const title = deferred()
  const entered = deferred()
  const view = await mount({
    updateConvTitle: () => {
      entered.resolve()
      return title.promise
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = 'A新问题'
    const sending = state.sendText()
    const owned = state.messages
    assert.equal(owned.length, 2)
    await entered.promise
    await state.loadConversation('B')
    title.resolve()
    await sending
    assert.equal(state.currentConvId, 'B')
    assert.deepEqual(
      state.messages.map((message) => message.content),
      ['B原问题', 'B原回复'],
    )
    assert.deepEqual(view.streams, [{ query: 'A新问题', history: [] }])
    assert.equal(owned[1].content, 'A新问题回复')
    assert.equal(view.writes[0][0], 'A')
    assert.equal(view.writes[0][1], 'A新问题')
  } finally {
    title.resolve()
    view.close()
  }
})

test('删除正在生成的会话会中止原请求，迟到回调不能保存或复活缓存', async () => {
  const entered = deferred()
  const gate = deferred()
  let callbacks
  let signal
  const view = await mount({
    deleteConversation: async () => {},
    chatStream: async (_query, _history, requestSignal, handlers) => {
      signal = requestSignal
      callbacks = handlers
      callbacks.onThinking('旧工具')
      entered.resolve()
      await gate.promise
      callbacks.onToken('不能复活的内容')
      callbacks.onThinking('迟到工具')
      await callbacks.onDone({})
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.input = 'A的问题'
    const sending = view.state.sendText()
    await entered.promise
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(true)
    await deleting
    assert.equal(signal.aborted, true)
    assert.equal(view.state.currentConvId, null)
    assert.equal(view.state.loadingConvIds.has('A'), false)
    assert.equal(view.state.streamMessageCache.A, undefined)
    gate.resolve()
    await sending
    assert.equal(view.writes.length, 0)
    assert.equal(view.state.streamMessageCache.A, undefined)
    assert.equal(view.state.messages.length, 0)
    assert.equal(view.notices.length, 0)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('后台会话删除不清空当前会话及其草稿、附件、过程和展开状态', async () => {
  const view = await mount({ deleteConversation: async () => {} })
  try {
    await view.state.loadConversation('B')
    const messages = view.state.messages
    const file = new File(['草稿'], 'B.txt')
    view.state.pendingFile = file
    view.state.input = 'B未发送的内容'
    view.state.thinkingSteps = [{ type: 'tool', label: 'B工具' }]
    messages.at(-1).thinkingExpanded = true
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(true)
    await deleting
    assert.equal(view.state.currentConvId, 'B')
    assert.equal(view.state.messages, messages)
    assert.equal(messages.at(-1).thinkingExpanded, true)
    assert.equal(view.state.input, 'B未发送的内容')
    assert.equal(view.state.pendingFile, file)
    assert.equal(view.state.thinkingSteps[0].label, 'B工具')
  } finally {
    view.close()
  }
})

for (const success of [true, false]) {
  test(`删除等待期间模型完成：${success ? '成功则不再保存' : '失败则保留会话并正常保存'}`, async () => {
    const modelEntered = deferred()
    const streamGate = deferred()
    const deletionGate = deferred()
    let callbacks
    let signal
    const view = await mount({
      deleteConversation: () => deletionGate.promise,
      chatStream: async (_query, _history, ownedSignal, handlers) => {
        callbacks = handlers
        signal = ownedSignal
        modelEntered.resolve()
        await streamGate.promise
      },
    })
    try {
      view.state.currentConvId = 'A'
      view.state.input = '原问题'
      const sending = view.state.sendText()
      await modelEntered.promise
      const deleting = view.state.handleDeleteConv('A')
      view.state.resolveConfirm(true)
      await nextTick()
      callbacks.onToken('完整回复')
      const completing = callbacks.onDone({})
      await nextTick()
      assert.equal(view.writes.length, 0)
      assert.equal(view.state.deletingConvIds.has('A'), true)
      if (success) deletionGate.resolve()
      else deletionGate.reject(new Error('删除服务失败'))
      await deleting
      await completing
      streamGate.resolve()
      await sending
      assert.equal(view.writes.length, success ? 0 : 1)
      assert.equal(signal.aborted, success)
      assert.equal(view.state.deletingConvIds.size, 0)
      if (!success) {
        assert.equal(view.state.currentConvId, 'A')
        assert.equal(view.state.messages.at(-1).content, '完整回复')
        assert.match(view.notices[0].options.message, /删除未获确认/)
      }
    } finally {
      deletionGate.resolve()
      streamGate.resolve()
      view.close()
    }
  })
}

test('取消删除不会中止请求或清理会话和草稿', async () => {
  const deleted = []
  const view = await mount({ deleteConversation: async (id) => deleted.push(id) })
  try {
    await view.state.loadConversation('A')
    view.state.input = '保留草稿'
    const owned = view.state.messages
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(false)
    await deleting
    assert.deepEqual(deleted, [])
    assert.equal(view.state.currentConvId, 'A')
    assert.equal(view.state.messages, owned)
    assert.equal(view.state.input, '保留草稿')
  } finally {
    view.close()
  }
})

test('删除准备阶段的请求不恢复旧草稿或启动模型，当前页恢复之前的新对话草稿', async () => {
  const titleGate = deferred()
  const titleEntered = deferred()
  const view = await mount({
    deleteConversation: async () => {},
    updateConvTitle: () => {
      titleEntered.resolve()
      return titleGate.promise
    },
  })
  try {
    const file = new File(['新对话附件'], '新草稿.txt')
    view.state.input = '新对话草稿'
    view.state.pendingFile = file
    await view.state.loadConversation('A')
    view.state.messages = []
    view.state.input = '即将删除的原问题'
    const sending = view.state.sendText()
    await titleEntered.promise
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(true)
    await deleting
    titleGate.resolve()
    await sending
    assert.equal(view.state.input, '新对话草稿')
    assert.equal(view.state.pendingFile, file)
    assert.equal(view.state.messages.length, 0)
    assert.equal(view.streams.length, 0)
    assert.equal(view.writes.length, 0)
    assert.equal(view.notices.length, 0)
  } finally {
    titleGate.resolve()
    view.close()
  }
})

test('删除等待期间阻止同会话新发送，但不锁住其他会话', async () => {
  const deletionGate = deferred()
  const view = await mount({ deleteConversation: () => deletionGate.promise })
  try {
    await view.state.loadConversation('A')
    const count = view.state.messages.length
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(true)
    await nextTick()
    view.state.input = 'A不能重发'
    assert.equal(view.state.canSend, false)
    await view.state.sendText()
    assert.equal(view.state.messages.length, count)
    assert.equal(view.state.input, 'A不能重发')
    await view.state.loadConversation('B')
    view.state.input = 'B可以发送'
    await view.state.sendText()
    assert.equal(view.writes[0][0], 'B')
    deletionGate.resolve()
    await deleting
    assert.equal(view.state.currentConvId, 'B')
  } finally {
    deletionGate.resolve()
    view.close()
  }
})

test('删除正在重跑的合同会失效独立控制器，迟到过程和收尾不能复活未保存缓存', async () => {
  const entered = deferred()
  const gate = deferred()
  let signal
  const view = await mount({
    deleteConversation: async () => {},
    regenerateContractStream: async (_cid, _id, _revision, ownedSignal, callbacks) => {
      signal = ownedSignal
      callbacks.onThinking('原工具')
      entered.resolve()
      await gate.promise
      callbacks.onThinking('迟到工具')
      callbacks.onDone({ aborted: true })
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [
      { role: 'user', content: '上传合同', file: { name: '历史.txt' } },
      {
        id: 10,
        revision: 'a'.repeat(64),
        role: 'assistant',
        content: '原报告',
        contractData: { raw_text: '原合同', chat_reply: '原报告', risk_points: [] },
        saveFailed: true,
      },
    ]
    const running = view.state.regenerateMessage(1)
    await entered.promise
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(true)
    await deleting
    assert.equal(signal.aborted, true)
    gate.resolve()
    await running
    assert.equal(view.state.streamMessageCache.A, undefined)
    assert.equal(view.state.loadingConvIds.has('A'), false)
    assert.equal(view.state.messages.length, 0)
    assert.equal(view.notices.length, 0)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('迟到的历史和列表响应不能恢复已删除会话，也不能抢占当前其他会话', async () => {
  const historyGate = deferred()
  const listGate = deferred()
  let staleList = false
  const view = await mount({
    deleteConversation: async () => {},
    getConversation: (id) =>
      id === 'A' ? historyGate.promise : Promise.resolve({ id, messages: [] }),
    listConversations: () => (staleList ? listGate.promise : Promise.resolve([])),
  })
  try {
    await view.state.loadConversation('B')
    const loading = view.state.loadConversation('A')
    staleList = true
    const refreshing = view.state.refreshConvList()
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(true)
    await nextTick()
    historyGate.resolve({ id: 'A', messages: [{ role: 'user', content: '不能恢复的旧内容' }] })
    listGate.resolve([
      { id: 'A', title: '旧会话' },
      { id: 'B', title: '保留会话' },
    ])
    await Promise.all([loading, refreshing, deleting])
    assert.equal(view.state.currentConvId, 'B')
    assert.deepEqual(
      view.state.conversations.map((conv) => conv.id),
      ['B'],
    )
    assert.equal(view.state.messages.length, 0)
    assert.equal(view.state.historyLoading, false)
    await view.state.loadConversation('A')
    assert.equal(view.state.currentConvId, 'B')
  } finally {
    historyGate.resolve({ id: 'A', messages: [] })
    listGate.resolve([])
    view.close()
  }
})

for (const saveFails of [false, true]) {
  test(`保存已在途时删除会话，迟到的${saveFails ? '失败' : '成功'}不恢复缓存或弹出保存警告`, async () => {
    const entered = deferred()
    const saveGate = deferred()
    const view = await mount({
      deleteConversation: async () => {},
      saveMessages: async () => {
        entered.resolve()
        await saveGate.promise
      },
    })
    try {
      view.state.currentConvId = 'A'
      view.state.input = '原问题'
      const sending = view.state.sendText()
      await entered.promise
      const deleting = view.state.handleDeleteConv('A')
      view.state.resolveConfirm(true)
      await deleting
      if (saveFails) saveGate.reject(new Error('会话已被删除'))
      else saveGate.resolve()
      await sending
      assert.equal(view.state.streamMessageCache.A, undefined)
      assert.equal(view.state.messages.length, 0)
      assert.equal(view.notices.length, 0)
    } finally {
      saveGate.resolve()
      view.close()
    }
  })
}

test('创建会话等待期间连续打开新对话，逆序返回也不抢占新页面', async () => {
  const firstCreate = deferred()
  const secondCreate = deferred()
  const entered = deferred()
  let count = 0
  const view = await mount({
    createConversation: () => {
      count++
      entered.resolve()
      return count === 1 ? firstCreate.promise : secondCreate.promise
    },
  })
  try {
    const state = view.state
    state.input = 'A问题'
    const first = state.sendText()
    await entered.promise
    await state.newChat()
    state.input = 'B问题'
    const second = state.sendText()
    await nextTick()
    secondCreate.resolve({ id: 'B', title: '新对话' })
    await second
    firstCreate.resolve({ id: 'A', title: '新对话' })
    await first
    assert.equal(state.currentConvId, 'B')
    assert.deepEqual(
      state.messages.map((message) => message.content),
      ['B问题', 'B问题回复'],
    )
    assert.deepEqual(
      view.writes.map((write) => [write[0], write[1]]),
      [
        ['B', 'B问题'],
        ['A', 'A问题'],
      ],
    )
    assert.equal(state.loadingConvIds.size, 0)
  } finally {
    firstCreate.resolve({ id: 'A' })
    secondCreate.resolve({ id: 'B' })
    view.close()
  }
})

test('合同发送在创建等待前固定文件，不消费另一会话的草稿和附件', async () => {
  const gate = deferred()
  const entered = deferred()
  const view = await mount({
    createConversation: () => {
      entered.resolve()
      return gate.promise
    },
  })
  try {
    const state = view.state
    const original = new File(['A原文'], 'A.txt')
    const other = new File(['B原文'], 'B.txt')
    state.pendingFile = original
    state.input = 'A指令'
    const sending = state.sendFile('A指令')
    await entered.promise
    await state.newChat()
    state.pendingFile = other
    state.input = 'B草稿'
    gate.resolve({ id: 'A', title: '新对话' })
    await sending
    assert.equal(state.currentConvId, null)
    assert.equal(state.pendingFile, other)
    assert.equal(state.input, 'B草稿')
    assert.equal(view.streams[0].file, original)
    assert.equal(view.streams[0].instruction, 'A指令')
    assert.equal(view.writes[0][0], 'A')
    assert.equal(view.writes[0][1], '📄 上传合同：A.txt\nA指令')
    assert.equal(view.writes[0][4].instruction, 'A指令')
  } finally {
    gate.resolve({ id: 'A' })
    view.close()
  }
})

test('附加指令超限保留原文字和附件，不创建会话、不加锁或写假消息', async () => {
  const view = await mount()
  try {
    const file = new File(['合同'], '合同.txt')
    const text = ' 字'.trim().repeat(4001)
    view.state.pendingFile = file
    view.state.input = text
    await view.state.sendFile(text)
    assert.equal(view.state.pendingFile, file)
    assert.equal(view.state.input, text)
    assert.equal(view.state.currentConvId, null)
    assert.equal(view.state.loadingConvIds.size, 0)
    assert.equal(view.state.messages.length, 0)
    assert.equal(view.streams.length, 0)
    assert.equal(view.writes.length, 0)
    assert.match(view.notices[0].options.message, /4000/)
  } finally {
    view.close()
  }
})

test('保存的附加指令来自原请求，不采信完成帧伪造的值，也不消费当前草稿', async () => {
  const view = await mount({
    analyzeContractStream: async (_file, _signal, callbacks, instruction) => {
      assert.equal(instruction, '重点审查乙方责任\n检查押金')
      await callbacks.onDone({
        raw_text: '合同原文',
        chat_reply: '完整报告',
        risk_points: [],
        instruction: '模型伪造的值',
      })
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.pendingFile = new File(['合同原文'], '合同.txt')
    await view.state.sendFile('  重点审查乙方责任\n检查押金  ')
    assert.equal(view.state.messages.at(-1).contractData.instruction, '重点审查乙方责任\n检查押金')
    assert.equal(view.writes[0][4].instruction, '重点审查乙方责任\n检查押金')
    assert.equal(view.writes[0][1], '📄 上传合同：合同.txt\n重点审查乙方责任\n检查押金')
  } finally {
    view.close()
  }
})

test('准备阶段快速回车不会重复发送或意外停止原请求', async () => {
  const gate = deferred()
  const entered = deferred()
  const view = await mount({
    updateConvTitle: () => {
      entered.resolve()
      return gate.promise
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = '唯一问题'
    const sending = state.sendText()
    await entered.promise
    for (let index = 0; index < 100; index++) {
      state.handleSend({ type: 'keydown' })
      state.handleSend({ type: 'click' })
    }
    assert.equal(state.abortControllers.A.signal.aborted, false)
    assert.equal(state.messages.length, 2)
    gate.resolve()
    await sending
    assert.equal(view.streams.length, 1)
    assert.equal(view.writes.length, 1)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('保存延迟期间保持本会话锁，其他会话可发送且旧清理不影响它', async () => {
  const saveGate = deferred()
  const saving = deferred()
  const streamGate = deferred()
  const streaming = deferred()
  const view = await mount({
    saveMessages: async (convId) => {
      if (convId === 'A') {
        saving.resolve()
        await saveGate.promise
      }
    },
    chatStream: async (query, _history, _signal, callbacks) => {
      if (query === 'B问题') {
        streaming.resolve()
        await streamGate.promise
      }
      callbacks.onToken(query + '回复')
      callbacks.onDone({})
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = 'A问题'
    const first = state.sendText()
    await saving.promise
    assert.ok(state.loadingConvIds.has('A'))
    await state.loadConversation('B')
    state.input = 'B问题'
    const second = state.sendText()
    await streaming.promise
    const controller = state.abortControllers.B
    saveGate.resolve()
    await first
    assert.ok(state.loadingConvIds.has('B'))
    assert.equal(state.abortControllers.B, controller)
    await state.newChat()
    await state.loadConversation('B')
    assert.equal(state.messages.at(-2).content, 'B问题')
    streamGate.resolve()
    await second
    assert.equal(state.messages.at(-1).content, 'B问题回复')
  } finally {
    saveGate.resolve()
    streamGate.resolve()
    view.close()
  }
})

test('刷新列表等待期间切换会话，也只向原会话发送历史快照', async () => {
  const gate = deferred()
  const entered = deferred()
  let delay = false
  const view = await mount({
    listConversations: async () => {
      if (delay) {
        entered.resolve()
        await gate.promise
      }
      return []
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.messages = [
      { role: 'user', content: 'A旧问题' },
      { role: 'assistant', content: 'A旧回复' },
    ]
    state.input = 'A追问'
    delay = true
    const sending = state.sendText()
    await entered.promise
    await state.loadConversation('B')
    gate.resolve()
    await sending
    assert.deepEqual(view.streams[0].history, [
      { role: 'user', content: 'A旧问题' },
      { role: 'assistant', content: 'A旧回复' },
    ])
    assert.deepEqual(
      state.messages.map((message) => message.content),
      ['B原问题', 'B原回复'],
    )
  } finally {
    gate.resolve()
    view.close()
  }
})

test('后台推理 token 和工具片段在切回后完整恢复，前后台正文没有重复', async () => {
  const gate = deferred()
  const entered = deferred()
  let callbacks
  const view = await mount({
    chatStream: async (_query, _history, _signal, handlers) => {
      callbacks = handlers
      entered.resolve()
      await gate.promise
      handlers.onDone({})
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = 'A问题'
    const sending = state.sendText()
    await entered.promise
    callbacks.onToken('第一段')
    await state.loadConversation('B')
    callbacks.onReasoningToken('后台分析')
    callbacks.onToolChunk('search_laws', '工具内容一', true)
    callbacks.onToolChunk('search_laws', '内容二', false)
    callbacks.onToken('第二段')
    await state.loadConversation('A')
    assert.equal(state.messages.at(-1).content, '第一段第二段')
    assert.deepEqual(state.thinkingSteps, [
      { type: 'reasoning', label: '后台分析' },
      { type: 'done', label: 'search_laws 完成', snippet: '工具内容一内容二' },
    ])
    callbacks.onToken('第三段')
    gate.resolve()
    await sending
    assert.equal(state.messages.at(-1).content, '第一段第二段第三段')
    assert.equal(view.writes[0][2], '第一段第二段第三段')
  } finally {
    gate.resolve()
    view.close()
  }
})

test('停止一个会话不影响另一个会话，并且准备阶段停止不会启动模型', async () => {
  const gate = deferred()
  const entered = deferred()
  const view = await mount({
    updateConvTitle: async () => {
      entered.resolve()
      await gate.promise
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = 'A问题'
    const sending = state.sendText()
    await entered.promise
    const ownController = state.abortControllers.A
    const unrelated = new AbortController()
    state.abortControllers.B = unrelated
    state.loadingConvIds.add('B')
    await state.loadConversation('B')
    state.stopGeneration('A')
    gate.resolve()
    await sending
    assert.equal(ownController.signal.aborted, true)
    assert.equal(unrelated.signal.aborted, false)
    assert.equal(state.abortControllers.B, unrelated)
    assert.ok(state.loadingConvIds.has('B'))
    assert.equal(view.streams.length, 0)
    assert.equal(view.writes.length, 0)
    assert.equal(state.messages.at(-1).content, 'B原回复')
    await state.loadConversation('A')
    assert.equal(state.input, 'A问题')
  } finally {
    gate.resolve()
    view.close()
  }
})

test('较早历史请求后返回时，不覆盖最终选中会话或新对话', async () => {
  const slow = deferred()
  const view = await mount({
    getConversation: async (id) => (id === 'slow' ? slow.promise : { id, messages: [] }),
  })
  try {
    const state = view.state
    const first = state.loadConversation('slow')
    await state.loadConversation('B')
    slow.resolve({ id: 'slow', messages: [{ role: 'user', content: '过期历史' }] })
    await first
    assert.equal(state.currentConvId, 'B')
    assert.deepEqual(state.messages, [])
    const second = state.loadConversation('slow')
    await state.newChat()
    await second
    assert.equal(state.currentConvId, null)
    assert.deepEqual(state.messages, [])
    assert.equal(state.historyLoading, false)
  } finally {
    slow.resolve({ id: 'slow', messages: [] })
    view.close()
  }
})

test('正在加载历史时返回创建结果，不会抢占加载中的目标页面', async () => {
  const creation = deferred()
  const history = deferred()
  const entered = deferred()
  const view = await mount({
    createConversation: () => {
      entered.resolve()
      return creation.promise
    },
    getConversation: () => history.promise,
  })
  try {
    const state = view.state
    state.input = '新会话问题'
    const sending = state.sendText()
    await entered.promise
    const loading = state.loadConversation('B')
    creation.resolve({ id: 'A', title: '新对话' })
    await sending
    assert.notEqual(state.currentConvId, 'A')
    history.resolve({ id: 'B', messages: [{ role: 'assistant', content: 'B原回复' }] })
    await loading
    assert.equal(state.currentConvId, 'B')
    assert.equal(state.messages[0].content, 'B原回复')
  } finally {
    creation.resolve({ id: 'A' })
    history.resolve({ id: 'B', messages: [] })
    view.close()
  }
})

for (const kind of ['text', 'file']) {
  for (const failure of ['HTTP', 'network']) {
    test(`创建会话 ${failure} 失败恢复 ${kind} 草稿，清理占位并允许重试`, async () => {
      const view = await mount({
        createConversation: async () => {
          const error = new Error('sk-test-private upstream failure')
          if (failure === 'HTTP') error.response = { status: 503, data: { detail: '内部异常细节' } }
          throw error
        },
      })
      try {
        const state = view.state
        const text = '  待发文字\n第二行  '
        const file = kind === 'file' ? new File(['合同原文'], '待发合同.txt') : null
        state.input = text
        state.pendingFile = file
        await (file ? state.sendFile(text.trim()) : state.sendText())
        assert.equal(state.input, text)
        assert.equal(state.pendingFile, file)
        assert.equal(state.messages.length, 0)
        assert.equal(state.loadingConvIds.size, 0)
        assert.deepEqual(state.abortControllers, {})
        assert.equal(view.streams.length, 0)
        assert.equal(view.writes.length, 0)
        assert.match(view.notices.at(-1).options.message, /已恢复/)
        assert.doesNotMatch(view.notices.at(-1).options.message, /sk-test|内部异常/)
        globalThis.__sendingTestApi.createConversation = async () => ({
          id: 'retry',
          title: '新对话',
        })
        await (file ? state.sendFile(state.input.trim()) : state.sendText())
        assert.equal(view.streams.length, 1)
        assert.equal(view.writes.length, 1)
        assert.equal(view.writes[0][0], 'retry')
      } finally {
        view.close()
      }
    })
  }
}

function waitForAbort(signal, entered) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('已取消', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    entered.resolve()
  })
}

for (const kind of ['text', 'file']) {
  test(`创建等待时停止 ${kind} 请求会立即释放锁并恢复内容`, async () => {
    const entered = deferred()
    const view = await mount({ createConversation: (signal) => waitForAbort(signal, entered) })
    try {
      const state = view.state
      const file = kind === 'file' ? new File(['合同原文'], '取消合同.txt') : null
      state.input = '创建期间取消'
      state.pendingFile = file
      const sending = file ? state.sendFile(state.input) : state.sendText()
      await entered.promise
      state.stopGeneration(state.pageKey())
      await sending
      assert.equal(state.input, '创建期间取消')
      assert.equal(state.pendingFile, file)
      assert.equal(state.loadingConvIds.size, 0)
      assert.equal(state.messages.length, 0)
      assert.equal(view.writes.length, 0)
      assert.match(view.notices.at(-1).options.message, /已取消发送/)
    } finally {
      view.close()
    }
  })
}

test('首个异步等待前停止，不调用创建接口', async () => {
  let creations = 0
  const view = await mount({
    createConversation: async () => {
      creations++
      return { id: 'unexpected' }
    },
  })
  try {
    const state = view.state
    state.input = '立即取消'
    const sending = state.sendText()
    state.stopGeneration(state.pageKey())
    await sending
    assert.equal(creations, 0)
    assert.equal(state.input, '立即取消')
    assert.equal(state.messages.length, 0)
  } finally {
    view.close()
  }
})

for (const stage of ['title', 'list']) {
  test(`${stage} 等待时取消会归还已有会话草稿，不写假回复`, async () => {
    const entered = deferred()
    let hold = false
    const view = await mount({
      updateConvTitle: (_id, _title, signal) =>
        stage === 'title' ? waitForAbort(signal, entered) : Promise.resolve(),
      listConversations: (signal) =>
        hold && stage === 'list' ? waitForAbort(signal, entered) : Promise.resolve([]),
    })
    try {
      const state = view.state
      state.currentConvId = 'A'
      const original =
        stage === 'list'
          ? [
              { role: 'user', content: '原问题' },
              { role: 'assistant', content: '原回复' },
            ]
          : []
      state.messages = structuredClone(original)
      state.input = '准备阶段取消'
      hold = true
      const sending = state.sendText()
      await entered.promise
      state.stopGeneration('A')
      await sending
      assert.equal(state.input, '准备阶段取消')
      assert.deepEqual(state.messages, original)
      assert.equal(state.loadingConvIds.size, 0)
      assert.equal(view.writes.length, 0)
      assert.equal(view.streams.length, 0)
    } finally {
      view.close()
    }
  })
}

test('失败的旧空白页不覆盖新草稿，槽位空闲后可逐次恢复', async () => {
  const creation = deferred()
  const entered = deferred()
  const view = await mount({
    createConversation: () => {
      entered.resolve()
      return creation.promise
    },
  })
  try {
    const state = view.state
    const original = new File(['A原文'], 'A.txt')
    const newer = new File(['B原文'], 'B.txt')
    state.input = 'A待发'
    state.pendingFile = original
    const sending = state.sendFile('A待发')
    await entered.promise
    await state.newChat()
    state.input = 'B新草稿'
    state.pendingFile = newer
    creation.reject(new Error('模拟创建失败'))
    await sending
    assert.equal(state.input, 'B新草稿')
    assert.equal(state.pendingFile, newer)
    assert.match(view.notices.at(-1).options.message, /已暂存/)
    await state.newChat()
    assert.equal(state.input, 'B新草稿')
    state.input = ''
    state.pendingFile = null
    await state.newChat()
    assert.equal(state.input, 'A待发')
    assert.equal(state.pendingFile, original)
    globalThis.__sendingTestApi.createConversation = async () => ({ id: 'retry', title: '重试' })
    await state.sendFile(state.input)
    await state.newChat()
    assert.equal(state.input, '')
    assert.equal(state.pendingFile, null)
  } finally {
    creation.resolve({ id: 'A' })
    view.close()
  }
})

test('旧创建失败时另一个新对话仍在创建，不把恢复内容塞入它的输入框', async () => {
  const first = deferred()
  const second = deferred()
  const entered = deferred()
  let count = 0
  const view = await mount({
    createConversation: () => {
      entered.resolve()
      return count++ === 0 ? first.promise : second.promise
    },
  })
  try {
    const state = view.state
    state.input = 'A待发'
    const sendingA = state.sendText()
    await entered.promise
    await state.newChat()
    state.input = 'B已发送'
    const sendingB = state.sendText()
    await nextTick()
    first.reject(new Error('模拟创建失败'))
    await sendingA
    assert.equal(state.input, '')
    assert.equal(state.loading, true)
    second.resolve({ id: 'B', title: 'B对话' })
    await sendingB
    assert.equal(state.currentConvId, 'B')
    assert.equal(state.input, '')
    await state.newChat()
    assert.equal(state.input, 'A待发')
    assert.equal(view.writes.length, 1)
    assert.equal(view.writes[0][1], 'B已发送')
  } finally {
    first.resolve({ id: 'A' })
    second.resolve({ id: 'B' })
    view.close()
  }
})

test('模型已开始后停止仍保存部分回复，不把已提交请求恢复为待发草稿', async () => {
  const entered = deferred()
  const view = await mount({
    chatStream: async (_query, _history, signal, callbacks) => {
      callbacks.onToken('部分内容')
      try {
        await waitForAbort(signal, entered)
      } catch {
        callbacks.onDone({ aborted: true })
      }
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = '已提交问题'
    const sending = state.sendText()
    await entered.promise
    state.stopGeneration('A')
    await sending
    assert.equal(state.input, '')
    assert.equal(state.messages.at(-1).content, '部分内容')
    assert.equal(view.writes[0][2], '部分内容')
  } finally {
    view.close()
  }
})

const streamFrame = (event) => 'data: ' + JSON.stringify(event) + '\n\n'
const streamResponse = (events) =>
  new Response(events.map(streamFrame).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })

test('真实读取器截断时保留正文并仅保存一次带提示的结果', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    streamResponse([{ type: 'token', content: '已经收到的正文' }]),
  )
  const view = await mount({ chatStream: realChatStream })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = '问题'
    await state.sendText()
    assert.match(state.messages.at(-1).content, /已经收到的正文/)
    assert.match(state.messages.at(-1).content, /回复传输未完整结束/)
    assert.equal(view.writes.length, 1)
    assert.equal(view.writes[0][2], state.messages.at(-1).content)
    assert.equal(state.loadingConvIds.size, 0)
    assert.equal(state.messages.at(-1).saveFailed, false)
  } finally {
    view.close()
  }
})

test('重复完成及完成后的正文或错误不能再次修改回复或保存', async () => {
  const view = await mount({
    chatStream: async (_query, _history, _signal, callbacks) => {
      callbacks.onToken('唯一回复')
      callbacks.onDone({})
      callbacks.onToken('不可追加')
      callbacks.onError('不可覆盖')
      callbacks.onDone({})
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = '问题'
    await state.sendText()
    assert.equal(view.writes.length, 1)
    assert.equal(state.messages.at(-1).content, '唯一回复')
  } finally {
    view.close()
  }
})

for (const terminal of [{ type: 'done' }, { type: 'error', message: '上游服务失败' }]) {
  test(`${terminal.type} 后保存失败保留所属缓存，不伪装断网或重复写入`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () =>
      streamResponse([{ type: 'token', content: '收到的回复' }, terminal]),
    )
    let saves = 0
    const view = await mount({
      chatStream: realChatStream,
      saveMessages: async () => {
        saves++
        throw new Error('sk-private save error')
      },
    })
    try {
      const state = view.state
      state.currentConvId = 'A'
      state.input = '问题'
      await state.sendText()
      const result = state.messages.at(-1)
      assert.equal(saves, 1)
      assert.equal(result.saveFailed, true)
      assert.match(result.content, /收到的回复/)
      assert.doesNotMatch(result.content, /网络连接中断|sk-private/)
      assert.match(view.notices.at(-1).options.message, /未确认保存/)
      assert.equal(state.loadingConvIds.size, 0)
      await state.loadConversation('B')
      await state.loadConversation('A')
      assert.equal(state.messages.at(-1), result)
      assert.equal(saves, 1)
      assert.deepEqual(state.abortControllers, {})
    } finally {
      view.close()
    }
  })
}

test('真实读取器等待保存期间停止也不二次终止或重复保存', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    streamResponse([{ type: 'token', content: '完整回复' }, { type: 'done' }]),
  )
  const entered = deferred()
  const gate = deferred()
  let saves = 0
  const view = await mount({
    chatStream: realChatStream,
    saveMessages: async () => {
      saves++
      entered.resolve()
      await gate.promise
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = '问题'
    const sending = state.sendText()
    await entered.promise
    assert.ok(state.loadingConvIds.has('A'))
    state.stopGeneration('A')
    gate.resolve()
    await sending
    assert.equal(saves, 1)
    assert.equal(state.messages.at(-1).content, '完整回复')
    assert.equal(state.input, '')
    assert.equal(view.notices.length, 0)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('已保存但刷新列表失败时，不误报消息保存失败', async () => {
  let saved = false
  const view = await mount({
    saveMessages: async () => {
      saved = true
    },
    listConversations: async () => {
      if (saved) throw new Error('列表不可用')
      return []
    },
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = '问题'
    await state.sendText()
    assert.equal(state.messages.at(-1).saveFailed, false)
    assert.equal(view.notices.length, 0)
    assert.equal(state.streamMessageCache.A, undefined)
  } finally {
    view.close()
  }
})

for (const valid of [false, true]) {
  test(`合同完成帧${valid ? '完整时采用最终报告' : '缺字段时保留正文且不附加假标注'}`, async (context) => {
    const final = {
      type: 'done',
      ...(valid ? { raw_text: '合同原文', chat_reply: '最终完整报告', risk_points: [] } : {}),
    }
    context.mock.method(globalThis, 'fetch', async () =>
      streamResponse([{ type: 'token', content: '中途正文' }, final]),
    )
    const view = await mount({ analyzeContractStream: realContractStream })
    try {
      const state = view.state
      state.currentConvId = 'A'
      state.pendingFile = new File(['合同'], '合同.txt')
      await state.sendFile()
      assert.equal(view.writes.length, 1)
      const assistant = state.messages.at(-1)
      if (valid) {
        assert.equal(assistant.content, '最终完整报告')
        assert.equal(assistant.contractData.chat_reply, '最终完整报告')
      } else {
        assert.match(assistant.content, /中途正文/)
        assert.match(assistant.content, /未收到完整的合同报告/)
        assert.equal(assistant.contractData, undefined)
        assert.equal(view.writes[0][4], null)
      }
    } finally {
      view.close()
    }
  })
}
