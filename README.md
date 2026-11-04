# JS-DOS Bundle Lab — ZIP to `.jsdos`

A small, local-only browser utility built with TypeScript, React 19, Vite 8, Tailwind CSS v4 and JSZip. It packages an existing game ZIP as a JS-DOS v8 bundle for testing.

## Run locally

Requirements: a recent Node.js release supported by Vite 8 (Node `>=20.19.0` or `>=22.12.0`) and npm.

```bash
npm install
npm run dev
```

Open the local URL shown by Vite. To make a production build:

```bash
npm run build
npm run preview
```

## Use

1. Select or drop a `.zip` game archive.
2. Review the archive paths and detected `.EXE`, `.COM`, or `.BAT` files.
3. Review/edit `.jsdos/dosbox.conf`. If the ZIP already contains a root-level config, it is loaded as-is. A nested config is offered as the source config and copied to the required root location. If no config exists, the app starts with a basic DOSBox template.
4. Optionally edit `.jsdos/jsdos.json`; it must be a JSON object.
5. Optionally click **Use as boot command** beside a likely launch file, then check the `[autoexec]` section. The app does not guess the launch command automatically.
6. Convert and download the `.jsdos` file. Test it with your JS-DOS player before replacing the original ZIP on your site.

## Important limitations

- JS-DOS v8 expects a bundle that is ZIP-compatible and contains `.jsdos/dosbox.conf` at the archive root. `.jsdos/jsdos.json` is optional but this app writes it to preserve/edit bundle metadata.
- Packaging cannot infer every game's startup steps. Games requiring `cd`/`mount` commands, CD-ROM images, sound-card settings, custom cycles, installers or a particular folder layout may need hand edits.
- ZIP paths are preserved. If most files sit inside a top-level folder, the app warns but does not flatten paths, because changing them can break relative paths or startup scripts.
- The input ZIP is read and rewritten in the browser. Nothing is uploaded. Very large archives can require substantial browser memory and processing time.
- Supports ordinary ZIP archives, not RAR, 7z, split ZIPs or password-protected ZIPs.

## Structure

```text
src/App.tsx       Main UI, ZIP inspection and bundle packaging
src/index.css     Tailwind v4 import and custom styles
src/main.tsx      React entry point
vite.config.ts    Vite, React and Tailwind v4 plugins
```

## JS-DOS bundle reference

The `.jsdos` extension is used for a ZIP-compatible bundle; JS-DOS documents `.jsdos/dosbox.conf` as required and `.jsdos/jsdos.json` as optional metadata. See [JS-DOS bundle cookbook](https://js-dos.com/jsdos-bundle.html).
