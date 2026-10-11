// 提示词去重：同一个词只留第一次出现的，忽略大小写与多余空格。
// 纯函数（不碰响应式），方便测试。

export interface DedupeTag {
  value: string
  /** 权重（1 或空=不加权） */
  weight?: number
  /** 禁用的词不输出 */
  disabled?: boolean
}

/** 归一化成比较用的 key：去首尾空格、内部连续空白压成一个、转小写 */
export function tagKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 去掉重复的词，保留第一次出现的位置。
 * 两处"别丢信息"的处理：
 * - 后面的重复项带权重、保留的那个没有 → 把权重补给保留的（`masterpiece, (masterpiece:1.2)` 留成带权重的一个）
 * - 保留的被禁用、后面的重复项是启用的 → 保留的改为启用（否则看着还在、其实不输出）
 * 返回的是新对象，不改动传进来的数组与元素。
 */
export function dedupeTags<T extends DedupeTag>(
  tags: T[],
  keyOf: (tag: T) => string = tag => tagKey(tag.value),
): T[] {
  const seen = new Map<string, T>()
  const out: T[] = []
  for (const tag of tags) {
    const key = keyOf(tag)
    const kept = seen.get(key)
    if (!kept) {
      const copy = { ...tag }
      seen.set(key, copy)
      out.push(copy)
      continue
    }
    if (kept.weight === undefined && tag.weight !== undefined)
      kept.weight = tag.weight
    if (kept.disabled && !tag.disabled)
      kept.disabled = false
  }
  return out
}
