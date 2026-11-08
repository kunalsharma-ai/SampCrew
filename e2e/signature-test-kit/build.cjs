/**
 * Builds the SampCrew Outlook signature test kit: a folder (and zip) someone can run on a Windows PC with Outlook to
 * try the real setup file before SampCrew is hosted.
 *
 *   pnpm build:packages && pnpm signature:test-kit [output folder]
 *
 * The setup file is the one SampCrew gives every computer (apps/api/src/modules/signatures/installer.ts), pointed
 * at a stand-in server on 127.0.0.1 (kit/test-server.ps1). The signature it installs is drawn by the real renderer
 * (@crew/contracts), with a logo, a photo and a festival banner, exactly as the API would send it.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, '.data/signature-test-kit'));
const PORT = 47800;
const contracts = require(path.join(ROOT, 'packages/contracts/dist/index.js'));

// The installer module has no imports, so it can be loaded straight from its TypeScript source.
function loadInstaller() {
  const src = fs.readFileSync(path.join(ROOT, 'apps/api/src/modules/signatures/installer.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}

/** A real PNG in one colour with a darker frame, so Outlook's scaling is easy to spot. */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [0];
    for (let x = 0; x < width; x++) {
      const edge = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
      row.push(...(edge ? [r >> 1, g >> 1, b >> 1] : [r, g, b]));
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const write = (rel, content) => {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

const { buildInstaller, SIGNATURE_NAME, AGENT_VERSION } = loadInstaller();
const token = 'scsig_testkit_' + crypto.randomBytes(18).toString('base64url');
const files = `${SIGNATURE_NAME}_files`;
const data = {
  ...contracts.SAMPLE_SIGNATURE,
  pronouns: 'she/her',
  brandColor: '#4f46e5',
  accentColor: '#06b6d4',
  font: 'Segoe UI',
  size: 'medium',
  photoSrc: `${files}/photo.png`,
  logoSrc: `${files}/logo.png`,
  logoWidth: 300,
  logoHeight: 100,
  banner: { message: 'Happy Diwali! Wishing you light, joy and success.', icon: '\u{1FA94}', bgColor: '#fff7ed', fgColor: '#9a3412', linkUrl: 'https://northwind.example', position: 'below' },
};
const template = 'photo-left';
const r = contracts.renderSignature(template, data);
for (const src of [data.photoSrc, data.logoSrc]) if (!r.html.includes(src)) console.warn(`note: the ${template} design does not use ${src}`);
const version = crypto.createHash('sha256').update([r.html, r.text, 'testkit'].join('\n')).digest('hex').slice(0, 32);
const images = [
  { name: 'photo.png', path: '/signature-agent/images/photo' },
  { name: 'logo.png', path: '/signature-agent/images/logo' },
];

fs.rmSync(OUT, { recursive: true, force: true });
write('SampCrew-Outlook-Signature-Setup.cmd', buildInstaller({ apiUrl: `http://127.0.0.1:${PORT}`, token }));
write('kit/data/sync.json', JSON.stringify({ version, html: r.html, text: r.text, images }, null, 1));
write('kit/data/token.txt', token);
write('kit/data/images/photo.png', png(96, 96, [236, 72, 153]));
write('kit/data/images/logo.png', png(300, 100, [79, 70, 229]));
for (const f of ['test-server.ps1', 'backup.ps1', 'check.ps1', 'remove.ps1']) {
  const s = fs.readFileSync(path.join(__dirname, 'kit', f), 'utf8');
  if (/[^\x00-\x7f]/.test(s)) throw new Error(`${f} must be plain ASCII so Windows PowerShell 5.1 reads it correctly`);
  write(`kit/${f}`, crlf(s));
}
const ps = (file, args = '') => `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0kit\\${file}"${args}`;
write('1-Start-Test.cmd', crlf(`@echo off
rem SampCrew signature test, step 1: saves your Outlook signature settings, starts the test server and runs the real setup file.
cd /d "%~dp0"
echo SampCrew Outlook signature test
echo.
${ps('backup.ps1')}
start "SampCrew test server" ${ps('test-server.ps1')}
ping -n 4 127.0.0.1 >nul
call "%~dp0SampCrew-Outlook-Signature-Setup.cmd"
echo.
echo Step 1 is done. Leave the "SampCrew test server" window open.
echo Open Outlook (restart it if it was open), start a new email and a reply, and look at the signature.
echo Then double-click 2-Check-Result.cmd.
pause
`));
write('2-Check-Result.cmd', crlf(`@echo off
rem SampCrew signature test, step 2: checks the files, Outlook settings and scheduled task, and writes the result file.
cd /d "%~dp0"
${ps('check.ps1')}
echo.
echo Send SampCrew-signature-test-result.txt to SampCrew support, with a screenshot of a new email in Outlook.
echo When you are done, double-click 3-Remove-Test.cmd.
pause
`));
write('3-Remove-Test.cmd', crlf(`@echo off
rem SampCrew signature test, step 3: removes the test signature and puts your own Outlook signature settings back.
cd /d "%~dp0"
${ps('remove.ps1')}
echo You can close the "SampCrew test server" window now.
pause
`));
write('README.txt', crlf(`SampCrew Outlook signature test kit
===================================

This kit tries the real SampCrew signature setup file on a Windows PC with desktop Outlook, before SampCrew is
hosted. A small test server runs on this PC only (127.0.0.1:${PORT}) and gives the setup file a sample signature
for "Priya Sharma" with a logo, a photo and a festival banner, drawn exactly as SampCrew draws it.

Nothing needs administrator rights. Your own Outlook signature settings are saved first and put back in step 3.

Before you start
- Use a PC with classic desktop Outlook (2013, 2016, 2019, 2021 or Microsoft 365) that has opened at least once.
  The "new Outlook" app keeps signatures online and is not covered.
- Unzip the whole folder first (right-click the zip, Extract All). Do not run the files from inside the zip.

Steps
1. Double-click 1-Start-Test.cmd.
   If Windows shows "Windows protected your PC", click More info, then Run anyway. The files are not code-signed yet.
   A "SampCrew test server" window opens; leave it open. A message says the signature is now in Outlook.
2. Open Outlook (restart it if it was already open). Start a new email and a reply. The sample signature should
   appear in both, with the purple logo, the pink photo and the Diwali banner.
3. Double-click 2-Check-Result.cmd. It checks the files, the Outlook settings and the scheduled task, starts the
   task once to make sure the background sync works, and writes SampCrew-signature-test-result.txt.
4. Send SampCrew-signature-test-result.txt and a screenshot of the new email to SampCrew support.
5. Double-click 3-Remove-Test.cmd. It runs the setup file's own uninstall, checks nothing was left behind and puts
   your earlier signature settings back. Close the test server window.

Built ${new Date().toISOString().slice(0, 10)} from the SampCrew source, sync version ${AGENT_VERSION}.
`));

const zip = `${OUT}.zip`;
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, '.'], { cwd: OUT });
console.log(`ok - test kit in ${OUT}`);
console.log(`ok - zip at ${zip}`);
