# Project VOICE 前端开发快速入门指南

## 目标读者
本指南适合有 TypeScript 基础但对 Project VOICE 项目前端架构不熟悉的开发者。

## 开发环境配置

### 1. 环境要求
- Node.js >= 16.0.0
- Python 3.x
- Google Cloud SDK (用于部署)

### 2. 项目启动
```bash
# 1. 克隆项目
git clone <repository-url>
cd project-voice

# 2. 安装依赖
npm install

# 3. 设置环境变量
export API_KEY=your_gemini_api_key

# 4. 启动开发服务器
npm run dev
```

开发服务器将在 http://localhost:5000 启动。

### 3. 开发工具
```bash
# 代码检查
npm run lint

# 修复代码风格
npm run fix

# 构建生产版本
npm run build

# 运行测试
npm run test

# 启动 Storybook
npm run storybook
```

## 核心概念理解

### 1. 技术栈核心
- **Lit**: 用于构建 Web Components
- **TypeScript**: 类型安全的 JavaScript
- **Signals**: 响应式状态管理
- **esbuild**: 超快的打包工具

### 2. 关键设计原则
- **组件化**: 每个功能都是独立的组件
- **事件驱动**: 组件间通过事件通信
- **单向数据流**: 数据从父组件流向子组件
- **响应式状态**: 状态变化自动更新UI

## 快速开发指南

### 1. 创建新组件

#### 基本组件结构
```typescript
// src/pv-my-component.ts
import {css, html, LitElement} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {State} from './state.js';

@customElement('pv-my-component')
export class PvMyComponent extends LitElement {
  @property({type: Object})
  private state!: State;

  static styles = css`
    :host {
      display: block;
      padding: 16px;
    }
  `;

  render() {
    return html`
      <div class="my-component">
        <h2>My Component</h2>
        <p>Current text: ${this.state.text}</p>
      </div>
    `;
  }
}
```

#### 响应式组件（使用 Signals）
```typescript
import {SignalWatcher} from '@lit-labs/signals';

@customElement('pv-reactive-component')
export class PvReactiveComponent extends SignalWatcher(LitElement) {
  @property({type: Object})
  private state!: State;

  render() {
    // 自动响应 state.text 的变化
    return html`
      <div>Text: ${this.state.text}</div>
    `;
  }
}
```

### 2. 事件处理

#### 定义自定义事件
```typescript
// 定义事件类型
export class MyCustomEvent extends CustomEvent<string> {
  constructor(type: string, detail: string) {
    super(type, {
      detail,
      bubbles: true,
      composed: true
    });
  }
}

// 在组件中触发事件
private handleClick() {
  this.dispatchEvent(new MyCustomEvent('my-custom-event', 'some data'));
}
```

#### 监听事件
```typescript
@customElement('pv-parent-component')
export class PvParentComponent extends LitElement {
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('my-custom-event', this.handleMyEvent);
  }

  private handleMyEvent = (e: MyCustomEvent) => {
    console.log('Received event:', e.detail);
  };
}
```

### 3. 状态管理

#### 读取状态
```typescript
@customElement('pv-reader-component')
export class PvReaderComponent extends SignalWatcher(LitElement) {
  @property({type: Object})
  private state!: State;

  render() {
    return html`
      <div>
        <p>Current language: ${this.state.lang.name}</p>
        <p>Text: ${this.state.text}</p>
        <p>Emotion: ${this.state.emotion}</p>
      </div>
    `;
  }
}
```

#### 更新状态
```typescript
@customElement('pv-writer-component')
export class PvWriterComponent extends LitElement {
  @property({type: Object})
  private state!: State;

  private handleTextChange(e: Event) {
    const input = e.target as HTMLInputElement;
    this.state.text = input.value;
  }

  private handleEmotionSelect(emotion: string) {
    this.state.emotion = emotion;
  }

  render() {
    return html`
      <input @input=${this.handleTextChange} value=${this.state.text}>
      <select @change=${(e: Event) => this.handleEmotionSelect((e.target as HTMLSelectElement).value)}>
        <option value="">Select emotion</option>
        <option value="happy">Happy</option>
        <option value="sad">Sad</option>
      </select>
    `;
  }
}
```

### 4. API 调用

