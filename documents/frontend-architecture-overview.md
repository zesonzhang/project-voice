# Project VOICE 前端架构概述

## 技术栈
- **框架**: Lit (Web Components)
- **状态管理**: @lit-labs/signals (响应式状态)
- **构建工具**: esbuild
- **UI组件**: Material Design Web Components
- **国际化**: @lit/localize
- **TypeScript**: 类型安全

## 核心架构模式
项目采用基于 Web Components 的组件化架构，使用 Lit 框架构建。主要特点：
- 组件化设计，每个功能模块都是独立的 Web Component
- 使用 Signals 进行响应式状态管理
- 事件驱动的组件通信

## 主要模块

### 1. 入口和主组件
- **`src/index.ts`**: 应用入口，仅导入主组件
- **`src/pv-app.ts`**: 核心应用组件，负责：
  - 组织所有子组件
  - 管理全局状态
  - 处理用户交互的主要逻辑
  - 协调各组件之间的通信

### 2. 状态管理 (`src/state.ts`)
使用 Signals 实现响应式状态管理：
- **全局状态**:
  - `lang`: 当前语言设置
  - `text`: 当前输入的文本
  - `keyboard`: 当前键盘类型
  - `emotion`: 句子情感类型
  - `messageHistory`: 消息历史记录
  - `initialPhrases`: 初始短语建议
- **配置状态**: AI配置、语音设置、UI偏好等
- **持久化**: 通过 `ConfigStorage` 保存到本地存储

### 3. API 通信 (`src/macro-api-client.ts`)
负责与后端 AI 服务通信：
- **主要功能**:
  - `fetchSuggestions()`: 获取句子和词语建议
  - 支持中断请求 (AbortController)
  - 处理并发请求（句子和词语建议）
- **数据格式**: 使用 FormData 发送请求，包含文本、语言、上下文等信息

### 4. 核心UI组件

#### 输入组件
- **`pv-textarea-wrapper.ts`**: 文本输入区域包装器
  - 管理输入历史
  - 触发文本更新事件
  - 支持撤销/重做功能

- **`pv-character-input.ts`**: 字符输入组件
  - 集成不同类型的键盘
  - 处理字符选择事件

#### 键盘组件 (`src/keyboards/`)
- `pv-single-row-keyboard.ts`: 单行键盘
- `pv-qwerty-keyboard.ts`: QWERTY键盘
- `pv-fifty-key-keyboard.ts`: 五十音键盘（日语）

#### 建议组件
- **`pv-suggestion-stripe.ts`**: 句子建议条
  - 显示AI生成的句子建议
  - 支持逐词选择
  - 区分建议来源（AI/历史）

- **`pv-functions-bar.ts`**: 功能栏
  - 语言切换
  - 键盘切换
  - 文本操作（撤销、删除、复制）
  - 语音输出控制

### 5. 辅助模块

#### 语言支持 (`src/language.ts`)
- 定义语言接口和实现
- 每种语言包含：
  - 分词逻辑 (`segment()`)
  - 词语连接规则 (`join()`)
  - 可用键盘列表
  - AI模型配置
  - 初始短语

#### 音频管理 (`src/audio-manager.ts`)
- 播放点击音效
- 管理语音合成

#### 输入历史 (`src/input-history.ts`)
- 记录输入历史
- 支持撤销/重做
- 统计输入信息

## 数据流

### 1. 用户输入流程
```
用户点击键盘 → pv-character-input 触发事件 
→ pv-app 处理字符选择 
→ 更新 pv-textarea-wrapper 
→ 触发 text-update 事件 
→ pv-app 调用 updateSuggestions()
```

### 2. AI建议流程
```
文本更新 → pv-app.updateSuggestions() 
→ MacroApiClient.fetchSuggestions() 
→ 后端API请求 
→ 解析响应 
→ 更新 suggestions 和 words 
→ UI自动更新（响应式）
```

### 3. 建议选择流程
```
用户点击建议 → pv-suggestion-stripe 触发 select 事件 
→ pv-app 处理选择 
→ 更新文本框 
→ 记录输入历史 
→ 触发新的建议请求
```

### 4. 状态同步
- 使用 Signals 实现响应式更新
- 组件通过 `@property` 装饰器接收状态
- 状态变化自动触发组件重新渲染

## 关键设计模式

### 1. 事件驱动
- 组件间通过自定义事件通信
- 事件冒泡到父组件处理
- 保持组件解耦

### 2. 组合优于继承
- 使用组合构建复杂UI
- 每个组件职责单一
- 通过属性和事件连接

### 3. 响应式编程
- Signals 提供细粒度响应性
- 自动追踪依赖
- 最小化重新渲染

### 4. 渐进增强
- 基础功能不依赖JavaScript
- 逐步添加高级特性
- 支持辅助技术

## 性能优化

1. **防抖处理**: 输入时延迟API请求
2. **请求中断**: 新请求时取消旧请求
3. **懒加载**: 按需加载语言模块
4. **最小化渲染**: 使用Lit的高效差异算法

## 可扩展性

1. **语言扩展**: 实现Language接口即可添加新语言
2. **键盘扩展**: 创建新的键盘组件
3. **AI模型配置**: 通过配置切换不同模型
4. **功能插件**: 通过组件组合添加新功能
