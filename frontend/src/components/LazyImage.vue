<template>
  <div class="lazy-image-wrapper" :class="{ 'is-loaded': isLoaded, 'has-error': hasError }">
    <div v-if="!isLoaded && !hasError" class="image-skeleton">
      <div class="skeleton-shimmer"></div>
    </div>
    <img
      v-show="isLoaded"
      :src="src"
      :alt="alt"
      :class="className"
      :style="imageStyle"
      @load="onLoad"
      @error="onError"
    />
    <div v-if="hasError" class="image-error">
      <span class="error-icon">{{ fallbackText }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'

const props = defineProps({
  src: { type: String, required: true },
  alt: { type: String, default: '' },
  className: { type: String, default: '' },
  fallbackText: { type: String, default: '?' },
  threshold: { type: Number, default: 0.1 },
  rootMargin: { type: String, default: '100px' }
})

const isLoaded = ref(false)
const hasError = ref(false)
const observer = ref(null)

const imageStyle = computed(() => ({
  opacity: isLoaded.value ? 1 : 0,
  transition: 'opacity 0.3s ease'
}))

function onLoad() {
  isLoaded.value = true
}

function onError() {
  hasError.value = true
  isLoaded.value = false
}

function loadImage() {
  if (isLoaded.value || hasError.value) return
  const img = new Image()
  img.onload = onLoad
  img.onerror = onError
  img.src = props.src
}

onMounted(() => {
  if ('IntersectionObserver' in window) {
    observer.value = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            loadImage()
            observer.value?.unobserve(entry.target)
          }
        })
      },
      {
        threshold: props.threshold,
        rootMargin: props.rootMargin
      }
    )
    const wrapper = document.querySelector('.lazy-image-wrapper')
    if (wrapper) {
      observer.value.observe(wrapper)
    }
  } else {
    loadImage()
  }
})

onUnmounted(() => {
  observer.value?.disconnect()
})
</script>

<style scoped>
.lazy-image-wrapper {
  position: relative;
  overflow: hidden;
  background: var(--bg-hover);
}

.image-skeleton {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--bg-hover) 0%, var(--bg-active) 50%, var(--bg-hover) 100%);
  background-size: 200% 200%;
  animation: shimmer 1.5s infinite;
}

.skeleton-shimmer {
  width: 100%;
  height: 100%;
}

@keyframes shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.lazy-image-wrapper.is-loaded .image-skeleton {
  display: none;
}

img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--brand-start) 0%, var(--brand-end) 100%);
}

.error-icon {
  font-size: 32px;
  font-weight: 700;
  color: white;
  letter-spacing: -2px;
}
</style>