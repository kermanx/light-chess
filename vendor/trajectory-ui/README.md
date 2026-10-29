# Trajectory UI

`@deepseek-ai/trajectory-ui` is a Vue 3 component library distilled from the DeepSeek Harness trajectory view. It keeps the original dense event-ledger composition: a 32px toolbar, a three-lane 50px timing overview, 30px ledger rows with Turn and Request rails, and a local resizable inspector.

The package exports its Vue, TypeScript, and CSS sources directly. The reusable library entry does not import a DeepSeek Harness runtime or require Harness session events, and it has no library build step. Consumers must process Vue SFCs and run UnoCSS with the Codicon icon collection enabled. The repository's Trajectory Viewer application separately pins the official Harness session-format reader for file and raw-share imports.

This repository also contains the Trajectory Viewer single-page application. The app uses the library as its main surface and adds local and server-mounted imports, trajectory-group navigation, downloads, and an immutable public sharing API.

## Trajectory Viewer

The application opens with an empty, local group. Imported files stay in the browser until the user selects **Share**. Local groups have no application-defined file-size or item-count limit; the browser's available memory and WebAssembly limits still apply. A shared group is limited to 1,024 trajectories and 1 GiB per trajectory, and receives a random ten-character URL id.

The importer accepts normalized Trajectory UI documents, record arrays, common chat message arrays, DeepSeek Harness session JSON Lines, and Code CLI benchmark exports (`code_cli.trajectory/v1`). It reads `.json`, `.jsonl`, and `.ndjson` directly. Parsing runs in a browser worker; DSH sessions use the official catalog for decoding and migration. Archives are extracted in a separate browser worker and can contain multiple trajectory files or archives nested up to four levels; supported families include Zip, 7-Zip, RAR, Tar, Cpio, Cab, LHA, and filters such as Gzip, Bzip2, XZ/LZMA, and Zstandard.

Code CLI exports expand each agent's `trajs` into separate selectable trajectories, with the primary agent first. This applies to files, archives, network paths and existing raw shares. Structured tool calls/results take precedence over their flattened text copies; reasoning, error flags and exact argument strings are retained. Cached input tokens are separated from uncached input. Message timestamps are retained, but request duration and TTFT remain unavailable when the export did not record them. The original run/sample, agent and trajectory data (including generation metadata and unapplied `overlay_patches`) remain under the normalized document's `codeCli` field through sharing and downloads. Normalized documents remain version 1. Links to subsequent trajectories inside a raw share use `trajectory=<manifest-id>~2`, `~3`, and so on.

The same adapter is available to library consumers without a DSH runtime:

```ts
import { parseCodeCliTrajectory, type TrajectoryDocument } from '@deepseek-ai/trajectory-ui'

const documents: TrajectoryDocument[] | null = parseCodeCliTrajectory(JSON.parse(text), 'benchmark')
// null means a different format; malformed or unsupported Code CLI versions throw.
// Pass a document's records and requests to TrajectoryView.
```

Build and run the complete local application with persistent data in `.data`:

```sh
pnpm install
pnpm build
TRAJECTORY_DATA_ROOT=.data pnpm start
```

The server listens on `0.0.0.0:${PORT:-4173}`. `PUBLIC_BASE_PATH` configures a stable external path such as `/trajectory-viewer-test/`; HFAI Dev Preview paths are derived from `DEPLOY_PREVIEW_URL`. Deployed test and production environments must provide an absolute, persistent `TRAJECTORY_DATA_ROOT`. Dev Previews use `DEPLOY_PREVIEW_DATA_ROOT` automatically.

The server discovers the cluster's NFS/Weka/3FS mounts from `/proc/self/mounts` and groups them under their top-level storage directories (`/weka-*`, `/nfs-*`, `/fs-*`, `/hf3fs-*`, and `/hdd`). Only namespaces with an actual recognized network mount are shown; personal mount paths and runtime mounts such as `/opt/conda` are not separate entry points. 3FS mounts use `hffuse.hf3fs`. A directly supplied Weka path may resolve through a symbolic link into a mounted 3FS root; the resolved destination must still be inside an allowed root. The **Path** dialog starts at these roots each time it opens, with no saved-path or share-history list.

