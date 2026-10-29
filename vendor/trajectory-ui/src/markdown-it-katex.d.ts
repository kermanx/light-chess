declare module 'markdown-it-katex' {
  import type MarkdownIt from 'markdown-it'

  interface KatexOptions {
    throwOnError?: boolean
    errorColor?: string
    strict?: boolean | string | ((errorCode: string, errorMsg: string, token: unknown) => boolean | string | undefined)
  }

  const markdownItKatex: (markdown: MarkdownIt, options?: KatexOptions) => void
  export default markdownItKatex
}
