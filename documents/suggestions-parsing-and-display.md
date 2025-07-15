# Project VOICE 建议解析与展示流程详解

## 1. 后端响应格式

### 后端 API 端点
- **URL**: `/run-macro`
- **方法**: POST
- **返回格式**: JSON

### 响应结构
```json
{
  "messages": [
    {
      "text": "1. 第一个建议\n2. 第二个建议\n3. 第三个建议\n..."
    }
  ]
}
```

后端返回的建议是一个包含编号的文本列表，每个建议占一行，格式为：
```
1. 建议内容1
2. 建议内容2
3. 建议内容3
...
```

## 2. 前端解析流程

### 2.1 API 请求 (`macro-api-client.ts`)

```typescript
// 主要的获取建议方法
async fetchSuggestions(
  textValue: string,
  language: string,
  model: string,
  context: {...}
) {
  // 并行请求词语建议和句子建议
  const wordsFetch = MacroApiClient.fetchSuggestion(
    userInputs,
    abortSignal,
    wordMacroId,    // 词语建议的 macro ID
    model
  );
  
  const sentencesFetch = MacroApiClient.fetchSuggestion(
    userInputs,
    abortSignal,
    sentenceMacroId, // 句子建议的 macro ID
    model
  );
  
  // 等待两个请求完成
  const result = Promise.all([sentencesFetch, wordsFetch]);
  return result; // 返回 [句子建议数组, 词语建议数组]
}
```

### 2.2 响应解析 (`parseResponse` 函数)

```typescript
function parseResponse(response: string, num: number) {
  // 处理响应中的换行符
  response = response.replaceAll('\\\n', '');
  
  return response
    .split('\n')                           // 按行分割
    .map(text => text.trim())              // 去除空白
    .filter(text => text.match(/^[0-9]+\./)) // 只保留以数字开头的行
    .slice(0, num)                         // 限制数量
    .map(text => text.replace(/^\d+\.\s?/, '')); // 移除序号
}
```

**解析步骤**：
1. 移除转义的换行符 `\\\n`
2. 按实际换行符分割成数组
3. 去除每行首尾空白
4. 过滤出以数字和点开头的行（如 "1.", "2." 等）
5. 限制返回的建议数量
6. 移除每行开头的序号，只保留建议内容

## 3. 数据处理流程 (`pv-app.ts`)

### 3.1 更新建议的主流程

```typescript
async updateSuggestions() {
  // 1. 防抖处理
  window.clearTimeout(this.timeoutId);
  
  // 2. 延迟执行（根据请求频率动态调整延迟）
  this.timeoutId = window.setTimeout(async () => {
    // 3. 调用 API 获取建议
    const result = await this.apiClient.fetchSuggestions(...);
    
    if (!result) return;
    
    // 4. 解构返回结果
    const [sentenceValues, words] = result;
    
    // 5. 创建句子建议对象
    const sentences = sentenceValues.map(
      s => new SentenceSuggestion(
        SentenceSuggestionSource.LLM,
        firstHalf + ignoreUnnecessaryDiffs(secondHalf, s)
      )
    );
    
    // 6. 更新组件状态
    this.updateSentences(sentences);
    this.updateWords(words);
  }, this.delayBeforeFetchMs());
}
```

### 3.2 句子建议处理

```typescript
private updateSentences(suggestions: SentenceSuggestion[]) {
  // 根据设置限制显示数量
  if (!this.stateInternal.sentenceSmallMargin) {
    suggestions = suggestions.slice(0, LARGE_MARGIN_LINE_LIMIT);
  }
  
  // 规范化每个建议（处理空格、Unicode等）
  this.suggestions = suggestions.map(s => {
    s.value = normalize(s.value);
    return s;
  });
}
```

### 3.3 词语建议处理

```typescript
private updateWords(words: string[]) {
  // 规范化每个词语
  this.words = words.map(w => normalize(w));
}
```

## 4. UI 展示

### 4.1 词语建议展示 (`pv-app.ts` render 方法)

```typescript
// 渲染词语建议按钮
const bodyOfWordSuggestions = words.map(word =>
  !word ? '' : html`
    <li>
      <pv-button
        label="${word}"
        rounded
        @click="${() => this.onSuggestedWordClick(word)}"
      ></pv-button>
    </li>
  `
);
```

