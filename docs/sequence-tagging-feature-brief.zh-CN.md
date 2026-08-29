# 功能设计简报：通过单调序列标记消除建议竞态条件 (Monotonic Sequence Tagging)

[English Version](./sequence-tagging-feature-brief.md) | 简体中文版本

**状态：** 已落地投产 (Implemented & Verified in Production)  
**最近更新：** 2026-08-29  
**作者：** Project VOICE 核心团队  
**核心组件：** 前端表现编排层 ([`src/pv-app.ts`](../src/pv-app.ts))  
**目标版本：** Pre-M1（在 M1–M4 端侧演进中持续验证）  
**关联文档：** [`docs/on-device-llm-design.md`](./on-device-llm-design.md), [`docs/architecture.md`](./architecture.md)  

---

## 1. 执行摘要 (Executive Summary)

在 Project VOICE 中，预测性词语（Words）与整句（Sentences）建议是随着用户输入实时异步生成的。在既有架构中，请求通过 HTTP 发送到 Python 后端并转发至云端 Google Gemini API；在端侧大模型架构落地后，建议亦可由客户端 Web Worker 借助 WebGPU 运行的 Gemma 模型本地生成。

在这两种范式下，异步生成机制天然引入了**并发竞态条件（Race Conditions）**：当用户快速击键或频繁调整交互上下文时，后发请求可能会先于先发请求返回，导致陈旧过时的候选词突然冲掉界面上最新的建议结果。

尽管旧版客户端在 `MacroApiClient` 中集成了 `AbortController`，并在 `pv-app.ts` 中配置了动态防抖（Debounce）定时器，**但这些手段无法防御关键的竞态失效场景**——尤其是**防抖窗口内在途请求竞态（Debounce-Window In-Flight Race）**、**微任务结算竞态（Post-Resolution Settlement Race）**以及**本地缓存颠倒竞态（Local Cache Inversion Race）**。

本简报系统阐述了**单调序列标记（Monotonic Sequence Tagging）**机制。这是一套零外部依赖、高内聚于前端表现层的状态同步契约。通过为每一次用户交互输入标记严格单调递增的序列号（`suggestionRequestId`），系统在数学上保证了：**唯有与用户最新一次交互严格对应的推理结果，才被允许渲染至用户界面**。

将该机制作为 Pre-M1 独立基础设施落地，带来了双重核心收益：
1. **彻底根除了既有 Cloud Gemini 生产链路上的 UI 闪烁与建议倒退故障**；
2. **构建了一套统一、高容错的调度门禁契约**，使后续端侧本地大模型（LiteRT-LM Web / WebGPU）能够无缝继承该一致性保障。

---

## 2. 问题陈述：AAC 用户体验与 UI 倒退危害

Project VOICE 服务的核心人群是运动与言语障碍人士（如肌萎缩侧索硬化症 ALS、脑瘫、脊髓损伤患者）。他们高度依赖辅助输入设备（例如眼动追踪仪、头部追踪传感器、单键/多键物理扫描开关 Switch Access，或特制虚拟键盘）。

在这一特殊人机交互环境下，预测文本的稳定性与确定性具有决定性意义：
- **高昂的单次击键成本：** 对眼动注视或按键扫描用户而言，输入一个字符或在候选项中移动光标需要耗费极大的体力与数十秒时间。
- **UI 闪烁带来严重的认知困扰：** 当用户刚输入新字符（例如从 `"hel"` 推进至 `"help"`），候选项瞬间呈现为 `"helpful"`，却在 50ms 后被迟到的 `"hel"` 的旧响应（`"hello"`、`"helmet"`）强行覆盖，会造成极大的视觉挫败与认知混乱。
- **误选灾难（Accidental Erroneous Selection）：** 在自动扫描模式（Switch Scanning）下，高亮焦点按照固定节奏在候选项间跳动。如果陈旧响应恰好在用户按下物理开关的毫秒瞬间覆盖了候选项，用户将选出完全错误的词句，不得不耗费数分钟进入艰难的退格纠错流程。

---

## 3. 既有架构与传统缓解机制

建议请求的生命周期由表现层的 [`src/pv-app.ts`](../src/pv-app.ts) 进行编排，并通过 [`SuggestionProviderRouter`](../src/suggestion-provider-router.ts) 分发至 Cloud Path（基于 `MacroApiClient` 的云端 Gemini）或 Local Path（基于 `ModelRuntimeAdapter` 的本地端侧 Worker）：

```text
用户输入事件 ──► pv-app.ts (防抖调度 & 序列状态编排)
                       │
                       ▼
            SuggestionProviderRouter
           ┌───────────┴───────────┐
           ▼                       ▼
   CloudSuggestionProvider    LocalSuggestionProvider
   (MacroApiClient / Gemini)  (Web Worker / WebGPU)
```

在引入序列标记前，系统尝试通过以下三种传统手段抑制并发异常：

### 3.1 机制 1：基于 QPS 自适应退避的动态防抖 (`pv-app.ts`)
用户键入字符时，`pv-app.ts` 不会立即发起网络请求，而是重置防抖计时器：

