'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const configDir = path.join(root, 'config');
const configPath = path.join(configDir, 'watermark-watch.json');
const logPath = path.join(configDir, 'watermark-watch.log');
const publicDir = path.join(root, 'public');
const defaultOutputDir = path.join(root, 'outputs');
const alpha48Path = path.join(root, 'assets', 'gemini-watermark-alpha-48.png');
const alpha96Path = path.join(root, 'assets', 'gemini-watermark-alpha-96.png');
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.tif', '.tiff']);
const outputFormats = new Set(['same', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'tif', 'tiff']);
const writableSameFormats = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff']);
const maxUploadBytes = 250 * 1024 * 1024;
let sharp;
let chokidar;
let express;
let upload;

const state = {
  pending: new Map(),
  processing: new Set(),
  processed: new Set(),
  alphaMaps: new Map(),
  alphaMapLoads: new Map(),
  recent: [],
  downloads: new Map(),
  nextDownloadId: 1,
  mode: 'idle',
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

function printHelp() {
  process.stdout.write(`Gemini watermark cleaner

Usage:
  node script.js --web
  node script.js --watch --folder "/path/to/input"
  node script.js --web --watch --folder "/path/to/input" --port 8010

Options:
  --web                 Start localhost web UI and upload API.
  --watch               Watch a folder and process new images automatically.
  --folder <path>       Folder used by --watch. Saved for next runs.
  --output <path>       Output folder. Defaults to the source image folder.
  --port <number>       Localhost port for web mode. Default: 8010.
  --host <host>         Bind host. Default: 127.0.0.1.
  --format <same|png|jpg|jpeg|webp|avif|tif|tiff>
  --quality <1-100>     Quality for jpg/webp/avif/tiff. Default: 95.
  --recursive           Watch subfolders too.
  --overwrite           Overwrite existing clean output files.
  --init                Save provided settings without starting services.
  --help                Show this help.

If neither --web nor --watch is provided, the app starts web mode.
`);
}

function requireSharp() {
  if (!sharp) sharp = require('sharp');
  return sharp;
}

function requireChokidar() {
  if (!chokidar) chokidar = require('chokidar');
  return chokidar;
}

function requireWebDeps() {
  if (!express) express = require('express');
  if (!upload) {
    const multer = require('multer');
    upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxUploadBytes, files: 20 },
    });
  }
}

function parseArgs(argv) {
  const args = {
    web: false,
    watch: false,
    folder: undefined,
    outputDir: undefined,
    port: 8010,
    host: '127.0.0.1',
    format: undefined,
    quality: undefined,
    recursive: false,
    overwrite: false,
    init: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };

    if (arg === '--web') args.web = true;
    else if (arg === '--watch') args.watch = true;
    else if (arg === '--folder') args.folder = next();
    else if (arg === '--output' || arg === '--output-dir') args.outputDir = next();
    else if (arg === '--port') args.port = Number(next());
    else if (arg === '--host') args.host = next();
    else if (arg === '--format') args.format = next();
    else if (arg === '--quality') args.quality = Number(next());
    else if (arg === '--recursive') args.recursive = true;
    else if (arg === '--overwrite') args.overwrite = true;
    else if (arg === '--init') args.init = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!args.web && !args.watch && !args.init && !args.help) args.web = true;
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('Port must be 1-65535.');
  if (args.quality !== undefined && (!Number.isFinite(args.quality) || args.quality < 1 || args.quality > 100)) {
    throw new Error('Quality must be 1-100.');
  }
  if (args.format !== undefined) args.format = normalizeRequestedFormat(args.format);
  return args;
}

function normalizeRequestedFormat(value) {
  const format = String(value || 'same').replace(/^\./, '').toLowerCase();
  if (!outputFormats.has(format)) {
    throw new Error(`Unsupported output format: ${value}`);
  }
  return format;
}

function outputExtensionForInput(inputExt, requestedFormat) {
  const sourceFormat = String(inputExt || '').replace(/^\./, '').toLowerCase() || 'png';
  const format = normalizeRequestedFormat(requestedFormat || 'same');
  if (format !== 'same') return format;
  return writableSameFormats.has(sourceFormat) ? sourceFormat : 'png';
}

