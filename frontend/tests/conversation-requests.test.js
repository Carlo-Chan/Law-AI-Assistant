import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ref } from 'vue'
import {
  createConversationRequests,
  LOADING_DOTS,
} from '../src/composables/conversationRequests.js'

test('失效目标请求立即释放资源，迟到发布、绑定和清理不能复活缓存', () => {
  const state = fixture()
  const request = state.requests.begin('A', { role: 'user', content: '待删除的问题' })
  assert.equal(state.requests.invalidate('A'), request.messages)
  assert.equal(request.invalidated, true)
  assert.equal(request.controller.signal.aborted, true)
  assert.equal(state.loadingIds.value.has('A'), false)
  assert.equal(state.controllers.value.A, undefined)
  state.requests.publish(request)
  assert.equal(state.requests.bind(request, 'late-A'), false)
  state.requests.finish(request)
  assert.deepEqual(state.cache.value, {})
  assert.equal(state.loadingIds.value.size, 0)
})

test('失效一个请求不停止其他会话，也不改变其缓存、过程和展开状态', () => {
  const state = fixture()
  const first = state.requests.begin('A', { role: 'user', content: 'A问题' })
  state.current.value = 'B'
  state.messages.value = []
  const second = state.requests.begin('B', { role: 'user', content: 'B问题' })
  second.assistant.thinkingExpanded = true
  second.steps.push({ type: 'tool', label: 'B工具' })
  state.requests.publish(second)
  const cache = state.cache.value.B
  state.requests.invalidate('A')
  first.assistant.saveFailed = true
  state.requests.finish(first)
  assert.equal(second.controller.signal.aborted, false)
  assert.equal(state.cache.value.B, cache)
  assert.equal(state.thinkingSteps.value[0].label, 'B工具')
  assert.equal(second.assistant.thinkingExpanded, true)
  assert.equal(state.loadingIds.value.has('B'), true)
})

test('没有活动请求的历史缓存与独立重跑控制器也能完整失效', () => {
  const state = fixture()
  const controller = new AbortController()
  state.controllers.value.A = controller
  state.cache.value.A = { messages: state.messages.value, thinkingSteps: [] }
  state.loadingIds.value.add('A')
  state.requests.invalidate('A')
  assert.equal(controller.signal.aborted, true)
  assert.equal(state.cache.value.A, undefined)
  assert.equal(state.controllers.value.A, undefined)
  assert.equal(state.loadingIds.value.size, 0)
})
function fixture(key = 'A') {
  const current = ref(key)
  const messages = ref([{ role: 'user', content: 'A之前的问题' }])
  const thinkingSteps = ref([])
  const loadingIds = ref(new Set())
  const controllers = ref({})
  const cache = ref({})
  return {
    current,
    messages,
    thinkingSteps,
    loadingIds,
    controllers,
    cache,
    requests: createConversationRequests({
      currentKey: () => current.value,
      messages,
      thinkingSteps,
      loadingIds,
      controllers,
      cache,
    }),
  }
}

test('首次等待前固定历史、消息对象和占位回复', () => {
  const state = fixture()
  const request = state.requests.begin('A', { role: 'user', content: 'A新问题' })
  assert.deepEqual(request.history, [{ role: 'user', content: 'A之前的问题' }])
  assert.equal(request.messages.length, 3)
  assert.equal(request.assistant.content, LOADING_DOTS)
  state.current.value = 'B'
  state.messages.value = [{ role: 'user', content: 'B的问题' }]
  request.assistant.content = 'A的回复'
  state.requests.publish(request)
  assert.equal(state.messages.value.length, 1)
  assert.equal(state.cache.value.A.messages[2].content, 'A的回复')
  assert.equal(state.cache.value.A.messages, request.messages)
  assert.deepEqual(request.history, [{ role: 'user', content: 'A之前的问题' }])
})

test('历史快照不随原消息编辑而变化', () => {
  const state = fixture()
  const request = state.requests.begin('A', { role: 'user', content: '新问题' })
  state.messages.value[0].content = '被编辑的内容'
  assert.equal(request.history[0].content, 'A之前的问题')
})

test('同步锁拦截同会话连点，但不阻止其他会话发送', () => {
  const state = fixture()
  const first = state.requests.begin('A', { role: 'user', content: '新问题' })
  for (let index = 0; index < 50; index++) {
    assert.equal(state.requests.begin('A', { role: 'user', content: '重复问题' }), null)
  }
  state.current.value = 'B'
  state.messages.value = []
  const second = state.requests.begin('B', { role: 'user', content: 'B问题' })
  assert.ok(first && second)
  assert.equal(first.messages.length, 3)
  assert.equal(second.messages.length, 2)
})

test('创建响应返回时只迁移原临时归属，不能切走当前其他页面', () => {
  const state = fixture('draft-1')
  const first = state.requests.begin(null, { role: 'user', content: '第一条' })
  state.current.value = 'draft-2'
  state.messages.value = []
  const second = state.requests.begin(null, { role: 'user', content: '第二条' })
  assert.equal(state.requests.bind(first, 'created-A'), false)
  assert.equal(state.current.value, 'draft-2')
  assert.ok(state.loadingIds.value.has('draft-2'))
  assert.equal(state.controllers.value['draft-2'], second.controller)
  assert.equal(state.cache.value['created-A'].messages, first.messages)
  assert.equal(state.cache.value['draft-1'], undefined)
  assert.equal(first.convId, 'created-A')
})

