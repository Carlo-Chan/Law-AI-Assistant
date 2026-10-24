import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMessageScroll } from '../src/composables/messageScroll.js'

function fixture() {
  const frames = new Map()
  const resizes = []
  const mutations = []
  const changes = []
  const cancelled = []
  let nextFrame = 0
  class Resize {
    constructor(callback) {
      this.callback = callback
      this.observed = new Set()
      resizes.push(this)
    }
    observe(element) {
      this.observed.add(element)
    }
    unobserve(element) {
      this.observed.delete(element)
    }
    disconnect() {
      this.observed.clear()
      this.disconnected = true
    }
  }
  class Mutation {
    constructor(callback) {
      this.callback = callback
      mutations.push(this)
    }
    observe(element, options) {
      this.element = element
      this.options = options
    }
    disconnect() {
      this.disconnected = true
    }
  }
  const scroll = createMessageScroll({
    onChange: (value) => changes.push(value),
    Resize,
    Mutation,
    requestFrame(callback) {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    },
    cancelFrame(id) {
      cancelled.push(id)
      frames.delete(id)
    },
  })
  return {
    scroll,
    frames,
    resizes,
    mutations,
    changes,
    cancelled,
    flush() {
      for (const [id, callback] of [...frames]) {
        frames.delete(id)
        callback()
      }
    },
  }
}

const element = (properties = {}) => ({
  nodeType: 1,
  children: [],
  scrollTop: 0,
  scrollHeight: 1000,
  clientHeight: 500,
  ...properties,
})

for (const [metrics, expected] of [
  [{ scrollHeight: 500 }, false],
  [{ scrollHeight: 600 }, false],
  [{ scrollHeight: 600.1 }, true],
  [{ scrollTop: 500 }, false],
  [{ clientHeight: 0 }, false],
  [{ scrollHeight: 0 }, false],
]) {
  test(`按钮保持原有距底超过100px才显示：${JSON.stringify(metrics)}`, () => {
    const state = fixture()
    state.scroll.connect(element(metrics))
    assert.equal(state.changes.at(-1), expected)
    state.scroll.dispose()
  })
}

test('窗口和消息尺寸变化合并到一帧，标识为零时也不重复排队', () => {
  const state = fixture()
  const root = element()
  state.scroll.connect(root)
  root.clientHeight = 950
  for (let count = 0; count < 10; count++) state.resizes[0].callback()
  assert.equal(state.frames.size, 1)
  assert.equal(state.frames.has(0), true)
  state.flush()
  assert.equal(state.changes.at(-1), false)
  state.scroll.dispose()
})

test('直接观察消息行尺寸，内容变高无需滚动或新增节点即可更新按钮', () => {
  const state = fixture()
  const row = {}
  const root = element({ children: [row], scrollHeight: 500 })
  state.scroll.connect(root)
  assert.ok(state.resizes[0].observed.has(row))
  root.scrollHeight = 1500
  state.resizes[0].callback()
  state.flush()
  assert.equal(state.changes.at(-1), true)
  state.scroll.dispose()
})

test('消息增删时补充及移除行观察，不监听每次文字变动的整个子树', () => {
  const state = fixture()
  const first = {}
  const second = {}
  const root = element({ children: [first] })
  state.scroll.connect(root)
  root.children = [second]
  state.mutations[0].callback()
  assert.deepEqual(state.mutations[0].options, { childList: true })
  assert.equal(state.resizes[0].observed.has(first), false)
  assert.equal(state.resizes[0].observed.has(second), true)
  state.scroll.dispose()
})

test('切换容器撤销旧观察及动画，旧回调不能读取新容器或清掉新帧', () => {
  const state = fixture()
  state.scroll.connect(element())
  const oldResize = state.resizes[0]
  const oldMutation = state.mutations[0]
  oldResize.callback()
  const oldFrame = state.frames.get(0)
  state.scroll.connect(element({ scrollHeight: 500 }))
  assert.equal(oldResize.disconnected, true)
  assert.equal(oldMutation.disconnected, true)
  assert.deepEqual(state.cancelled, [0])
  state.resizes[1].callback()
  oldResize.callback()
  oldMutation.callback()
  oldFrame()
  assert.equal(state.frames.size, 1)
  state.flush()
  assert.equal(state.changes.at(-1), false)
  state.scroll.dispose()
})

test('一键到底同步隐藏按钮，不依赖后续滚动事件', () => {
  const state = fixture()
  const root = element()
  state.scroll.connect(root)
  assert.equal(state.changes.at(-1), true)
  state.scroll.toBottom()
  assert.equal(root.scrollTop, root.scrollHeight)
  assert.equal(state.changes.at(-1), false)
  state.scroll.dispose()
})

test('卸载释放全部观察和排队任务，重复卸载或迟到连接不能恢复按钮', () => {
  const state = fixture()
  const root = element()
  state.scroll.connect(root)
  state.resizes[0].callback()
  state.scroll.dispose()
  state.scroll.dispose()
  assert.equal(state.frames.size, 0)
  assert.equal(state.resizes[0].disconnected, true)
  assert.equal(state.mutations[0].disconnected, true)
  state.scroll.connect(root)
  state.scroll.toBottom()
  state.resizes[0].callback()
  assert.equal(state.frames.size, 0)
  assert.equal(root.scrollTop, 0)
  assert.equal(state.changes.at(-1), false)
})

test('缺少观察器和动画接口时仍可直接同步滚动状态', () => {
  const changes = []
  const scroll = createMessageScroll({
    onChange: (value) => changes.push(value),
    Resize: null,
    Mutation: null,
    requestFrame: null,
  })
  const root = element()
  scroll.connect(root)
  assert.equal(changes.at(-1), true)
  root.scrollTop = 500
  scroll.sync()
  assert.equal(changes.at(-1), false)
  scroll.connect(null)
  scroll.dispose()
})
