import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getContractUploadError, MAX_CONTRACT_FILE_BYTES } from '../src/utils/upload.js'

test('历史附件的文件名对象不能被当作真实文件发送', () => {
  const error = getContractUploadError({ name: '合同.pdf' })
  assert.equal(typeof error, 'string')
  assert.ok(error.includes('重新选择'))
})

test('伪造名称和大小的普通对象仍不能通过附件校验', () => {
  const error = getContractUploadError({ name: '合同.pdf', size: 10, type: 'application/pdf' })
  assert.ok(error.includes('重新选择'))
})

test('缺失附件和非文件值得到明确提示，而不是抛出异常', () => {
  for (const value of [undefined, null, '', '[object Object]', new Blob(['合同'])]) {
    assert.ok(getContractUploadError(value).includes('重新选择'))
  }
})

test('当前内存中的真实附件仍可通过校验', () => {
  const file = new File(['合同正文'], '合同.txt', { type: 'text/plain' })
  assert.equal(getContractUploadError(file), '')
})

test('真实空文件仍沿用原有允许选择的行为', () => {
  assert.equal(getContractUploadError(new File([], '空合同.txt')), '')
})

test('真实文件恰好达到大小上限时仍允许选择', () => {
  const file = new File([new ArrayBuffer(MAX_CONTRACT_FILE_BYTES)], '合同.pdf')
  assert.equal(getContractUploadError(file), '')
})

test('真实文件超过大小上限时仍返回原有超限提示', () => {
  const file = new File([new ArrayBuffer(MAX_CONTRACT_FILE_BYTES + 1)], '合同.pdf')
  assert.equal(getContractUploadError(file), '合同文件不能超过 10 MiB，请压缩或拆分后重试。')
})