test('仍在原页面时创建完成允许接续真实会话', () => {
  const state = fixture('draft-1')
  const request = state.requests.begin(null, { role: 'user', content: '新问题' })
  assert.equal(state.requests.bind(request, 'created-A'), true)
  state.current.value = 'created-A'
  assert.equal(state.requests.isActive(request), true)
  assert.deepEqual([...state.loadingIds.value], ['created-A'])
  assert.equal(state.controllers.value['draft-1'], undefined)
})

test('后台每类过程更新均写入所属缓存，不污染当前思维链', () => {
  const state = fixture()
  const request = state.requests.begin('A', { role: 'user', content: '新问题' })
  state.current.value = 'B'
  state.thinkingSteps.value = [{ type: 'tool', label: 'B工具' }]
  for (const step of [
    { type: 'tool', label: 'A工具' },
    { type: 'reasoning', label: 'A分析' },
    { type: 'done', label: 'A工具完成', snippet: 'A结果' },
  ]) {
    request.steps.push(step)
    state.requests.publish(request)
    assert.deepEqual(state.cache.value.A.thinkingSteps, request.steps)
    assert.equal(state.thinkingSteps.value[0].label, 'B工具')
  }
})

test('提前完成一个会话不会清理其他会话的控制器和缓存', () => {
  const state = fixture()
  const first = state.requests.begin('A', { role: 'user', content: 'A问题' })
  state.current.value = 'B'
  state.messages.value = []
  const second = state.requests.begin('B', { role: 'user', content: 'B问题' })
  state.requests.finish(first)
  assert.deepEqual([...state.loadingIds.value], ['B'])
  assert.equal(state.controllers.value.B, second.controller)
  assert.equal(state.cache.value.B.messages, second.messages)
  second.controller.abort()
  assert.equal(first.controller.signal.aborted, false)
  state.requests.finish(second)
  assert.deepEqual([...state.loadingIds.value], [])
})

test('陈旧清理不能释放后继请求的锁', () => {
  const state = fixture()
  const first = state.requests.begin('A', { role: 'user', content: 'A问题' })
  state.requests.finish(first)
  const second = state.requests.begin('A', { role: 'user', content: '后继问题' })
  state.requests.finish(first)
  assert.equal(state.controllers.value.A, second.controller)
  assert.ok(state.loadingIds.value.has('A'))
})

test('准备失败只移除本次问答占位，保留既有消息及其他新增内容', () => {
  const state = fixture()
  const request = state.requests.begin('A', { role: 'user', content: '本次未发出' })
  request.messages.push({ role: 'user', content: '其他新增内容' })
  request.steps.push({ type: 'reasoning', label: '准备过程' })
  state.requests.discard(request)
  assert.deepEqual(
    request.messages.map((message) => message.content),
    ['A之前的问题', '其他新增内容'],
  )
  assert.deepEqual(state.thinkingSteps.value, [])
  assert.ok(state.loadingIds.value.has('A'))
  state.requests.finish(request)
  assert.equal(state.loadingIds.value.size, 0)
})

test('旧请求不能撤回后继请求的消息或覆盖其缓存', () => {
  const state = fixture()
  const first = state.requests.begin('A', { role: 'user', content: '旧请求' })
  state.requests.finish(first)
  const second = state.requests.begin('A', { role: 'user', content: '后继请求' })
  const cache = state.cache.value.A
  state.requests.discard(first)
  assert.equal(state.cache.value.A, cache)
  assert.equal(state.cache.value.A.messages.at(-2).content, '后继请求')
  assert.equal(state.controllers.value.A, second.controller)
})

test('保存未确认时释放锁但保留消息缓存，其他会话状态不变', () => {
  const state = fixture()
  const request = state.requests.begin('A', { role: 'user', content: '问题' })
  request.assistant.content = '未确认保存的内容'
  request.assistant.saveFailed = true
  state.controllers.value.B = new AbortController()
  state.loadingIds.value.add('B')
  state.requests.finish(request)
  assert.equal(state.loadingIds.value.has('A'), false)
  assert.equal(state.loadingIds.value.has('B'), true)
  assert.equal(state.cache.value.A.messages.at(-1).content, '未确认保存的内容')
})

test('后续新回复保存成功，也不能丢掉前面未确认的回复', () => {
  const state = fixture()
  const first = state.requests.begin('A', { role: 'user', content: '第一个问题' })
  first.assistant.saveFailed = true
  state.requests.finish(first)
  const next = state.requests.begin('A', { role: 'user', content: '第二个问题' })
  next.assistant.saveFailed = false
  state.requests.finish(next)
  assert.equal(state.cache.value.A.messages.length, 5)
  assert.equal(state.cache.value.A.messages[2].saveFailed, true)
})
