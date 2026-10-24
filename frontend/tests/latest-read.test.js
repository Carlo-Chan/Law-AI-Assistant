import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLatestRead } from '../src/composables/latestRead.js'

test('开始新读取只取消前一个，迟到收尾不能清掉后来任务', () => {
  const scope = createLatestRead()
  const old = scope.begin()
  const latest = scope.begin()
  assert.equal(old.signal.aborted, true)
  assert.equal(scope.isCurrent(old), false)
  assert.equal(scope.isCurrent(latest), true)
  scope.finish(old)
  assert.equal(scope.isCurrent(latest), true)
  scope.finish(latest)
  assert.equal(scope.isCurrent(latest), false)
  assert.equal(latest.signal.aborted, false)
})

test('取消子读取不反向取消父请求，后续读取仍正常', () => {
  const scope = createLatestRead()
  const parent = new AbortController()
  const old = scope.begin({ signal: parent.signal })
  const latest = scope.begin({ signal: parent.signal })
  assert.equal(old.signal.aborted, true)
  assert.equal(parent.signal.aborted, false)
  assert.equal(latest.signal.aborted, false)
  scope.dispose()
  assert.equal(latest.signal.aborted, true)
  assert.equal(parent.signal.aborted, false)
})

test('父请求取消会终止当前读取并立即解绑取消监听', (context) => {
  const scope = createLatestRead()
  const parent = new AbortController()
  const removed = context.mock.method(parent.signal, 'removeEventListener')
  const read = scope.begin({ signal: parent.signal })
  parent.abort()
  assert.equal(read.signal.aborted, true)
  assert.equal(scope.isCurrent(read), false)
  assert.equal(removed.mock.callCount(), 1)
  scope.finish(read)
  scope.dispose()
  assert.equal(removed.mock.callCount(), 1)
})

for (const action of ['finish', 'cancel', 'dispose']) {
  test(`${action} 会解绑父信号监听，迟到父取消不再影响已释放的读取`, (context) => {
    const scope = createLatestRead()
    const parent = new AbortController()
    const added = context.mock.method(parent.signal, 'addEventListener')
    const removed = context.mock.method(parent.signal, 'removeEventListener')
    const read = scope.begin({ signal: parent.signal })
    if (action === 'finish') scope.finish(read)
    else scope[action]()
    assert.equal(removed.mock.callCount(), 1)
    assert.equal(removed.mock.calls[0].arguments[1], added.mock.calls[0].arguments[1])
    const aborted = read.signal.aborted
    parent.abort()
    assert.equal(read.signal.aborted, aborted)
    scope.finish(read)
    assert.equal(removed.mock.callCount(), 1)
  })
}

test('父信号预先取消时不开始读取，也不干扰已有独立请求', () => {
  const scope = createLatestRead()
  const active = scope.begin()
  const parent = new AbortController()
  parent.abort()
  assert.equal(scope.begin({ signal: parent.signal }), null)
  assert.equal(scope.isCurrent(active), true)
  assert.equal(active.signal.aborted, false)
  scope.dispose()
})

test('按身份取消只影响对应读取，不误停其他会话的历史加载', () => {
  const scope = createLatestRead()
  const read = scope.begin({ key: 'A' })
  assert.equal(scope.cancel('B'), false)
  assert.equal(scope.isCurrent(read), true)
  assert.equal(scope.cancel('A'), true)
  assert.equal(read.signal.aborted, true)
  assert.equal(scope.cancel('A'), false)
})

test('卸载可重复执行，拒绝新任务，其他读取作用域不受影响', () => {
  const history = createLatestRead()
  const list = createLatestRead()
  const first = history.begin()
  const independent = list.begin()
  history.dispose()
  history.dispose()
  assert.equal(first.signal.aborted, true)
  assert.equal(history.begin(), null)
  assert.equal(history.isCurrent(null), false)
  assert.equal(list.isCurrent(independent), true)
  list.dispose()
})