**展示特点**：
- 每个词语显示为一个圆角按钮
- 点击后会将词语追加到当前文本

### 4.2 句子建议展示 (`pv-suggestion-stripe.ts`)

```typescript
// 渲染句子建议条
const bodyOfSentenceSuggestions = this.suggestions.map(suggestion => {
  const sharedOffset = getSharedPrefix([suggestion.value, text]);
  return html`
    <li class="${this.stateInternal.sentenceSmallMargin ? 'tight' : ''}">
      <pv-suggestion-stripe
        .offset="${sharedOffset}"
        .suggestion="${suggestion}"
        @select="${this.onSuggestionSelect}"
      ></pv-suggestion-stripe>
    </li>
  `;
});
```

**句子建议条的特殊功能**：
1. **共享前缀处理**：计算当前文本和建议的共同前缀
2. **逐词选择**：用户可以选择建议中的部分词语，而不是整个句子
3. **视觉反馈**：鼠标悬停时高亮显示选择范围

### 4.3 `pv-suggestion-stripe` 组件详解

```typescript
render() {
  // 将句子分词
  const words = splitPunctuations(
    this.state.lang.segment(this.suggestion.value)
  );
  
  // 计算已输入的前缀词
  const leadingWords = getLeadingWords(words, offsetWords);
  
  return html`
    ${leadingWords.length > 0 ? html`<span class="ellipsis">… </span>` : ''}
    ${words.map((word, i) =>
      i < leadingWords.length ? '' : html`
        <pv-button
          ?active="${i <= this.mouseoverIndex}"
          .label="${word}"
          @mouseenter="${() => { this.mouseoverIndex = i; }}"
          @click="${() => {
            // 触发选择事件，传递选中的部分
            this.dispatchEvent(
              new SuggestionSelectEvent('select', {
                detail: [
                  this.state.lang.join(words.slice(0, i + 1)),
                  i - leadingWords.length,
                  this.suggestion.source
                ]
              })
            );
          }}"
        ></pv-button>
      `
    )}
  `;
}
```

## 5. 用户交互流程

### 5.1 选择词语建议
```
用户点击词语按钮 
→ onSuggestedWordClick(word) 
→ 将词语追加到文本（考虑语言特定规则）
→ 规范化文本
→ 更新输入框
→ 触发新的建议请求
```

### 5.2 选择句子建议
```
用户点击句子中的某个词 
→ SuggestionSelectEvent 
→ onSuggestionSelect 
→ 获取从开始到选中词的部分文本
→ 更新输入框
→ 记录输入来源（用于统计）
→ 触发新的建议请求
```

## 6. 性能优化

1. **防抖机制**：避免频繁请求
   ```typescript
   private delayBeforeFetchMs() {
     // 根据最近的请求频率动态调整延迟
     return Math.min(150 * (this.prevCallsMs.length - 1), 300);
   }
   ```

2. **请求中断**：新请求时取消旧请求
   ```typescript
   abortFetch() {
     this.fetchAbortController?.abort();
   }
   ```

3. **加载状态**：显示加载指示器
   ```html
   <div class="loader ${this.isLoading ? 'loading' : ''}">
     <md-circular-progress indeterminate></md-circular-progress>
   </div>
   ```

## 7. 特殊处理

### 7.1 文本规范化 (`normalize` 函数)
- 处理 Unicode 字符组合
- 移除多余空格
- 处理标点符号前的空格

### 7.2 差异忽略 (`ignoreUnnecessaryDiffs` 函数)
- 使用 diff-match-patch 库
- 保留用户已输入的部分
- 只在文本末尾应用建议的修改

### 7.3 多语言支持
- 不同语言有不同的分词逻辑
- 日语使用 TinySegmenter
- 英语按空格分词
- 中文按字符分词

## 总结

整个建议系统的设计非常精巧：
1. **并行请求**：同时获取句子和词语建议，提高效率
2. **智能解析**：灵活处理后端返回的编号列表格式
3. **渐进式选择**：用户可以选择句子的一部分，而不是全部
4. **响应式更新**：使用 Lit 的响应式系统自动更新 UI
5. **性能优化**：防抖、请求中断、动态延迟等机制
6. **用户体验**：视觉反馈、加载状态、平滑交互

这种设计让有输入困难的用户能够通过最少的操作完成复杂的文本输入。
