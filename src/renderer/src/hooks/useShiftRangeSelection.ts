import { useCallback, useRef } from 'react'

export function useShiftRangeSelection(orderedKeys: string[]) {
  const lastClickedKeyRef = useRef<string | null>(null)

  const resolveRange = useCallback(
    (key: string, shiftKey: boolean): string[] => {
      const anchorKey = lastClickedKeyRef.current
      lastClickedKeyRef.current = key

      if (!shiftKey || anchorKey === null) {
        return [key]
      }

      const anchorIndex = orderedKeys.indexOf(anchorKey)
      const keyIndex = orderedKeys.indexOf(key)

      if (anchorIndex === -1 || keyIndex === -1) {
        return [key]
      }

      const start = Math.min(anchorIndex, keyIndex)
      const end = Math.max(anchorIndex, keyIndex)
      return orderedKeys.slice(start, end + 1)
    },
    [orderedKeys],
  )

  return { resolveRange }
}