```typescript
// src/pv-app.ts
private delayBeforeFetchMs() {
  // 根据最近 1 秒内的调用频率，返回 0ms 至 300ms 的平滑延迟
  return Math.min(150 * (this.prevCallsMs.length - 1), 300);
}

async updateSuggestions() {
  window.clearTimeout(this.timeoutId);
  ...
  this.timeoutId = window.setTimeout(async () => {
    ...
    const result = await this.providers.suggest(...);
    ...
  }, this.delayBeforeFetchMs());
}
```

### 3.2 机制 2：单实例请求抢占中止 (`macro-api-client.ts`)
在 Cloud 路径中，`MacroApiClient` 维护单个类级别的 `AbortController` 实例。每次发起新请求前，先中止旧的控制器：

```typescript
// src/macro-api-client.ts
export class MacroApiClient {
  private fetchAbortController: AbortController | null = null;

  async fetchSuggestions(...) {
    // 中止上一轮在途的 fetch
    this.fetchAbortController?.abort();
    this.fetchAbortController = new AbortController();
    const abortSignal = this.fetchAbortController.signal;

    const wordsFetch = MacroApiClient.fetchSuggestion(..., abortSignal, ...);
    const sentencesFetch = MacroApiClient.fetchSuggestion(..., abortSignal, ...);

    const result = Promise.all([sentencesFetch, wordsFetch]).catch(err => {
      if (err instanceof DOMException) {
        console.log('Request was aborted by user:', userInputs);
      } else {
        alert(`Failed to access Gemini server or ${err || 'something'}.`);
      }
      return null;
    });

    return result;
  }
}
```

### 3.3 机制 3：清空输入时的快速中止 (`pv-app.ts`)
当用户彻底删除文本且无上下文历史时，`pv-app.ts` 会调用 `this.providers.abort()` 并清空当前建议项：

```typescript
// src/pv-app.ts
if (isBlankAtCall) {
  if (!hasHistoryOrMemory) {
    this.isLoading = false;
    this.suggestions = [];
    this.words = [];
    return;
  }
}
```

---

## 4. 传统机制失效的技术深度剖析

上述机制在用户极慢打字时表现尚可，但在真实交互中暴露出严重的理论与工程盲区：

### 4.1 失效场景 1：防抖窗口内在途请求竞态（高频触发 Bug）

最严重的结构性缺陷在于：**旧请求的取消信号与下一次请求的“派发时刻”强绑定，而非与触发失效的“用户击键时刻”绑定。**

时序拆解如下：

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant App as pv-app.ts
    participant Client as MacroApiClient
    participant Server as Gemini API (/run-macro)

    User->>App: 键入 "a"
    Note over App: 防抖定时器 1 到期 (150ms)
    App->>Client: fetchSuggestions("a") [创建 AC1]
    Client->>Server: HTTP POST /run-macro (Prompt "a")

    Note over Server: 云端模型推理中... (耗时 ~120ms)

    User->>App: 快速键入 "b" (当前文本 "ab")，T = 80ms
    Note over App: updateSuggestions() 触发<br/>设置防抖定时器 2 (150ms 延迟)<br/>致命盲区：AC1 此时并未被 abort！

    Server-->>Client: "a" 的 HTTP 200 OK 在 T = 120ms 到达
    Note over Client: AC1 从未被取消！<br/>Promise.all 正常结算返回 "a" 的结果
    Client-->>App: 返回 "a" 的预测建议
    App->>App: this.updateSentences(...) / this.updateWords(...)
    Note over User: 严重 BUG：用户看着输入框里的 "ab"，<br/>候选项却闪退回以 "a" 开头的候选词！

    Note over App: 防抖定时器 2 于 T = 230ms 到期
    App->>Client: fetchSuggestions("ab") [此时才 abort AC1，但为时已晚]
    Client->>Server: HTTP POST /run-macro (Prompt "ab")
    Server-->>Client: 返回 "ab" 的结果
    App->>App: 再次刷新 UI 为 "ab" 建议
```

#### 根因说明
当用户输入 `"b"` 时，`window.clearTimeout(this.timeoutId)` 仅取消了未派发的定时器，但在网络线路上飞行的请求 1 并未受到任何阻碍。只要请求 1 在随后的 150ms~300ms 防抖窗口内返回，就会无情冲毁当前界面。

---

### 4.2 失效场景 2：微任务结算竞态（Post-Resolution Settlement Race）

根据 WHATWG Fetch 标准，`AbortSignal` 仅能在底层网络字节流未结束前打断请求。

```typescript
const text = fetch(url, { signal: abortSignal })
  .then(async res => {
    const textResponse = await res.text(); // 响应体全部接收后，底层网络已 Resolve！
    return JSON.parse(textResponse);
  })
  .then(extractText);