`TRAJECTORY_IMPORT_ROOTS` optionally overrides discovery, for example when running locally. Each entry must be an existing absolute directory; separate multiple entries with the platform path delimiter (`:` on Linux and macOS, `;` on Windows). An explicitly empty value disables network-path imports. The server resolves symbolic links before checking containment, rejects targets outside the roots, and does not follow symbolic links while walking a requested directory. A directory is streamed to the browser as a Zip64 archive containing only supported trajectory and archive files.

```sh
TRAJECTORY_IMPORT_ROOTS=/weka-hg \
TRAJECTORY_DATA_ROOT=.data \
pnpm start
```

Network-path imports are read into the requesting browser and are not copied into the share store unless the user selects **Share**. The API is unauthenticated: anyone who can reach the application can browse these network roots and read supported files that the server process can access.

The **Path** dialog can browse these configured roots one folder at a time. Use its breadcrumbs or **Up one level** to navigate, select a file, or import the current folder. The absolute-path field remains editable; **Browse** opens a typed directory or selects a typed file in its parent folder, while **Import path** imports it directly. Listings show subfolders and supported trajectory/archive files and omit symbolic-link entries.

Open an allowlisted NFS file or directory directly by placing its absolute path in the application URL. The page reads the current NFS contents on every load; selecting **Share** creates a separate immutable snapshot.

```text
https://example.test/trajectory-viewer/?path=/weka-hg/team/trajectory-imports/run.jsonl
```

The application URL accepts `path` only on its base route, not on a shared-group route. Special URL characters in the path must be percent encoded. The absolute path remains visible in browser history and HTTP access logs.

The viewer also synchronizes its current view to query parameters, and **Share** / **Copy link** includes them:

- `trajectory`: the manifest trajectory ID for an uploaded share, or the one-based import position for a local/network group.
- `message` or `request`: the selected record ID or request ID. Requests take precedence if both are supplied.
- `tab`: the inspector tab key (`summary`, `preview`, `raw`, `source`, `code`, `payload`, `result`, `schema`, `timing`, `usage`, `options`, `diff`, `systemPrompt`, or `tools`).
- `search`: the trajectory search text, URL encoded without trimming.

Opening or reloading the link restores the chosen trajectory before its selection, tab, and search. Missing or unknown trajectories fall back to the first item; unknown selections are cleared and unavailable tabs fall back to a supported tab. View changes replace the current history entry, and browser navigation restores the destination URL's view. Local file contents still require uploading to share with another browser. Network links reflect the current contents and ordering of the imported path.

### Sharing API v1

All endpoints are stable beneath the application's external path:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `api/v1` | API capabilities and limits |
| `GET` | `api/v1/imports/network-path?path=...` | Browse an allowlisted directory; omit `path` to list configured roots |
| `POST` | `api/v1/imports/network-path` | Read an allowlisted server file or directory into the requesting browser |
| `POST` | `api/v1/shares` | Upload and atomically publish a group |
| `GET` | `api/v1/shares/{shareId}` | Read group metadata without trajectory bodies |
| `GET` | `api/v1/shares/{shareId}/trajectories/{trajectoryId}` | Stream one uploaded trajectory in its stored representation; byte ranges are supported |
| `GET` | `api/v1/shares/{shareId}/download` | Stream the complete group as a Zip64 archive |

Network browsing returns `path` (the listed directory), `parentPath`, `selectedPath`, `breadcrumbs`, and `entries` with `name`, absolute `path`, and `kind` (`directory` or `file`). At the root chooser the path fields are `null`. A file path lists its parent and sets `selectedPath` to the file. Browsing does not read file contents or publish data, and uses the same canonical-path containment checks as importing.

Create a share with one `metadata` field followed by one or more `trajectory` file fields. Each file may be a DeepSeek Harness session `.jsonl`/`.ndjson` exactly as DSH produced it or a normalized Trajectory UI JSON object; no client-side conversion is required. Send each part with `Content-Type: application/json`; metadata order matches file-part order.

