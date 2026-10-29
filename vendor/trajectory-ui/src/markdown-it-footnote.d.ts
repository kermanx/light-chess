declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it'

  const markdownItFootnote: (markdown: MarkdownIt) => void
  export default markdownItFootnote
}
