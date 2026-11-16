// Inlines the built JS and CSS straight into dist/index.html so the app runs
// from file:// — Chrome/Edge block external <script type="module"> and <link>
// stylesheets under the file:// origin (CORS), but inline tags and data: URIs
// are allowed. Run after `vite build`, before packaging the portable build.
//
//   node scripts/inline-singlefile.mjs
//
// Leaves device images (devices/*.png) as sibling files — <img src> loads fine
// from file://; only fetch()-based export embedding of those is unavailable
// offline, which is a graceful degradation (uploaded images still embed).

import {readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';

const __dirname=dirname(fileURLToPath(import.meta.url));
const DIST=join(__dirname,'..','dist');
const INDEX=join(DIST,'index.html');

const run=async()=>{
  let html=await readFile(INDEX,'utf8');
  const used=[];
  const scriptHashes=[];

  // Inline the module script: <script type="module" ... src="./assets/x.js"></script>
  const scriptRe=/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g;
  html=await replaceAsync(html,scriptRe,async(m,src)=>{
    const file=join(DIST,src.replace(/^\.?\//,''));
    used.push(file);
    let js=await readFile(file,'utf8');
    // Guard against a literal </script> inside string content breaking parsing.
    js=js.replace(/<\/script>/gi,'<\\/script>');
    // The page's CSP allows no inline script ('unsafe-inline' is gone), so the
    // one script we inline is authorised by the hash of its exact text.
    const body=`\n${js}\n`;
    scriptHashes.push(`'sha256-${createHash('sha256').update(body,'utf8').digest('base64')}'`);
    return `<script type="module">${body}</script>`;
  });
  if(scriptHashes.length){
    const cspRe=/(<meta http-equiv="Content-Security-Policy" content="[^"]*?script-src )([^;"]*)/;
    if(!cspRe.test(html))throw new Error('inline-singlefile: CSP script-src not found — refusing to ship an inlined script the policy would block');
    html=html.replace(cspRe,(m,a,b)=>`${a}${b.trim()} ${scriptHashes.join(' ')}`);
  }

  // Inline stylesheets: <link rel="stylesheet" ... href="./assets/x.css">
  const linkRe=/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g;
  html=await replaceAsync(html,linkRe,async(m,href)=>{
    const file=join(DIST,href.replace(/^\.?\//,''));
    used.push(file);
    const css=await readFile(file,'utf8');
    return `<style>\n${css}\n</style>`;
  });

  // Drop modulepreload hints — pointless once inlined, and they 404 on file://.
  html=html.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/g,'');

  await writeFile(INDEX,html);
  // Remove the now-inlined asset files so the folder is clean.
  for(const f of used){try{await rm(f);}catch(_){}}
  // Drop the assets/ dir if it's now empty (everything was inlined).
  try{const left=await readdir(join(DIST,'assets'));if(!left.length)await rm(join(DIST,'assets'),{recursive:true});}catch(_){}

  const kb=(Buffer.byteLength(html)/1024).toFixed(0);
  console.log(`Inlined ${used.length} asset(s) into index.html (${kb} KB). Runs from file://.`);
};

async function replaceAsync(str,re,fn){
  const parts=[];let last=0,m;
  while((m=re.exec(str))){
    parts.push(str.slice(last,m.index));
    parts.push(await fn(...m));
    last=m.index+m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join('');
}

run();
