# Gemini Watermark Cleaner

Lokální Node.js nástroj pro odstranění Gemini watermarku z obrázků. Umí běžet jako jednoduchý web na `localhostu`, jako automatický watcher složky (kdykoliv uložíte obrázek do zadané složky automaticky ti do pár vteřin vytvoří druhý obrázek bez watermarku), nebo jako oboje najednou. Vše se zpracovává lokálně na počítači bez Ai modelů, do 3s, bez ztráty kvality, spolehlivě na jakémkoliv pozadí.

## Požadavky

- Node.js 18 nebo novější
- npm nebo Yarn
- Volitelně PM2 pro nonstop běh na pozadí

## Instalace

```bash
git clone https://github.com/PsychedelicCZ/FCK-GEMINI
cd watermark
npm install
```

Yarn varianta:

```bash
yarn install
```

## Spuštění webu

```bash
npm run web
```

Potom otevři [http://127.0.0.1:8010](http://127.0.0.1:8010). Obrázky můžeš nahrát ručně přes web. Pokud nezadáš `--output`, výstupy z web uploadu se ukládají do složky `outputs/` v projektu a web nabídne download link.

S vlastním portem a výstupní složkou:

```bash
node script.js --web --port 8011 --output "/path/to/output"
```

Windows příklad:

```powershell
node script.js --web --port 8011 --output "C:\Users\me\Pictures\clean"
```

## Spuštění autosložky

Watcher zpracuje existující i nově přidané obrázky ve složce.

```bash
node script.js --watch --folder "/path/to/images"
```

Windows:

```powershell
node script.js --watch --folder "C:\Users\me\Pictures\gemini"
```

Linux/macOS:

```bash
node script.js --watch --folder "$HOME/Pictures/gemini"
```

Rekurzivní hlídání podsložek:

```bash
node script.js --watch --folder "/path/to/images" --recursive
```

## Web + autosložka najednou

```bash
node script.js --web --watch --folder "/path/to/images" --port 8010
```

## První nastavení

Nastavení složky můžeš uložit bez startu služby:

```bash
node script.js --init --folder "/path/to/images" --output "/path/to/output" --recursive
```

Konfigurace se uloží do `config/watermark-watch.json`. Další spuštění může použít uloženou složku:

```bash
node script.js --watch
```

## PM2 nonstop běh

Instalace PM2:

```bash
npm install -g pm2
```

Web i watcher:

```bash
pm2 start script.js --name watermark-cleaner -- --web --watch --folder "/path/to/images" --port 8010
pm2 save
```

Pouze web:

```bash
pm2 start script.js --name watermark-web -- --web --port 8010
pm2 save
```

Pouze autosložka:

```bash
pm2 start script.js --name watermark-watch -- --watch --folder "/path/to/images"
pm2 save
```

Automatický start po restartu systému:

```bash
pm2 startup
```

PM2 vypíše příkaz, který je potřeba spustit s právy administrátora/root podle systému.

Užitečné PM2 příkazy:

```bash
pm2 list
pm2 logs watermark-cleaner
pm2 restart watermark-cleaner
pm2 stop watermark-cleaner
pm2 delete watermark-cleaner
```

## CLI volby

```text
--web                 Start localhost web UI a upload API
--watch               Hlídání složky
--folder <path>       Složka pro watcher
--output <path>       Výstupní složka
--port <number>       Port webu, default 8010
--host <host>         Host, default 127.0.0.1
--format <same|png|jpg|jpeg|webp|avif|tif|tiff>
--quality <1-100>     Kvalita pro jpg/webp/avif/tiff, default 95
--recursive           Hlídání podsložek
--overwrite           Přepsat existující clean výstupy
--init                Uložit nastavení a nespouštět službu
--help                Nápověda
```

Při `--format same` se zachová původní formát, pokud ho `sharp` umí zapisovat. Vstupní BMP se bezpečně uloží jako PNG, aby přípona odpovídala skutečnému obsahu souboru.

## Podporované systémy

Windows, Linux i macOS. Watcher používá `chokidar`, takže nevyužívá platformově omezený `fs.watch` recursive režim.

## Výstupy

Pro watcher se výstup ukládá vedle původního souboru jako `nazev-clean.ext`, pokud nezadáš `--output`. Pokud soubor existuje, vytvoří se `nazev-clean-2.ext`, `nazev-clean-3.ext` atd. S `--overwrite` se existující výstup přepíše.