function readSavedConfig() {
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function saveConfig(config) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function resolveConfig(args) {
  const saved = readSavedConfig();
  const config = {
    enabled: true,
    folder: args.folder || saved.folder,
    outputDir: args.outputDir || saved.outputDir,
    format: normalizeRequestedFormat(args.format || saved.format || 'same'),
    quality: args.quality ?? saved.quality ?? 95,
    recursive: args.recursive || Boolean(saved.recursive),
    overwrite: args.overwrite || Boolean(saved.overwrite),
  };

  if (args.folder || args.outputDir || args.recursive || args.overwrite || args.format !== undefined || args.quality !== undefined) {
    saveConfig(config);
  }

  return config;
}

function validateWatchConfig(config) {
  if (!config.folder) throw new Error('Missing watched folder. Use --folder "/path/to/images".');
  const folder = path.resolve(String(config.folder));
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error(`Watched folder does not exist: ${folder}`);
  }
  return { ...config, folder };
}

function sanitizeName(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'output';
}

function uniqueOutput(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let index = 2; index < 10000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No free output name for ${filePath}`);
}

function outputPathFor(input, config) {
  const inputExt = path.extname(input).replace(/^\./, '').toLowerCase() || 'png';
  const outputExt = outputExtensionForInput(inputExt, config.format);
  const outputDir = config.outputDir ? path.resolve(String(config.outputDir)) : path.dirname(input);
  fs.mkdirSync(outputDir, { recursive: true });
  const parsed = path.parse(input);
  const target = path.join(outputDir, `${sanitizeName(parsed.name)}-clean.${outputExt}`);
  return config.overwrite ? target : uniqueOutput(target);
}

function isWatchableImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  return imageExts.has(ext) && !/-clean(?:-\d+)?\.[^.]+$/i.test(base);
}

function detectGeminiWatermarkConfig(width, height) {
  if (width > 1024 && height > 1024) return { logoSize: 96, marginRight: 64, marginBottom: 64 };
  return { logoSize: 48, marginRight: 32, marginBottom: 32 };
}

function watermarkPosition(width, height, cfg) {
  return {
    x: Math.max(0, width - cfg.marginRight - cfg.logoSize),
    y: Math.max(0, height - cfg.marginBottom - cfg.logoSize),
    width: Math.min(cfg.logoSize, width),
    height: Math.min(cfg.logoSize, height),
  };
}

async function loadAlphaMap(size) {
  if (state.alphaMaps.has(size)) return state.alphaMaps.get(size);
  if (state.alphaMapLoads.has(size)) return state.alphaMapLoads.get(size);

  const loadPromise = loadAlphaMapUncached(size)
    .then(alphaMap => {
      state.alphaMaps.set(size, alphaMap);
      state.alphaMapLoads.delete(size);
      return alphaMap;
    })
    .catch(err => {
      state.alphaMapLoads.delete(size);
      throw err;
    });

  state.alphaMapLoads.set(size, loadPromise);
  return loadPromise;
}

async function loadAlphaMapUncached(size) {
  const filePath = size === 96 ? alpha96Path : alpha48Path;
  if (!fs.existsSync(filePath)) throw new Error(`Alpha map missing: ${filePath}`);
  const sharpInstance = requireSharp();
  const source = fs.readFileSync(filePath);
  let raw;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      raw = await sharpInstance(source, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      break;
    } catch (err) {
      lastError = err;
      await new Promise(resolve => setTimeout(resolve, attempt * 100));
    }
  }
  if (!raw) {
    throw new Error(`Could not load internal alpha map ${path.basename(filePath)}: ${lastError.message}`);
  }
  const { data, info } = raw;
  const alphaMap = new Float32Array(info.width * info.height);
  for (let i = 0; i < alphaMap.length; i += 1) {
    const idx = i * info.channels;
    alphaMap[i] = Math.max(data[idx], data[idx + 1], data[idx + 2]) / 255;
  }
  return alphaMap;
}

function waitForStableFile(filePath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastSize = -1;
    let stableTicks = 0;
    const timer = setInterval(() => {
      try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
        const size = fs.statSync(filePath).size;
        if (size > 0 && size === lastSize) stableTicks += 1;
        else stableTicks = 0;
        lastSize = size;
        if (stableTicks >= 2) {
          clearInterval(timer);
          resolve();
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('File did not stabilize in time.'));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 500);
  });
}

function outputFormat(output, config) {
  return outputExtensionForInput(path.extname(output), config.format);
}

function assertUploadedImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new Error(`${file?.originalname || 'Image'} was uploaded as an empty file.`);
  }

  const ext = path.extname(file.originalname).toLowerCase();
  if (!imageExts.has(ext)) throw new Error(`${file.originalname} has an unsupported extension.`);

  if (ext === '.png') {
    const pngSignature = '89504e470d0a1a0a';
    const actualSignature = file.buffer.subarray(0, 8).toString('hex');
    if (actualSignature !== pngSignature) {
      throw new Error(`${file.originalname} is not a valid PNG file. It may be incomplete or renamed.`);
    }
    const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    if (file.buffer.indexOf(iend) === -1) {
      throw new Error(`${file.originalname} looks like an incomplete PNG upload. File size received: ${file.buffer.length} bytes.`);
    }
  }
}

async function removeGeminiWatermarkBuffer(inputBuffer, output, config) {
  const sharpInstance = requireSharp();
  const raw = await sharpInstance(inputBuffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raw.info;
  const wmCfg = detectGeminiWatermarkConfig(width, height);
  const pos = watermarkPosition(width, height, wmCfg);
  const alphaMap = await loadAlphaMap(wmCfg.logoSize);
  const pixels = raw.data;
  const ALPHA_THRESHOLD = 0.002;
  const MAX_ALPHA = 0.99;
  const LOGO_VALUE = 255;

  for (let row = 0; row < pos.height; row += 1) {
    for (let col = 0; col < pos.width; col += 1) {
      const imgIdx = ((pos.y + row) * width + (pos.x + col)) * channels;
      const alphaIdx = row * wmCfg.logoSize + col;
      let alpha = alphaMap[alphaIdx];
      if (alpha < ALPHA_THRESHOLD) continue;
      alpha = Math.min(alpha, MAX_ALPHA);
      const oneMinusAlpha = 1 - alpha;
      for (let c = 0; c < 3; c += 1) {
        const original = (pixels[imgIdx + c] - alpha * LOGO_VALUE) / oneMinusAlpha;
        pixels[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
      }
    }
  }

  const format = outputFormat(output, config);
  const image = sharpInstance(pixels, { raw: { width, height, channels } });
  const quality = Number(config.quality || 95);
  if (format === 'jpg' || format === 'jpeg') return image.jpeg({ quality }).toBuffer();
  if (format === 'webp') return image.webp({ quality }).toBuffer();
  if (format === 'avif') return image.avif({ quality: Math.min(quality, 90), effort: 4 }).toBuffer();
  if (format === 'tif' || format === 'tiff') return image.tiff({ quality }).toBuffer();
  return image.png().toBuffer();
}

async function removeGeminiWatermark(input, output, config) {
  const buffer = await removeGeminiWatermarkBuffer(fs.readFileSync(input), output, config);
  fs.writeFileSync(output, buffer);
}

function rememberRecent(item) {
  const record = { ...item, time: new Date().toISOString() };
  if (record.output) {
    const id = String(state.nextDownloadId);
    state.nextDownloadId += 1;
    state.downloads.set(id, record.output);
    record.downloadUrl = `/api/download/${id}`;
  }
  state.recent.unshift(record);
  state.recent = state.recent.slice(0, 30);
  return record;
}

async function processFile(filePath, config) {
  const resolved = path.resolve(filePath);
  if (state.processing.has(resolved) || state.processed.has(resolved)) return null;
  if (!isWatchableImage(resolved) || !fs.existsSync(resolved)) return null;
  state.processing.add(resolved);
  try {
    await waitForStableFile(resolved);
    const output = outputPathFor(resolved, config);
    await removeGeminiWatermark(resolved, output, config);
    state.processed.add(resolved);
    rememberRecent({ source: resolved, output, status: 'ok' });
    log(`OK ${resolved} -> ${output}`);
    return output;
  } catch (err) {
    rememberRecent({ source: resolved, status: 'error', error: err.message });
    log(`ERROR ${resolved}: ${err.message}`);
    return null;
  } finally {
    state.processing.delete(resolved);
  }
}

function schedule(filePath, config) {
  const resolved = path.resolve(filePath);
  if (!isWatchableImage(resolved)) return;
  clearTimeout(state.pending.get(resolved));
  state.pending.set(resolved, setTimeout(() => {
    state.pending.delete(resolved);
    processFile(resolved, config);
  }, 800));
}

function startWatcher(config) {
  const chokidarInstance = requireChokidar();
  const watchConfig = validateWatchConfig(config);
  state.mode = state.mode === 'web' ? 'web+watch' : 'watch';
  log(`Watching ${watchConfig.folder} recursive=${Boolean(watchConfig.recursive)}`);
  const watcher = chokidarInstance.watch(watchConfig.folder, {
    ignored: filePath => {
      try {
        return !isWatchableImage(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
      } catch (_err) {
        return false;
      }
    },
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    depth: watchConfig.recursive ? undefined : 0,
  });
  watcher.on('add', filePath => schedule(filePath, watchConfig));
  watcher.on('error', err => log(`WATCHER ERROR ${err.message}`));
  return watcher;
}

function webOutputConfig(req) {
  const format = normalizeRequestedFormat(req.body.format || 'same');
  const quality = Number(req.body.quality || 95);
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new Error('Quality must be 1-100.');
  return { format, quality, overwrite: false };
}

function startWeb(config, args) {
  requireWebDeps();
  const app = express();
  state.mode = state.mode === 'watch' ? 'web+watch' : 'web';

  app.use(express.static(publicDir));
  app.use(express.json());

  app.get('/api/status', (_req, res) => {
    res.json({
      mode: state.mode,
      watchedFolder: config.folder ? path.resolve(String(config.folder)) : null,
      outputDir: config.outputDir ? path.resolve(String(config.outputDir)) : null,
      recent: state.recent,
    });
  });

  app.get('/api/download/:id', (req, res) => {
    const filePath = state.downloads.get(req.params.id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File is no longer available.' });
      return;
    }
    res.download(filePath);
  });

  app.post('/api/process', (req, res, next) => {
    upload.array('images', 20)(req, res, err => {
      if (!err) {
        next();
        return;
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `Image is too large. Maximum upload size is ${Math.round(maxUploadBytes / 1024 / 1024)} MB per file.` });
        return;
      }
      res.status(400).json({ error: err.message });
    });
  }, async (req, res) => {
    if (!req.files || req.files.length === 0) {
      res.status(400).json({ error: 'No images uploaded.' });
      return;
    }

    let requestConfig;
    try {
      requestConfig = webOutputConfig(req);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const results = [];
    for (const file of req.files) {
      try {
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        log(`UPLOAD ${file.originalname} ${file.buffer.length} bytes`);
        if (!imageExts.has(ext)) {
          results.push({ originalName: file.originalname, status: 'skipped', error: 'Unsupported image type.' });
          continue;
        }

        assertUploadedImage(file);
        const outputDir = config.outputDir ? path.resolve(String(config.outputDir)) : defaultOutputDir;
        const outputExt = outputExtensionForInput(ext, requestConfig.format);
        const output = uniqueOutput(path.join(outputDir, `${sanitizeName(path.parse(file.originalname).name)}-clean.${outputExt}`));
        fs.mkdirSync(path.dirname(output), { recursive: true });
        const buffer = await removeGeminiWatermarkBuffer(file.buffer, output, requestConfig);
        fs.writeFileSync(output, buffer);
        const item = rememberRecent({ originalName: file.originalname, source: file.originalname, output, status: 'ok' });
        results.push(item);
      } catch (err) {
        const item = { originalName: file.originalname, source: file.originalname, status: 'error', error: err.message };
        results.push(item);
        rememberRecent(item);
        log(`UPLOAD ERROR ${file.originalname}: ${err.message}`);
      }
    }
    res.json({ results });
  });

  app.listen(args.port, args.host, () => {
    log(`Web UI running at http://${args.host}:${args.port}`);
  });
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }

    const config = resolveConfig(args);
    if (args.init) {
      saveConfig(config);
      log(`Config saved to ${configPath}`);
      return;
    }

    if (args.watch) startWatcher(config);
    if (args.web) startWeb(config, args);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n`);
    printHelp();
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  removeGeminiWatermark,
  removeGeminiWatermarkBuffer,
  outputPathFor,
  isWatchableImage,
};