```sh
curl --fail-with-body \
  -F 'metadata={"version":1,"title":"Example","trajectories":[{"name":"run-1"}]}' \
  -F 'trajectory=@run-1.jsonl;type=application/json' \
  https://example.test/trajectory-viewer/api/v1/shares
```

HTTP `201` confirms that every uploaded part uses a supported format. The response contains `id`, the relative page `path`, and the immutable public `manifest`. Unsupported inputs return `415 unsupported_trajectory_format`. The API is intentionally unauthenticated; deployment operators should size and monitor the registered persistent data directory accordingly.

## Install

```sh
pnpm add @deepseek-ai/trajectory-ui vue
```

```ts
import { createApp } from 'vue'
import { TrajectoryView } from '@deepseek-ai/trajectory-ui'
import '@deepseek-ai/trajectory-ui/style.css'
```

## Record input

The public record is intentionally smaller than the dsh session projection. Array order owns ledger order; `id` owns identity across stream patches and older-history prepends.

The ledger opens at the newest loaded record and follows streamed appends while the viewport remains at the tail. Scrolling away pauses tail following; returning to the bottom resumes it. Clicking a timeline span brings its record into view, while dragging a timeline range centers the matching rows or aligns the first match when the range is taller than the viewport. A Request boundary dot selects the request-level Summary, Usage, and Timing inspector without selecting its anchor row; `selectedRequestId` and `update:selectedRequestId` expose that selection separately from `selectedId`.

The timeline preserves elapsed time for timestamp-only or partially timed operations. Points mark events; solid bars show recorded durations. For observation-only sources, hatched bars show estimated durations, explicitly labeled with ≈ in tooltips and Timing details. Fully timed operations retain idle-gap compression, labeled **Active time**. Scroll to zoom, right-drag to pan, drag to select a range, and use **Reset zoom** to restore the full time range; Escape clears the selection. Equal-width mode includes records without timestamps.

For observation-only sources, set the optional `TrajectoryRecord.timestampKind` to `'observation'`: `startedAt` then locates the recorded event and is not used as a request start or duration-bar anchor. Optional `resultObservedAt` adds a separate result marker that selects the same tool row. Code CLI imports set these fields automatically; the viewer upgrades earlier normalized Code CLI downloads in memory while preserving their records and stored share bytes. Model estimates run from the preceding message or latest matched tool result to the reply timestamp. Tool estimates run from each call to its matched result, so parallel calls can overlap. Missing or reversed boundaries, unfinished results, and zero-length gaps stay as event points. Estimates can include queueing and processing overhead; they are derived for display only and never populate measured duration, request timing, TTFT, generation time or throughput fields. Existing normalized files gain the same estimates without rewriting stored data.

```ts
import type { TrajectoryRecord, TrajectoryRequestDetails } from '@deepseek-ai/trajectory-ui'

const records: TrajectoryRecord[] = [{
  id: 'assistant-42',
  seq: 142,
  kind: 'assistant',
  turn: 7,
  step: 2,
  requestId: 'request-19',
  requestNumber: 19,
  summary: 'I found the lifecycle regression.',
  status: 'complete',
  startedAt: Date.now() - 2_400,
  durationMs: 2_400,
  ttftMs: 310,
  provider: 'deepseek',
  model: 'deepseek-chat',
  input: { messages: 18 },
  output: 'I found the lifecycle regression.',
  reasoning: 'The disposer is registered after the async handoff.',
  usage: { input: 4096, cacheRead: 3584, output: 188, reasoning: 72 },
}]

const requests: TrajectoryRequestDetails[] = [{
  id: 'request-19',
  number: 19,
  turn: 7,
  status: 'complete',
  provider: 'deepseek',
  model: 'deepseek-chat',
  startedAt: Date.now() - 2_400,
  durationMs: 2_400,
  ttftMs: 310,
  options: { temperature: 0 },
  usage: { input: 4096, cacheRead: 3584, output: 188, reasoning: 72 },
  resultId: 'assistant-42',
}]
```

