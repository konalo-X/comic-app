import { ref, onMounted, onUnmounted } from 'vue'

export function useTouch(elementRef, options = {}) {
  const {
    onSwipeLeft,
    onSwipeRight,
    onSwipeUp,
    onSwipeDown,
    onTap,
    onLongPress,
    threshold = 50,
    longPressDelay = 500
  } = options

  const startX = ref(0)
  const startY = ref(0)
  const startTime = ref(0)
  const isLongPress = ref(false)
  let longPressTimer = null

  const handleTouchStart = (e) => {
    const touch = e.touches[0]
    startX.value = touch.clientX
    startY.value = touch.clientY
    startTime.value = Date.now()
    isLongPress.value = false

    if (onLongPress) {
      longPressTimer = setTimeout(() => {
        isLongPress.value = true
        onLongPress(e)
      }, longPressDelay)
    }
  }

  const handleTouchMove = (e) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
  }

  const handleTouchEnd = (e) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }

    if (isLongPress.value) return

    const touch = e.changedTouches[0]
    const deltaX = touch.clientX - startX.value
    const deltaY = touch.clientY - startY.value
    const deltaTime = Date.now() - startTime.value

    // 快速点击
    if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10 && deltaTime < 300) {
      onTap?.(e)
      return
    }

    // 水平滑动
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > threshold) {
      if (deltaX > 0) {
        onSwipeRight?.(e)
      } else {
        onSwipeLeft?.(e)
      }
      return
    }

    // 垂直滑动
    if (Math.abs(deltaY) > threshold) {
      if (deltaY > 0) {
        onSwipeDown?.(e)
      } else {
        onSwipeUp?.(e)
      }
    }
  }

  onMounted(() => {
    const el = elementRef.value
    if (!el) return

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: true })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })
  })

  onUnmounted(() => {
    const el = elementRef.value
    if (!el) return

    el.removeEventListener('touchstart', handleTouchStart)
    el.removeEventListener('touchmove', handleTouchMove)
    el.removeEventListener('touchend', handleTouchEnd)

    if (longPressTimer) {
      clearTimeout(longPressTimer)
    }
  })
}