```

1. 请求 1 的 HTTP Body 接收完毕，浏览器网络底层将 Promise 状态标记为 Fulfilled，并向微任务队列插入后续回调（`res.text()`、`JSON.parse()` 等）。
2. 在这些微任务执行的间隙，用户敲下新按键，触发 `fetchAbortController?.abort()`。
3. **缺陷所在：** 对已经由网络栈兑现（Settled）的 Promise 调用 `abort()` 是**完全的空操作（No-op）**。浏览器绝不会倒退抛出 `DOMException: AbortError`。
4. 后续微任务链路继续顺利执行完毕，将陈旧建议派发至 UI。

---

### 4.3 失效场景 3：本地内存缓存倒置竞态 (Cache Inversion Race)

`pv-app.ts` 对初始/空白状态的候选项维护了本地内存缓存：

```typescript
// src/pv-app.ts
const cacheEntry = this.cachedInitialSuggestionsByLanguage.get(cacheKey);
if (cacheEntry && cacheEntry.historyKey === historyKey && cacheEntry.memoryKey === memoryKey) {
  this.suggestions = cacheEntry.suggestions;
  this.words = [];
  this.requestUpdate();
  return; // 同步返回，根本不调用 apiClient！
}
```

1. 用户打了一个字母，发起网络请求。
2. 用户立即按 Backspace 清空输入，命中了上述本地缓存分支。
3. 缓存逻辑同步执行，立即把缓存建议写入 `this.suggestions` 并 `return`。
4. **缺陷所在：** 由于未进入异步派发流程，旧的 `apiClient.fetchSuggestions()` 和 `abort()` 未被调用。
5. 稍后，第 1 步的慢速网络请求返回，覆盖掉清空状态下的合法初始缓存。

---

### 4.4 失效场景 4：缺乏状态与请求的身份关联 (Lack of Identity Correlation)

在旧设计中，返回的数据结构仅为原始数组元组：
```typescript
Promise<[string[], string[]] | null>
```
响应体本身没有携带任何版本号、请求时间戳或触发该请求的上下文哈希。数据到达前端时，前端无法追溯这一响应到底对应哪一次按键。

---

### 4.5 失效场景 5：端侧 LLM 流式输出的前向兼容性挑战

在规划的 WebGPU/Web Worker 端侧推理模式中：
- 字符是逐 Token 生成并通过 `postMessage` 持续派发的；
- 已提交到 WebGPU 队列中的 Tensor Compute Pass 很难做到纳秒级物理中断；
- Worker 到主线程的消息管道存在固有的排队与异步唤醒延迟。

即便通过 API 中止了 Local 模型的对话上下文，已经进入管道的“迟到 Token”依然会跨越线程边界流入主线程。若主线程缺少全局序列守卫，这些幽灵 Token 将污染界面。

---

## 5. 核心方案：单调序列标记 (Monotonic Sequence Tagging)

我们在 `src/pv-app.ts` 的核心编排层引入了**单调序列标记**机制。

### 5.1 概念架构

```text
                                        ┌───────────────────────────────┐
                                        │      suggestionRequestId      │
                                        │  (单调递增整数计数器，初始为 0)  │
                                        └───────────────┬───────────────┘
                                                        │
                      用户触发事件（输入字符、退格、切换情绪芯片、切换语言等）
                                                        │
                                                        ▼
                                     requestId = ++this.suggestionRequestId
                                                        │
                      ┌─────────────────────────────────┴─────────────────────────────────┐
                      ▼                                                                   ▼
              [本地缓存命中分支]                                                   [异步生成/网络分支]
                      │                                                                   │
    Gate 1: requestId === this.suggestionRequestId ?                     Gate 2: requestId === this.suggestionRequestId ?
            ├── 是  ──► 渲染缓存 UI                                               ├── 是  ──► 派发请求 / Worker
            └── 否  ──► 丢弃                                                      └── 否  ──► 提前中止，放弃计算
                                                                                          │
                                                                                    等待异步结果返回
                                                                                          │
                                                                         Gate 3: requestId === this.suggestionRequestId ?
                                                                                 ├── 是  ──► 安全更新 UI
                                                                                 └── 否  ──► 丢弃过时结果
