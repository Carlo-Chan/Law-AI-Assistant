import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { parse, compileScript } from 'vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import {
  chatStream as realChatStream,
  analyzeContractStream as realContractStream,
  regenerateChatStream as realChatRegenerationStream,
  regenerateContractStream as realContractRegenerationStream,
} from '../src/utils/api.js'
import { SSE_MAX_FRAME_BYTES } from '../src/utils/sse.js'

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
  'editSavedMessage',
  'saveMessages',
  'updateConvTitle',
  'chatStream',
  'analyzeContractStream',
  'regenerateContractStream',
  'regenerateChatStream',
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

// 布局宽度和动画帧由替身控制，直接验证真实页面拖拽的事件归属及资源释放。
async function mountDivider(context, { width = 1000, layout = true } = {}) {
  const view = await mount()
  const frames = new Map()
  let nextFrame = 0
  const previousBodyStyle = document.body.style.cssText
  const descriptors = ['requestAnimationFrame', 'cancelAnimationFrame'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ])
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  const panel = document.createElement('div')
  panel.className = 'app-layout'
  Object.defineProperty(panel, 'offsetWidth', { value: width })
  if (layout) document.body.append(panel)
  view.state.showPreview = true
  await nextTick()
  document.body.style.setProperty('user-select', 'text', 'important')
  document.body.style.setProperty('cursor', 'crosshair', 'important')
  let closed = false
  function unmount() {
    if (closed) return
    view.close()
    closed = true
  }
  const mouse = (type, clientX = 100, button = 0) =>
    new dom.window.MouseEvent(type, { clientX, button, cancelable: true })
  context.after(() => {
    // 旧实现的红灯验证也要清理残留监听，不能污染后续用例。
    document.dispatchEvent(mouse('mouseup'))
    unmount()
    panel.remove()
    document.body.style.cssText = previousBodyStyle
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  return {
    ...view,
    frames,
    mouse,
    unmount,
    start: (button = 0) => view.state.onDividerDragStart(mouse('mousedown', 100, button)),
    move: (clientX) => document.dispatchEvent(mouse('mousemove', clientX)),
    end: () => document.dispatchEvent(mouse('mouseup')),
    flush() {
      for (const [id, callback] of [...frames]) {
        frames.delete(id)
        callback()
      }
    },
  }
}

function assertDividerReleased(view) {
  assert.equal(view.state.dragging, false)
  assert.equal(view.frames.size, 0)
  assert.equal(document.body.style.userSelect, 'text')
  assert.equal(document.body.style.cursor, 'crosshair')
  assert.equal(document.body.style.getPropertyPriority('user-select'), 'important')
  assert.equal(document.body.style.getPropertyPriority('cursor'), 'important')
  const ratio = view.state.splitRatio
  view.move(800)
  assert.equal(view.frames.size, 0)
  assert.equal(view.state.splitRatio, ratio)
}

for (const reason of ['unmount', 'close', 'blur', 'narrow']) {
  test(`拖拽中${reason}会撤销待执行动画、全局事件并恢复原有光标样式`, async (context) => {
    const view = await mountDivider(context)
    const removed = context.mock.method(document, 'removeEventListener')
    const removedWindow = context.mock.method(window, 'removeEventListener')
    view.start()
    view.move(300)
    assert.equal(view.frames.size, 1)
    if (reason === 'unmount') view.unmount()
    if (reason === 'close') {
      view.state.showPreview = false
      await nextTick()
    }
    if (reason === 'blur') window.dispatchEvent(new dom.window.Event('blur'))
    if (reason === 'narrow') {
      const oldWidth = window.innerWidth
      try {
        window.innerWidth = 600
        window.dispatchEvent(new dom.window.Event('resize'))
      } finally {
        window.innerWidth = oldWidth
      }
    }
    assertDividerReleased(view)
    for (const type of ['mousemove', 'mouseup'])
      assert.equal(removed.mock.calls.filter((call) => call.arguments[0] === type).length, 1)
    assert.equal(removedWindow.mock.calls.filter((call) => call.arguments[0] === 'blur').length, 1)
  })
}

test('正常拖拽一帧内使用最后鼠标位置，鼠标释放后恢复原有样式', async (context) => {
  const view = await mountDivider(context)
  view.start()
  view.move(200)
  view.move(250)
  assert.equal(view.frames.size, 1)
  view.flush()
  assert.ok(Math.abs(view.state.splitRatio - 0.7) < 1e-9)
  view.move(900)
  view.flush()
  assert.equal(view.state.splitRatio, 0.75)
  view.move(-900)
  view.flush()
  assert.equal(view.state.splitRatio, 0.25)
  view.end()
  assertDividerReleased(view)
})

test('重复开始拖拽先清理上一次任务，重复结束也不会覆盖恢复的样式', async (context) => {
  const view = await mountDivider(context)
  view.start()
  view.move(200)
  const previousCallback = [...view.frames.values()][0]
  view.start()
  assert.equal(view.frames.size, 0)
  previousCallback()
  assert.equal(view.state.splitRatio, 0.55)
  view.move(300)
  assert.equal(view.frames.size, 1)
  view.end()
  assertDividerReleased(view)
  view.end()
  view.unmount()
  assertDividerReleased(view)
})

test('原本没有内联光标和选字样式时，拖拽结束不会额外留下样式', async (context) => {
  const view = await mountDivider(context)
  document.body.style.removeProperty('user-select')
  document.body.style.removeProperty('cursor')
  view.start()
  view.move(300)
  view.end()
  assert.equal(view.state.dragging, false)
  assert.equal(view.frames.size, 0)
  assert.equal(document.body.style.userSelect, '')
  assert.equal(document.body.style.cursor, '')
  view.move(800)
  assert.equal(view.frames.size, 0)
})

for (const options of [{ layout: false }, { width: 0 }, { width: Infinity }, { button: 2 }]) {
  test(`无效拖拽不改变状态或注册事件：${JSON.stringify(options)}`, async (context) => {
    const view = await mountDivider(context, options)
    const added = context.mock.method(document, 'addEventListener')
    view.start(options.button)
    assertDividerReleased(view)
    assert.equal(
      added.mock.calls.filter((call) => ['mousemove', 'mouseup'].includes(call.arguments[0]))
        .length,
      0,
    )
  })
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
  let nextSavedId = 101
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
    updateConvTitle: async (id, title) => ({ conversation_id: id, title, saved: true }),
    saveMessages: async (...args) => {
      writes.push(args)
      const receipt = savedPairReceipt(nextSavedId)
      nextSavedId += 2
      return receipt
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
function savedPairReceipt(firstId = 101) {
  return { ok: true, messages: [savedBubble(firstId, 'user'), savedBubble(firstId + 1)] }
}

function startConfirmedOperation(view, kind) {
  view.state.currentConvId = 'A'
  view.state.messages = [savedBubble(1, 'user', '原问题'), savedBubble(2)]
  if (kind === 'conversation') return view.state.handleDeleteConv('A')
  if (kind === 'message') return view.state.deleteMessage(0)
  view.state.editMessage(0)
  view.state.editingText = '待确认的修改'
  view.state.editSession.conflict = true
  return view.state.saveEdit()
}

async function mountConfirmation() {
  const mutations = []
  const view = await mount({
    deleteConversation: async (id) => mutations.push(['conversation', id]),
    deleteSavedMessage: async (_cid, id) => {
      mutations.push(['message', id])
      return { message_id: id, conversation_deleted: false }
    },
    editSavedMessage: async (_cid, id, _rev, content) => {
      mutations.push(['edit', id])
      return editAck(id, content)
    },
  })
  return { ...view, mutations }
}

for (const kind of ['conversation', 'message', 'edit']) {
  for (const accepted of [false, true]) {
    test(`${kind} 确认${accepted ? '点击后立即' : '等待期间'}卸载，不遗留等待或迟到写入`, async () => {
      const view = await mountConfirmation()
      let closed = false
      let settled = false
      const pending = startConfirmedOperation(view, kind).then(() => {
        settled = true
      })
      try {
        assert.equal(view.state.confirmState.visible, true)
        if (accepted) view.state.resolveConfirm(true)
        view.close()
        closed = true
        await new Promise(setImmediate)
        assert.equal(settled, true)
        assert.equal(view.state.confirmState.visible, false)
        assert.deepEqual(view.mutations, [])
        assert.equal(view.state.pendingMessageEdits.size, 0)
        assert.equal(view.state.pendingMessageDeletions.size, 0)
        assert.equal(view.state.messages[0].content, '原问题')
        if (kind === 'edit') {
          assert.equal(view.state.editingText, '待确认的修改')
          assert.equal(view.state.editSession.saving, false)
        }
      } finally {
        view.state.resolveConfirm(false)
        await pending
        if (!closed) view.close()
      }
    })
  }

  test(`已有确认框时 ${kind} 操作不替换原提示、不提交修改或占住操作锁`, async () => {
    const view = await mountConfirmation()
    const first = view.state.showConfirm('保留原确认提示')
    try {
      await startConfirmedOperation(view, kind)
      assert.equal(view.state.confirmState.visible, true)
      assert.equal(view.state.confirmState.message, '保留原确认提示')
      assert.deepEqual(view.mutations, [])
      assert.equal(view.state.pendingMessageEdits.size, 0)
      assert.equal(view.state.pendingMessageDeletions.size, 0)
    } finally {
      view.state.resolveConfirm(false)
      await first
      view.close()
    }
  })

  test(`${kind} 已确认并发出请求后卸载，不自动重试或假定撤回服务端操作`, async () => {
    const view = await mountConfirmation()
    const entered = deferred()
    const gate = deferred()
    const apiName = {
      conversation: 'deleteConversation',
      message: 'deleteSavedMessage',
      edit: 'editSavedMessage',
    }[kind]
    const original = globalThis.__sendingTestApi[apiName]
    let calls = 0
    globalThis.__sendingTestApi[apiName] = async (...args) => {
      calls++
      entered.resolve()
      await gate.promise
      return original(...args)
    }
    let closed = false
    const pending = startConfirmedOperation(view, kind)
    try {
      view.state.resolveConfirm(true)
      await entered.promise
      view.close()
      closed = true
      gate.resolve()
      await pending
      assert.equal(calls, 1)
      assert.equal(view.mutations.length, 1)
      assert.equal(view.state.confirmState.visible, false)
      assert.equal(view.notices.length, 0)
    } finally {
      gate.resolve()
      view.state.resolveConfirm(false)
      await pending
      if (!closed) view.close()
    }
  })
}

test('重复请求确认只保留当前弹窗，新请求取消而不覆盖原等待者', async () => {
  const view = await mountConfirmation()
  const results = []
  const first = view.state
    .showConfirm('原提示', { okText: '删除', cancelText: '取消' })
    .then((result) => results.push(['first', result]))
  const firstResolve = view.state.confirmResolve
  const second = view.state
    .showConfirm('不应显示的新提示')
    .then((result) => results.push(['second', result]))
  try {
    await new Promise(setImmediate)
    assert.deepEqual(results, [['second', false]])
    assert.equal(view.state.confirmState.message, '原提示')
    assert.equal(view.state.confirmState.okText, '删除')
    view.state.resolveConfirm(true)
    await first
    assert.deepEqual(results, [
      ['second', false],
      ['first', true],
    ])
  } finally {
    firstResolve(false)
    view.state.resolveConfirm(false)
    await Promise.all([first, second])
    view.close()
  }
})

test('确认框卸载后拒绝新请求和迟到确认，不重新显示弹窗或产生写入', async () => {
  const view = await mountConfirmation()
  view.close()
  let result
  const pending = view.state.showConfirm('卸载后不能再弹出').then((value) => {
    result = value
  })
  try {
    await new Promise(setImmediate)
    assert.equal(result, false)
    assert.equal(view.state.confirmState.visible, false)
    view.state.resolveConfirm(true)
    await startConfirmedOperation(view, 'conversation')
    assert.deepEqual(view.mutations, [])
  } finally {
    view.state.resolveConfirm(false)
    await pending
  }
})

test('正常确认只结算一次，后续独立确认仍可取消且不停止生成控制器', async () => {
  const view = await mountConfirmation()
  const controller = new AbortController()
  view.state.abortControllers.A = controller
  try {
    const first = view.state.showConfirm('第一次')
    view.state.resolveConfirm(true)
    view.state.resolveConfirm(false)
    assert.equal(await first, true)
    const second = view.state.showConfirm('第二次')
    view.state.resolveConfirm(false)
    assert.equal(await second, false)
    assert.equal(view.state.confirmState.visible, false)
    assert.equal(controller.signal.aborted, false)
  } finally {
    view.close()
  }
})

const editAck = (id, content) => ({
  message_id: id,
  content,
  revision: 'b'.repeat(64),
  saved: true,
})

function chatRegenerationDone(content = '新的完整回复') {
  return {
    saved: true,
    message_id: 2,
    revision: 'b'.repeat(64),
    source_message_id: 1,
    source_revision: messageRevision,
    query: '原问题',
    chat_reply: content,
    thinking_chain: [{ type: 'tool', label: '新工具' }],
  }
}

function seedChatRegeneration(state) {
  state.currentConvId = 'A'
  state.messages = [
    savedBubble(1, 'user', '原问题'),
    { ...savedBubble(2), thinkingChain: [{ type: 'tool', label: '旧工具' }] },
    savedBubble(3, 'user', '后续问题'),
    savedBubble(4, 'assistant', '后续回复'),
  ]
}

for (const regeneration of [false, true]) {
  test(`${regeneration ? '咨询重生成' : '首次生成'}卸载后清空逐字队列，迟到正文不重开动画但仍可完成保存`, async (context) => {
    const gate = deferred()
    const entered = deferred()
    let callbacks
    let signal
    const text = '已收到的较长正文'.repeat(60)
    const stream = async (...args) => {
      callbacks = args.at(-1)
      signal = args.at(-2)
      callbacks.onToken(text)
      entered.resolve()
      await gate.promise
      await callbacks.onDone(regeneration ? chatRegenerationDone(text + '后续片段') : {})
    }
    const view = await mount({
      chatStream: stream,
      regenerateChatStream: stream,
    })
    context.mock.timers.enable({ apis: ['setInterval'] })
    const intervals = context.mock.method(globalThis, 'setInterval')
    const cleared = context.mock.method(globalThis, 'clearInterval')
    let closed = false
    let pending
    try {
      if (regeneration) {
        seedChatRegeneration(view.state)
        pending = view.state.regenerateMessage(1)
      } else {
        view.state.currentConvId = 'A'
        view.state.input = '问题'
        pending = view.state.sendText()
      }
      await entered.promise
      const assistant = view.state.messages[1]
      const animated = regeneration ? assistant.regenerationDraft : assistant
      assert.equal(animated.fullContent, text)
      assert.notEqual(animated.content, text)
      assert.equal(intervals.mock.callCount(), 1)
      view.close()
      closed = true
      assert.equal(animated.content, text)
      assert.equal(cleared.mock.callCount(), 1)
      if (regeneration) assert.equal(assistant.content, '原回复')
      callbacks.onToken('后续片段')
      assert.equal(animated.content, text + '后续片段')
      assert.equal(intervals.mock.callCount(), 1)
      context.mock.timers.tick(1000)
      assert.equal(animated.content, text + '后续片段')
      assert.equal(signal.aborted, false)
      gate.resolve()
      await pending
      assert.equal(assistant.content, text + '后续片段')
      assert.equal(view.writes.length, regeneration ? 0 : 1)
      if (!regeneration) assert.equal(view.writes[0][2], text + '后续片段')
      assert.equal(view.state.loadingConvIds.size, 0)
      assert.deepEqual(view.state.abortControllers, {})
      assert.equal(view.notices.length, 0)
    } finally {
      gate.resolve()
      await pending
      if (!closed) view.close()
    }
  })
}

test('切换会话后下一帧补齐后台剩余逐字内容并停掉所属动画，不误停生成', async (context) => {
  const gate = deferred()
  const entered = deferred()
  let signal
  const text = '后台完整正文'.repeat(80)
  const view = await mount({
    chatStream: async (_query, _history, ownedSignal, callbacks) => {
      signal = ownedSignal
      callbacks.onToken(text)
      entered.resolve()
      await gate.promise
      await callbacks.onDone({})
    },
  })
  context.mock.timers.enable({ apis: ['setInterval'] })
  const cleared = context.mock.method(globalThis, 'clearInterval')
  let pending
  try {
    view.state.currentConvId = 'A'
    view.state.input = '问题'
    pending = view.state.sendText()
    await entered.promise
    const assistant = view.state.messages[1]
    await view.state.loadConversation('B')
    context.mock.timers.tick(30)
    assert.equal(assistant.content, text)
    assert.equal(cleared.mock.callCount(), 1)
    assert.equal(signal.aborted, false)
    assert.equal(view.state.messages[1].content, 'B原回复')
    gate.resolve()
    await pending
    assert.equal(view.writes.length, 1)
    assert.equal(view.writes[0][0], 'A')
    assert.equal(view.writes[0][2], text)
  } finally {
    gate.resolve()
    await pending
    view.close()
  }
})

test('普通重生成只替换目标，流式预览不先删问答且保留草稿和待发附件', async () => {
  const gate = deferred()
  const entered = deferred()
  let calls = 0
  const view = await mount({
    regenerateChatStream: async (cid, id, version, _signal, callbacks) => {
      calls++
      assert.deepEqual([cid, id, version], ['A', 2, messageRevision])
      callbacks.onThinking('新工具')
      callbacks.onToken('生成中的预览')
      entered.resolve()
      await gate.promise
      callbacks.onDone(chatRegenerationDone())
    },
    saveMessages: () => assert.fail('不能追加问答'),
    chatStream: () => assert.fail('不能当作新问题发送'),
    analyzeContractStream: () => assert.fail('不能误传待发附件'),
  })
  try {
    seedChatRegeneration(view.state)
    view.state.input = '另一个待发问题'
    const file = new File(['合同'], '待发合同.txt')
    view.state.pendingFile = file
    const running = view.state.regenerateMessage(1)
    await entered.promise
    for (let index = 0; index < 20; index++) view.state.regenerateMessage(1)
    assert.equal(calls, 1)
    assert.equal(view.state.messages.length, 4)
    assert.equal(view.state.messages[1].content, '原回复')
    assert.equal(view.state.messages[1].regenerationDraft.fullContent, '生成中的预览')
    gate.resolve()
    await running
    assert.equal(view.state.messages[1].content, '新的完整回复')
    assert.equal(view.state.messages[1].id, 2)
    assert.equal(view.state.messages[2].content, '后续问题')
    assert.equal(view.state.messages[3].content, '后续回复')
    assert.equal(view.state.input, '另一个待发问题')
    assert.equal(view.state.pendingFile, file)
    assert.equal(view.state.messages[1].regenerationDraft, undefined)
    assert.equal(view.state.loadingConvIds.size, 0)
  } finally {
    gate.resolve()
    view.close()
  }
})

for (const failure of ['error', 'eof', 'abort', 'unconfirmed']) {
  test(`普通重生成 ${failure} 时恢复旧回复和旧过程，不保存部分预览`, async () => {
    const view = await mount({
      regenerateChatStream: async (_cid, _id, _rev, signal, callbacks) => {
        callbacks.onThinking('新工具')
        callbacks.onToken('部分预览')
        if (failure === 'error') callbacks.onError('服务暂不可用。')
        if (failure === 'abort') {
          view.state.stopGeneration()
          assert.equal(signal.aborted, true)
          callbacks.onDone({ aborted: true })
        }
        if (failure === 'unconfirmed') callbacks.onDone({ chat_reply: '未确认的新回复' })
      },
    })
    try {
      seedChatRegeneration(view.state)
      const before = view.state.messages.map((message) => JSON.parse(JSON.stringify(message)))
      await view.state.regenerateMessage(1)
      assert.equal(view.state.messages[1].content, before[1].content)
      assert.deepEqual(view.state.messages[1].thinkingChain, before[1].thinkingChain)
      assert.equal(view.state.messages[1].regenerationDraft, undefined)
      assert.equal(view.state.messages.length, 4)
      assert.equal(view.state.streamMessageCache.A, undefined)
      assert.equal(view.state.loadingConvIds.size, 0)
      assert.equal(view.writes.length, 0)
      assert.match(view.notices.at(-1).options.message, /原回复|重新生成/)
    } finally {
      view.close()
    }
  })
}

test('普通重生成首个等待前切换会话，预览和保存结果不串入新页面', async () => {
  const gate = deferred()
  const entered = deferred()
  const view = await mount({
    regenerateChatStream: async (_cid, _id, _rev, _signal, callbacks) => {
      entered.resolve()
      await gate.promise
      callbacks.onToken('A预览')
      callbacks.onDone(chatRegenerationDone('A新回复'))
    },
  })
  try {
    seedChatRegeneration(view.state)
    const owned = view.state.messages
    const running = view.state.regenerateMessage(1)
    await view.state.loadConversation('B')
    await entered.promise
    view.state.input = 'B草稿'
    gate.resolve()
    await running
    assert.equal(owned[1].content, 'A新回复')
    assert.equal(view.state.currentConvId, 'B')
    assert.equal(view.state.messages[1].content, 'B原回复')
    assert.equal(view.state.input, 'B草稿')
    assert.equal(view.state.thinkingSteps.length, 0)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('后台普通重生成不阻塞另一会话发送，旧收尾不清理新请求', async () => {
  const gate = deferred()
  const entered = deferred()
  const view = await mount({
    regenerateChatStream: async (_cid, _id, _rev, signal, callbacks) => {
      entered.resolve()
      await gate.promise
      assert.equal(signal.aborted, false)
      callbacks.onDone(chatRegenerationDone())
    },
  })
  try {
    seedChatRegeneration(view.state)
    const running = view.state.regenerateMessage(1)
    await entered.promise
    await view.state.loadConversation('B')
    view.state.input = 'B问题'
    await view.state.sendText()
    gate.resolve()
    await running
    assert.equal(view.state.messages.at(-1).content, 'B问题回复')
    assert.equal(view.writes.length, 1)
    assert.equal(view.writes[0][0], 'B')
  } finally {
    gate.resolve()
    view.close()
  }
})

for (const role of ['assistant', 'user']) {
  test(`删除普通重生成中的 ${role} 只停止所属重跑并删除所点气泡`, async () => {
    const entered = deferred()
    const deletes = []
    const view = await mount({
      regenerateChatStream: async (_cid, _id, _rev, signal, callbacks) => {
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
      seedChatRegeneration(view.state)
      const running = view.state.regenerateMessage(1)
      await entered.promise
      const deleting = view.state.deleteMessage(role === 'assistant' ? 1 : 0)
      view.state.resolveConfirm(true)
      await Promise.all([running, deleting])
      assert.equal(deletes.length, 1)
      assert.equal(deletes[0][1], role === 'assistant' ? 2 : 1)
      assert.equal(view.state.messages.length, 3)
      assert.equal(view.state.messages[0].content, role === 'assistant' ? '原问题' : '原回复')
      assert.equal(view.notices.length, 0)
    } finally {
      view.close()
    }
  })
}

test('删除整个会话后，普通重生成迟到的正文或完成不恢复缓存', async () => {
  const gate = deferred()
  const entered = deferred()
  const view = await mount({
    deleteConversation: async () => {},
    regenerateChatStream: async (_cid, _id, _rev, _signal, callbacks) => {
      entered.resolve()
      await gate.promise
      callbacks.onToken('不能复活')
      callbacks.onDone(chatRegenerationDone())
    },
  })
  try {
    seedChatRegeneration(view.state)
    const running = view.state.regenerateMessage(1)
    await entered.promise
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(true)
    await deleting
    gate.resolve()
    await running
    assert.equal(view.state.messages.length, 0)
    assert.equal(view.state.streamMessageCache.A, undefined)
    assert.equal(view.state.loadingConvIds.size, 0)
    assert.equal(view.notices.length, 0)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('缺少对应问题时不删旧回复，不创建新请求', async () => {
  const view = await mount({ regenerateChatStream: () => assert.fail('不能重跑') })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(2)]
    await view.state.regenerateMessage(0)
    assert.equal(view.state.messages.length, 1)
    assert.match(view.notices[0].options.message, /缺少对应问题/)
  } finally {
    view.close()
  }
})
const editConflict = () =>
  Object.assign(new Error('message_changed'), {
    response: { status: 409, data: { code: 'message_changed' } },
  })

test('编辑保存仅更新目标，服务端确认前不改正文，不重建历史或调用模型', async () => {
  const gate = deferred()
  const calls = []
  const view = await mount({
    editSavedMessage: async (...args) => {
      calls.push(args)
      return gate.promise
    },
    chatStream: () => assert.fail('不能重新生成'),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '原问题'), savedBubble(2)]
    view.state.editMessage(0)
    view.state.editingText = '  修正\n问题  '
    const saving = view.state.saveEdit()
    assert.equal(view.state.messages[0].content, '原问题')
    assert.equal(view.state.editSession.saving, true)
    for (let index = 0; index < 50; index++) view.state.saveEdit()
    assert.deepEqual(calls, [['A', 1, messageRevision, '  修正\n问题  ']])
    gate.resolve(editAck(1, '  修正\n问题  '))
    await saving
    assert.equal(view.state.messages[0].content, '  修正\n问题  ')
    assert.equal(view.state.messages[1].id, 2)
    assert.equal(view.state.editingIndex, -1)
    assert.equal(view.state.pendingMessageEdits.size, 0)
  } finally {
    gate.resolve(editAck(1, '  修正\n问题  '))
    view.close()
  }
})

test('保存等待时切换会话，迟到结果不清空另一会话的编辑文字', async () => {
  const gate = deferred()
  const view = await mount({ editSavedMessage: () => gate.promise })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', 'A问题')]
    const owned = view.state.messages
    view.state.editMessage(0)
    view.state.editingText = 'A修正'
    const saving = view.state.saveEdit()
    await view.state.loadConversation('B')
    assert.equal(view.state.editingIndex, -1)
    view.state.editMessage(0)
    view.state.editingText = 'B未保存的修改'
    gate.resolve(editAck(1, 'A修正'))
    await saving
    assert.equal(owned[0].content, 'A修正')
    assert.equal(view.state.messages[0].content, 'B原问题')
    assert.equal(view.state.editingText, 'B未保存的修改')
    assert.equal(view.state.editingIndex, 0)
  } finally {
    gate.resolve(editAck(1, 'A修正'))
    view.close()
  }
})

test('保存失败保留原消息与编辑稿，切走再回来仍可继续编辑', async () => {
  const initial = [savedBubble(1, 'user', '原问题'), savedBubble(2)]
  const view = await mount({
    editSavedMessage: async () => {
      throw new Error('私有异常不能公开')
    },
    getConversation: async (id) => ({ id, messages: structuredClone(initial) }),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = structuredClone(initial)
    view.state.editMessage(0)
    view.state.editingText = '保留编辑稿'
    await view.state.saveEdit()
    assert.equal(view.state.messages[0].content, '原问题')
    assert.equal(view.state.editingText, '保留编辑稿')
    assert.match(view.notices.at(-1).options.message, /编辑文字已保留/)
    await view.state.loadConversation('B')
    await view.state.loadConversation('A')
    assert.equal(view.state.editingIndex, 0)
    assert.equal(view.state.editingText, '保留编辑稿')
    view.state.cancelEdit()
    assert.equal(view.state.editingIndex, -1)
    assert.equal(view.state.messageEditDrafts.size, 0)
  } finally {
    view.close()
  }
})

test('编辑目标按稳定身份定位，下标移动不会保存到其他问题', async () => {
  const calls = []
  const view = await mount({
    editSavedMessage: async (...args) => {
      calls.push(args)
      return editAck(args[1], args[3])
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '原问题')]
    view.state.editMessage(0)
    view.state.messages.unshift(savedBubble(2, 'user', '前面插入的问题'))
    assert.equal(view.state.editingIndex, 1)
    view.state.editingText = '只改原问题'
    await view.state.saveEdit(0)
    assert.equal(calls[0][1], 1)
    assert.equal(view.state.messages[0].content, '前面插入的问题')
    assert.equal(view.state.messages[1].content, '只改原问题')
  } finally {
    view.close()
  }
})

test('不相交的冲突自动读取最新消息并合并，不弹覆盖确认或刷新页面', async () => {
  const calls = []
  const view = await mount({
    editSavedMessage: async (...args) => {
      calls.push(args)
      if (calls.length === 1) throw editConflict()
      return editAck(args[1], args[3])
    },
    getConversation: async (id) => ({
      id,
      messages: [{ ...savedBubble(1, 'user', '租金1500元'), revision: 'b'.repeat(64) }],
    }),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '租金1000元')]
    view.state.editMessage(0)
    view.state.editingText = '租金1000元。'
    await view.state.saveEdit()
    assert.equal(calls.length, 2)
    assert.equal(calls[1][2], 'b'.repeat(64))
    assert.equal(calls[1][3], '租金1500元。')
    assert.equal(view.state.messages[0].content, '租金1500元。')
    assert.equal(view.state.confirmState.visible, false)
  } finally {
    view.close()
  }
})

for (const overwrite of [true, false]) {
  test(`重叠修改先保留草稿，用户${overwrite ? '确认' : '取消'}后才决定覆盖`, async () => {
    const calls = []
    const view = await mount({
      editSavedMessage: async (...args) => {
        calls.push(args)
        if (calls.length === 1) throw editConflict()
        return editAck(args[1], args[3])
      },
      getConversation: async (id) => ({
        id,
        messages: [{ ...savedBubble(1, 'user', '租金1500元'), revision: 'b'.repeat(64) }],
      }),
    })
    try {
      view.state.currentConvId = 'A'
      view.state.messages = [savedBubble(1, 'user', '租金1000元')]
      view.state.editMessage(0)
      view.state.editingText = '租金1200元'
      await view.state.saveEdit()
      assert.equal(calls.length, 1)
      assert.equal(view.state.editingText, '租金1200元')
      assert.equal(view.state.messages[0].content, '租金1500元')
      assert.match(view.notices.at(-1).options.message, /无法安全合并/)
      const saving = view.state.saveEdit()
      assert.equal(view.state.confirmState.visible, true)
      assert.match(view.state.confirmState.message, /租金1500元/)
      view.state.resolveConfirm(overwrite)
      await saving
      assert.equal(calls.length, overwrite ? 2 : 1)
      assert.equal(view.state.messages[0].content, overwrite ? '租金1200元' : '租金1500元')
      if (!overwrite) assert.equal(view.state.editingText, '租金1200元')
    } finally {
      view.close()
    }
  })
}

test('正在生成的新问题等待原保存后再定点编辑，原模型输入与回复不变', async () => {
  const entered = deferred()
  const gate = deferred()
  const calls = []
  let signal
  const view = await mount({
    chatStream: async (query, _history, ownedSignal, callbacks) => {
      assert.equal(query, '原问题')
      signal = ownedSignal
      entered.resolve()
      await gate.promise
      await callbacks.onDone({ chat_reply: '完整原回复' })
    },
    saveMessages: async (...args) => {
      view.writes.push(args)
      return savedPairReceipt()
    },
    editSavedMessage: async (...args) => {
      calls.push(args)
      return editAck(args[1], args[3])
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.input = '原问题'
    const sending = view.state.sendText()
    await entered.promise
    view.state.editMessage(0)
    view.state.editingText = '修正问题'
    const saving = view.state.saveEdit()
    assert.equal(calls.length, 0)
    assert.equal(signal.aborted, false)
    gate.resolve()
    await Promise.all([saving, sending])
    assert.equal(view.writes[0][1], '原问题')
    assert.equal(calls[0][1], 101)
    assert.equal(view.state.messages[0].content, '修正问题')
    assert.equal(view.state.messages[1].content, '完整原回复')
    assert.equal(view.state.loadingConvIds.size, 0)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('等待生成期间取消编辑不停止生成，也不会在完成后偷偷保存修改', async () => {
  const entered = deferred()
  const gate = deferred()
  const view = await mount({
    chatStream: async (_query, _history, signal, callbacks) => {
      entered.resolve()
      await gate.promise
      assert.equal(signal.aborted, false)
      await callbacks.onDone({ chat_reply: '回复' })
    },
    saveMessages: async () => savedPairReceipt(),
    editSavedMessage: () => assert.fail('取消后不能保存编辑'),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.input = '原问题'
    const sending = view.state.sendText()
    await entered.promise
    view.state.editMessage(0)
    view.state.editingText = '取消的修改'
    const saving = view.state.saveEdit()
    view.state.cancelEdit()
    assert.equal(view.state.pendingMessageEdits.size, 0)
    gate.resolve()
    await Promise.all([sending, saving])
    assert.equal(view.state.messages[0].content, '原问题')
    assert.equal(view.state.editingIndex, -1)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('编辑旧问题不停止同会话的新生成，其他消息保存仍正常', async () => {
  const entered = deferred()
  const gate = deferred()
  let signal
  const view = await mount({
    chatStream: async (_query, _history, ownedSignal, callbacks) => {
      signal = ownedSignal
      entered.resolve()
      await gate.promise
      await callbacks.onDone({ chat_reply: '新回复' })
    },
    editSavedMessage: async (_cid, id, _revision, content) => editAck(id, content),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '旧问题'), savedBubble(2)]
    view.state.input = '新问题'
    const sending = view.state.sendText()
    await entered.promise
    view.state.editMessage(0)
    view.state.editingText = '修正旧问题'
    await view.state.saveEdit()
    assert.equal(signal.aborted, false)
    assert.equal(view.state.messages[0].content, '修正旧问题')
    gate.resolve()
    await sending
    assert.equal(view.state.messages.length, 4)
    assert.equal(view.writes[0][1], '新问题')
  } finally {
    gate.resolve()
    view.close()
  }
})

test('保存中的会话阻止本地重复写入，但另一会话仍能发送', async () => {
  const gate = deferred()
  const view = await mount({ editSavedMessage: () => gate.promise })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '原问题')]
    view.state.editMessage(0)
    view.state.editingText = '修正'
    const saving = view.state.saveEdit()
    view.state.input = '不能并写'
    view.state.handleSend()
    assert.equal(view.streams.length, 0)
    assert.equal(view.state.canSend, false)
    await view.state.loadConversation('B')
    view.state.input = 'B问题'
    await view.state.sendText()
    assert.equal(view.streams.length, 1)
    gate.resolve(editAck(1, '修正'))
    await saving
    assert.equal(view.state.currentConvId, 'B')
    assert.equal(view.state.messages.at(-1).content, 'B问题回复')
  } finally {
    gate.resolve(editAck(1, '修正'))
    view.close()
  }
})

test('编辑保存期间拒绝同会话的删除与重新生成，避免整段改写竞争', async () => {
  const gate = deferred()
  const view = await mount({
    editSavedMessage: () => gate.promise,
    deleteSavedMessage: () => assert.fail('不能与编辑同时删除'),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '原问题'), savedBubble(2)]
    view.state.editMessage(0)
    view.state.editingText = '修正'
    const saving = view.state.saveEdit()
    await view.state.regenerateMessage(1)
    await view.state.deleteMessage(0)
    assert.equal(view.state.messages.length, 2)
    assert.equal(view.state.confirmState.visible, false)
    gate.resolve(editAck(1, '修正'))
    await saving
  } finally {
    gate.resolve(editAck(1, '修正'))
    view.close()
  }
})

test('旧历史响应晚于编辑保存返回，不把已保存正文改回去', async () => {
  const historyGate = deferred()
  const patchGate = deferred()
  const view = await mount({
    editSavedMessage: () => patchGate.promise,
    getConversation: () => historyGate.promise,
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '原问题')]
    view.state.editMessage(0)
    view.state.editingText = '已保存修改'
    const saving = view.state.saveEdit()
    const loading = view.state.loadConversation('A')
    patchGate.resolve(editAck(1, '已保存修改'))
    await saving
    historyGate.resolve({ id: 'A', messages: [savedBubble(1, 'user', '原问题')] })
    await loading
    assert.equal(view.state.messages[0].content, '已保存修改')
    assert.equal(view.state.messages[0].revision, 'b'.repeat(64))
  } finally {
    patchGate.resolve(editAck(1, '已保存修改'))
    historyGate.resolve({ id: 'A', messages: [] })
    view.close()
  }
})

test('整会话删除后迟到的编辑结果不会恢复消息或产生无关提示', async () => {
  const gate = deferred()
  const view = await mount({
    editSavedMessage: () => gate.promise,
    deleteConversation: async () => {},
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(1, 'user', '原问题')]
    view.state.editMessage(0)
    view.state.editingText = '不应恢复'
    const saving = view.state.saveEdit()
    const deleting = view.state.handleDeleteConv('A')
    view.state.resolveConfirm(true)
    await deleting
    gate.resolve(editAck(1, '不应恢复'))
    await saving
    assert.equal(view.state.messages.length, 0)
    assert.equal(view.state.currentConvId, null)
    assert.equal(view.state.messageEditDrafts.size, 0)
    assert.equal(view.notices.length, 0)
  } finally {
    gate.resolve(editAck(1, '不应恢复'))
    view.close()
  }
})

test('新消息编辑稿取得身份后可跨页恢复，目标删除后按身份清理', async () => {
  const gate = deferred()
  const entered = deferred()
  const view = await mount({
    chatStream: async (_query, _history, _signal, callbacks) => {
      entered.resolve()
      await gate.promise
      await callbacks.onDone({ chat_reply: '回复' })
    },
    saveMessages: async () => savedPairReceipt(),
    getConversation: async (id) => ({
      id,
      messages: [savedBubble(101, 'user', '原问题'), savedBubble(102)],
    }),
    deleteSavedMessage: async (_cid, id) => ({ message_id: id, conversation_deleted: false }),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.input = '原问题'
    const sending = view.state.sendText()
    await entered.promise
    view.state.editMessage(0)
    view.state.editingText = '还未点击保存的修改'
    await view.state.newChat()
    gate.resolve()
    await sending
    await view.state.loadConversation('A')
    assert.equal(view.state.editingIndex, 0)
    assert.equal(view.state.editingText, '还未点击保存的修改')
    const deleting = view.state.deleteMessage(0)
    view.state.resolveConfirm(true)
    await deleting
    assert.equal(view.state.editingIndex, -1)
    assert.equal(view.state.messageEditDrafts.size, 0)
  } finally {
    gate.resolve()
    view.close()
  }
})

test('创建失败后原草稿保留，等待保存的编辑文字进入既有草稿恢复队列', async () => {
  const gate = deferred()
  const entered = deferred()
  const view = await mount({
    createConversation: async () => {
      entered.resolve()
      return gate.promise
    },
    editSavedMessage: () => assert.fail('未创建成功不能保存修改'),
  })
  try {
    view.state.input = '原问题'
    const sending = view.state.sendText()
    await entered.promise
    view.state.editMessage(0)
    view.state.editingText = '恢复这份编辑'
    const saving = view.state.saveEdit()
    gate.reject(new Error('创建失败'))
    await Promise.all([sending, saving])
    assert.equal(view.state.input, '原问题')
    assert.equal(view.state.messages.length, 0)
    view.state.input = ''
    await view.state.newChat()
    assert.equal(view.state.input, '恢复这份编辑')
  } finally {
    gate.resolve({ id: 'unused' })
    view.close()
  }
})

test('单条删除固定确认时的会话和消息，切换页面及下标变化不误删', async () => {
  const deletes = []
  const view = await mount({
    deleteSavedMessage: async (...args) => {
      deletes.push(args)
      return { message_id: args[1], conversation_deleted: false }
    },
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

test('未确认保存的消息与服务器记录不能安全对齐时不尝试删除', async () => {
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
        return savedPairReceipt()
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
      return savedPairReceipt(convId === 'A' ? 101 : 201)
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

test('重命名保存失败保留原标题和编辑草稿，不伪装成功', async () => {
  const view = await mount({
    updateConvTitle: async () => {
      throw new Error('sk-private save failure')
    },
    getConversation: async (id) => ({ id, title: '原标题', messages: [] }),
  })
  try {
    view.state.conversations = [{ id: 'A', title: '原标题' }]
    await view.state.startRename('A')
    view.state.renameText = '待保存草稿'
    await view.state.finishRename('A')
    assert.equal(view.state.conversations[0].title, '原标题')
    assert.equal(view.state.renamingConvId, 'A')
    assert.equal(view.state.renameText, '待保存草稿')
    assert.match(view.notices.at(-1).options.message, /草稿.*保留|保留.*草稿/)
  } finally {
    view.close()
  }
})

test('重命名 A 的迟到保存不关闭 B 编辑器或清空 B 草稿', async () => {
  const gate = deferred()
  const view = await mount({
    updateConvTitle: async (id, title) => {
      await gate.promise
      return { conversation_id: id, title, saved: true }
    },
  })
  let pending
  try {
    view.state.conversations = [
      { id: 'A', title: 'A原标题' },
      { id: 'B', title: 'B原标题' },
    ]
    await view.state.startRename('A')
    view.state.renameText = 'A新标题'
    pending = view.state.finishRename('A')
    await view.state.startRename('B')
    view.state.renameText = 'B编辑草稿'
    gate.resolve()
    await pending
    assert.equal(view.state.conversations[0].title, 'A新标题')
    assert.equal(view.state.renamingConvId, 'B')
    assert.equal(view.state.renameText, 'B编辑草稿')
  } finally {
    gate.resolve()
    await pending
    view.close()
  }
})

test('重命名回车和失焦重复触发只发送一次，空白及未修改标题不发送', async () => {
  let calls = 0
  const gate = deferred()
  const view = await mount({
    updateConvTitle: async (id, title) => {
      calls++
      await gate.promise
      return { conversation_id: id, title, saved: true }
    },
  })
  const pending = []
  try {
    view.state.conversations = [{ id: 'A', title: '原标题' }]
    await view.state.startRename('A')
    view.state.renameText = '新标题'
    for (let attempt = 0; attempt < 10; attempt++) pending.push(view.state.finishRename('A'))
    assert.equal(calls, 1)
    gate.resolve()
    await Promise.all(pending)
    await view.state.startRename('A')
    await view.state.finishRename('A')
    await view.state.startRename('A')
    view.state.renameText = '   '
    await view.state.finishRename('A')
    assert.equal(calls, 1)
  } finally {
    gate.resolve()
    await Promise.all(pending)
    view.close()
  }
})

test('中文输入法确认和旧输入框事件不会误保存后来新开的重命名草稿', async () => {
  const calls = []
  const view = await mount({
    updateConvTitle: async (id, title) => {
      calls.push(title)
      return { conversation_id: id, title, saved: true }
    },
  })
  try {
    view.state.conversations = [{ id: 'A', title: '原标题' }]
    await view.state.startRename('A')
    const oldKey = view.state.renameSession.key
    view.state.renameText = '正在选中文字'
    await view.state.finishRename('A', { isComposing: true })
    view.state.cancelRename({ isComposing: true })
    assert.equal(view.state.renamingConvId, 'A')
    assert.equal(calls.length, 0)
    view.state.cancelRename()
    await view.state.startRename('A')
    view.state.renameText = '新草稿'
    const oldEvent = { currentTarget: { dataset: { renameKey: String(oldKey) } } }
    await view.state.finishRename('A', oldEvent)
    view.state.cancelRename(oldEvent)
    assert.equal(calls.length, 0)
    assert.equal(view.state.renameText, '新草稿')
    await view.state.finishRename('A')
    assert.deepEqual(calls, ['新草稿'])
  } finally {
    view.close()
  }
})

test('重命名回执丢失但服务端已保存时，读取核实后关闭编辑器而不重复写入', async () => {
  let writes = 0
  const view = await mount({
    updateConvTitle: async () => {
      writes++
      throw new Error('回执丢失')
    },
    getConversation: async (id) => ({ id, title: '已保存新标题', messages: [] }),
  })
  try {
    view.state.conversations = [{ id: 'A', title: '原标题' }]
    await view.state.startRename('A')
    view.state.renameText = '已保存新标题'
    await view.state.finishRename('A')
    assert.equal(writes, 1)
    assert.equal(view.state.conversations[0].title, '已保存新标题')
    assert.equal(view.state.renamingConvId, null)
    assert.equal(view.notices.length, 0)
  } finally {
    view.close()
  }
})

test('重命名冲突沿用确认框，取消保留草稿，确认时使用最新原标题', async () => {
  const versions = []
  const view = await mount({
    updateConvTitle: async (id, title, _signal, expected) => {
      versions.push(expected)
      if (versions.length === 1) throw new Error('标题变更')
      return { conversation_id: id, title, saved: true }
    },
    getConversation: async (id) => ({ id, title: '其他位置新标题', messages: [] }),
  })
  try {
    view.state.conversations = [{ id: 'A', title: '原标题' }]
    await view.state.startRename('A')
    view.state.renameText = '自己的标题'
    await view.state.finishRename('A')
    const cancelled = view.state.finishRename('A')
    assert.equal(view.state.confirmState.visible, true)
    view.state.resolveConfirm(false)
    await cancelled
    assert.equal(view.state.renameText, '自己的标题')
    assert.equal(versions.length, 1)
    const approved = view.state.finishRename('A')
    view.state.resolveConfirm(true)
    await approved
    assert.deepEqual(versions, ['原标题', '其他位置新标题'])
    assert.equal(view.state.conversations[0].title, '自己的标题')
  } finally {
    view.close()
  }
})

test('自动命名只允许替换默认标题，不覆盖已自定义的会话标题', async () => {
  const expected = []
  const view = await mount({
    updateConvTitle: async (_id, _title, _signal, original) => expected.push(original),
  })
  try {
    view.state.currentConvId = 'A'
    view.state.input = '第一条问题'
    await view.state.sendText()
    assert.deepEqual(expected, ['新对话'])
  } finally {
    view.close()
  }
})

test('恢复缓存对话也在 DOM 更新后定位到底，不等待下一次模型片段', async () => {
  const view = await mount({ getConversation: () => assert.fail('缓存恢复不应读取数据库') })
  try {
    const container = { scrollTop: 25, scrollHeight: 1800, clientHeight: 600 }
    view.state.msgContainer = container
    view.state.streamMessageCache.A = {
      messages: [savedBubble(1, 'user', '问题'), savedBubble(2)],
      thinkingSteps: [{ type: 'tool', label: '已有过程' }],
    }
    await view.state.loadConversation('A')
    assert.equal(container.scrollTop, 1800)
    assert.equal(view.state.messages[1].content, '原回复')
    assert.equal(view.state.thinkingSteps[0].label, '已有过程')
    assert.equal(view.state.showScrollBtn, false)
  } finally {
    view.close()
  }
})

test('点击一键到底立即更新按钮状态，不依赖浏览器再派发滚动事件', async () => {
  const view = await mount()
  try {
    view.state.messages = [savedBubble(2)]
    const container = { scrollTop: 0, scrollHeight: 1800, clientHeight: 600 }
    view.state.msgContainer = container
    await nextTick()
    view.state.onMsgScroll()
    assert.equal(view.state.showScrollBtn, true)
    await view.state.scrollToBottom()
    assert.equal(container.scrollTop, 1800)
    assert.equal(view.state.showScrollBtn, false)
  } finally {
    view.close()
  }
})

test('已排队的一键到底操作不滚动后来切换的新对话', async () => {
  const view = await mount()
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(2)]
    view.state.msgContainer = { scrollTop: 20, scrollHeight: 1800, clientHeight: 600 }
    const pending = view.state.scrollToBottom()
    const switching = view.state.newChat()
    view.state.msgContainer.scrollTop = 17
    await Promise.all([pending, switching])
    assert.equal(view.state.msgContainer.scrollTop, 17)
    assert.equal(view.state.showScrollBtn, false)
  } finally {
    view.close()
  }
})

test('缓存恢复等待 DOM 期间切换目标，不抢回页面或滚动新的目标', async () => {
  const view = await mount()
  try {
    view.state.msgContainer = { scrollTop: 12, scrollHeight: 1800, clientHeight: 600 }
    view.state.streamMessageCache.A = { messages: [savedBubble(2)], thinkingSteps: [] }
    const first = view.state.loadConversation('A')
    await view.state.newChat()
    view.state.msgContainer.scrollTop = 17
    await first
    assert.equal(view.state.currentConvId, null)
    assert.equal(view.state.msgContainer.scrollTop, 17)
  } finally {
    view.close()
  }
})

const legacyGreeting =
  '您好！我是 AI 法律助手。您可以向我咨询法律问题，或上传合同文件进行风险审查。'

for (const [description, first] of [
  ['用户提到产品名', savedBubble(1, 'user', 'AI 法律助手能帮我审查租赁合同吗？')],
  ['用户引用旧欢迎语', savedBubble(1, 'user', legacyGreeting)],
  [
    '助手正常回复提到产品名',
    savedBubble(1, 'assistant', 'AI 法律助手仅提供参考，请核对合同原文。'),
  ],
  [
    '助手回复以旧欢迎语开头但有正文',
    savedBubble(1, 'assistant', legacyGreeting + '\n\n以下是分析。'),
  ],
  [
    '内容相同但带合同报告',
    {
      ...savedBubble(1, 'assistant', legacyGreeting),
      contract_data: JSON.stringify({
        raw_text: '合同原文',
        chat_reply: legacyGreeting,
        risk_points: [],
      }),
    },
  ],
  ['内容相同但带附件', { ...savedBubble(1, 'assistant', legacyGreeting), file_name: '合同.txt' }],
  [
    '内容相同但带工具过程',
    {
      ...savedBubble(1, 'assistant', legacyGreeting),
      thinking_chain: JSON.stringify([{ type: 'tool', label: '检索记录' }]),
    },
  ],
]) {
  test(`历史读取保留真实首条消息：${description}`, async () => {
    const stored = [first, savedBubble(2, 'assistant', '后续回复')]
    const snapshot = structuredClone(stored)
    const view = await mount({ getConversation: async (id) => ({ id, messages: stored }) })
    try {
      await view.state.loadConversation('A')
      assert.equal(view.state.messages.length, 2)
      assert.equal(view.state.messages[0].id, first.id)
      assert.equal(view.state.messages[0].revision, first.revision)
      assert.equal(view.state.messages[0].role, first.role)
      assert.equal(view.state.messages[0].content, first.content)
      if (first.contract_data)
        assert.equal(view.state.messages[0].contractData.raw_text, '合同原文')
      if (first.file_name) assert.equal(view.state.messages[0].file.name, first.file_name)
      if (first.thinking_chain)
        assert.equal(view.state.messages[0].thinkingChain[0].label, '检索记录')
      assert.deepEqual(stored, snapshot)
      assert.equal(view.writes.length, 0)
    } finally {
      view.close()
    }
  })
}

for (const emptySteps of [false, true]) {
  test(`历史读取不再特殊过滤旧欢迎语，空过程字段为${emptySteps}`, async () => {
    const greeting = {
      ...savedBubble(1, 'assistant', legacyGreeting),
      ...(emptySteps ? { thinking_chain: '[]' } : {}),
    }
    const stored = [greeting, savedBubble(2, 'user', '真实问题'), savedBubble(3)]
    const snapshot = structuredClone(stored)
    const view = await mount({ getConversation: async (id) => ({ id, messages: stored }) })
    try {
      await view.state.loadConversation('A')
      assert.deepEqual(
        view.state.messages.map((message) => message.id),
        [1, 2, 3],
      )
      assert.equal(view.state.messages[0].content, legacyGreeting)
      assert.deepEqual(stored, snapshot)
      assert.equal(view.writes.length, 0)
    } finally {
      view.close()
    }
  })
}

test('历史中非首条的欢迎语保留，不能按全文关键字清理问答', async () => {
  const view = await mount({
    getConversation: async (id) => ({
      id,
      messages: [
        savedBubble(1, 'user', '请输出欢迎语'),
        savedBubble(2, 'assistant', legacyGreeting),
      ],
    }),
  })
  try {
    await view.state.loadConversation('A')
    assert.deepEqual(
      view.state.messages.map((message) => message.id),
      [1, 2],
    )
  } finally {
    view.close()
  }
})

for (const onlyGreeting of [false, true]) {
  test(`历史为空或仅有一条消息时按实际内容恢复：${onlyGreeting}`, async () => {
    const view = await mount({
      getConversation: async (id) => ({
        id,
        messages: onlyGreeting ? [savedBubble(1, 'assistant', legacyGreeting)] : [],
      }),
    })
    try {
      await view.state.loadConversation('A')
      assert.equal(view.state.messages.length, onlyGreeting ? 1 : 0)
      if (onlyGreeting) assert.equal(view.state.messages[0].content, legacyGreeting)
      assert.equal(view.state.historyLoading, false)
      assert.equal(view.state.showScrollBtn, false)
    } finally {
      view.close()
    }
  })
}

test('提到产品名的首条问题恢复后，继续发送仍提供完整原始上下文', async () => {
  const first = savedBubble(1, 'user', '请问 AI 法律助手如何审查合同？')
  const second = savedBubble(2, 'assistant', '请提供合同原文。')
  const view = await mount({ getConversation: async (id) => ({ id, messages: [first, second] }) })
  try {
    await view.state.loadConversation('A')
    view.state.input = '继续说明'
    await view.state.sendText()
    assert.deepEqual(
      view.streams[0].history,
      [first, second].map(({ role, content }) => ({ role, content })),
    )
  } finally {
    view.close()
  }
})

test('列表刷新只采用最近一次请求的结果，不让迟到旧列表覆盖标题及顺序', async () => {
  const old = deferred()
  let calls = 0
  const view = await mount()
  globalThis.__sendingTestApi.listConversations = async () =>
    calls++ === 0
      ? old.promise
      : [
          { id: 'B', title: '最新标题' },
          { id: 'A', title: 'A' },
        ]
  const pending = view.state.refreshConvList()
  try {
    await view.state.refreshConvList()
    old.resolve([{ id: 'A', title: '旧标题' }])
    await pending
    assert.deepEqual(
      view.state.conversations.map((item) => item.id),
      ['B', 'A'],
    )
    assert.equal(view.state.conversations[0].title, '最新标题')
  } finally {
    old.resolve([])
    await pending
    view.close()
  }
})

test('最新列表读取失败时保留当前列表，不倒退采用已过期的旧响应', async () => {
  const old = deferred()
  let calls = 0
  const view = await mount()
  view.state.conversations = [{ id: 'saved', title: '已显示列表' }]
  globalThis.__sendingTestApi.listConversations = async () => {
    if (calls++ === 0) return old.promise
    throw new Error('列表读取失败')
  }
  const pending = view.state.refreshConvList()
  try {
    await view.state.refreshConvList()
    old.resolve([{ id: 'obsolete', title: '旧快照' }])
    await pending
    assert.equal(view.state.conversations[0].id, 'saved')
  } finally {
    old.resolve([])
    await pending
    view.close()
  }
})

for (const destination of ['network', 'cache', 'new']) {
  test(`历史切换到 ${destination} 会取消旧读取，迟到响应不影响最终目标`, async () => {
    const old = deferred()
    let oldSignal
    const view = await mount({
      getConversation: async (id, signal) => {
        if (id !== 'slow') return { id, messages: [] }
        oldSignal = signal
        return old.promise
      },
    })
    const pending = view.state.loadConversation('slow')
    try {
      if (destination === 'new') await view.state.newChat()
      else {
        if (destination === 'cache')
          view.state.streamMessageCache.B = { messages: [], thinkingSteps: [] }
        await view.state.loadConversation('B')
      }
      assert.equal(oldSignal?.aborted, true)
      old.resolve({ id: 'slow', messages: [{ role: 'assistant', content: '不能出现' }] })
      await pending
      assert.equal(view.state.currentConvId, destination === 'new' ? null : 'B')
      assert.deepEqual(view.state.messages, [])
      assert.equal(view.state.historyLoading, false)
    } finally {
      old.resolve({ id: 'slow', messages: [] })
      await pending
      view.close()
    }
  })
}

test('组件卸载取消历史与列表读取，忽略迟到结果并拒绝发起新读取', async () => {
  const oldHistory = deferred()
  const oldList = deferred()
  const signals = []
  const view = await mount()
  globalThis.__sendingTestApi.getConversation = (_id, signal) => {
    signals.push(signal)
    return oldHistory.promise
  }
  globalThis.__sendingTestApi.listConversations = (signal) => {
    signals.push(signal)
    return oldList.promise
  }
  view.state.currentConvId = 'A'
  view.state.messages = [savedBubble(2)]
  view.state.conversations = [{ id: 'A', title: '原列表' }]
  const pending = [view.state.loadConversation('B'), view.state.refreshConvList()]
  let closed = false
  try {
    view.close()
    closed = true
    assert.equal(signals.length, 2)
    assert.ok(signals.every((signal) => signal?.aborted))
    oldHistory.resolve({ id: 'B', messages: [] })
    oldList.resolve([{ id: 'B', title: '迟到列表' }])
    await Promise.all(pending)
    assert.equal(view.state.currentConvId, 'A')
    assert.equal(view.state.messages[0].content, '原回复')
    assert.equal(view.state.conversations[0].id, 'A')
    assert.equal(view.state.historyLoading, false)
    await view.state.loadConversation('new')
    await view.state.refreshConvList()
    assert.equal(signals.length, 2)
  } finally {
    oldHistory.resolve({ id: 'B', messages: [] })
    oldList.resolve([])
    await Promise.all(pending)
    if (!closed) view.close()
  }
})

test('切换新对话发生在历史 DOM 更新等待期间，不被旧读取滚动到底', async () => {
  const view = await mount({ getConversation: async (id) => ({ id, messages: [] }) })
  try {
    view.state.msgContainer = { scrollTop: 0, scrollHeight: 900 }
    const pending = view.state.loadConversation('A')
    await Promise.resolve()
    await view.state.newChat()
    view.state.msgContainer.scrollTop = 17
    await pending
    assert.equal(view.state.msgContainer.scrollTop, 17)
    assert.equal(view.state.currentConvId, null)
  } finally {
    view.close()
  }
})

test('失效历史读取的失败不再输出迟到警告或完整请求异常', async (context) => {
  const gate = deferred()
  const warnings = context.mock.method(console, 'warn', () => {})
  const view = await mount({
    getConversation: (id) => (id === 'old' ? gate.promise : { id, messages: [] }),
  })
  const pending = view.state.loadConversation('old')
  try {
    await view.state.loadConversation('B')
    gate.reject(new Error('sk-private obsolete request'))
    await pending
    assert.equal(warnings.mock.callCount(), 0)
  } finally {
    gate.resolve({ id: 'old', messages: [] })
    await pending
    view.close()
  }
})

for (const change of ['create', 'rename']) {
  test(`${change} 本地列表变更不会被之前已发出的旧列表抹掉`, async () => {
    const old = deferred()
    const entered = deferred()
    const titleGate = deferred()
    const view = await mount({
      updateConvTitle: async (id, title) => {
        entered.resolve()
        await titleGate.promise
        return { conversation_id: id, title, saved: true }
      },
    })
    let calls = 0
    globalThis.__sendingTestApi.listConversations = () =>
      calls++ === 0 ? old.promise : Promise.resolve([{ id: 'created-A', title: '新对话' }])
    view.state.conversations = [{ id: 'A', title: '旧标题' }]
    const pending = view.state.refreshConvList()
    let sending
    try {
      if (change === 'create') {
        view.state.input = '新问题'
        sending = view.state.sendText()
        await entered.promise
      } else {
        await view.state.startRename('A')
        view.state.renameText = '新标题'
        titleGate.resolve()
        await view.state.finishRename('A')
      }
      old.resolve([{ id: 'A', title: '旧标题' }])
      await pending
      if (change === 'create') assert.equal(view.state.conversations[0].id, 'created-A')
      else assert.equal(view.state.conversations[0].title, '新标题')
    } finally {
      titleGate.resolve()
      old.resolve([])
      await pending
      await sending
      view.close()
    }
  })
}

test('替换准备阶段的列表读取只取消子请求，不停止所属生成或丢失正文', async () => {
  const entered = deferred()
  let hold = false
  let childSignal
  const view = await mount({
    listConversations: (signal) => {
      if (!hold) return Promise.resolve([])
      hold = false
      childSignal = signal
      return waitForAbort(signal, entered)
    },
  })
  let sending
  try {
    view.state.currentConvId = 'A'
    view.state.input = '正常生成的问题'
    hold = true
    sending = view.state.sendText()
    await entered.promise
    const parent = view.state.abortControllers.A
    await view.state.refreshConvList()
    assert.equal(childSignal.aborted, true)
    assert.equal(parent.signal.aborted, false)
    await sending
    assert.equal(view.writes.length, 1)
    assert.equal(view.writes[0][2], '正常生成的问题回复')
    assert.equal(view.state.loadingConvIds.size, 0)
    assert.equal(parent.signal.aborted, false)
  } finally {
    view.state.stopGeneration('A')
    await sending
    view.close()
  }
})

for (const deletedId of ['A', 'B']) {
  test(`删除 ${deletedId} 时只取消同身份的在途历史读取，其他目标仍能加载`, async () => {
    const gate = deferred()
    let signal
    const view = await mount({
      getConversation: async (id, ownedSignal) => {
        signal = ownedSignal
        return gate.promise
      },
      deleteConversation: async () => {},
    })
    view.state.currentConvId = 'B'
    const pending = view.state.loadConversation('A')
    try {
      const deleting = view.state.handleDeleteConv(deletedId)
      view.state.resolveConfirm(true)
      await deleting
      assert.equal(signal.aborted, deletedId === 'A')
      assert.equal(view.state.historyLoading, deletedId !== 'A')
      gate.resolve({ id: 'A', messages: [] })
      await pending
      assert.equal(view.state.currentConvId, deletedId === 'A' ? 'B' : 'A')
      assert.equal(view.state.historyLoading, false)
    } finally {
      gate.resolve({ id: 'A', messages: [] })
      await pending
      view.close()
    }
  })
}

test('当前历史读取失败释放加载状态，只记录异常类型而不回显请求详情', async (context) => {
  const warnings = context.mock.method(console, 'warn', () => {})
  const view = await mount({
    getConversation: async () => {
      throw new Error('sk-private details')
    },
  })
  try {
    view.state.currentConvId = 'A'
    view.state.messages = [savedBubble(2)]
    await view.state.loadConversation('B')
    assert.equal(view.state.currentConvId, 'A')
    assert.equal(view.state.messages[0].content, '原回复')
    assert.equal(view.state.historyLoading, false)
    assert.equal(warnings.mock.callCount(), 1)
    assert.deepEqual(warnings.mock.calls[0].arguments, ['加载历史对话失败，异常类型：', 'Error'])
  } finally {
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

function invalidSaveReceipt(kind) {
  if (kind === 'missing') return undefined
  if (kind === 'ok-only') return { ok: true }
  const receipt = savedPairReceipt()
  if (kind === 'missing-status') delete receipt.ok
  if (kind === 'not-confirmed') receipt.ok = false
  if (kind === 'partial') receipt.messages[1].revision = 'invalid'
  if (kind === 'duplicate') receipt.messages[1].id = receipt.messages[0].id
  return receipt
}

for (const contract of [false, true]) {
  for (const kind of [
    'missing',
    'ok-only',
    'missing-status',
    'not-confirmed',
    'partial',
    'duplicate',
  ]) {
    test(`${contract ? '合同' : '咨询'}保存回执为 ${kind} 时保留未确认缓存，不伪装已保存或重试`, async () => {
      const entered = deferred()
      const saveGate = deferred()
      const writes = []
      const view = await mount({
        saveMessages: async (...args) => {
          writes.push(args)
          entered.resolve()
          return saveGate.promise
        },
        getConversation: () => assert.fail('恢复未确认缓存不能重读并覆盖页面内容'),
      })
      let sending
      try {
        const state = view.state
        state.currentConvId = 'A'
        state.input = '原问题'
        if (contract) state.pendingFile = new File(['合同原文'], '合同.txt')
        sending = contract ? state.sendFile(state.input) : state.sendText()
        await entered.promise
        const assistant = state.messages.at(-1)
        const text = assistant.content
        const file = new File(['下一份合同'], '待发.txt')
        state.input = '下一条草稿'
        state.pendingFile = file
        saveGate.resolve(invalidSaveReceipt(kind))
        await sending
        assert.equal(assistant.saveFailed, true)
        assert.equal(assistant.content, text)
        assert.equal(assistant.fullContent, text)
        assert.equal(assistant.id, undefined)
        assert.equal(state.messages[0].id, undefined)
        assert.equal(state.streamMessageCache.A.messages, state.messages)
        assert.equal(writes.length, 1)
        assert.equal(view.streams.length, 1)
        assert.equal(view.notices.length, 1)
        assert.match(view.notices[0].options.message, /未确认保存/)
        assert.equal(state.loading, false)
        assert.deepEqual(state.abortControllers, {})
        assert.equal(state.input, '下一条草稿')
        assert.equal(state.pendingFile, file)
        if (contract) assert.equal(assistant.contractData.raw_text, '合同原文')
        await state.newChat()
        await state.loadConversation('A')
        assert.equal(state.messages.at(-1), assistant)
        assert.equal(state.messages.at(-1).content, text)
        assert.equal(state.input, '下一条草稿')
        assert.equal(state.pendingFile, file)
        assert.equal(writes.length, 1)
      } finally {
        saveGate.resolve(invalidSaveReceipt(kind))
        await sending
        view.close()
      }
    })
  }

  test(`${contract ? '合同' : '咨询'}有效保存回执绑定本轮两个身份并正常释放缓存`, async () => {
    const view = await mount()
    try {
      view.state.currentConvId = 'A'
      view.state.input = '原问题'
      if (contract) view.state.pendingFile = new File(['合同原文'], '合同.txt')
      await (contract ? view.state.sendFile() : view.state.sendText())
      assert.deepEqual(
        view.state.messages.map((message) => message.id),
        [101, 102],
      )
      assert.equal(view.state.messages.at(-1).saveFailed, false)
      assert.equal(view.state.streamMessageCache.A, undefined)
      assert.equal(view.state.loading, false)
      assert.equal(view.writes.length, 1)
      assert.equal(view.notices.length, 0)
    } finally {
      view.close()
    }
  })
}

test('后台保存回执无效只保留所属缓存，不释放另一会话的锁或覆盖过程', async () => {
  const savingA = deferred()
  const saveA = deferred()
  const streamingB = deferred()
  const streamB = deferred()
  const view = await mount({
    saveMessages: async (id) => {
      if (id === 'A') {
        savingA.resolve()
        return saveA.promise
      }
      return savedPairReceipt(201)
    },
    chatStream: async (query, _history, _signal, callbacks) => {
      callbacks.onThinking(query + '工具')
      callbacks.onToken(query + '正文')
      if (query === 'B问题') {
        streamingB.resolve()
        await streamB.promise
      }
      await callbacks.onDone({})
    },
  })
  let first
  let second
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = 'A问题'
    first = state.sendText()
    await savingA.promise
    const assistantA = state.messages.at(-1)
    await state.loadConversation('B')
    state.input = 'B问题'
    second = state.sendText()
    await streamingB.promise
    const controller = state.abortControllers.B
    saveA.resolve({ ok: true })
    await first
    assert.equal(assistantA.saveFailed, true)
    assert.equal(state.streamMessageCache.A.messages.at(-1), assistantA)
    assert.equal(state.currentConvId, 'B')
    assert.equal(state.loading, true)
    assert.equal(state.abortControllers.B, controller)
    assert.equal(controller.signal.aborted, false)
    assert.equal(state.thinkingSteps.at(-1).label, 'B问题工具')
    streamB.resolve()
    await second
    assert.equal(state.messages.at(-1).id, 202)
    assert.equal(state.messages.at(-1).saveFailed, false)
    assert.equal(state.streamMessageCache.B, undefined)
    await state.loadConversation('A')
    assert.equal(state.messages.at(-1), assistantA)
    assert.equal(assistantA.content, 'A问题正文')
  } finally {
    saveA.resolve({ ok: true })
    streamB.resolve()
    await Promise.all([first, second])
    view.close()
  }
})

test('后续一轮保存成功不清除前一轮无效回执的未确认标记或缓存', async () => {
  let writes = 0
  const view = await mount({
    saveMessages: async () => (++writes === 1 ? { ok: true } : savedPairReceipt(201)),
  })
  try {
    const state = view.state
    state.currentConvId = 'A'
    state.input = '第一轮'
    await state.sendText()
    const first = state.messages.at(-1)
    state.input = '第二轮'
    await state.sendText()
    assert.equal(first.saveFailed, true)
    assert.equal(state.messages.at(-1).saveFailed, false)
    assert.equal(state.messages.at(-1).id, 202)
    assert.equal(state.streamMessageCache.A.messages, state.messages)
    assert.equal(state.messages.length, 4)
    assert.equal(writes, 2)
    assert.equal(view.notices.length, 1)
  } finally {
    view.close()
  }
})

const streamFrame = (event) => 'data: ' + JSON.stringify(event) + '\n\n'
const streamResponse = (events) =>
  new Response(events.map(streamFrame).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })

for (const contract of [false, true]) {
  for (const regeneration of [false, true]) {
    test(`真实页面${contract ? '合同' : '咨询'}${regeneration ? '重跑' : '首次生成'}遇到超大 HTTP 错误不显示原始内容或重复保存`, async (context) => {
      const bytes = new TextEncoder().encode(JSON.stringify({ detail: 'sk-private '.repeat(7000) }))
      let sent = false
      let cancelled = 0
      const body = new ReadableStream(
        {
          pull(controller) {
            if (sent) controller.close()
            else {
              sent = true
              controller.enqueue(bytes)
            }
          },
          cancel() {
            cancelled++
          },
        },
        { highWaterMark: 0 },
      )
      context.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 502 }))
      const warning = context.mock.method(console, 'warn', () => {})
      const view = await mount({
        chatStream: realChatStream,
        analyzeContractStream: realContractStream,
        regenerateChatStream: realChatRegenerationStream,
        regenerateContractStream: realContractRegenerationStream,
      })
      try {
        const state = view.state
        state.currentConvId = 'A'
        if (regeneration) {
          seedChatRegeneration(state)
          if (contract)
            state.messages[1].contractData = {
              raw_text: '合同原文',
              chat_reply: '原回复',
              risk_points: [],
            }
        }
        const before = JSON.parse(JSON.stringify(state.messages))
        state.input = '待发草稿'
        const file = new File(['待发附件'], '合同.txt')
        if (contract || regeneration) state.pendingFile = file
        if (regeneration) await state.regenerateMessage(1)
        else await (contract ? state.sendFile() : state.sendText())
        if (regeneration) {
          assert.equal(state.messages[1].content, before[1].content)
          assert.equal(state.messages[1].revision, before[1].revision)
          assert.deepEqual(state.messages[1].contractData, before[1].contractData)
          assert.deepEqual(state.messages[1].thinkingChain, before[1].thinkingChain)
          assert.deepEqual(state.messages[0], before[0])
          assert.deepEqual(state.messages.slice(2), before.slice(2))
          assert.equal(view.writes.length, 0)
          assert.equal(state.input, '待发草稿')
          assert.equal(state.pendingFile, file)
          assert.match(view.notices.at(-1).options.message, /HTTP 502/)
        } else {
          assert.match(state.messages.at(-1).content, /HTTP 502/)
          assert.equal(view.writes.length, 1)
          assert.equal(state.messages.at(-1).saveFailed, false)
          assert.equal(state.messages.at(-1).contractData, undefined)
        }
        assert.ok(!JSON.stringify(state.messages).includes('sk-private'))
        assert.ok(!JSON.stringify(view.notices).includes('sk-private'))
        assert.ok(!JSON.stringify(warning.mock.calls).includes('sk-private'))
        assert.equal(state.loading, false)
        assert.deepEqual(state.abortControllers, {})
        assert.equal(cancelled, 1)
        assert.equal(body.locked, false)
      } finally {
        view.close()
      }
    })
  }
}

function oversizedStreamResponse() {
  const encoder = new TextEncoder()
  const chunk = encoder.encode('x'.repeat(64 * 1024))
  let remaining = SSE_MAX_FRAME_BYTES + 1
  const state = { cancelled: 0 }
  state.response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            streamFrame({ type: 'thinking', label: '检索工具' }) +
              streamFrame({ type: 'token', content: '已收到的部分正文' }) +
              'data: ',
          ),
        )
      },
      pull(controller) {
        if (remaining <= 0) {
          controller.enqueue(encoder.encode('\n\n' + streamFrame({ type: 'done' })))
          controller.close()
        } else {
          controller.enqueue(chunk.subarray(0, Math.min(remaining, chunk.length)))
          remaining -= chunk.length
        }
      },
      cancel() {
        state.cancelled++
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
  return state
}

for (const contract of [false, true]) {
  test(`真实读取器${contract ? '合同' : '咨询'}首次生成超限保留部分正文，保存一次并释放状态`, async (context) => {
    const stream = oversizedStreamResponse()
    context.mock.method(globalThis, 'fetch', async () => stream.response)
    const view = await mount({
      chatStream: realChatStream,
      analyzeContractStream: realContractStream,
    })
    try {
      view.state.currentConvId = 'A'
      view.state.input = '问题'
      if (contract) view.state.pendingFile = new File(['合同'], '合同.txt')
      await (contract ? view.state.sendFile() : view.state.sendText())
      const assistant = view.state.messages.at(-1)
      assert.match(assistant.content, /已收到的部分正文/)
      assert.match(assistant.content, /单次回复数据过大/)
      assert.equal(assistant.contractData, undefined)
      assert.equal(view.writes.length, 1)
      assert.equal(view.writes[0][2], assistant.content)
      assert.equal(view.state.loadingConvIds.size, 0)
      assert.deepEqual(view.state.abortControllers, {})
      assert.equal(stream.cancelled, 1)
      assert.equal(stream.response.body.locked, false)
    } finally {
      view.close()
    }
  })

  test(`真实读取器${contract ? '合同' : '咨询'}重生成超限保留旧回复、草稿及附件，不追加保存`, async (context) => {
    const stream = oversizedStreamResponse()
    context.mock.method(globalThis, 'fetch', async () => stream.response)
    const view = await mount({
      regenerateChatStream: realChatRegenerationStream,
      regenerateContractStream: realContractRegenerationStream,
    })
    try {
      seedChatRegeneration(view.state)
      if (contract) {
        view.state.messages[0].file = { name: '历史合同.txt' }
        view.state.messages[1].contractData = {
          raw_text: '合同原文',
          chat_reply: '原回复',
          risk_points: [],
        }
      }
      const before = JSON.parse(JSON.stringify(view.state.messages))
      const file = new File(['待发附件'], '待发.txt')
      view.state.input = '待发草稿'
      view.state.pendingFile = file
      await view.state.regenerateMessage(1)
      assert.equal(view.state.messages[1].content, before[1].content)
      assert.deepEqual(view.state.messages[1].thinkingChain, before[1].thinkingChain)
      assert.deepEqual(view.state.messages[1].contractData, before[1].contractData)
      assert.deepEqual(view.state.messages.slice(2), before.slice(2))
      assert.equal(view.state.messages[1].regenerationDraft, undefined)
      assert.equal(view.state.input, '待发草稿')
      assert.equal(view.state.pendingFile, file)
      assert.equal(view.writes.length, 0)
      assert.match(view.notices.at(-1).options.message, /单次回复数据过大/)
      assert.equal(view.state.loadingConvIds.size, 0)
      assert.deepEqual(view.state.abortControllers, {})
      assert.equal(stream.cancelled, 1)
      assert.equal(stream.response.body.locked, false)
    } finally {
      view.close()
    }
  })
}

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
      return savedPairReceipt()
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
      return savedPairReceipt()
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
