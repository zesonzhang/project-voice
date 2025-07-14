# Project VOICE 前端文档

## 文档概述

本文档集合为后端开发工程师提供 Project VOICE 前端架构的全面理解。文档以中文编写，便于快速理解和上手。

## 文档目录

### 1. [前端架构文档](./frontend-architecture.md)
**适合人群**: 想要了解整体架构的开发者  
**内容**:
- 技术栈介绍
- 项目结构说明
- 主要模块功能
- 设计模式和原则
- 构建和部署流程

### 2. [数据流详细说明](./data-flow-detailed.md)
**适合人群**: 需要深入理解数据流转的开发者  
**内容**:
- 应用初始化流程
- 文本输入和AI建议流程
- 组件间通信机制
- 状态管理详解
- 性能优化策略

### 3. [组件关系图](./component-relationships.md)
**适合人群**: 需要了解组件结构的开发者  
**内容**:
- 组件层次结构
- 组件依赖关系
- 事件系统详解
- 生命周期管理
- 组件通信模式

### 4. [前端开发快速入门](./frontend-quickstart.md)
**适合人群**: 准备进行前端开发的工程师  
**内容**:
- 开发环境配置
- 核心概念理解
- 常见开发任务
- 调试和故障排除
- 测试和部署

## 技术栈速览

### 核心技术
- **TypeScript**: 类型安全的 JavaScript
- **Lit**: 现代 Web Components 框架
- **esbuild**: 超快的 JavaScript 打包器
- **@lit-labs/signals**: 响应式状态管理

### 架构特点
- **组件化设计**: 每个功能模块都是独立的 Web Component
- **响应式状态**: 使用 Signals 实现自动 UI 更新
- **事件驱动**: 组件间通过自定义事件进行通信
- **可访问性优先**: 支持键盘导航、屏幕阅读器等辅助技术

## 快速开始

### 环境准备
```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器
npm run dev

# 3. 访问应用
open http://localhost:5000
```

### 项目结构
```
src/
├── index.ts              # 应用入口
├── pv-app.ts             # 主应用组件
├── state.ts              # 全局状态管理
├── macro-api-client.ts   # API 客户端
├── keyboards/            # 键盘组件
├── stories/              # Storybook 故事
└── tests/               # 测试文件
```

## 核心概念

### 1. 组件系统
Project VOICE 使用 Lit 构建的 Web Components，每个组件都是自包含的、可复用的 UI 单元。

### 2. 状态管理
使用 `@lit-labs/signals` 实现响应式状态管理，状态变化自动触发 UI 更新。

### 3. 事件通信
组件间通过自定义事件进行通信，遵循单向数据流原则。

### 4. AI 集成
通过 `MacroApiClient` 与后端 AI 服务交互，获取智能建议。

## 主要组件

### 用户界面组件
- **pv-app**: 主应用组件，协调所有子组件
- **pv-textarea-wrapper**: 文本输入区域
- **pv-suggestion-stripe**: AI 建议显示
- **pv-functions-bar**: 功能按钮栏

### 输入组件
- **pv-fifty-key-keyboard**: 日语五十音键盘
- **pv-qwerty-keyboard**: 英语 QWERTY 键盘
- **pv-single-row-keyboard**: 简化单行键盘

### 功能组件
- **pv-setting-panel**: 设置面板
- **pv-conversation-history**: 对话历史
- **pv-sentence-type-selector**: 句子类型选择器

## 开发流程

### 1. 开发环境
```bash
npm run dev      # 启动开发服务器
npm run watch    # 监听模式构建
npm run lint     # 代码检查
```

### 2. 组件开发
```bash
npm run storybook    # 启动 Storybook
```

### 3. 测试
```bash
npm run test     # 运行测试
```

### 4. 构建和部署
```bash
npm run build    # 生产构建
npm run deploy   # 部署到 Google App Engine
```

## 开发建议

### 对于后端开发者
1. **从概念入手**: 先阅读架构文档了解整体设计
2. **理解数据流**: 重点关注数据流文档中的状态管理
3. **动手实践**: 使用快速入门指南搭建开发环境
4. **组件化思维**: 每个功能都是独立的组件

### 学习路径
1. 阅读 [前端架构文档](./frontend-architecture.md) 了解整体架构
2. 研究 [数据流详细说明](./data-flow-detailed.md) 理解数据流转
3. 查看 [组件关系图](./component-relationships.md) 了解组件结构  
4. 使用 [前端开发快速入门](./frontend-quickstart.md) 开始开发

## 常见问题

### Q: 为什么选择 Lit 而不是 React/Vue？
A: Lit 基于 Web Components 标准，具有更好的性能和更小的包体积，适合构建可访问性应用。

### Q: 如何理解 Signals 状态管理？
A: Signals 是响应式编程模式，状态变化时自动更新相关 UI，类似于 Vue 的响应式系统。

### Q: 组件间如何通信？
A: 主要通过自定义事件（事件冒泡）和共享状态（Signals）进行通信。

### Q: 如何调试组件？
A: 使用 Storybook 进行组件隔离开发，使用浏览器开发工具进行调试。

## 相关资源

### 官方文档
- [Lit 官方文档](https://lit.dev/)
- [TypeScript 官方文档](https://www.typescriptlang.org/)
- [Material Web Components](https://material-web.dev/)

### 开发工具
- [Storybook](https://storybook.js.org/)
- [esbuild](https://esbuild.github.io/)
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)

---

**最后更新**: 2024年12月
**维护者**: Project VOICE 团队

通过这套文档，后端开发工程师可以快速理解和上手 Project VOICE 的前端开发。如有疑问，请参考具体的子文档或联系团队成员。