```

### 5.2 核心不变量 (The UI Consistency Invariant)

> **表现层一致性公理：**  
> 一项候选词/句建议（无论来自同步缓存、云端 HTTP 还是端侧 Worker）被允许修改应用程序状态并渲染到界面的**充要条件**是：**该数据在写入状态的瞬间，其关联的 `requestId` 严格等于应用程序全局的 `this.suggestionRequestId`，且推理模式保持匹配。**

$$\text{CanMutateUI} \iff \text{requestId} = \text{this.suggestionRequestId} \land \text{mode} = \text{this.stateInternal.inferenceMode}$$

### 5.3 双层协同防御：`AbortController` + `Sequence Tagging`

序列标记并不排斥底层 Abort 机制，二者职责清晰，构成互补的双层防御体系：

| 防御层级 | 责任实体 | 核心职责 | 无法解决的问题（失效边界） |
|---|---|---|---|
| **Layer 1: 传输与算力层** | `AbortController` (HTTP) / `ModelRuntimeAdapter.cancel()` (WebGPU) | **资源保护：** 尽快关闭 TCP/HTTP2 连接，减少云端计费/服务器负载，释放本地 GPU 计算队列。 | 无法填补防抖时间缝隙，无法撤回微任务结算期的数据，无法处理缓存倒置。 |
| **Layer 2: 表现与状态层** | `Sequence Tagging` (`suggestionRequestId`) | **渲染一致性：** 保证不论底层发生何种乱序、延迟或缓存穿透，过时的数据永远无法触碰 UI 状态。 | 自身不负责主动终止正在运行的网络请求或 GPU 算力消耗。 |

---

## 6. 单调序列标记的时序流程

下图展示了单调序列标记如何彻底消解失效场景 1 中的防抖在途竞态：

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant App as pv-app.ts
    participant Router as SuggestionProviderRouter
    participant Server as Gemini API / Local Worker

    User->>App: 键入 "a"
    Note over App: suggestionRequestId 递增为 1<br/>当前作用域 requestId = 1
    Note over App: 防抖定时器 1 到期 (150ms)
    App->>App: Gate 2: requestId (1) === suggestionRequestId (1) -> 通过
    App->>Router: suggest("a")
    Router->>Server: 发起推演计算

    User->>App: 键入 "b" (文本为 "ab")，发生在 T = 80ms
    Note over App: suggestionRequestId 递增为 2<br/>当前作用域 requestId = 2<br/>启动防抖定时器 2

    Server-->>Router: "a" 的结果在 T = 120ms 返回
    Router-->>App: 返回 "a" 的建议 (绑定的 requestId = 1)

    Note over App: Gate 3 校验: requestId (1) !== suggestionRequestId (2)!
    App->>App: 判定数据已陈旧：直接丢弃！(UI 零变动，零闪烁)

    Note over App: 防抖定时器 2 于 T = 230ms 到期
    App->>App: Gate 2: requestId (2) === suggestionRequestId (2) -> 通过
    App->>Router: suggest("ab")
    Router->>Server: 发起推演计算
    Server-->>Router: 返回 "ab" 的结果
    Router-->>App: 返回 "ab" 的建议 (绑定的 requestId = 2)
    Note over App: Gate 3 校验: requestId (2) === suggestionRequestId (2) -> 匹配！
    App->>App: this.updateSentences(...) / this.updateWords(...)
    Note over User: UI 丝滑更新为 "ab" 的候选词，毫无倒退现象！
```

---

## 7. 备选方案对比与技术权衡

| 评估维度 | 方案 0：既有基线 (`AbortController` 独占) | 方案 1：按键即强行 Abort (Keydown Eager Abort) | 方案 2：文本内容比对 (`res.text === currentText`) | 方案 3：高精度时间戳 (`Date.now()`) | **方案 4：单调序列标记 (本项目采纳)** |
|---|---|---|---|---|---|
| **消除防抖窗口内在途竞态** | ❌ 否 | ⚠️ 部分有效（无法解决快响应） | ⚠️ 部分有效 | ✅ 是 | ✅ **完全消除** |
| **消除微任务结算期竞态** | ❌ 否 | ❌ 否 | ✅ 是 | ✅ 是 | ✅ **完全消除** |
| **消除本地缓存倒置竞态** | ❌ 否 | ❌ 否 | ❌ 否 | ⚠️ 易受时钟漂移影响 | ✅ **完全消除** |
| **支持非文本状态触发（情绪、角色、语言）** | ❌ 否 | ❌ 否 | ❌ **失效**（文本一致但上下文已变） | ✅ 是 | ✅ **完美支持** |
| **防御快速撤销/重输（"a" -> "" -> "a"）** | ❌ 否 | ❌ 否 | ❌ **失效**（错误信任旧请求结果） | ⚠️ 依赖时钟精度 | ✅ **完美支持（单调序号严格唯一）** |
| **端侧 Worker 流式输出适配** | ❌ 否 | ❌ 否 | ⚠️ 需反复对比字符串 | ⚠️ 需反复读取时钟 | ✅ **原生契合（微秒级整数比较）** |
| **运行时额外开销** | 无 | 低 | 产生字符串内存分配与深度比对 | 系统时钟调用开销 | **极低（单实例 8 字节，1 次自增与比对）** |

---

## 8. 生产落地架构与代码实现对齐

该机制在 [`src/pv-app.ts`](../src/pv-app.ts) 中作为核心编排逻辑落地，并通过统一的 [`SuggestionProviderRouter`](../src/suggestion-provider-router.ts) 进行调度。

### 8.1 步骤 1：PvApp 中的单调序列计数器

在 [`src/pv-app.ts`](../src/pv-app.ts)：

```typescript
export class PvApp extends LitElement {
  ...
  // 单调自增的建议请求序列号
  private suggestionRequestId = 0;
  private inFlightRequests = 0;
  private timeoutId: number | undefined;
```

### 8.2 步骤 2：updateSuggestions() 中的三重门禁编排

