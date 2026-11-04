/**
 * jsdom 项目的测试环境开关（计划 §vitest：projects = node + jsdom）。
 * React 19 在非 act 环境下直接改 store 会打 "not configured to support act(...)" 告警，
 * 而这批面板测试全是「改 zustand → 断言 DOM」，必须显式打开 act 环境。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
