/**
 * 余额查询（宿主侧入口）—— **转发**到共享核心的实现。
 *
 * ## 为什么只是一个转发
 *
 * 取数逻辑原本就在这里，后来按用户要求把余额取数**搬到桌宠侧**
 * （桌宠自己取，改完只需重启桌宠、不必重启 DSH），于是它被移到了
 * `src/shared-core/balance.js` —— 那样宿主与桌宠能读**同一份**，
 * 口径不会漂移。
 *
 * ⚠️ 这里**刻意只做转发，不再实现任何逻辑**。
 * 之前吃过"同一份东西在两处各写一套、慢慢漂移"的亏（动作清单、
 * 随机动作的触发参数都踩过），所以宁可多一个转发文件，
 * 也不留两份取数代码。
 *
 * 宿主侧仍然需要它：`DSHpet_balance` 工具是用户显式查询，得能拿到数。
 *
 * > 历史说明：这里最初写着"API Key 绝不能进桌宠进程"。后来发现
 * > DSH 把密钥**明文**存在 `$DSH_HOME/.credentials.yaml`，本机任何进程都能读 ——
 * > 那条边界本来就不存在。现在的分工是：宿主与桌宠都能取数，
 * > 但**日常的自动刷新与播报由桌宠负责**（宿主只在工具被调用时按需查询），
 * > 而密钥始终只进各自的**主进程**、绝不进渲染进程。
 */

export {
  BALANCE_SOURCE,
  DEFAULT_API_BASE,
  DEFAULT_CREDENTIAL,
  normalizeApiBase,
  normalizeBalanceResponse,
  createBalanceFetcher,
} from '../shared-core/balance.js'