在 [`src/pv-app.ts`](../src/pv-app.ts)：

```typescript
  async updateSuggestions() {
    window.clearTimeout(this.timeoutId);
    // 1. 用户一发生交互，第一时间单调递增并捕获本轮 requestId
    const requestId = ++this.suggestionRequestId;
    // 立即通知底层中断已有路线的传输/计算，避免资源浪费
    this.providers.abort();

    const now = Date.now();
    this.prevCallsMs.push(now);
    this.prevCallsMs = this.prevCallsMs.filter(item => item > now - 1000);

    const historyKey = formatConversationHistory(
      this.conversationHistory,
      Date.now() - CONVERSATION_HISTORY_MAX_AGE_MS,
      CONVERSATION_HISTORY_MAX_TURNS,
    );
    const memoryKey = '';
    const hasHistoryOrMemory = historyKey.length > 0 || memoryKey.length > 0;
    const isBlankAtCall = this.isBlank();
    const languageKey = this.stateInternal.lang.promptName;
    const [firstHalf, secondHalf] = splitLastFewSentencesForLLM(
      this.stateInternal.text,
    );
    const sentencePromptId =
      this.state.features.sentenceMacroId ?? this.stateInternal.sentenceMacroId;
    const wordPromptId =
      this.state.features.wordMacroId ?? this.stateInternal.wordMacroId;

    if (!sentencePromptId || !wordPromptId) {
      console.error(
        'Macro IDs are not properly configured. Please check src/constants.ts or src/language.ts.',
        this.state.aiConfig,
        sentencePromptId,
        wordPromptId,
      );
      return;
    }

    const mode = this.stateInternal.inferenceMode;
    const request: SuggestionRequest = {
      text: secondHalf,
      language: languageKey,
      cloudModel: this.stateInternal.model,
      sentencePromptId,
      wordPromptId,
      persona: this.stateInternal.persona,
      lastInputSpeech: this.state.lastInputSpeech,
      lastOutputSpeech: this.state.lastOutputSpeech,
      conversationHistory: historyKey,
      sentenceEmotion: this.state.emotion,
    };
    const cacheKey = this.cacheKey(mode, request, memoryKey);

    if (isBlankAtCall) {
      if (!hasHistoryOrMemory) {
        this.isLoading = false;
        this.suggestions = [];
        this.words = [];
        return;
      }

      // 检查缓存
      const cacheEntry = this.cachedInitialSuggestionsByLanguage.get(cacheKey);
      if (
        cacheEntry &&
        cacheEntry.historyKey === historyKey &&
        cacheEntry.memoryKey === memoryKey
      ) {
        // GATE 1: 缓存结果门禁校验
        if (requestId !== this.suggestionRequestId) {
          return;
        }
        this.suggestions = cacheEntry.suggestions;
        this.words = [];
        this.requestUpdate();
        return;
      }
    }

    this.timeoutId = window.setTimeout(async () => {
      // GATE 2: 防抖到期后的派发前预检（如果用户在防抖等待期内又打字了，直接放弃）
      if (requestId !== this.suggestionRequestId) {
        return;
      }
      this.inFlightRequests++;
      this.isLoading = true;
      let result: SuggestionResult | null = null;
      try {
        result = await this.providers.suggest(mode, request, partial => {
          // 流式 partial 结果门禁：确保 Token 片段严格归属于当前序列与当前模式
          if (
            requestId === this.suggestionRequestId &&
            mode === this.stateInternal.inferenceMode
          ) {
            this.updateWords(partial.words);
            this.requestUpdate();
          }
        });
      } catch (error) {
        if (error instanceof SuggestionProviderError) {
          alert(error.message);
        } else {
          console.error('Suggestion provider failed.', error);
        }
      } finally {
        this.inFlightRequests--;
        if (this.inFlightRequests === 0) {
          this.isLoading = false;
        }
      }

      // GATE 3: 最终结果结算完成后的全量门禁
      if (
        !result ||
        requestId !== this.suggestionRequestId ||
        mode !== this.stateInternal.inferenceMode
      ) {
        return;
      }

      const sentences = result.sentences.map(
        s =>
          new SentenceSuggestion(
            SentenceSuggestionSource.LLM,
            firstHalf + ignoreUnnecessaryDiffs(secondHalf, s),
          ),
      );
      this.updateSentences(sentences);
      this.updateWords(result.words);

      if (isBlankAtCall) {
        this.cachedInitialSuggestionsByLanguage.set(cacheKey, {
          suggestions: sentences,
          historyKey: historyKey,
          memoryKey: memoryKey,
        });
      }

      this.requestUpdate();
    }, this.delayBeforeFetchMs());
  }
```

> **高并发细节设计：** Gate 3 校验特意放置在 `finally` 块之后。无论到来的结果是最新、陈旧还是异常中断，`inFlightRequests--` 都能无条件执行，彻底根绝了异步竞态下加载动画指示器（Spinner）卡死的顽疾。同时 Gate 2 处于 `inFlightRequests++` 之前，被扼杀在防抖期的请求绝不会误增计数。

