import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'

export default [
  {
    ignores: ['node_modules/', 'dist/', 'release/', 'electron/']
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        window: true
      },
      ecmaVersion: 'latest',
      sourceType: 'module'
    }
  },
  ...pluginVue.configs['flat/recommended'],
  prettier,
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      'vue/require-default-prop': 'off',
      'vue/require-prop-types': 'off'
    }
  }
]