#### 使用 MacroApiClient
```typescript
@customElement('pv-api-component')
export class PvApiComponent extends LitElement {
  @property({type: Object})
  private state!: State;

  private macroApiClient = new MacroApiClient();

  private async fetchSuggestions() {
    const context = {
      sentenceMacroId: this.state.sentenceMacroId,
      wordMacroId: this.state.wordMacroId,
      persona: this.state.persona,
      lastOutputSpeech: this.state.lastOutputSpeech,
      lastInputSpeech: this.state.lastInputSpeech,
      conversationHistory: this.buildConversationHistory(),
      sentenceEmotion: this.state.emotion,
    };

    try {
      const suggestions = await this.macroApiClient.fetchSuggestions(
        this.state.text,
        this.state.lang.name,
        this.state.model,
        context
      );
      
      this.handleSuggestions(suggestions);
    } catch (error) {
      console.error('Failed to fetch suggestions:', error);
    }
  }

  private handleSuggestions(suggestions: {words: string[], sentences: string[]}) {
    // 处理建议结果
  }
}
```

### 5. 国际化支持

#### 使用 @lit/localize
```typescript
import {localized, msg} from '@lit/localize';

@localized()
@customElement('pv-i18n-component')
export class PvI18nComponent extends LitElement {
  render() {
    return html`
      <button>${msg('Click me')}</button>
      <p>${msg('Welcome to Project VOICE')}</p>
    `;
  }
}
```

#### 添加翻译
```typescript
// src/locales/ja.ts
export const templates = {
  's1234567890': '私をクリック',
  's0987654321': 'Project VOICE へようこそ',
};
```

## 常见开发任务

### 1. 添加新的键盘类型

