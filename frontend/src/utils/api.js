/**
 * 后端 API 封装
 */
import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 180000,
})

/**
 * 法律咨询
 */
export async function chat(query, history = []) {
  const { data } = await api.post('/chat', { query, history })
  return data.data
}

/**
 * 合同审查（上传文件）
 */
export async function analyzeContract(file) {
  const formData = new FormData()
  formData.append('file', file)
  const { data } = await api.post('/analyze_contract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data.data
}
