# Project VOICE 前端架构文档

## 概述

Project VOICE 是一个基于 TypeScript 的 Web 应用，主要为有语音和输入困难的用户提供AI增强的沟通支持工具。前端采用现代化的 Web 技术栈构建，使用组件化架构和声明式编程范式。

## 技术栈

### 核心技术
- **TypeScript**: 类型安全的 JavaScript 超集
- **Lit**: 轻量级 Web Components 库，用于构建用户界面
- **esbuild**: 超快的 JavaScript 打包器
- **Material Web Components**: Google 的 Material Design 组件库

### 状态管理
- **@lit-labs/signals**: 响应式状态管理
- **@lit/context**: 跨组件数据传递

### 国际化
- **@lit/localize**: 本地化和多语言支持

### 开发工具
- **Storybook**: 组件开发和测试
- **GTS**: Google TypeScript 样式指南
- **Jasmine**: 测试框架

## 项目结构

```
src/
├── index.ts                    # 应用入口点
├── pv-app.ts                   # 主应用组件
├── state.ts                    # 全局状态管理
├── constants.ts                # 常量定义
├── config-storage.ts           # 配置存储
├── macro-api-client.ts         # 后端API客户端
├── audio-manager.ts            # 音频管理
├── input-history.ts            # 输入历史管理
├── language.ts                 # 语言定义
├── keyboards/                  # 键盘组件
│   ├── pv-fifty-key-keyboard.ts
│   ├── pv-qwerty-keyboard.ts
│   └── pv-single-row-keyboard.ts
└── 组件文件...
```

## 主要模块

### 1. 应用入口 (index.ts)
```typescript
import './pv-app.js';
```
- 应用的最简入口点
- 只负责导入主应用组件

### 2. 主应用组件 (pv-app.ts)
**职责**: 应用的根组件，协调所有子组件

**主要功能**:
- 管理应用级别的状态
- 处理用户输入和AI建议
- 协调各个子组件之间的通信
- 处理国际化设置

**关键方法**:
- `handleTextUpdate()`: 处理文本更新
- `handleSuggestionSelect()`: 处理AI建议选择
- `fetchSuggestions()`: 获取AI建议

### 3. 状态管理 (state.ts)
**职责**: 全局状态管理中心

**核心特性**:
- 使用 `@lit-labs/signals` 实现响应式状态
- 持久化存储支持
- 类型安全的状态访问

**主要状态**:
```typescript
class State {
  // 语言和本地化
  private langSignal = signal(LANGUAGES['japaneseWithSingleRowKeyboard']);
  private checkedLanguagesSignal = signal([] as string[]);
  
  // 用户界面状态
  private keyboardSignal = signal(literal`pv-alphanumeric-single-row-keyboard`);
  private textSignal = signal('');
  private emotionSignal = signal('');
  
  // AI配置
  private aiConfigInternal = 'smart';
  
  // 语音设置
  private voiceSpeakingRateInternal: number;
  private voicePitchInternal: number;
  private voiceNameInternal: string;
  
  // 消息历史
  private messageHistoryInternal: [string, number][] = [];
}
```

### 4. API客户端 (macro-api-client.ts)
**职责**: 与后端AI服务通信

**主要方法**:
- `fetchSuggestions()`: 获取AI建议
- `abortFetch()`: 取消请求
- `parseResponse()`: 解析后端响应

**请求流程**:
1. 用户输入文本
2. 构造请求参数（语言、上下文、情感等）
3. 并发请求单词和句子建议
4. 解析响应并返回建议列表

### 5. 核心UI组件

#### 文本输入包装器 (pv-textarea-wrapper.ts)
**职责**: 文本输入区域的管理

**功能**:
- 自适应文本区域大小
- 输入历史管理
- 文本更新事件处理

#### 建议条 (pv-suggestion-stripe.ts)
**职责**: 显示AI生成的建议

**功能**:
- 渲染建议列表
- 处理建议选择
- 支持单词和句子建议

#### 功能栏 (pv-functions-bar.ts)
**职责**: 提供应用功能按钮

