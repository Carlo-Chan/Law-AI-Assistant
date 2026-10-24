import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createTypewriterScope } from '../src/composables/useTypewriter.js'
import { LOADING_DOTS } from '../src/composables/conversationRequests.js'

function fixture(context) {
  context.mock.timers.enable({ apis: ['setInterval'] })
  const scope = createTypewriterScope()
  const intervals = context.mock.method(globalThis, 'setInterval')
  const cleared = context.mock.method(globalThis, 'clearInterval')
  context.after(() => scope.dispose())
  return { scope, intervals, cleared }
}

for (const [length, batch] of [
  [10, 1],
  [21, 2],
  [51, 4],
  [201, 10],
]) {
  test(`队列长度 ${length} 保持原有每帧 ${batch} 字符的逐字速度`, (context) => {
    const { scope, intervals } = fixture(context)
    const message = { content: LOADING_DOTS }
    const scroll = mock.fn()
    scope.appendToTypewriter(message, '文'.repeat(length), () => true, scroll)
    assert.equal(message.content, '')
    assert.equal(message.fullContent, '文'.repeat(length))
    assert.equal(intervals.mock.callCount(), 1)
    context.mock.timers.tick(30)
    assert.equal(message.content, '文'.repeat(batch))
    assert.equal(scroll.mock.callCount(), 1)
  })
}

test('连续片段共用一个任务，保留原有前缀并按顺序补全', (context) => {
  const { scope, intervals } = fixture(context)
  const message = { content: '已有前文' }
  scope.appendToTypewriter(message, '甲乙')
  scope.appendToTypewriter(message, '丙丁')
  assert.equal(intervals.mock.callCount(), 1)
  context.mock.timers.tick(30)
  assert.equal(message.content, '已有前文甲')
  scope.flushTypewriter(message)
  assert.equal(message.content, '已有前文甲乙丙丁')
  assert.equal(message.fullContent, message.content)
})

test('最后一帧立即释放定时器，后续片段可开启新任务但不重复正文', (context) => {
  const { scope, intervals, cleared } = fixture(context)
  const message = { content: '' }
  const scroll = mock.fn()
  scope.appendToTypewriter(message, '甲', () => true, scroll)
  context.mock.timers.tick(30)
  assert.equal(message.content, '甲')
  assert.equal(cleared.mock.callCount(), 1)
  context.mock.timers.tick(300)
  assert.equal(scroll.mock.callCount(), 1)
  scope.appendToTypewriter(message, '乙', () => true, scroll)
  assert.equal(intervals.mock.callCount(), 2)
  context.mock.timers.tick(30)
  assert.equal(message.content, '甲乙')
  assert.equal(cleared.mock.callCount(), 2)
})

test('取消后的旧帧不能消费后来新任务的队列，重复补齐不覆盖手动更新', (context) => {
  const { scope, intervals, cleared } = fixture(context)
  const message = { content: '' }
  scope.appendToTypewriter(message, '甲乙')
  const oldTick = intervals.mock.calls[0].arguments[0]
  scope.flushTypewriter(message)
  scope.appendToTypewriter(message, '丙丁')
  oldTick()
  assert.equal(message.content, '甲乙')
  context.mock.timers.tick(30)
  assert.equal(message.content, '甲乙丙')
  scope.flushTypewriter(message)
  assert.equal(message.content, '甲乙丙丁')
  message.content = '已由保存结果更新'
  scope.flushTypewriter(message)
  assert.equal(message.content, '已由保存结果更新')
  assert.equal(cleared.mock.callCount(), 2)
})

test('卸载仅释放本作用域全部任务，不清理其他页面实例的动画', (context) => {
  const { scope, cleared } = fixture(context)
  const other = createTypewriterScope()
  context.after(() => other.dispose())
  const first = { content: '' }
  const second = { content: '' }
  const independent = { content: '' }
  scope.appendToTypewriter(first, '第一段')
  scope.appendToTypewriter(second, '第二段')
  other.appendToTypewriter(independent, '独立页面')
  scope.dispose()
  scope.dispose()
  assert.equal(first.content, '第一段')
  assert.equal(second.content, '第二段')
  assert.equal(independent.content, '')
  assert.equal(cleared.mock.callCount(), 2)
  context.mock.timers.tick(30)
  assert.equal(independent.content, '独')
})

test('卸载后迟到片段继续补齐全文，但不创建定时器或滚动页面', (context) => {
  const { scope, intervals } = fixture(context)
  const message = { content: LOADING_DOTS }
  const scroll = mock.fn()
  scope.appendToTypewriter(message, '前半', () => true, scroll)
  scope.dispose()
  scope.appendToTypewriter(message, '后半', () => true, scroll)
  const lateMessage = { content: LOADING_DOTS }
  scope.appendToTypewriter(lateMessage, '新到片段', () => true, scroll)
  assert.equal(message.content, '前半后半')
  assert.equal(lateMessage.content, '新到片段')
  assert.equal(intervals.mock.callCount(), 1)
  assert.equal(scroll.mock.callCount(), 0)
  context.mock.timers.tick(300)
  assert.equal(scroll.mock.callCount(), 0)
})

test('后台片段直接补齐正文，不创建无用的动画任务', (context) => {
  const { scope, intervals } = fixture(context)
  const message = { content: LOADING_DOTS }
  const scroll = mock.fn()
  scope.appendToTypewriter(message, '后台正文', () => false, scroll)
  assert.equal(message.content, '后台正文')
  assert.equal(intervals.mock.callCount(), 0)
  assert.equal(scroll.mock.callCount(), 0)
})

test('活跃状态每帧重新判断，进入后台后补齐队列并停止滚动', (context) => {
  const { scope, cleared } = fixture(context)
  let active = true
  const message = { content: '' }
  const scroll = mock.fn()
  scope.appendToTypewriter(message, '完整正文', () => active, scroll)
  context.mock.timers.tick(30)
  assert.equal(message.content, '完')
  active = false
  context.mock.timers.tick(30)
  assert.equal(message.content, '完整正文')
  assert.equal(cleared.mock.callCount(), 1)
  assert.equal(scroll.mock.callCount(), 1)
})

test('空片段不清除占位、不分配全文或开启定时器', (context) => {
  const { scope, intervals } = fixture(context)
  const message = { content: LOADING_DOTS }
  scope.appendToTypewriter(message, '')
  assert.deepEqual(message, { content: LOADING_DOTS })
  assert.equal(intervals.mock.callCount(), 0)
})

test('定时器标识为零也只能启动一次并能正确清理', (context) => {
  const intervals = context.mock.method(globalThis, 'setInterval', () => 0)
  const cleared = context.mock.method(globalThis, 'clearInterval', () => {})
  const scope = createTypewriterScope()
  context.after(() => scope.dispose())
  const message = { content: '' }
  scope.appendToTypewriter(message, '甲')
  scope.appendToTypewriter(message, '乙')
  assert.equal(intervals.mock.callCount(), 1)
  scope.dispose()
  assert.equal(message.content, '甲乙')
  assert.deepEqual(cleared.mock.calls[0].arguments, [0])
})

test('无任务的消息不会被其他页面的补齐操作改写', (context) => {
  const { scope, cleared } = fixture(context)
  const message = { content: '当前正文', fullContent: '不应覆盖的旧全文' }
  scope.flushTypewriter(message)
  assert.equal(message.content, '当前正文')
  assert.equal(cleared.mock.callCount(), 0)
})