Supported kinds are `system`, `user`, `context`, `compacted`, `assistant`, `tool`, and `subtool`. Tool and subtool records can point at an assistant with `parentId`; this is what the Calls fold control collapses. Pass `requests` when request-level status, options, cumulative usage, retry details, or timing cannot be reconstructed from a record. Assistant `sourceBlocks` preserve raw text, thinking, image, and tool-call order. System records can carry `tools`, `previousInput`, and `previousTools` for the catalog and update diff.

## Harness session compatibility

The application reads native Harness v4 JSON Lines with the official current format catalog. Historical v0–v3 files use the official historical catalog and retain their v3 logical representation: upgrading them to v4 requires external child-session evidence that a standalone file cannot supply. Both feed the same projector. Strict validation runs first; recovery reports when damaged data may have been omitted. Newer formats or officially refused input receive a visible best-effort warning. Normalized downloads and shares stay at version 1. See the [synchronization record](docs/upstream-sync.md) for the exact upstream commit, pinned reader release, compatibility rules and remaining differences.

Records may additionally carry `inputRaw` for exact tool arguments, `outputBlocks` for tool-result content, `rawOutput` for the original compaction response, `interrupted`, `steering`, and structured `error` fields. `toolChanges: { added, removed }` names tools changed by a context message. `requestOnly` marks a request placeholder without an assistant result, and `resultSeq` identifies a persisted tool result. `TrajectoryRequestDetails.systemPrompt` and `tools` capture the prompt state at that request; tool definitions retain optional `deferLoading: true`. Existing `input` and `output` values keep their meanings.

```ts
const program: TrajectoryRecord = {
  id: 'tool-42', kind: 'tool', toolName: 'run_code', summary: 'Inspect the report',
  input: { code: 'print(42)\n', description: 'Inspect the report' },
  inputRaw: '{ "code": "print(42)\\n", "description": "Inspect the report" }\n',
  schema: { parameters: { properties: { code: { description: 'Python source code' } } } },
  output: [{ type: 'text', text: '{"rows":42}' }],
  outputBlocks: [{ type: 'text', content: '{"rows":42}' }],
}
```

`run_code` gains a Code inspector with line numbers, wrapping, exact copying and an original-JSON toggle. Summary uses the same highlighter in a compact, wrapped preview without the toolbar or line numbers, including records that supply only `inputRaw`. Language highlighting uses the recorded schema's leading ``Execute a program in `typescript` `` / ``Execute a program in `python` `` declaration or its legacy code-parameter description. Unknown, missing or conflicting language hints remain plain text; source code and current runtime settings are not used to guess the language. Structured results have an expandable JSON view; expanding a string preserves its newlines and allows independent wrapping.

A content block can retain an `attachment` object and a caller-supplied `url`. Attachment rows preserve order and repeated references, show filenames, media types, byte sizes and image dimensions, and open available images in a lightbox. Durable attachment IDs are not URLs: the file viewer shows reference details when bytes are unavailable. Raw attachment fields start collapsed. File and unknown content blocks use `type: 'text'` with a readable `content` fallback and an `original` value, retaining compatibility with earlier library readers.

Markdown links distinguish absolute URLs from filesystem paths, including Windows and line-suffixed paths. Safe URL schemes remain clickable; local files without a workspace opener and unsafe destinations retain inert labels. Images require absolute HTTP(S), and raw HTML never executes. In-page footnotes remain supported.

The tool Result tab separates the live raw result from persisted rendered content. Historical files contain only the latter. A live integration can pass `watchToolResult` to `TrajectoryView` (or `TrajectoryInspector`):

```ts
import type { TrajectoryWatchToolResult } from '@deepseek-ai/trajectory-ui'

const watchToolResult: TrajectoryWatchToolResult = (resultSeq, onValue) => {
  // Subscribe to this session's canonical result and return its cleanup function.
  return sessionResults.subscribe(resultSeq, onValue)
}
```

The view subscribes only while that record's Result tab is selected, disposes on selection/tab/observer changes and unmount, and ignores late updates. Publish `undefined` when a result becomes unavailable; `null` and `false` remain valid results. Use a new observer function when switching sessions. Live values are held only in the inspector and are not serialized into records or shares.

