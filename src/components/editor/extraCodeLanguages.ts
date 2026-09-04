/**
 * 补几门 atomic-editor 没带的代码块语言。
 *
 * 它自带的那份清单（`ATOMIC_CODE_LANGUAGES`）是刻意精简的：不用
 * `@codemirror/language-data` 那五十来门（约 1MB），只装真用得上的。
 * 代价是差了几门 —— **Vue 首当其冲**，`.vue` 单文件组件在这台机器上天天写。
 *
 * 没登记的语言不会报错，只是整段落回 `CodeText`（纯文本），一点高亮都没有。
 * 围栏上那个语言角标照样显示，因为它只是把 ``` 后面那串字原样印出来，
 * 不代表真的认得 —— 所以「有角标但没颜色」正是漏了语言的样子。
 *
 * `load()` 是动态 import：语法只在真出现这种代码块时才下载，
 * 不写 Vue 的人不用为它买单。加新语言照这个格式往下写就行。
 */
import { LanguageDescription } from '@codemirror/language'

export const EXTRA_CODE_LANGUAGES = [
  LanguageDescription.of({
    name: 'Vue',
    extensions: ['vue'],
    load: () => import('@codemirror/lang-vue').then((m) => m.vue()),
  }),
]
