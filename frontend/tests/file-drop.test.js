import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createFileDrop } from '../src/composables/fileDrop.js'

function mount(context) {
  const dom = new JSDOM('<main><p>合同</p><button>按钮</button></main><aside>侧边栏</aside>')
  const { document } = dom.window
  const panel = document.querySelector('main')
  const selected = []
  const warnings = []
  let enabled = true
  const drop = createFileDrop({
    isEnabled: () => enabled,
    onFile: (file) => selected.push(file),
    onWarning: (message) => warnings.push(message),
    onBlocked: () => warnings.push('操作中'),
  })
  drop.connect(panel)
  context.after(() => {
    drop.dispose()
    dom.window.close()
  })
  function dispatch(type, { target = panel, files = [], types = ['Files'], items = [] } = {}) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { files, types, items, dropEffect: 'none' },
    })
    target.dispatchEvent(event)
    return event
  }
  return {
    dom,
    document,
    panel,
    drop,
    dispatch,
    selected,
    warnings,
    disable: () => (enabled = false),
  }
}

test('文件内容尚不可读时通过类型显示提示，子元素进出不闪烁', (context) => {
  const view = mount(context)
  assert.equal(view.dispatch('dragenter').defaultPrevented, true)
  assert.equal(view.drop.active.value, true)
  view.dispatch('dragenter', { target: view.panel.firstChild })
  view.dispatch('dragleave', { target: view.panel.firstChild })
  assert.equal(view.drop.active.value, true)
  view.dispatch('dragleave')
  assert.equal(view.drop.active.value, false)
})

test('没有先收到进入事件时，经过事件也能恢复拖放提示和复制光标', (context) => {
  const view = mount(context)
  const event = view.dispatch('dragover')
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.dataTransfer.dropEffect, 'copy')
  assert.equal(view.drop.active.value, true)
})

test('单文件只在放下时交给附件入口，不提前读取或多次选择', (context) => {
  const view = mount(context)
  const file = new File(['合成合同'], '合同.txt')
  view.dispatch('dragenter', { files: [file] })
  view.dispatch('dragover', { files: [file] })
  assert.equal(view.selected.length, 0)
  assert.equal(view.dispatch('drop', { files: [file] }).defaultPrevented, true)
  assert.deepEqual(view.selected, [file])
  assert.equal(view.drop.active.value, false)
})

test('离开对话区后隐藏提示，侧边栏放下仍阻止浏览器导航但不添加附件', (context) => {
  const view = mount(context)
  const outside = view.document.querySelector('aside')
  view.dispatch('dragenter')
  const over = view.dispatch('dragover', { target: outside })
  assert.equal(view.drop.active.value, false)
  assert.equal(over.dataTransfer.dropEffect, 'none')
  assert.equal(over.defaultPrevented, true)
  const event = view.dispatch('drop', {
    target: outside,
    files: [new File(['合同'], '合同.txt')],
  })
  assert.equal(event.defaultPrevented, true)
  assert.equal(view.selected.length, 0)
  assert.equal(view.warnings.length, 0)
})

for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  test(`普通文字的 ${type} 不被拦截，不触发附件入口`, (context) => {
    const view = mount(context)
    const event = view.dispatch(type, { types: ['text/plain'] })
    assert.equal(event.defaultPrevented, false)
    assert.equal(view.drop.active.value, false)
    assert.equal(view.selected.length, 0)
    assert.equal(view.warnings.length, 0)
  })
}

test('有文件条目但 types 不完整时仍识别文件拖放', (context) => {
  const view = mount(context)
  view.dispatch('dragenter', { types: [], items: [{ kind: 'file' }] })
  assert.equal(view.drop.active.value, true)
})

test('拒绝多文件而不是悄悄取第一个', (context) => {
  const view = mount(context)
  view.dispatch('drop', { files: [new File([], '一.txt'), new File([], '二.pdf')] })
  assert.equal(view.selected.length, 0)
  assert.match(view.warnings[0], /一次只能添加一个/)
})

test('文件夹不作为普通文件接收', (context) => {
  const view = mount(context)
  view.dispatch('drop', {
    files: [new File([], '合同目录')],
    items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }],
  })
  assert.equal(view.selected.length, 0)
  assert.match(view.warnings[0], /文件夹/)
})

for (const broken of [false, true]) {
  test(`文件读取${broken ? '抛出异常' : '返回空列表'}时给出可操作提示`, (context) => {
    const view = mount(context)
    view.dispatch('drop', {
      items: broken
        ? [
            {
              kind: 'file',
              webkitGetAsEntry: () => {
                throw new Error('合成读取失败')
              },
            },
          ]
        : [],
    })
    assert.equal(view.selected.length, 0)
    assert.match(view.warnings[0], /重新拖入或点击/)
  })
}

test('放下前再次检查可用性，操作中不改写附件', (context) => {
  const view = mount(context)
  view.dispatch('dragenter')
  view.disable()
  const over = view.dispatch('dragover')
  assert.equal(over.dataTransfer.dropEffect, 'none')
  assert.equal(view.drop.active.value, false)
  view.dispatch('drop', { files: [new File([], '合同.txt')] })
  assert.deepEqual(view.warnings, ['操作中'])
  assert.equal(view.selected.length, 0)
})

for (const reason of ['escape', 'blur', 'visibility', 'reset']) {
  test(`${reason} 取消拖放提示，不改变草稿`, (context) => {
    const view = mount(context)
    view.dispatch('dragenter')
    if (reason === 'escape')
      view.document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    if (reason === 'blur') view.dom.window.dispatchEvent(new view.dom.window.Event('blur'))
    if (reason === 'visibility')
      view.document.dispatchEvent(new view.dom.window.Event('visibilitychange'))
    if (reason === 'reset') view.drop.reset()
    assert.equal(view.drop.active.value, false)
    assert.equal(view.selected.length, 0)
  })
}

test('更换区域后只接收新区域，重复连接不会累计监听', (context) => {
  const view = mount(context)
  const target = view.document.querySelector('aside')
  view.drop.connect(target)
  view.drop.connect(target)
  view.dispatch('drop', { files: [new File([], '旧.txt')] })
  view.dispatch('drop', { target, files: [new File([], '新.txt')] })
  assert.deepEqual(
    view.selected.map((file) => file.name),
    ['新.txt'],
  )
})

test('卸载撤销全局监听，重复卸载和重新连接均不能恢复处理器', (context) => {
  const view = mount(context)
  view.dispatch('dragenter')
  view.drop.dispose()
  view.drop.dispose()
  view.drop.connect(view.panel)
  assert.equal(view.drop.active.value, false)
  const event = view.dispatch('drop', { files: [new File([], '合同.txt')] })
  assert.equal(event.defaultPrevented, false)
  assert.equal(view.selected.length, 0)
})