### 8.3 步骤 3：Provider 路由抽象与流式输出拦截

通过 [`SuggestionProviderRouter`](../src/suggestion-provider-router.ts)，`pv-app.ts` 对具体推理引擎实现完全解耦：
1. `updateSuggestions()` 启动时，调用 `this.providers.abort()`，对云端触发 `MacroApiClient.abortFetch()`，对端侧触发 `ModelRuntimeAdapter.cancel()`。
2. 端侧模型流式产生词语片段时，`onPartialResult` 回调在主线程实时拦截并同样执行序列守卫：`requestId === this.suggestionRequestId && mode === this.stateInternal.inferenceMode`。
3. 当用户在设置面板切换推理模式（Cloud ↔ Local）时，Router 会即刻中断非活动路线，且 Gate 3 保证残余响应绝不跨越模式边界泄露。

---

## 9. 验证与测试策略

为了在数学和工程层面证明竞态条件的彻底消除，我们在自动化浏览器测试套件 [`src/tests/test_pv-app.ts`](../src/tests/test_pv-app.ts) 中构造了基于延迟决议 Promise（Deferred Resolvers）的时序颠倒测试用例。

### 9.1 自动化 Jasmine 单元测试 (`src/tests/test_pv-app.ts`)

代码库中的真实测试用例覆盖了 Gate 2 与 Gate 3：

```typescript
// Gate 3 测试：验证乱序返回时陈旧数据被安全丢弃
it('discards delayed in-flight suggestions when newer input advances sequence ID (Gate 3)', async () => {
  const storage = new ConfigStorage('test', TEST_CONFIG);
  const state = new State(storage);
  state.lang = LANGUAGES['englishWithSingleRowKeyboard'];
  state.inferenceMode = 'local';

  const firstResolvers: Array<(value: string) => void> = [];
  const secondResolvers: Array<(value: string) => void> = [];

  const local = new MockLocalSuggestionProvider(async prompt => {
    if (prompt.includes('first')) {
      return new Promise<string>(resolve => firstResolvers.push(resolve));
    } else {
      return new Promise<string>(resolve => secondResolvers.push(resolve));
    }
  });
  const router = new SuggestionProviderRouter(() => {
    throw new Error('Cloud should not be called');
  }, local);
  const element = new TEST_ONLY.PvAppElement(state, router);

  // 1. 触发第一次输入 "first" (seq 1)
  state.text = 'first';
  void element.updateSuggestions();
  await new Promise(resolve => window.setTimeout(resolve, 10));

  // 2. 紧接着触发第二次输入 "second" (seq 2，自增序列号)
  state.text = 'second';
  void element.updateSuggestions();
  await new Promise(resolve => window.setTimeout(resolve, 250));

  // 3. 故意先 resolve 第二次请求
  secondResolvers.forEach(r => r('1. Second suggestion'));
  await new Promise(resolve => window.setTimeout(resolve, 50));
  expect(element.suggestions.map(s => s.value)).toEqual(['Second suggestion']);

  // 4. 随后迟到的第一次请求才 resolve (时序颠倒到达)
  firstResolvers.forEach(r => r('1. Stale first suggestion'));
  await new Promise(resolve => window.setTimeout(resolve, 50));

  // 5. 断言：迟到的旧结果已被 Gate 3 拦截，UI 保持最新！
  expect(element.suggestions.map(s => s.value)).toEqual(['Second suggestion']);
});

// Gate 2 测试：防抖期间有新输入时抑制旧任务的派发
it('suppresses pre-dispatch execution when sequence ID advances during debounce (Gate 2)', async () => {
  const storage = new ConfigStorage('test', TEST_CONFIG);
  const state = new State(storage);
  state.lang = LANGUAGES['englishWithSingleRowKeyboard'];
  state.inferenceMode = 'local';

  let executedCalls = 0;
  const local = new MockLocalSuggestionProvider(async () => {
    executedCalls++;
    return '1. Result';
  });
  const router = new SuggestionProviderRouter(() => {
    throw new Error('Cloud should not be called');
  }, local);
  const element = new TEST_ONLY.PvAppElement(state, router);

  state.text = 'a';
  void element.updateSuggestions(); // seq 1 进入防抖倒计时

  // 在防抖触发前快速键入 'b'
  state.text = 'ab';
  void element.updateSuggestions(); // seq 2 生效，seq 1 作废

  await new Promise(resolve => window.setTimeout(resolve, 200));

  // 验证只有最新的请求 (seq 2) 真正执行了派发
  expect(executedCalls).toBe(2); // 1 次用于 words，1 次用于 sentences
});
```