## Basic view

```vue
<script setup lang="ts">
import { TrajectoryView } from '@deepseek-ai/trajectory-ui'
import '@deepseek-ai/trajectory-ui/style.css'
import { records, requests } from './trajectory-data'
</script>

<template>
  <div style="height: 100vh">
    <TrajectoryView :records="records" :requests="requests" theme="light" locale="en" />
  </div>
</template>
```

`theme` accepts `light`, `dark`, `auto`, or `host`; `locale` accepts `en` or `zh-CN`. `host` maps the library palette to the nearest `--ui-*` semantic tokens supplied by the containing application. Role tags keep their dsh colors unless the host provides `--ui-role-user`, `--ui-role-user-bg`, `--ui-role-context`, `--ui-role-context-bg`, `--ui-role-assistant`, `--ui-role-assistant-bg`, `--ui-role-tool`, or `--ui-role-tool-bg`. The inspector renders GFM, footnotes, KaTeX, and Shiki-highlighted code with raw HTML and unsafe links disabled; structured results and request options use expandable JSON trees; schemas and sources retain their preformatted views. It also exposes `input`, `output`, and `reasoning` scoped slots when an application needs a domain renderer.

Use `v-model:selected-id`, `v-model:selected-request-id`, `v-model:search-query`, and `v-model:inspector-tab` to control the view from a host application. `inspectorTab` accepts `TrajectoryDetailTab | null` and reports the resolved tab when the selection changes. The standalone `TrajectoryInspector` exposes `v-model:active-tab`. These bindings are optional; the library keeps internal state when omitted and leaves URL handling to the host.

## Streaming

Use a store when records arrive incrementally. `append` and `prepend` deduplicate by `id`; `patch` updates a running row without changing its identity or virtual position.

```ts
import { createTrajectoryStore } from '@deepseek-ai/trajectory-ui'

const store = createTrajectoryStore()

store.apply({
  type: 'append',
  records: [{
    id: 'assistant-live',
    kind: 'assistant',
    turn: 1,
    step: 1,
    summary: '',
    status: 'running',
    startedAt: Date.now(),
    durationMs: null,
  }],
})

store.apply({
  type: 'patch',
  id: 'assistant-live',
  patch: { summary: 'The first streamed fragment' },
})
```

The store can consume an `AsyncIterable<TrajectoryMutation>` or a `ReadableStream<TrajectoryMutation>` directly:

```ts
await store.consume(mutationStream, { signal: abortController.signal })
```

For an HTTP NDJSON response, convert the byte stream first:

```ts
import { readTrajectoryNdjson } from '@deepseek-ai/trajectory-ui'

const response = await fetch('/api/trajectory', { signal })
if (!response.body) throw new Error('Missing response body')
await store.consume(readTrajectoryNdjson(response.body, signal), { signal })
```

## Progressive older history

Pass an older-page loader to the store. The timeline boundary and first ledger row request one page. After a prepend, the ledger restores the prior visual anchor so content does not jump.

```ts
const store = createTrajectoryStore({
  records: recentRecords,
  hasMore: true,
  loadOlder: async ({ beforeId, beforeSeq, signal }) => {
    const query = new URLSearchParams({
      ...(beforeId ? { beforeId } : {}),
      ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }),
    })
    const response = await fetch(`/api/trajectory/history?${query}`, { signal })
    return await response.json() as {
      records: TrajectoryRecord[]
      hasMore: boolean
    }
  },
})
```

```vue
<TrajectoryView :store="store" />
```

## Mutations

- `append`: add new tail records or replace same-id tail values.
- `prepend`: add an older prefix and optionally update `hasMore`.
- `patch`: immutably update one same-id record.
- `upsert`: append or replace one record.
- `remove`: remove records by stable id.
- `replace`: replace the complete loaded window.
- `history`: update history availability or its loading marker.

Call `store.dispose()` when an application owns the store lifecycle. A store passed to `TrajectoryView` remains caller-owned; an internal store created from the `records` prop is disposed by the view.

## Development

```sh
pnpm install
pnpm dev
pnpm typecheck
```
