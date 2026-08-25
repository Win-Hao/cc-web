/**
 * D8：src/engine 的公开面 —— 服务器只从这里拿引擎。
 *   Engine / claudeEngineFactory：真 claude 进程
 *   EngineLike + 事件 / 动作的类型：服务器和测试替身共用的契约
 * 进程层（process.ts）、能力探测（capabilities.ts）、回收池（pool.ts）、
 * 失败分类（diagnose.ts）是内部 seam，按需直接引用。
 */
export { Engine } from './engine.js'
export type { EngineOptions, ProtocolOptions } from './engine.js'
export { buildEngineArgs, claudeEngineFactory } from './factory.js'
export type { ClaudeEngineFactoryDeps } from './factory.js'
export type { EngineTrace, EngineTransport, ProcessSpec, TransportEvents } from './process.js'
export { ControlRequestError } from './types.js'
export type {
  ApprovalDecision,
  ApprovalRequest,
  ControlArgs,
  ControlPayload,
  ControlRequest,
  ControlSubtype,
  EngineEvents,
  EngineFactory,
  EngineFactoryOptions,
  EngineLike,
  PermissionMode,
  PromptImage,
  TurnEvent,
  TurnResult,
} from './types.js'
