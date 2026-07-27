这是一个由 bun 驱动的 ai agent 软件。

## 代码风格

永远使用 posix 风格的路径。
在编写 ai agent 工具的使用，统一使用 snake_case 风格的 xml 格式返回结果，如需要处理路径时统一转化为 posix 风格。

### 通用原则

- 优先使用内联代码，如需复杂操作如递归，考虑提取为内联函数，只有代码真正能被复用时，或代码量较大时才考虑提取为公共函数。
- 优先使用函数式数组方法（flatMap、filter、map）而非 for 循环；在 filter 上使用类型守卫以保持下游的类型推断。
- 优先使用web api。

- 除非需要组合或复用，否则将所有逻辑放在一个函数中。
- 不要预先提取只使用一次的辅助函数。除非该辅助函数被复用、隐藏了真正复杂的边界、或具有能改善调用方可读性的明确独立名称，否则请将逻辑内联在调用处。
- 仅导出外部需要使用或已经使用的函数。避免过度导出。

遵循 YAGNI 原则：只实现当前明确需要的功能，不提前实现可能未来用到的功能。即使预测到后续需求，也要等到需求明确时再添加，避免增加不必要的复杂度和维护成本。

当一个值只使用一次时，通过内联来减少变量总数。
任何时候都不要主动删除解释性的注释，这些注释在日后维护时会帮助快速理解代码。对于一些复杂性较高的逻辑建议主动添加注释，说明其作用和实现原理。

```ts
// 好
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// 差
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### 变量

优先使用 `const` 而非 `let`。使用三元运算符或提前返回代替重新赋值。

```ts
// 好
const foo = condition ? 1 : 2

// 差
let foo
if (condition) foo = 1
else foo = 2
```

### 控制流

避免使用 `else` 语句。优先使用提前返回。

```ts
// 好
function foo() {
  if (condition) return 1
  return 2
}

// 差
function foo() {
  if (condition) return 1
  else return 2
}
```

### 语言

项目的首选语言为简体中文，无论是注释语言，日志展示语言，还是用户交互语言，优先使用简体中文。
