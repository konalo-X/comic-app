import { ref, onBeforeUnmount } from 'vue'

export function useFetch() {
  const loading = ref(false)
  const error = ref(null)

  let controller = null

  function execute(asyncFn, opts = {}) {
    const { onError, silent = false } = opts

    if (controller) {
      controller.abort()
    }
    controller = new AbortController()

    loading.value = true
    error.value = null

    return Promise.resolve()
      .then(() => asyncFn({ signal: controller.signal }))
      .then((result) => {
        loading.value = false
        return result
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return
        loading.value = false
        error.value = e?.message || e?.toString() || 'Unknown error'
        if (!silent) {
          console.error('[useFetch]', error.value)
        }
        if (onError) {
          onError(e)
        }
      })
  }

  function abort() {
    if (controller) {
      controller.abort()
      controller = null
    }
    loading.value = false
  }

  function reset() {
    abort()
    error.value = null
  }

  onBeforeUnmount(() => {
    abort()
  })

  return { loading, error, execute, abort, reset }
}