#### 1.1 创建键盘组件
```typescript
// src/keyboards/pv-custom-keyboard.ts
import {css, html, LitElement} from 'lit';
import {customElement, property} from 'lit/decorators.js';

@customElement('pv-custom-keyboard')
export class PvCustomKeyboard extends LitElement {
  @property({type: Array})
  keys: string[] = ['A', 'B', 'C', 'D', 'E'];

  static styles = css`
    .keyboard {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    
    .key {
      padding: 12px 16px;
      border: 1px solid #ccc;
      border-radius: 4px;
      cursor: pointer;
    }
    
    .key:hover {
      background-color: #f0f0f0;
    }
  `;

  private handleKeyClick(key: string) {
    this.dispatchEvent(new CustomEvent('character-select', {
      detail: key,
      bubbles: true
    }));
  }

  render() {
    return html`
      <div class="keyboard">
        ${this.keys.map(key => html`
          <button 
            class="key" 
            @click=${() => this.handleKeyClick(key)}>
            ${key}
          </button>
        `)}
      </div>
    `;
  }
}
```

#### 1.2 注册键盘
```typescript
// src/language.ts
export const LANGUAGES = {
  // ... 其他语言
  customLanguage: {
    name: 'Custom',
    keyboards: [literal`pv-custom-keyboard`],
    // ... 其他配置
  }
};
```

### 2. 添加新的功能按钮

#### 2.1 在 pv-functions-bar.ts 中添加
```typescript
// 在 EVENT_KEY 中添加新事件
const EVENT_KEY = {
  // ... 现有事件
  newFeatureClick: 'new-feature-click',
} as const;

// 在 render 方法中添加按钮
render() {
  return html`
    <!-- 其他按钮 -->
    <md-icon-button 
      @click=${this.onNewFeatureClick}
      title="New Feature">
      <md-icon>new_icon</md-icon>
    </md-icon-button>
  `;
}

// 添加事件处理方法
@playClickSound()
private onNewFeatureClick() {
  this.dispatchEvent(new CustomEvent(EVENT_KEY.newFeatureClick));
}
```

#### 2.2 在 pv-app.ts 中处理事件
```typescript
// 在 render 方法中监听事件
render() {
  return html`
    <pv-functions-bar 
      @new-feature-click=${this.onNewFeatureClick}
      .state=${this.state}>
    </pv-functions-bar>
  `;
}

// 添加事件处理方法
private onNewFeatureClick() {
  // 实现新功能逻辑
  console.log('New feature clicked');
}
```

### 3. 自定义样式

#### 3.1 组件样式
```typescript
static styles = css`
  :host {
    display: block;
    font-family: var(--md-sys-typescale-body-medium-font);
  }
  
  .container {
    padding: 16px;
    background-color: var(--md-sys-color-surface);
    border-radius: 8px;
  }
  
  .button {
    background-color: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    border: none;
    border-radius: 4px;
    padding: 8px 16px;
    cursor: pointer;
  }
  
  .button:hover {
    background-color: var(--md-sys-color-primary-container);
  }
`;
```

#### 3.2 响应式设计
```typescript
static styles = css`
  .responsive-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  
  @media (min-width: 768px) {
    .responsive-container {
      flex-direction: row;
    }
  }
  
  @media (max-width: 480px) {
    .responsive-container {
      padding: 8px;
    }
  }
`;
```

## 调试和故障排除

### 1. 常见问题

#### 组件不更新
```typescript
// 问题：组件没有响应状态变化
// 解决：确保继承 SignalWatcher
export class MyComponent extends SignalWatcher(LitElement) {
  // ...
}
```

#### 事件不触发
```typescript
// 问题：事件监听器没有正确绑定
// 解决：在 connectedCallback 中绑定
connectedCallback() {
  super.connectedCallback();
  this.addEventListener('my-event', this.handleMyEvent);
}
```

#### 状态不持久化
```typescript
// 问题：状态变化没有保存到 localStorage
// 解决：确保使用 state setter
// 错误：this.state.textSignal.set(newText);
// 正确：this.state.text = newText;
```

### 2. 开发工具

#### 使用 Storybook
```bash
# 启动 Storybook
npm run storybook

# 添加新的 story
# src/stories/my-component.stories.ts
export default {
  title: 'Components/MyComponent',
  component: 'pv-my-component',
};

export const Default = {
  args: {
    state: mockState,
  },
};
```

#### 浏览器调试
```typescript
// 在组件中添加调试信息
render() {
  console.log('Component rendering with state:', this.state);
  return html`<!-- ... -->`;
}
```

## 性能优化建议

### 1. 避免频繁重渲染
```typescript
// 使用 @property 而不是直接访问属性
@property({type: Object})
private state!: State;

// 使用 shouldUpdate 控制更新
shouldUpdate(changedProperties: PropertyValues) {
  return changedProperties.has('state');
}
```

### 2. 懒加载组件
```typescript
// 动态导入组件
private async loadComponent() {
  const module = await import('./heavy-component.js');
  // 使用组件
}
```

### 3. 防抖处理
```typescript
// 防抖输入处理
private handleInput = debounce((e: Event) => {
  this.updateSuggestions();
}, 300);
```

## 测试

### 1. 单元测试
```typescript
// src/tests/my-component.test.ts
describe('PvMyComponent', () => {
  let component: PvMyComponent;
  
  beforeEach(() => {
    component = new PvMyComponent();
    component.state = createMockState();
  });
  
  it('should render correctly', () => {
    const rendered = component.render();
    expect(rendered).toContain('My Component');
  });
});
```

### 2. 端到端测试
```typescript
// 使用 Playwright 进行端到端测试
test('should handle text input', async ({page}) => {
  await page.goto('/');
  await page.fill('textarea', 'Hello world');
  await page.click('[data-testid="suggest-button"]');
  
  const suggestions = await page.locator('.suggestion').all();
  expect(suggestions.length).toBeGreaterThan(0);
});
```

## 部署

### 1. 构建生产版本
```bash
npm run build
```

### 2. 部署到 Google App Engine
```bash
npm run deploy
```

## 参考资源

### 1. 官方文档
- [Lit Documentation](https://lit.dev/)
- [TypeScript Documentation](https://www.typescriptlang.org/)
- [Material Web Components](https://material-web.dev/)

### 2. 项目文档
- [前端架构文档](./frontend-architecture.md)
- [数据流详细说明](./data-flow-detailed.md)
- [组件关系图](./component-relationships.md)

### 3. 开发工具
- [Storybook](https://storybook.js.org/)
- [esbuild](https://esbuild.github.io/)
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)

通过这个快速入门指南，你应该能够理解 Project VOICE 的前端架构，并开始进行有效的开发工作。记住，项目使用现代的 Web 技术栈，重点关注可访问性和用户体验。