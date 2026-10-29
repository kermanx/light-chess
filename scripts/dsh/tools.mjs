import { defineTool } from '@deepseek-ai/dsh-tools'

// DSH's native parameter format, shared by both hosts. Rules and the current
// board come from the host prompt; tools only analyze hypotheses or select a move.
export function gameToolDefinitions(mode) {
  const arena = mode === 'arena'
  const integer = { type: 'integer', required: true }
  const action = { type: 'object', additionalProperties: false,
    description: arena ? 'Diagonal: {kind:"diag",x,y,ori}; edge: {kind:"edge",id:"h:x:y" or "v:x:y"}. Zero-based coordinates.' : 'Setup: {kind:"setup",home:{x,y,dir}}; diagonal: {kind:"diag",x,y,ori}; edge: {kind:"edge",id}. Zero-based coordinates.',
    properties: {
      kind: { type: 'string', enum: arena ? ['diag', 'edge'] : ['setup', 'diag', 'edge'], required: true },
      x: { type: 'integer' }, y: { type: 'integer' }, ori: { type: 'string', enum: ['/', '\\'] }, id: { type: 'string' },
      ...(!arena ? { home: { type: 'object', additionalProperties: false, properties: { x: integer, y: integer, dir: integer } } } : {}),
    },
  }
  const color = { type: 'string', enum: arena ? ['blue', 'red'] : ['blue', 'red', 'green', 'yellow'], required: true }
  return {
    analyze: ['Analyze the current board or 0..8 proposed alternating moves without changing it. Returns exact turn settlement, threats and paginated attack/defense candidates for the FINAL side to move; legal fallback when neither exists. Counts are complete; ordering is not strategic ranking. Optional light details apply to that same hypothetical board.', {
      sequence: { type: 'array', items: { ...action, properties: { ...action.properties, kind: { type: 'string', enum: ['diag', 'edge'], required: true } } }, description: 'Defaults to []. During setup only [] is supported.' },
      offset: { type: 'integer', description: 'Page offset for each candidate group; default 0.' },
      limit: { type: 'integer', description: 'Candidates per group, default 8, range 1..20.' },
      light: { type: 'object', additionalProperties: false, description: 'Optional actual light paths and reachable cells; omitted by default.', properties: {
        color, target: { type: 'object', additionalProperties: false, properties: { x: integer, y: integer } },
      } },
    }],
    // Keep committing an action independent of free-form explanation generation.
    play: ['Select ONE final legal move for this turn. Success returns only {ok:true}; the host supplies the next board separately. No undo.', {
      action: { ...action, required: true },
    }],
  }
}

export function gameToolsPlugin({ game, mode, onTool = () => {}, afterTool = () => {}, getMoveExplanation = () => '' }) {
  return {
    name: 'light-chess-tools', inject: ['tools'],
    apply(ctx) {
      for (const [name, [description, parameters]] of Object.entries(gameToolDefinitions(mode))) {
        ctx.effect(() => ctx.tools.register(defineTool({
          name, description, parameters,
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute(args) {
            onTool('call', { name, args })
            let result
            try { result = await game[name](name === 'play' ? { ...args, rationale: getMoveExplanation() } : args) }
            catch (error) {
              result = { error: String(error.message ?? error) }
              onTool('result', { name, result })
              await afterTool(name, result)
              // Preserve native tool failure semantics in the session and UI.
              throw error
            }
            onTool('result', { name, result })
            await afterTool(name, result)
            return JSON.stringify(result)
          },
          presentCall: () => ({ title: name }),
        })))
      }
    },
  }
}
