import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDraftRecovery } from '../src/composables/draftRecovery.js'

function fixture() {
  const drafts = new Map()
  const busy = new Set()
  return {
    drafts,
    busy,
    recovery: createDraftRecovery({
      read: (owner) => drafts.get(owner) || { text: '', file: null },
      write: (owner, draft) => drafts.set(owner, draft),
      canRestore: (owner) => !busy.has(owner),
    }),
  }
}

test('空草稿直接恢复并保留原 File 引用及文字空白', () => {
  const { recovery, drafts } = fixture()
  const file = new File(['原文'], '合同.txt')
  assert.equal(recovery.recover('A', { text: '  原文字\n', file }), 'restored')
  assert.deepEqual(drafts.get('A'), { text: '  原文字\n', file })
})

test('纯空白新草稿也不能被旧内容覆盖', () => {
  const { recovery, drafts } = fixture()
  drafts.set('A', { text: '  ', file: null })
  assert.equal(recovery.recover('A', { text: '旧内容', file: null }), 'queued')
  assert.equal(recovery.resume('A'), false)
  assert.equal(drafts.get('A').text, '  ')
})

test('已有新附件时不替换或拼接，清空后按原组合恢复', () => {
  const { recovery, drafts } = fixture()
  const original = new File(['旧'], '旧.txt')
  const newer = new File(['新'], '新.txt')
  drafts.set('A', { text: '新指令', file: newer })
  recovery.recover('A', { text: '旧指令', file: original })
  assert.equal(drafts.get('A').file, newer)
  drafts.delete('A')
  assert.equal(recovery.resume('A'), true)
  assert.deepEqual(drafts.get('A'), { text: '旧指令', file: original })
  assert.equal(recovery.resume('A'), false)
})

test('多个失败请求依次恢复且会话之间隔离', () => {
  const { recovery, drafts, busy } = fixture()
  busy.add('A')
  busy.add('B')
  recovery.recover('A', { text: 'A一', file: null })
  recovery.recover('B', { text: 'B一', file: null })
  recovery.recover('A', { text: 'A二', file: null })
  busy.clear()
  recovery.resume('A')
  assert.equal(drafts.get('A').text, 'A一')
  assert.equal(recovery.resume('A'), false)
  drafts.delete('A')
  recovery.resume('A')
  assert.equal(drafts.get('A').text, 'A二')
  recovery.resume('B')
  assert.equal(drafts.get('B').text, 'B一')
})

test('完全相同的现有草稿无需重复排队', () => {
  const { recovery, drafts } = fixture()
  drafts.set('A', { text: '原文字', file: null })
  assert.equal(recovery.recover('A', { text: '原文字', file: null }), 'restored')
  drafts.delete('A')
  assert.equal(recovery.resume('A'), false)
})

test('恢复队列保存草稿快照，不受调用方对象随后修改影响', () => {
  const { recovery, drafts, busy } = fixture()
  busy.add('A')
  const draft = { text: '原文字', file: null }
  recovery.recover('A', draft)
  draft.text = '调用方的新文字'
  busy.clear()
  recovery.resume('A')
  assert.equal(drafts.get('A').text, '原文字')
})
