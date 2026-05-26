# Headless SillyTavern Pipeline Parity

目标：headless API、Telegram、CLI 等入口必须走同一条生成链路，并且这条链路要复用或严格移植原始 SillyTavern Web UI 的 prompt 拼接和大模型请求规则。不能用简化版 prompt 代替原始酒馆行为。

## 原始权威链路

- `public/script.js`
  - `Generate()`：生成入口，负责聊天历史、角色字段、first message、附件、reasoning、world info、extension prompts、instruct mode、上下文预算等总编排。
  - `sendGenerationRequest()`：按 `main_api` 分派到 chat-completion、text-completion、NovelAI、Kobold 等请求入口。
- `public/scripts/openai.js`
  - `prepareOpenAIMessages()`：Chat Completion 模式的最终 message 构造入口。
  - `preparePromptsForChatCompletion()`：角色描述、personality、scenario、persona、world info、jailbreak、bias、quiet prompt、group nudge、extension prompt 的合并规则。
  - `populateChatHistory()` / `populateDialogueExamples()`：历史消息和示例对话的预算、角色、name、空消息、continue nudge、媒体消息处理。
  - `sendOpenAIRequest()` / `getStreamingReply()`：请求参数生成、发送、流式响应解析。
- `public/scripts/PromptManager.js`
  - Prompt collection、prompt order、enabled/disabled、marker、role、identifier、injection position 等规则。
- `public/scripts/world-info.js`
  - `getWorldInfoPrompt()`：世界书扫描、递归、depth、budget、角色书、全局书、位置注入规则。
- `public/scripts/instruct-mode.js`
  - Instruct 模式下 story string、示例、聊天历史、停止词等格式化规则。
- `src/endpoints/backends/chat-completions.js`
  - 原始后端对 OpenAI、Claude、Gemini、OpenRouter、Mistral、Custom 等 provider 的请求体构造和转发规则。

## 当前 headless 差距

- `src/headless/prompt.js` 仍是 legacy simplified prompt compiler，只覆盖角色基础字段、简单宏、简单世界书匹配和聊天历史。
- 还没有完整移植原始 `Generate()`、`PromptManager`、`getWorldInfoPrompt()`、instruct mode 和 token budget pipeline。
- 还没有让 Telegram/API/CLI 统一调用完整 SillyTavern prompt pipeline。

## 已开始迁移的原始规则

- `src/headless/st-pipeline/chat-completion-reply.js` 移植了 `public/scripts/openai.js:getStreamingReply()` 的 provider-specific response extraction 规则。
- `src/headless/generation.js` 的 OpenAI-compatible provider 已改为使用该规则解析流式和非流式响应，避免只读取 `choices[0].delta.content` 导致兼容 provider 返回空。
- `src/headless/st-pipeline/chat-completion-parameters.js` 开始移植 `public/scripts/openai.js:createGenerationParameters()` 的 Chat Completion 请求参数构造规则，覆盖采样参数、max tokens、stop、seed、o-series、GPT-5、OpenRouter、Claude、Gemini、Mistral、Cohere 等 provider-specific 字段。
- `src/headless/st-pipeline/chat-completion-prompt.js` 开始移植 `PromptManager` 的 Chat Completion prompt definitions 和 `prompt_order` 展开方式，headless 不再把角色信息手写成单个大 system prompt。
- `src/headless/generation.js` 的 OpenAI-compatible 请求已开始使用该参数构造模块，导入的酒馆 OpenAI 预设会进入实际模型请求体。
- `tests/headless/prompt.test.js` 覆盖 prompt order、导入 OpenAI 预设 prompts、角色字段、世界书、示例对话和聊天历史展开。
- `tests/headless/st-pipeline.test.js` 覆盖 OpenAI-compatible fallback、reasoning、OpenRouter image/signature、Claude、Mistral、请求参数映射和 o-series 转换。
- `tests/headless/headless-api.test.js` 覆盖导入预设后，真实 OpenAI-compatible 请求体包含 `temperature`、`top_p`、penalty、`max_tokens`、`stop` 等字段。

## 下一步必须完成

1. 建立 headless generation plan adapter，输入 session/chat/character/preset/worldbook/model profile，输出与原始 Web UI 等价的 messages/request body。
2. 迁移 `PromptManager` prompt collection 和 prompt order，不再手写系统 prompt 拼接。
3. 迁移 `getWorldInfoPrompt()`，支持世界书预算、递归、depth、角色书、全局书和注入位置。
4. 迁移 instruct mode、example dialogue、chat history token budgeting、stop strings、continue/regenerate 的原始规则。
5. 对 Telegram/API/CLI 做统一入口，全部调用同一个 headless pipeline。
6. 增加 parity tests：固定角色卡、预设、世界书、聊天历史，对比 headless 输出和原始 Web UI pipeline 输出。
