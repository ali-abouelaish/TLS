// Builds vps/trustedlet: only the files the live site needs, plus deploy/, ready to upload to the VPS.
//
// Usage (Node 20.12+, no dependencies):
//   node scripts/build-vps.mjs
// then, from the site folder:
//   scp -r vps/trustedlet <user>@<vps>:~/
//   ssh -t <user>@<vps> "sudo bash ~/trustedlet/deploy/install.sh"
//
// .env goes too when it exists, so a first install has the API key and sign-in address. install.sh never
// overwrites the .env already on the server, so the Harbor secret you paste in there survives updates.
// The folder is rebuilt from scratch each run.

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'vps', 'trustedlet');

const FILES = [
  'Trusted Let.dc.html', 'Listing.dc.html', 'Enquiry.dc.html', 'support.js', 'image-slot.js',
  'listings.json', 'RG-Primrose-Hill-Camden_33.jpg', 'server.mjs', 'scripts/fetch-listings.mjs',
  'private/staff-listings.json', '.env.example', 'deploy/install.sh', 'deploy/trustedlet.service'
];
const DIRS = ['assets'];
const OPTIONAL = ['.env', '.image-slots.state.json'];
const LF_ONLY = /\.(sh|service)$/; // bash and systemd reject Windows line endings

async function main() {
  const missing = [...FILES, ...DIRS].filter(f => !existsSync(join(ROOT, f)));
  if (missing.length) throw new Error(`missing ${missing.join(', ')} (run node scripts/fetch-listings.mjs for the listings)`);
  const example = await readFile(join(ROOT, '.env.example'), 'utf8');
  if (/^\s*(HARBOR_OPS_API_KEY|HARBOR_SIGN_IN_SECRET|SESSION_SECRET)=\S/m.test(example)) {
    throw new Error('.env.example holds a real value: move it to .env and leave it empty in .env.example');
  }

  await rm(OUT, { recursive: true, force: true });
  for (const f of [...FILES, ...OPTIONAL.filter(f => existsSync(join(ROOT, f)))]) {
    const to = join(OUT, f);
    await mkdir(dirname(to), { recursive: true });
    if (LF_ONLY.test(f)) await writeFile(to, (await readFile(join(ROOT, f), 'utf8')).replace(/\r\n/g, '\n'));
    else await cp(join(ROOT, f), to);
  }
  for (const d of DIRS) await cp(join(ROOT, d), join(OUT, d), { recursive: true });

  console.log(`Built ${OUT}${existsSync(join(ROOT, '.env')) ? '' : ' (no .env: install.sh will start from .env.example)'}`);
  console.log('Upload it:  scp -r vps/trustedlet <user>@<vps>:~/');
  console.log('Install it: ssh -t <user>@<vps> "sudo bash ~/trustedlet/deploy/install.sh"');
}

main().catch(err => {
  console.error(`build-vps: ${err.message}`);
  process.exitCode = 1;
});
