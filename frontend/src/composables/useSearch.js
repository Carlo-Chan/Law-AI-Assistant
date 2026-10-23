/**
 * 对话搜索 composable
 *
 * 支持三种匹配策略：
 * 1. 纯汉字子串匹配
 * 2. 拼音全拼匹配（如 "minfa" 匹配 "民法典"）
 * 3. 拼音首字母匹配（如 "mf" 匹配 "民法典"）
 * 4. 字符级模糊匹配（query 的每个字符按顺序在 title 中出现即可）
 */
import { pinyin } from 'pinyin-pro'

/**
 * 拼音模糊搜索：支持全拼、首字母匹配
 *
 * @param {string} title  对话标题
 * @param {string} query  搜索关键词（已转小写）
 * @returns {boolean} 是否匹配
 */
export function pinyinMatch(title, query) {
  const titlePinyin = pinyin(title, { toneType: 'none', type: 'array' }).join('').toLowerCase()
  const titleInitials = pinyin(title, { toneType: 'none', type: 'array' })
    .map((s) => s[0])
    .join('')
    .toLowerCase()
  return titlePinyin.includes(query) || titleInitials.includes(query)
}

/**
 * 字符级模糊匹配：query 的每个字符按顺序在 title 中出现即可
 *
 * @param {string} title  对话标题（已转小写）
 * @param {string} query  搜索关键词（已转小写）
 * @returns {boolean} 是否匹配
 */
export function fuzzyMatch(title, query) {
  let ti = 0
  for (let qi = 0; qi < query.length; qi++) {
    const qch = query[qi]
    let found = false
    while (ti < title.length) {
      if (title[ti] === qch) {
        found = true
        ti++
        break
      }
      ti++
    }
    if (!found) return false
  }
  return true
}
