// 工具层可预期错误：消息会原样返回给模型（IsError 结果），用于其自我纠正。
// 与之相对，其他异常会被内核包装为 "error invoking Agent capability handler"。
export class ToolError extends Error {}
