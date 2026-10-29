import { defineConfig } from 'unocss'
import presetIcons from '@unocss/preset-icons'
import presetUno from '@unocss/preset-uno'
import transformerDirectives from '@unocss/transformer-directives'

export default defineConfig({
  // Source is a local package, so Vite's normal transform pipeline sees it.
  // Avoid a separate filesystem watcher that outlives Vite's dev server.
  content: { pipeline: { include: [/\.(vue|ts|html)($|\?)/] } },
  presets: [
    presetUno(),
    presetIcons({
      scale: 1,
      extraProperties: {
        display: 'inline-block',
        'flex-shrink': '0',
      },
    }),
  ],
  transformers: [transformerDirectives()],
  safelist: [
    'i-codicon-search',
    'i-codicon-watch',
    'i-codicon-history',
    'i-codicon-fold',
    'i-codicon-unfold',
    'i-codicon-chevron-right',
    'i-codicon-chevron-down',
    'i-codicon-close',
    'i-codicon-check',
    'i-codicon-error',
    'i-codicon-loading',
    'i-codicon-list-tree',
    'i-codicon-globe',
    'i-codicon-device-desktop',
    'i-codicon-cloud-upload',
    'i-codicon-cloud-download',
    'i-codicon-copy',
    'i-codicon-share',
    'i-codicon-color-mode',
    'i-codicon-folder-opened',
    'i-codicon-remote-explorer',
  ],
})
