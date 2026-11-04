import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import JSZip from 'jszip';

type ArchiveItem = { name: string; dir: boolean };
type ArchiveSummary = {
  count: number;
  entries: ArchiveItem[];
  executables: string[];
  rootConfigFound: boolean;
  nestedConfigPath: string | null;
  singleWrapper: string | null;
};
type EditorTab = 'dosbox' | 'metadata';
type Notice = { kind: 'success' | 'warning' | 'error' | 'info'; message: string };

const DOSBOX_PATH = '.jsdos/dosbox.conf';
const JSDOS_PATH = '.jsdos/jsdos.json';

const DEFAULT_DOSBOX_CONF = `[sdl]
autolock=false
fullscreen=false
fullresolution=original
windowresolution=original
output=surface
sensitivity=100
waitonerror=true
usescancodes=true

[dosbox]
machine=svga_s3
memsize=32

[cpu]
core=auto
cputype=auto
cycles=auto

[mixer]
nosound=false
rate=22050
blocksize=1024

[render]
frameskip=0
aspect=false
scaler=none

[midi]
mpu401=intelligent
mididevice=default

[sblaster]
sbtype=sb16
sbbase=220
irq=7
dma=1
hdma=5
sbmixer=true
oplmode=auto

[speaker]
pcspeaker=true
pcrate=44100

[dos]
xms=true
ems=true
umb=true
country=86

[ipx]
ipx=true

[autoexec]
@echo on
mount c .
c:
echo on
`;

const DEFAULT_JSDOS_JSON = JSON.stringify(
  {
    version: '8.xx',
    backend: 'dosbox',
    autolock: true,
  },
  null,
  2
);

// ─── Reference Helper Functions (from useZipToJSDos_2.ts) ────────────────────

/**
 * Scores an executable name to intelligently guess if it's the main game entry point[cite: 6].
 */
export function scoreExecutable(filepath: string, archiveName?: string): number {
  let score = 0;
  const lowerPath = filepath.toLowerCase();
  const filename = lowerPath.split('/').pop() || '';
  const stem = filename.replace(/\.(exe|bat|com)$/i, '');

  const installers = ['setup', 'install', 'uninst', 'config', 'setsound', 'patch', 'update', 'util', 'test'];
  if (installers.some(i => filename.includes(i))) score -= 50;

  if (filename.includes('readme') || filename.includes('help')) score -= 20;

  if (stem.length <= 2) score -= 10;
  if (stem.length >= 4) score += (stem.length - 3) * 2;

  const mainNames = ['play.bat', 'start.exe', 'start.bat', 'run.bat', 'run.exe', 'game.exe', 'main.exe', 'play.exe', 'go.bat', 'go.exe', 'bam2.bat', 'doom2.exe'];
  if (mainNames.includes(filename)) score += 20;

  if (archiveName) {
    const cleanArchive = archiveName.toLowerCase().replace(/\.zip$/g, '').replace(/[^a-z0-9]/g, '');
    const cleanFile = stem.replace(/[^a-z0-9]/g, '');

    if (cleanArchive && cleanFile && (cleanArchive.includes(cleanFile) || cleanFile.includes(cleanArchive))) {
      score += 30;
    }
  }

  if (filename.endsWith('.bat')) score += 5;

  const depth = filepath.split('/').length - 1;
  score -= (depth * 5);

  return score;
}

/**
 * Parses the ZIP file directly in the browser and returns all valid DOS executables[cite: 6].
 */
export async function parseExecutablesFromZip(file: File | Blob, originalFilename?: string): Promise<string[]> {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(file);
  const executables: string[] = [];

  loadedZip.forEach((relativePath, zipEntry) => {
    if (!zipEntry.dir) {
      const lower = relativePath.toLowerCase();
      if (lower.endsWith(".exe") || lower.endsWith(".bat") || lower.endsWith(".com")) {
        if (!relativePath.includes("__MACOSX") && !relativePath.split("/").some(p => p.startsWith("."))) {
          executables.push(relativePath);
        }
      }
    }
  });

  return executables.sort((a, b) => {
    return scoreExecutable(b, originalFilename) - scoreExecutable(a, originalFilename);
  });
}

function hasDosUnsafeChars(path: string): boolean {
  return /[^\x20-\x7E]/.test(path);
}

