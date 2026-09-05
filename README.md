# pi-zeldoc-provider

[Zeldoc.ai](https://zeldoc.ai) model provider for the
[Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

Registers `zeldoc` as a provider in Pi and discovers every model your Zeldoc.ai
API key can use, so you can pick ZDev or any router model from `/model`.

## Install

```bash
pi install npm:pi-zeldoc-provider
```

Or straight from GitHub:

```bash
pi install https://github.com/martinmose/pi-zeldoc-provider
```

## Authenticate

Either export your API key before starting Pi:

```bash
export ZELDOC_API_KEY=your-api-key
```

Or store it in Pi: start `pi`, run `/login`, pick **Zeldoc.ai**, and paste the key.

Don't have a key yet? See
[Generate an API key](https://docs.zeldoc.ai/connect-opencode#generate-an-api-key).

## Use

Start `pi`, run `/model`, and pick a model under **Zeldoc.ai**. ZDev is available
immediately; the rest of your catalog appears after the first refresh (a few
seconds after startup). To make ZDev the default, add to `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "zeldoc",
  "defaultModel": "zdev",
  "defaultThinkingLevel": "high"
}
```

Thinking levels are wired up per model: ZDev exposes `high` and `max`, ZDev 2
exposes `low`, `high`, and `max`, and router models (GPT, Gemini, GLM, ...) get
the effort levels published on [models.dev](https://models.dev).

## Limit which models are shown

Zeldoc.ai's catalog includes image, audio, and embedding models. Those are
filtered out automatically. To narrow the list further, add substrings to match
in `~/.pi/agent/settings.json`:

```json
{
  "zeldoc.models": ["zdev", "glm", "gpt-5"]
}
```

Only model ids containing one of the substrings are registered. Pi's own
`enabledModels` setting still applies on top for Ctrl+P cycling.

## How it works

- The ZDev models are registered synchronously with their known limits
  (1M context, 131k output), so `pi --model zeldoc/zdev` works even before the
  catalog has been fetched.
- On startup Pi asks the provider to refresh. The extension calls
  `GET /v1/models` on Zeldoc.ai, enriches the result with reasoning metadata
  from models.dev (cached for 7 days under `~/.pi/agent/cache/`), and persists
  the catalog in Pi's models store. Later sessions load from the store and
  re-fetch at most once an hour, or immediately with `pi update --models`.
- Set `PI_ZELDOC_PROVIDER_DEBUG=1` to trace refreshes on stderr.

## Development

```bash
pnpm install
pnpm check        # tsc --noEmit
pnpm format       # biome check
pnpm format:fix   # biome auto-fix
```

Try a local checkout without installing it:

```bash
pi --no-extensions -e ./extensions/zeldoc.ts --model zeldoc/zdev
```

## License

MIT