**功能**:
- 语音播放控制
- 设置面板切换
- 键盘切换
- 文本操作（复制、删除、撤销等）

#### 对话历史 (pv-conversation-history.ts)
**职责**: 管理和显示对话历史

**功能**:
- 历史消息展示
- 消息重用
- 历史记录管理

#### 设置面板 (pv-setting-panel.ts)
**职责**: 应用设置管理

**功能**:
- 语言设置
- 语音设置
- AI配置
- 界面偏好设置

### 6. 键盘系统

#### 三种键盘类型:
1. **五十音键盘** (pv-fifty-key-keyboard.ts): 日语输入
2. **QWERTY键盘** (pv-qwerty-keyboard.ts): 英语输入
3. **单行键盘** (pv-single-row-keyboard.ts): 简化输入

**特点**:
- 支持多语言输入
- 自适应布局
- 可访问性优化

## 数据流架构

### 1. 单向数据流
```
用户输入 → 状态更新 → 组件重新渲染 → UI更新
```

### 2. 事件驱动通信
```
子组件事件 → 父组件处理 → 状态更新 → 相关组件更新
```

### 3. AI建议流程
```
文本输入 → API请求 → 后端AI处理 → 建议返回 → UI展示 → 用户选择
```

## 设计模式

### 1. 组件化架构
- 每个功能模块独立组件
- 单一职责原则
- 可复用性设计

### 2. 响应式状态管理
- 使用 Signals 实现响应式更新
- 自动依赖追踪
- 最小化重新渲染

### 3. 事件驱动通信
- 自定义事件传递数据
- 松耦合组件设计
- 清晰的数据流向

### 4. 配置化设计
- 多语言支持
- 主题定制
- 功能开关

## 关键代码示例

### 状态管理示例
```typescript
// 状态定义
private textSignal = signal('');

// 状态获取
get text() {
  return this.textSignal.get();
}

// 状态更新
set text(newText: string) {
  this.textSignal.set(newText);
}
```

### 组件通信示例
```typescript
// 事件定义
export class SuggestionSelectEvent extends CustomEvent<[string, number]> {}

// 事件触发
this.dispatchEvent(new SuggestionSelectEvent('suggestion-select', {
  detail: [suggestion, index]
}));

// 事件处理
@query('pv-suggestion-stripe')
private suggestionStripe?: PvSuggestionStripe;

this.suggestionStripe?.addEventListener('suggestion-select', (e) => {
  this.handleSuggestionSelect(e.detail);
});
```

### API调用示例
```typescript
async fetchSuggestions(textValue: string, language: string, model: string, context: Context) {
  const userInputs = {
    language,
    text: textValue,
    persona: context.persona,
    // ... 其他上下文
  };
  
  const [words, sentences] = await Promise.all([
    this.fetchSuggestion(userInputs, abortSignal, wordMacroId, model),
    this.fetchSuggestion(userInputs, abortSignal, sentenceMacroId, model)
  ]);
  
  return { words, sentences };
}
```

## 构建和部署

### 开发环境
```bash
npm run dev     # 启动开发服务器
npm run watch   # 监听模式构建
npm run lint    # 代码检查
npm run test    # 运行测试
```

### 生产构建
```bash
npm run build   # 生产构建
npm run deploy  # 部署到 Google App Engine
```

### 组件开发
```bash
npm run storybook   # 启动 Storybook
```

## 可访问性特性

- 键盘导航支持
- 屏幕阅读器兼容
- 高对比度模式
- 眼球追踪支持
- 开关访问支持

## 国际化支持

- 基于 `@lit/localize` 实现
- 支持多语言切换
- 消息提取和翻译工作流
- 运行时语言切换

## 总结

Project VOICE 的前端架构采用现代化的 Web 技术栈，通过组件化设计、响应式状态管理和事件驱动通信，构建了一个高效、可维护、可扩展的用户界面。整个架构以用户体验为中心，特别针对辅助技术用户进行了优化，体现了包容性设计的理念。