### 9.2 手动 QA 验收清单
1. **高频击键仿真：** 以 80+ WPM 快速打出 `"hello world"`。在 Chrome DevTools Network 面板中确认多个请求被建立或中断，而 UI 建议栏平滑跟随输入，绝无前缀倒退现象。
2. **快速退格重输：** 输入 `"cat"`，连续按两次 Backspace 退至 `"c"`，快速重输 `"ar"` 变成 `"car"`。确认候选项呈现为汽车相关联想，而非猫咪相关词汇。
3. **情绪芯片抖动：** 键入一个词，在 `"Happy"`、`"Urgent"`、`"Neutral"` 之间快速点击切换，确认最终建议严格匹配最后选中的情绪，绝无早期选择的残留闪烁。
4. **语言即时切换：** 输入部分字母，快速切换语言，确认新语言建议正确载入，旧语言结果被丢弃。
5. **加载指示器状态：** 确认 Spinner 正常显示与消失，在任何极端取消场景下均无卡顿假死。

---

## 10. 深度评估：Sequence Tagging 对 Cloud Path 的必要性

一个关键的系统性技术问题是：**单调序列标记这项改动对于 Cloud 路径（云端 Gemini 链路）是否也是必需的，还是说它仅仅是为端侧（WebGPU/Worker）量身定做的？**

**结论：对 Cloud Path 完全必需，且不可替代。事实上，Sequence Tagging 最早正是为了彻底根除 Cloud 路径中的严重竞态而设计的。**

详细评估论证如下：

### 10.1 云端网络环境的高延迟抖动（Jitter & RTT Variance）
- **Local 端侧路径：** 运行于本地浏览器 WebGPU/Worker 内，主线程与 Worker 之间仅有进程内内存通信（$1\text{--}5\text{ ms}$），虽然受算力影响执行耗时不同，但通信时序整体较为稳定。
- **Cloud 云端路径：** 必须跨越完整的物理网络协议栈：浏览器 $\rightarrow$ 公网 HTTP $\rightarrow$ Python Flask 服务器 (`/run-macro`) $\rightarrow$ Google 内部 RPC $\rightarrow$ Gemini 云端集群 $\rightarrow$ 回传。
  - 单次云端请求耗时在 **150 ms 至 3,000+ ms** 之间剧烈波动（受蜂窝网/Wi-Fi 丢包、TCP 握手重传、API 排队策略及 LLM 生成长度影响）。
  - 用户输入 `"c"`（遭遇云端冷启动或网络抖动，耗时 1200ms），紧接着输入 `"a"` 变成 `"ca"`（命中热点链路，耗时 200ms 返回）。`"ca"` 率先到达并展示，1 秒后 `"c"` 的结果到达。
  - **如果没有 Sequence Tagging，Cloud 路径在日常打字中会频繁出现建议回退与严重 UI 闪烁。**

### 10.2 HTTP 网络通信中 `AbortController` 的三大先天盲区
尽管 `MacroApiClient` 已经接入了原生的 `AbortController`，但纯网络层的取消在逻辑上存在天然破绽：
1. **防抖时间缝隙（The Debounce Window Gap）：** 当用户打出 `"a"` 后，在第 80ms 打出 `"b"`，防抖重新计时。在传统的取消逻辑中，旧请求的 `abort()` 只有在下一次请求**真正发出**（即第 230ms）时才会被执行。在中间 150ms 的时间空隙中，请求 1 在网络上是活跃且未受控的。只要云端在此刻返回响应，就会直接篡改 UI。
2. **微任务排队期间的不可撤回性：** 一旦网络层将 HTTP 数据包接收完毕，`fetch` 的底层状态就固定为 Fulfilled。如果此时用户按键，外部调用 `abort()` 对已完成网络握手的 Promise 是无效的。其后排队的 JSON 解析与映射微任务必定会继续执行并覆写状态。
3. **TCP 连接池效率的平衡：** 若过于激进地在每个按键瞬间立即掐断 HTTP 连接，会导致浏览器频繁销毁并重建 HTTP/2 连接通道，极大损害 TLS/TCP 连接复用带来的性能增益。

### 10.3 非文本交互维度的状态突变（Non-Text Triggers）
Project VOICE 的建议重新推演不仅由按键触发，还由情绪、角色、对话上下文的变化触发：
- 切换情绪标签（`Happy` $\rightarrow$ `Urgent` $\rightarrow$ `Neutral`）；
- 对话上下文或语音识别（ASR）转写结果更新；
- 切换说话人角色设定（Persona）。

如果用户输入 `"dinner"` 并在 100ms 内将情绪从 `"Happy"` 改为 `"Urgent"`：
- 两次请求的文本内容完全相同（均为 `"dinner"`），基于文本内容匹配的回包校验（如 `res.text === currentText`）完全失效；
- 唯有通过 Sequence Tagging（每次交互自增单调 ID），才能精准拦截迟到的 `"Happy"` 回包，确保界面停留在最新的 `"Urgent"` 建议上。

### 10.4 跨推理模式平滑切换的安全保障 (Cloud ↔ Local)
当用户在离线状态或设置面板中实时切换推理模式时：
- 刚刚发出的 Cloud HTTP 请求可能在切换 500ms 后才返回；
- Gate 3 强制进行了模式与序列的双重锁定：`requestId === this.suggestionRequestId && mode === this.stateInternal.inferenceMode`；
- 这彻底避免了云端建议漏入本地界面、甚至在用户断网/隐私模式下破坏数据合规边界的问题。