function toAsciiDirSegment(segment: string): string {
  const safe = segment
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .substring(0, 8)
    .toUpperCase();
  return safe || 'GAME';
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function findFile(zip: JSZip, path: string) {
  const target = normalizeZipPath(path).toLowerCase();
  return Object.values(zip.files).find((entry) => !entry.dir && normalizeZipPath(entry.name).toLowerCase() === target);
}

function findNestedFile(zip: JSZip, path: string) {
  const target = `/${normalizeZipPath(path).toLowerCase()}`;
  return Object.values(zip.files).find((entry) => {
    const normalized = `/${normalizeZipPath(entry.name).toLowerCase()}`;
    return !entry.dir && normalized.endsWith(target) && normalized !== target;
  });
}

function getSummary(zip: JSZip, executables: string[]): ArchiveSummary {
  const all = Object.values(zip.files);
  const files = all.filter((entry) => !entry.dir).map((entry) => ({ name: normalizeZipPath(entry.name), dir: false }));
  const dirs = all.filter((entry) => entry.dir).map((entry) => ({ name: normalizeZipPath(entry.name), dir: true }));
  const entries = [...dirs, ...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const rootConfigFound = Boolean(findFile(zip, DOSBOX_PATH));
  const nestedConfig = rootConfigFound ? null : findNestedFile(zip, DOSBOX_PATH);
  const filePaths = files.map((item) => item.name).filter((name) => name.length > 0);
  const topLevels = new Set(filePaths.map((name) => name.split('/')[0]).filter(Boolean));
  const anyRootFiles = filePaths.some((name) => !name.includes('/'));
  const singleWrapper = !anyRootFiles && topLevels.size === 1 ? [...topLevels][0] : null;

  return {
    count: files.length,
    entries: entries.slice(0, 100),
    executables,
    rootConfigFound,
    nestedConfigPath: nestedConfig?.name ?? null,
    singleWrapper,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; value >= 1024 && i < units.length; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function getBaseName(filename: string): string {
  return filename.replace(/\.zip$/i, '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || 'game-bundle';
}

function makeDosCommand(path: string): string {
  const dosPath = normalizeZipPath(path).replace(/\//g, '\\');
  return /\s/.test(dosPath) ? `"${dosPath}"` : dosPath;
}

function addBootCommand(config: string, command: string): string {
  const cleanedCommand = command.trim();
  if (!cleanedCommand) return config;
  const lines = config.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === '[autoexec]');
  if (start === -1) {
    return `${config.trimEnd()}\n\n[autoexec]\nmount c .\nc:\n${cleanedCommand}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start + 1, end);
  if (section.some((line) => line.trim().toLowerCase() === cleanedCommand.toLowerCase())) return config;
  section.push(cleanedCommand);
  lines.splice(start + 1, end - start - 1, ...section);
  return lines.join('\n');
}

/**
 * Automatically generates a smart DOSBox configuration based on safe path remapping[cite: 6].
 */
function generateSmartDosboxConf(targetExe: string): string {
  let config = DEFAULT_DOSBOX_CONF;
  if (!targetExe) return config;

  const pathParts = targetExe.split('/');
  const exeName = pathParts.pop() || '';
  const originalDirPath = pathParts.join('/');

  const needsRemap = !!originalDirPath && hasDosUnsafeChars(originalDirPath);
  const safeDirPath = needsRemap ? pathParts.map(toAsciiDirSegment).join('/') : originalDirPath;

  const exeNeedsRename = hasDosUnsafeChars(exeName);
  const exeExt = exeName.match(/\.(exe|bat|com)$/i)?.[0]?.toUpperCase() ?? '.EXE';
  const safeExeName = exeNeedsRename ? ('RUN' + exeExt) : exeName;

  const mountCmd = safeDirPath ? `mount c "./${safeDirPath}"` : "mount c .";
  const baseConfigWithoutAutoexec = config.split('[autoexec]')[0].trim();

  return `${baseConfigWithoutAutoexec}

[autoexec]
@echo on
${mountCmd}
c:
${safeExeName}
`;
}

function prettyJson(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('jsdos.json must contain a JSON object, for example { "version": "8.xx", "backend": "dosbox", "autolock": true }.');
  }
  return JSON.stringify(parsed, null, 2);
}

function Icon({ children }: { children: string }) {
  return <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-lime-300/15 bg-lime-300/10 text-sm text-lime-200">{children}</span>;
}

function Tag({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'green' | 'amber' }) {
  const style = tone === 'green'
    ? 'border-lime-300/25 bg-lime-300/10 text-lime-200'
    : tone === 'amber'
      ? 'border-amber-300/25 bg-amber-300/10 text-amber-100'
      : 'border-white/10 bg-white/[0.04] text-zinc-300';
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${style}`}>{children}</span>;
}

function NoticeBox({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  const styles = {
    success: 'border-lime-300/25 bg-lime-300/[0.07] text-lime-100',
    warning: 'border-amber-300/25 bg-amber-300/[0.07] text-amber-100',
    error: 'border-rose-300/25 bg-rose-300/[0.07] text-rose-100',
    info: 'border-sky-300/20 bg-sky-300/[0.06] text-sky-100',
  };
  const symbol = { success: '✓', warning: '!', error: '×', info: 'i' }[notice.kind];
  return (
    <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-xl border p-3 text-sm ${styles[notice.kind]}`}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current/30 text-xs font-bold">{symbol}</span>
      <p className="min-w-0 flex-1 leading-6">{notice.message}</p>
      {onDismiss && <button onClick={onDismiss} className="rounded px-1 text-current/70 hover:text-current" aria-label="Dismiss notification">×</button>}
    </div>
  );
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [archive, setArchive] = useState<JSZip | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);
  const [dosboxConfig, setDosboxConfig] = useState(DEFAULT_DOSBOX_CONF);
  const [jsdosJson, setJsdosJson] = useState(DEFAULT_JSDOS_JSON);
  const [outputName, setOutputName] = useState('game-bundle');
  const [tab, setTab] = useState<EditorTab>('dosbox');
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [result, setResult] = useState<{ name: string; size: number } | null>(null);

  const executableList = useMemo(() => summary?.executables.slice(0, 16) ?? [], [summary]);
  // const bootLines = useMemo(() => {
  //   const sectionStart = dosboxConfig.split(/\r?\n/).findIndex((line) => line.trim().toLowerCase() === '[autoexec]');
  //   if (sectionStart < 0) return [];
  //   const lines = dosboxConfig.replace(/\r\n/g, '\n').split('\n');
  //   const out: string[] = [];
  //   for (let i = sectionStart + 1; i < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[i]); i += 1) {
  //     const line = lines[i].trim();
  //     if (line && !line.startsWith('#') && !line.startsWith(';') && !/^(echo\s+(off|on)|mount\s+c\s+\.|c:)$/i.test(line)) out.push(line);
  //   }
  //   return out;
  // }, [dosboxConfig]);

  async function loadArchive(file: File) {
    setNotice(null);
    setResult(null);
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setNotice({ kind: 'error', message: 'Choose a .zip file. RAR, 7z and encrypted archives are not supported by this converter.' });
      return;
    }
    setIsReading(true);
    try {
      // Use parseExecutablesFromZip from source [6] for intelligent executable discovery
      const executables = await parseExecutablesFromZip(file, file.name);
      const loadedZip = await JSZip.loadAsync(file, { checkCRC32: false, createFolders: true });
      const nextSummary = getSummary(loadedZip, executables,);
      if (nextSummary.count === 0) throw new Error('This ZIP archive contains no files.');

      const rootConfig = findFile(loadedZip, DOSBOX_PATH);
      const nestedConfig = rootConfig ? null : findNestedFile(loadedZip, DOSBOX_PATH);
      const configEntry = rootConfig ?? nestedConfig;

      let configText = DEFAULT_DOSBOX_CONF;
      if (configEntry) {
        configText = await configEntry.async('string');
      } else if (nextSummary.executables.length > 0) {
        configText = generateSmartDosboxConf(nextSummary.executables[0]);
      }

      const rootJson = findFile(loadedZip, JSDOS_PATH);
      const nestedJson = rootJson ? null : findNestedFile(loadedZip, JSDOS_PATH);
      const jsonEntry = rootJson ?? nestedJson;
      const jsonText = jsonEntry ? await jsonEntry.async('string') : DEFAULT_JSDOS_JSON;

      setArchive(loadedZip);
      setSourceFile(file);
      setSummary(nextSummary);
      setDosboxConfig(configText);
      setJsdosJson(jsonText);
      setOutputName(getBaseName(file.name));
      setTab('dosbox');

      if (rootConfig) {
        setNotice({ kind: 'success', message: 'Existing root-level .jsdos/dosbox.conf found and loaded.' });
      } else if (nestedConfig) {
        setNotice({ kind: 'warning', message: `Found config inside “${nestedConfig.name}”. Loaded for editing and normalized to root path.` });
      } else {
        setNotice({ kind: 'success', message: `Successfully auto-scored and populated boot configuration for "${nextSummary.executables[0] || 'game'}"!` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read this ZIP archive.';
      setNotice({ kind: 'error', message: `Could not open archive: ${message}` });
      setArchive(null);
      setSourceFile(null);
      setSummary(null);
    } finally {
      setIsReading(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void loadArchive(file);
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadArchive(file);
  }

  function clearWorkspace() {
    setArchive(null);
    setSourceFile(null);
    setSummary(null);
    setDosboxConfig(DEFAULT_DOSBOX_CONF);
    setJsdosJson(DEFAULT_JSDOS_JSON);
    setOutputName('game-bundle');
    setResult(null);
    setNotice(null);
    setTab('dosbox');
    if (inputRef.current) inputRef.current.value = '';
  }

  function insertExecutable(path: string) {
    setDosboxConfig((current) => addBootCommand(current, makeDosCommand(path)));
    setTab('dosbox');
    setNotice({ kind: 'info', message: `Added “${path}” to the end of [autoexec].` });
  }

  async function convertAndDownload() {
    if (!archive || !sourceFile || !summary) return;
    setIsConverting(true);
    setNotice(null);
    setResult(null);
    try {
      const metadataText = prettyJson(jsdosJson);
      if (!dosboxConfig.trim()) throw new Error('The DOSBox configuration is empty.');
      if (!/^\s*\[[^\]]+\]/m.test(dosboxConfig)) throw new Error('Invalid DOSBox configuration format.');

      // Incorporate createJSDosBundle remapping and sanitization logic from source [6]
      const topExe = summary.executables[0] || '';
      const pathParts = topExe.split('/');
      const exeName = pathParts.pop() || '';
      const originalDirPath = pathParts.join('/');
      const needsRemap = !!originalDirPath && hasDosUnsafeChars(originalDirPath);
      const safeDirPath = needsRemap ? pathParts.map(toAsciiDirSegment).join('/') : originalDirPath;

      const exeNeedsRename = hasDosUnsafeChars(exeName);
      const exeExt = exeName.match(/\.(exe|bat|com)$/i)?.[0]?.toUpperCase() ?? '.EXE';
      const safeExeName = exeNeedsRename ? ('RUN' + exeExt) : exeName;

      const bundleZip = new JSZip();
      const copyTasks: Promise<void>[] = [];

      archive.forEach((relativePath, zipEntry) => {
        if (zipEntry.dir) return;
        if (relativePath.includes('__MACOSX')) return;
        if (relativePath.split('/').some(p => p.startsWith('.'))) return;

        let destPath = relativePath;
        if (needsRemap && originalDirPath && relativePath.startsWith(originalDirPath + '/')) {
          destPath = safeDirPath + '/' + relativePath.slice(originalDirPath.length + 1);
        }

        if (exeNeedsRename) {
          const isTargetExe = relativePath === topExe || destPath.endsWith('/' + exeName) || destPath === exeName;
          if (isTargetExe) {
            destPath = destPath.slice(0, destPath.lastIndexOf('/') + 1) + safeExeName;
          }
        }

        copyTasks.push(
          zipEntry.async('uint8array').then((data) => {
            bundleZip.file(destPath, data);
          })
        );
      });

      await Promise.all(copyTasks);

      // Force Windows CRLF line endings required by DOSBox parser engine
      const normalizedConf = dosboxConfig.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

      bundleZip.file(DOSBOX_PATH, normalizedConf, { createFolders: true });
      bundleZip.file(JSDOS_PATH, `${metadataText}\n`, { createFolders: true });

      const blob = await bundleZip.generateAsync({
        type: 'blob',
        mimeType: 'application/zip',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const verification = await JSZip.loadAsync(blob);
      const verifiedConfig = findFile(verification, DOSBOX_PATH);
      const verifiedJson = findFile(verification, JSDOS_PATH);
      if (!verifiedConfig) throw new Error('Bundle validation failed: .jsdos/dosbox.conf missing.');
      if (!verifiedJson) throw new Error('Bundle validation failed: .jsdos/jsdos.json missing.');

      const cleanBase = getBaseName(outputName.replace(/\.jsdos$/i, '').replace(/\.zip$/i, ''));
      const filename = `${cleanBase}.jsdos`;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);

      setResult({ name: filename, size: blob.size });
      setNotice({ kind: 'success', message: `Created ${filename} successfully with safe path mapping and instant boot[cite: 6]!` });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not generate bundle.';
      setNotice({ kind: 'error', message });
    } finally {
      setIsConverting(false);
    }
  }

  return (
    <main className="app-grid min-h-screen overflow-hidden">
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-80 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.09),transparent_68%)]" />
      <div className="relative z-10 mx-auto max-w-7xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-lime-200/25 bg-lime-200/10 text-xl text-lime-200">▣</div>
            <div>
              <div className="text-sm font-black tracking-[0.19em] text-white">DOS<span className="text-lime-300">/</span>LAB</div>
              <div className="mt-0.5 text-[11px] tracking-wide text-zinc-500">JS-DOS BUNDLE WORKBENCH</div>
            </div>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <span className="h-2 w-2 rounded-full bg-lime-300 shadow-[0_0_12px_rgba(190,242,100,0.8)]" />
            <span className="text-xs text-zinc-400">Local-only processing</span>
          </div>
        </header>

        <section className="grid gap-7 py-10 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-end">
          <div className="max-w-3xl">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Tag tone="green">JS-DOS v8</Tag>
              <Tag>Smart Scored & CJK Safe</Tag>
              <Tag>Browser utility</Tag>
            </div>
            <h1 className="max-w-3xl text-4xl font-black leading-[1.06] tracking-tight text-white sm:text-5xl lg:text-6xl">
              Package it.<br /><span className="text-lime-300">Boots instantly.</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg">
              Convert game archives into JS-DOS <code className="rounded bg-white/5 px-1.5 py-0.5 text-sm text-lime-200">.jsdos</code> bundles with automated executable scoring, Unicode path sanitization, and embedded startup configurations[cite: 6].
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
            <div><div className="text-2xl font-black text-white">01</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Score ZIP</div></div>
            <div><div className="text-2xl font-black text-white">02</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Tune conf</div></div>
            <div><div className="text-2xl font-black text-lime-300">03</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Export</div></div>
          </div>
        </section>

        {notice && <div className="mb-5 float-in"><NoticeBox notice={notice} onDismiss={() => setNotice(null)} /></div>}

        {!archive ? (
          <section
            onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false); }}
            onDrop={onDrop}
            className={`drop-glow rounded-3xl border border-dashed p-6 transition-colors sm:p-10 ${isDragging ? 'border-lime-300 bg-lime-300/[0.07]' : 'border-zinc-700 bg-zinc-900/65 hover:border-zinc-500'}`}
          >
            <input ref={inputRef} type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={onFileChange} className="hidden" aria-label="Choose a ZIP archive" />
            <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-lime-200/20 bg-lime-200/[0.08] text-3xl text-lime-200">⇧</div>
              <h2 className="text-2xl font-bold text-white">Drop a game archive here</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">Choose a local <code className="text-lime-200">.zip</code> file. Executables will be intelligently scored and sanitized[cite: 6].</p>
              <button onClick={() => inputRef.current?.click()} disabled={isReading} className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-lime-300 px-5 py-3 text-sm font-black text-zinc-950 transition hover:bg-lime-200 disabled:cursor-wait disabled:opacity-60">
                {isReading ? <><span className="animate-spin">◌</span> Scoring executables…</> : <>Choose ZIP archive <span aria-hidden="true">↗</span></>}
              </button>
            </div>
          </section>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
            <section className="min-w-0 space-y-5">
              <div className="rounded-2xl border border-white/10 bg-zinc-900/75 p-5 sm:p-6">
                <div className="flex items-start gap-3">
                  <Icon>ZIP</Icon>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold uppercase tracking-[0.13em] text-zinc-500">Source archive</div>
                    <h2 className="mt-1 break-all text-lg font-bold text-white">{sourceFile?.name}</h2>
                    <div className="mt-2 flex flex-wrap gap-2"><Tag>{formatBytes(sourceFile?.size ?? 0)}</Tag>
                      <Tag>{`${summary?.count ?? 0} files`}</Tag>
                      <Tag tone={summary?.rootConfigFound ? 'green' : 'amber'}>{summary?.rootConfigFound ? 'JS-DOS config found' : 'Smart Scored'}</Tag>
                    </div>
                  </div>
                  <button onClick={clearWorkspace} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-400 transition hover:border-white/20 hover:text-white">Reset</button>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
                      <span className="text-lime-300">⌘</span> Scored launch candidates</div>
                    {executableList.length ? (
                      <div className="mt-3 space-y-2">
                        {executableList.map((path) => (
                          <div key={path} className="flex items-center gap-2">
                            <code title={path} className="min-w-0 flex-1 truncate text-xs text-zinc-400">{path}</code>
                            <button onClick={() => insertExecutable(path)} className="shrink-0 rounded-md border border-lime-300/20 px-2 py-1 text-[10px] font-bold text-lime-200 hover:bg-lime-300/10">Use as boot</button>
                          </div>
                        ))}
                      </div>
                    ) : <p className="mt-2 text-xs leading-5 text-zinc-500">No executables found.</p>}
                  </div>
                  <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300"><span className="text-lime-300">▤</span> Unicode & Path Safety</div>
                    <p className="mt-2 text-xs leading-5 text-zinc-400">Non-ASCII folder names and filenames are automatically sanitized and remapped for DOSBox compatibility[cite: 6].</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="min-w-0 space-y-5">
              <div className="rounded-2xl border border-white/10 bg-zinc-900/75 p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><div className="text-xs font-bold uppercase tracking-[0.13em] text-zinc-500">Bundle configuration</div><h2 className="mt-1 text-xl font-bold text-white">Tune config before export</h2></div>
                  <div className="flex rounded-lg border border-white/10 bg-black/20 p-1">
                    <button onClick={() => setTab('dosbox')} className={`rounded-md px-3 py-2 text-xs font-bold transition ${tab === 'dosbox' ? 'bg-lime-300 text-zinc-950' : 'text-zinc-400 hover:text-white'}`}>dosbox.conf</button>
                    <button onClick={() => setTab('metadata')} className={`rounded-md px-3 py-2 text-xs font-bold transition ${tab === 'metadata' ? 'bg-lime-300 text-zinc-950' : 'text-zinc-400 hover:text-white'}`}>jsdos.json</button>
                  </div>
                </div>

                {tab === 'dosbox' ? (
                  <div className="mt-5">
                    <textarea spellCheck={false} value={dosboxConfig} onChange={(event) => setDosboxConfig(event.target.value)} className="code-editor min-h-[390px] w-full resize-y rounded-xl border border-white/10 bg-[#070a09] p-4 text-[11px] text-lime-100/90 outline-none transition focus:border-lime-300/40" />
                  </div>
                ) : (
                  <div className="mt-5">
                    <textarea spellCheck={false} value={jsdosJson} onChange={(event) => setJsdosJson(event.target.value)} className="code-editor min-h-[390px] w-full resize-y rounded-xl border border-white/10 bg-[#070a09] p-4 text-[12px] text-sky-100/90 outline-none transition focus:border-lime-300/40" />
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-lime-300/20 bg-gradient-to-br from-lime-300/[0.08] to-zinc-900/80 p-5 sm:p-6">
                <div className="flex items-start gap-3"><Icon>↓</Icon><div><h3 className="text-lg font-bold text-white">Export .jsdos bundle</h3></div></div>
                <div className="mt-5">
                  <label htmlFor="output-name" className="mb-2 block text-xs font-semibold text-zinc-300">Output filename</label>
                  <div className="flex items-center rounded-xl border border-white/10 bg-black/30 px-3 focus-within:border-lime-300/40"><input id="output-name" value={outputName} onChange={(event) => setOutputName(event.target.value)} className="min-w-0 flex-1 bg-transparent py-3 text-sm text-white outline-none" /><span className="border-l border-white/10 py-1 pl-3 text-sm text-zinc-500">.jsdos</span></div>
                </div>
                <button onClick={() => void convertAndDownload()} disabled={isConverting || !archive} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-lime-300 px-5 py-3.5 text-sm font-black text-zinc-950 transition hover:bg-lime-200 disabled:cursor-wait disabled:opacity-60">
                  {isConverting ? <><span className="animate-spin">◌</span> Packaging bundle…</> : <>Convert &amp; download <span aria-hidden="true">↘</span></>}
                </button>
                {result && <div className="mt-4 rounded-xl border border-lime-300/20 bg-black/20 p-3"><div className="flex items-start gap-3"><span className="text-xl text-lime-200">✓</span><div className="min-w-0 flex-1"><div className="break-all text-sm font-bold text-white">{result.name}</div><div className="mt-1 text-xs text-zinc-400">{formatBytes(result.size)} · ready for instant booting</div></div></div></div>}
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}