# `@adhdev/terminal-render-web`

Browser terminal renderer used by ADHDev web surfaces.

## Sizing

Default and recommended sizing mode is `measured`.

- `measured`: dashboard default and preferred mode. Terminal size stays daemon-authoritative.
- `fit`: advanced opt-in escape hatch. Not recommended for normal dashboard use.

Example:

```tsx
<GhosttyTerminalView
  onInput={handleInput}
  onResize={handleResize}
  sizingMode="fit"
/>
```

Dashboard GUI does not expose this option and stays on `measured`.

For standalone/dashboard, advanced users can opt into `fit` by setting this in `~/.adhdev/config.json`:

```json
{
  "terminalSizingMode": "fit"
}
```

When omitted, the daemon reports `measured` and the dashboard keeps terminal sizing daemon-authoritative. This is the expected path for the best terminal behavior.
