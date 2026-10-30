#!/usr/bin/env node
/** Download the NuGet libraries used by the Windows client into ./lib. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = path.join(root, 'lib')
const cache = path.join(root, '.nuget-cache')
const packages = [
  { id: 'microsoft.web.webview2', version: '1.0.4314.35', files: [
    ['lib_manual/netcoreapp3.0/Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Core.dll'],
    ['lib_manual/netcoreapp3.0/Microsoft.Web.WebView2.WinForms.dll', 'Microsoft.Web.WebView2.WinForms.dll'],
    ['runtimes/win-x64/native/WebView2Loader.dll', 'WebView2Loader.dll'],
  ]},
  { id: 'naudio.core', version: '2.2.1', files: [['lib/netstandard2.0/NAudio.Core.dll', 'NAudio.Core.dll']] },
  { id: 'naudio.wasapi', version: '2.2.1', files: [['lib/netstandard2.0/NAudio.Wasapi.dll', 'NAudio.Wasapi.dll']] },
  { id: 'naudio.winmm', version: '2.2.1', files: [['lib/netstandard2.0/NAudio.WinMM.dll', 'NAudio.WinMM.dll']] },
  { id: 'taglibsharp', version: '2.3.0', files: [['lib/netstandard2.0/TagLibSharp.dll', 'TagLibSharp.dll']] },
]
fs.mkdirSync(lib, { recursive: true })
for (const pkg of packages) {
  if (pkg.files.every(([, out]) => fs.existsSync(path.join(lib, out)))) continue
  const nupkg = path.join(cache, `${pkg.id}.${pkg.version}.nupkg`)
  const dir = path.join(cache, `${pkg.id}.${pkg.version}`)
  fs.mkdirSync(cache, { recursive: true })
  if (!fs.existsSync(nupkg)) {
    const url = `https://api.nuget.org/v3-flatcontainer/${pkg.id}/${pkg.version}/${pkg.id}.${pkg.version}.nupkg`
    console.log('download', path.basename(nupkg))
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    fs.writeFileSync(nupkg, Buffer.from(await res.arrayBuffer()))
  }
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(path.join(dir, pkg.files[0][0]))) execFileSync('tar', ['-xf', nupkg, '-C', dir])
  for (const [rel, out] of pkg.files) fs.copyFileSync(path.join(dir, rel), path.join(lib, out))
}
console.log('dependencies ready:', lib)