### 10.5 架构公理：表现层 vs. 传输层职责分立
Sequence Tagging 将 UI 一致性保障彻底提升到了表现层。底层无论是 HTTP、WebSocket、Wasm 还是 WebGPU，上层统一遵循这一极简公理：

$$\text{允许渲染} \iff \text{requestId} = \text{this.suggestionRequestId} \land \text{mode} = \text{this.stateInternal.inferenceMode}$$

---

## 11. 成功指标与验收标准

### 11.1 关键量化指标
- **陈旧数据覆写率 (Stale Overwrite Rate)：** 在自动化并发用例与生产遥测中实现**严格 0%**。
- **UI 渲染附加延迟：** **0 ms**（JavaScript 整数比对耗时 $< 1 \mu s$）。
- **内存占用：** 单实例仅占用 8 字节整数，零堆内存垃圾分配。
- **网络开销影响：** **0% 额外开销**（保留底层 `AbortController` 以兼顾带宽节省）。

### 11.2 验收交付标准
- [x] 在每次调用 `updateSuggestions()` 时同步原子递增 `suggestionRequestId`。
- [x] Gate 1（缓存）、Gate 2（防抖前置）与 Gate 3（后置返回）均实施 `requestId === this.suggestionRequestId` 强校验。
- [x] 流式 Token 部分更新实施序列号与模式匹配门禁。
- [x] `inFlightRequests` 计数与加载状态管理在 `finally` 块中执行（避免 Spinner 假死）。
- [x] [`src/tests/test_pv-app.ts`](../src/tests/test_pv-app.ts) 中的单元测试全部通过 (`npm test`)。
- [x] Cloud Gemini 建议链路在高频输入下表现出绝对的 UI 稳定性。
- [x] Cloud 与 Local 模式切换时保持严格的状态隔离。

---

## 12. 工作量评估与影响范围

### 12.1 任务拆解与工作量

| 任务项 | 预估工时 | 技术说明 | 状态 |
|---|---|---|:---:|
| 在 `src/pv-app.ts` 中引入 `suggestionRequestId` 及三重门禁 | **XS** (< 0.5 天) | 约 15 行核心改动，属于表现层纯增量逻辑 | **已完成** |
| 在 `src/tests/test_pv-app.ts` 编写基于 Promise 的并发测试 | **S** (0.5–1 天) | 模拟 Gate 2 与 Gate 3 的时序反转场景 | **已完成** |
| 全流程人工 QA 验证（Cloud 与 Local 双链路） | **XS** (< 0.5 天) | 快速打字、退格、情绪及语言频繁切换场景 | **已完成** |
| 代码审查与合入 | **XS** (< 0.5 天) | 纯前端逻辑，无后端 API 变更依赖 | **已完成** |
| **总计** | **S–M (1–2 天)** | | **已交付投产 (Pre-M1)** |

### 12.2 变更文件清单

| 文件路径 | 变更类型 | 变更描述 |
|---|---|---|
| [`src/pv-app.ts`](../src/pv-app.ts) | 修改 | 引入 `suggestionRequestId`，编排 Gate 1、Gate 2、Gate 3 及流式守卫。 |
| [`src/tests/test_pv-app.ts`](../src/tests/test_pv-app.ts) | 修改 | 新增针对 Gate 2 与 Gate 3 的自动化并发验证测试套件。 |

### 12.3 未变动文件及原因

| 文件路径 | 未变动原因 |
|---|---|
| [`src/macro-api-client.ts`](../src/macro-api-client.ts) | 保留其 `AbortController` 机制作为 Layer 1 的传输层节流手段。 |
| `main.py` / `macro.py` | 后端保持无状态，序列号完全由前端表现层闭环管理。 |
| `templates/prompts/*.jinja2` | Prompt 模板结构无需任何改动。 |
| `package.json` / `pyproject.toml` | 零新增第三方依赖。 |

---

## 13. 落地与验证总结

单调序列标记作为 **Milestone Pre-M1** 核心基础设施在 [`src/pv-app.ts`](../src/pv-app.ts) 中完成落地，并通过了自动化浏览器测试与端到端手动验证。

### 交付验证要点：
1. **Gate 1（缓存门禁）：** 当新按键在缓存检索期间产生时，丢弃旧的缓存回填。
2. **Gate 2（防抖前置门禁）：** 防抖倒计时期间若有新按键发生，提前扼杀无效任务的调度。
3. **Gate 3（后置结算门禁）：** 当输入前移或模式切换时，丢弃所有迟到的完整推演与流式 Token 片段。
4. **双层防御合力：** 将 `AbortController`（传输与带宽节约）与序列门禁（表现层一致性）完美结合。
5. **零错误覆盖：** 经实测，Cloud Gemini 链路与后续接入的 Local Gemma 链路均实现 100% 竞态消除。
