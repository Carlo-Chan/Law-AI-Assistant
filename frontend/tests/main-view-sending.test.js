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
const sourceUrl = new URL('../src/views/MainView.vue', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'sending-regression' }).content
const apiNames = [
  'listConversations',
  'createConversation',
  'getConversation',
  'deleteConversation',
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
    analyzeContractStream: async (file, _signal, callbacks) => {
      streams.push({ file })
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
    assert.equal(view.writes[0][0], 'A')
    assert.equal(view.writes[0][1], '📄 上传合同：A.txt\nA指令')
  } finally {
    gate.resolve({ id: 'A' })
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
