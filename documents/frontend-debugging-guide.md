# 前端调试指南 - 从后端开发者视角

## 1. Console 日志 - 前端的 "print"

### 1.1 基本用法
```javascript
// 最基础的打印，类似 Python 的 print()
console.log('Hello World');
console.log('用户输入:', textValue);
console.log('API 响应:', response);

// 打印多个值
console.log('值1:', value1, '值2:', value2);

// 打印对象（会显示可展开的结构）
console.log({
  user: 'John',
  age: 30,
  data: [1, 2, 3]
});
```

### 1.2 不同级别的日志
```javascript
console.log('普通信息');      // 白色/黑色
console.info('提示信息');     // 蓝色图标
console.warn('警告信息');     // 黄色警告
console.error('错误信息');    // 红色错误
console.debug('调试信息');    // 灰色（可能需要开启 verbose）
```

### 1.3 高级 Console 技巧
```javascript
// 分组日志
console.group('API 请求详情');
console.log('URL:', url);
console.log('参数:', params);
console.log('响应:', response);
console.groupEnd();

// 表格显示（适合数组/对象数组）
console.table([
  { name: '建议1', score: 0.9 },
  { name: '建议2', score: 0.8 }
]);

// 计时器
console.time('API请求耗时');
// ... 执行代码
console.timeEnd('API请求耗时'); // 输出: API请求耗时: 234.567ms

// 断言（条件为 false 时才打印）
console.assert(response.length > 0, '响应为空！');

// 追踪调用栈
console.trace('调用栈追踪');
```

## 2. 在 Project VOICE 中添加调试日志

### 2.1 在 macro-api-client.ts 中添加日志
```typescript
async fetchSuggestions(
  textValue: string,
  language: string,
  model: string,
  context: {...}
) {
  console.group('🚀 fetchSuggestions 调用');
  console.log('输入文本:', textValue);
  console.log('语言:', language);
  console.log('模型:', model);
  console.log('上下文:', context);
  
  // ... 原有代码
  
  const result = await Promise.all([sentencesFetch, wordsFetch]);
  
  console.log('✅ API 响应:', result);
  console.groupEnd();
  
  return result;
}

// 解析函数中添加日志
function parseResponse(response: string, num: number) {
  console.log('原始响应:', response);
  
  const parsed = response
    .split('\n')
    .map(text => text.trim())
    .filter(text => text.match(/^[0-9]+\./))
    .slice(0, num)
    .map(text => text.replace(/^\d+\.\s?/, ''));
    
  console.log('解析结果:', parsed);
  return parsed;
}
```

### 2.2 在 pv-app.ts 中添加日志
```typescript
async updateSuggestions() {
  console.log('📝 updateSuggestions 触发');
  console.log('当前文本:', this.state.text);
  
  // 显示防抖延迟
  const delay = this.delayBeforeFetchMs();
  console.log(`⏱️ 防抖延迟: ${delay}ms`);
  
  // ... 原有代码
}

private onSuggestionSelect(e: SuggestionSelectEvent) {
  const [value, index, source] = e.detail;
  console.log('👆 用户选择了建议:', {
    value,
    index,
    source,
    当前文本: this.textField?.value
  });
}
```

## 3. Chrome DevTools 调试

### 3.1 打开开发者工具
- **Windows/Linux**: `F12` 或 `Ctrl+Shift+I`
- **Mac**: `Cmd+Option+I`
- **右键菜单**: 右键点击页面 → "检查"

### 3.2 Console 面板
- 查看所有 console.log 输出
- 可以直接在 Console 中执行 JavaScript 代码
- 支持自动补全和历史命令

### 3.3 断点调试（类似 Python 的 pdb）
```javascript
// 在代码中添加断点
debugger;  // 程序会在这里暂停

// 或者在 Sources 面板中点击行号添加断点
```

**断点调试操作**：
- `F8`: 继续执行
- `F10`: 单步执行（不进入函数）
- `F11`: 单步执行（进入函数）
- `Shift+F11`: 跳出当前函数

### 3.4 条件断点
右键点击行号 → "Add conditional breakpoint"
```javascript
// 只在特定条件下暂停
textValue.length > 10
```

## 4. Network 面板 - 监控 API 请求

查看所有网络请求，特别适合调试 API：
- 请求 URL、方法、状态码
- 请求头和响应头
- 请求体和响应体
- 请求时间线

