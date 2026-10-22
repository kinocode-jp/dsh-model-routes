// モデルごとの「モデル一覧に表示する」トグル用のホストサービス。
// 設定画面「モデル」のカードから、DSH の内部通信(Typert)で呼ぶ。
import { plainJson } from './auth-contracts.js'
import { createMessages } from './auth-messages.js'

/**
 * @param deps.state     () => buildModelsState の結果 { groups: [...] }
 * @param deps.setFlag   (routeId, modelId, visible) => Promise<void> 表示/非表示を保存して反映する
 * @param deps.reset     (routeId) => Promise<void> そのルートの設定を既定に戻す
 * @param deps.setRoute  (providerId, kind, enabled) => Promise<object> 既存のルート切り替えを呼ぶ
 * @param deps.messages  (key, params) => 画面に出す文言
 */
export function createModelsService({ state, setFlag, reset, setRoute, messages = createMessages() }) {
  const groupOf = routeId => {
    const group = state().groups.find(item => item.routeId === routeId)
    if (!group) throw new TypeError(messages('unknownRoute'))
    return group
  }
  const api = {
    async getModels() { return plainJson(state()) },
    async setRouteEnabled(routeId, enabled) {
      const group = groupOf(routeId)
      if (typeof enabled !== 'boolean') throw new TypeError('Invalid enabled')
      await setRoute(group.providerId, group.kind, enabled)
      return plainJson(state())
    },
    async setModelVisible(routeId, modelId, visible) {
      const group = groupOf(routeId)
      const model = group.models.find(item => item.id === modelId)
      if (!model) throw new TypeError(messages('unknownModel'))
      // API 枠の最後の1つは隠せない: 設定画面のキー入力欄が消えるため。
      if (!visible && model.visible && group.lastLocked) throw new TypeError(messages('lastModel'))
      await setFlag(routeId, modelId, visible)
      return plainJson(state())
    },
    async resetModels(routeId) {
      groupOf(routeId)
      await reset(routeId)
      return plainJson(state())
    },
  }
  Object.defineProperty(api, 'typertRemote', { value: { service: api, serviceKey: 'modelRoutesModels', namespace: 'modelRoutesModels' } })
  return api
}
