# IPvGO Playbook Explorer

A static, Vercel-ready browser for the certified 5×5 IPvGO playbooks.

The Explorer tab condenses the 150,000 WHRNG phases into a slider of distinct
playable entry phases, so every slider step opens a different game. The branch
navigator handles turns. Each branch represents an observed timing outcome or
random defense reply, so the page never implies that an uncertain continuation
is linear. The How it works tab explains the complete path from AND/OR proof,
timing-aware search, replay certificates, and packing to the separately trained
V9 WebGPU fallback, using the branch-exact timing model (White seeds at n+1,
replies land at n+1+waits per predicted branch, both adjacent arrivals proved).
The header and write-up offer the standalone player as `bruteforcego.js` — the
proof-of-concept that the playbook wins entirely on its own before the
production integration adds the neural fallback. `prepare:data` copies it from
`../ipvgobruteforce/data/seeded-phases/all-5x5-v1/merged/playbook.phase.js`, so
the site, its corpora, and the downloadable player must all come from the same
generation — rebuild the merged playbook first, then `prepare:data`, then
deploy.

## Local development

From this directory:

```sh
npm install
npm run prepare:data
npm run dev
```

`prepare:data` reads the certificate corpora under `../ipvgobruteforce`, strips
the proof-only history column from the display copy, and emits 1,000-phase gzip
shards under `public/data`. The original certificates remain the authority.

## Vercel

Set `ipvgo-playbook-web` as the Vercel project root. Prepare `public/data`
before deploying; it is intentionally ignored by Git because it is generated
from the local playbook corpus. `.vercelignore` still allows a local CLI deploy
to include it. The complete generated corpus is about 112 MB, so a bundled CLI
deployment requires Vercel Pro's larger static upload allowance.

For a smaller site deployment, upload the generated `public/data` tree to
Vercel Blob (or another static object origin), set `VITE_DATA_BASE_URL` to that
public base URL, and deploy only the application. The site is a static Vite
build with no server or game connection.
