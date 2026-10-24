/** 重跑共用的过程记录与一次性结束状态，正文可由调用方独立预览。 */
export function createRegenerationProgress({ onSteps = () => {}, onToken = () => {} } = {}) {
  const state = { steps: [], terminal: null, failure: '' }
  const active = () => !state.terminal && !state.failure
  const publish = () => onSteps([...state.steps])
  state.callbacks = {
    onThinking(label) {
      if (!active()) return
      state.steps.push({ type: 'tool', label })
      publish()
    },
    onReasoning(text) {
      if (!active()) return
      if (state.steps.at(-1)?.type === 'reasoning') state.steps.at(-1).label = text
      else state.steps.push({ type: 'reasoning', label: text })
      publish()
    },
    onReasoningToken(text) {
      if (!active()) return
      if (state.steps.at(-1)?.type !== 'reasoning')
        state.steps.push({ type: 'reasoning', label: '' })
      state.steps.at(-1).label += text
      publish()
    },
    onToolChunk(tool, text, first) {
      if (!active()) return
      if (first) state.steps.push({ type: 'done', label: tool + ' 完成', snippet: text })
      else if (state.steps.at(-1)?.type === 'done') state.steps.at(-1).snippet += text
      publish()
    },
    onToolResult(tool, output) {
      if (!active()) return
      state.steps.push({ type: 'done', label: tool + ' 完成', snippet: output })
      publish()
    },
    onToken(text) {
      if (active()) onToken(text)
    },
    onDone(event) {
      if (active()) state.terminal = event
    },
    onError(message) {
      if (active())
        state.failure = typeof message === 'string' && message ? message : '重新生成未完成。'
    },
  }
  return state
}