**使用技巧**：
1. 过滤器：只看 XHR/Fetch 请求
2. 保留日志：勾选 "Preserve log"
3. 查看详细信息：点击具体请求

## 5. 实时修改和测试

### 5.1 Console 中直接测试
```javascript
// 获取页面上的组件实例
const app = document.querySelector('pv-app');
console.log(app.state.text);  // 查看当前文本

// 手动触发方法
app.updateSuggestions();

// 修改状态
app.state.text = '测试文本';
```

### 5.2 Sources 面板实时编辑
1. 在 Sources 中找到文件
2. 直接编辑代码
3. `Ctrl+S` 保存（临时生效）

## 6. 性能分析

### 6.1 Performance 面板
- 记录页面性能
- 查看函数执行时间
- 分析渲染性能

### 6.2 简单性能日志
```javascript
// 测量函数执行时间
console.time('updateSuggestions');
await this.updateSuggestions();
console.timeEnd('updateSuggestions');

// 使用 performance API
const start = performance.now();
// ... 执行代码
const end = performance.now();
console.log(`执行时间: ${end - start}ms`);
```

## 7. 实用调试模式

### 7.1 开发环境条件日志
```javascript
// 只在开发环境打印
if (process.env.NODE_ENV === 'development') {
  console.log('调试信息:', data);
}
```

### 7.2 使用装饰器模式添加日志
```javascript
// 为所有方法调用添加日志
function logMethod(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;
  
  descriptor.value = function(...args: any[]) {
    console.log(`📍 调用 ${propertyKey}:`, args);
    const result = originalMethod.apply(this, args);
    console.log(`✅ ${propertyKey} 返回:`, result);
    return result;
  };
  
  return descriptor;
}

// 使用
class MyClass {
  @logMethod
  myMethod(param: string) {
    return param.toUpperCase();
  }
}
```

## 8. VS Code 调试

### 8.1 配置 launch.json
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "chrome",
      "request": "launch",
      "name": "Launch Chrome",
      "url": "http://localhost:5000",
      "webRoot": "${workspaceFolder}"
    }
  ]
}
```

### 8.2 在 VS Code 中设置断点
- 点击行号左侧设置断点
- F5 启动调试
- 使用调试面板控制执行

## 9. 常见调试场景

### 9.1 调试异步代码
```javascript
async function fetchData() {
  console.log('1. 开始请求');
  
  try {
    const response = await fetch(url);
    console.log('2. 收到响应:', response.status);
    
    const data = await response.json();
    console.log('3. 解析数据:', data);
    
    return data;
  } catch (error) {
    console.error('请求失败:', error);
    throw error;
  }
}
```

### 9.2 调试事件处理
```javascript
element.addEventListener('click', (event) => {
  console.log('点击事件:', {
    target: event.target,
    currentTarget: event.currentTarget,
    坐标: { x: event.clientX, y: event.clientY }
  });
});
```

### 9.3 调试状态变化
```javascript
// 使用 Proxy 监听对象变化
const watchedState = new Proxy(state, {
  set(target, property, value) {
    console.log(`状态变化: ${property} = ${value}`);
    target[property] = value;
    return true;
  }
});
```

## 10. 最佳实践

1. **使用有意义的日志**
   ```javascript
   // ❌ 不好
   console.log(data);
   
   // ✅ 好
   console.log('用户选择的建议:', data);
   ```

2. **使用 emoji 让日志更清晰**
   ```javascript
   console.log('🚀 开始请求');
   console.log('✅ 请求成功');
   console.log('❌ 请求失败');
   console.log('⚠️ 警告信息');
   ```

3. **生产环境移除日志**
   - 使用构建工具自动移除
   - 或使用条件判断

4. **使用 Source Maps**
   - 让压缩后的代码也能调试
   - 在 TypeScript 项目中特别重要

## 总结

前端调试主要依赖：
1. **Console API** - 最常用，类似 print
2. **Chrome DevTools** - 功能强大的调试工具
3. **断点调试** - 类似 pdb，可以逐步执行
4. **Network 面板** - 专门调试 API 请求
5. **VS Code 调试** - IDE 集成调试

对于 Project VOICE，建议你：
1. 在关键函数入口添加 console.log
2. 使用 Network 面板查看 API 请求/响应
3. 在复杂逻辑处设置断点
4. 使用 console.table 查看建议数组

这样你就能像在后端使用 print 一样方便地调试前端代码了！
